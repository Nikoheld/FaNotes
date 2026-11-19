//! Port of `downloadTransfer`: a resumable, size- and hash-verified download.
//!
//! The file is written to `<name>.part`, resumed with `Range` after a dropped
//! connection, checked for exact size and SHA-256, and only then renamed to its
//! final name. A hash mismatch deletes the file. Redirect and HTML answers
//! (captive portals) are refused with a diagnosis.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;

use crate::diagnosis::{diagnose_update_failure, looks_like_html, DiagnoseInput, Phase};
use crate::error::{err, ErrorKind, Result, UpdateError};
use crate::fetch::{fetch_github, read_failure_body, user_agent, Fetcher, Response};
use crate::platform::Platform;
use crate::util::{is_plain_file, js_number, lstat_opt, sha256_file};

pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// A fetcher should fail a read that stalls this long with `ErrorKind::TimedOut`.
pub const DOWNLOAD_IDLE: Duration = Duration::from_secs(12);
pub const MAX_DOWNLOAD_ATTEMPTS: u32 = 200;
pub const MAX_ZERO_PROGRESS_STALLS: u32 = 4;

const RETRYABLE_CODES: [&str; 14] = [
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ECONNABORTED",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CLOSED",
    "ERR_STREAM_PREMATURE_CLOSE",
];
static RETRYABLE_MESSAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)ECONNRESET|socket hang up|premature close|other side closed|UND_ERR_|ERR_STREAM_PREMATURE_CLOSE|terminated").unwrap()
});
static CONTENT_RANGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^bytes ([0-9]+)-([0-9]+)/([0-9]+)$").unwrap());

/// What to download and how to verify it.
#[derive(Debug, Clone)]
pub struct TransferInfo {
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub url: String,
}

pub struct TransferOptions<'a> {
    pub platform: Platform,
    pub current_version: &'a str,
    pub accept: &'a str,
    pub cancel: &'a AtomicBool,
    pub timeout: Duration,
    pub retry_delay: Duration,
    pub progress: Option<&'a mut dyn FnMut(u64, u64)>,
}

impl<'a> TransferOptions<'a> {
    pub fn new(
        platform: Platform,
        current_version: &'a str,
        accept: &'a str,
        cancel: &'a AtomicBool,
    ) -> Self {
        Self {
            platform,
            current_version,
            accept,
            cancel,
            timeout: DOWNLOAD_TIMEOUT,
            retry_delay: Duration::from_millis(50),
            progress: None,
        }
    }
}

/// `isRetryableTransferError`. A checksum failure, a filter page and an explicit stop are not retried.
pub fn is_retryable_transfer_error(error: &UpdateError, idle_stall: bool) -> bool {
    if idle_stall {
        return true;
    }
    if error.diagnosis.is_some() || error.is_abort() {
        return false;
    }
    if error
        .code
        .as_deref()
        .is_some_and(|code| RETRYABLE_CODES.contains(&code))
    {
        return true;
    }
    RETRYABLE_MESSAGE.is_match(&error.message)
}

fn reject_response(url: &str, response: &mut Response, status: u16) -> UpdateError {
    let body = read_failure_body(response, 8192);
    let meta = response.meta();
    let inner = UpdateError::new(
        ErrorKind::Network,
        format!("Der Update-Download antwortet mit HTTP {status}."),
    );
    let diagnosis = diagnose_update_failure(&DiagnoseInput {
        phase: Phase::Download,
        url,
        error: Some(&inner),
        response: Some(&meta),
        body_text: &body,
        resolved_address: None,
    });
    UpdateError::new(ErrorKind::Network, diagnosis.message.clone()).with_diagnosis(diagnosis)
}

fn open_part(path: &Path, append: bool) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

struct AttemptFailure {
    error: UpdateError,
    idle_stall: bool,
}

impl From<UpdateError> for AttemptFailure {
    fn from(error: UpdateError) -> Self {
        Self {
            error,
            idle_stall: false,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn attempt(
    fetcher: &dyn Fetcher,
    info: &TransferInfo,
    options: &mut TransferOptions<'_>,
    part_path: &Path,
    mut offset: u64,
    deadline: Instant,
) -> std::result::Result<(), AttemptFailure> {
    let mut headers = vec![
        ("Accept".to_owned(), options.accept.to_owned()),
        (
            "User-Agent".to_owned(),
            user_agent(options.platform, options.current_version),
        ),
    ];
    if offset > 0 {
        headers.push(("Range".to_owned(), format!("bytes={offset}-")));
    }
    let mut response = fetch_github(fetcher, &info.url, &headers, None)?;
    let status = response.status;
    if (300..400).contains(&status) {
        return Err(reject_response(&info.url, &mut response, status).into());
    }
    if offset > 0 && status != 206 {
        if status == 200 {
            offset = 0;
            let _ = std::fs::remove_file(part_path);
        } else {
            return Err(reject_response(&info.url, &mut response, status).into());
        }
    } else if offset == 0 && status != 200 {
        return Err(reject_response(&info.url, &mut response, status).into());
    }
    if looks_like_html(response.header("content-type"), "") {
        return Err(reject_response(&info.url, &mut response, status).into());
    }
    if offset > 0 {
        let range = response
            .header("content-range")
            .and_then(|h| CONTENT_RANGE.captures(h));
        let valid = range.is_some_and(|r| {
            r[1].parse::<u64>().ok() == Some(offset)
                && r[3].parse::<u64>().ok() == Some(info.size_bytes)
        });
        if !valid {
            return err(
                ErrorKind::Size,
                "Der Update-Server hat einen ungültigen Fortsetzungsbereich geliefert.",
            )
            .map_err(Into::into);
        }
    }
    // `Number(headers.get('content-length'))`: a missing header reads as 0, which
    // never equals a real size, so a response without Content-Length is refused.
    let advertised = js_number(response.header("content-length").unwrap_or(""));
    let expected = (info.size_bytes - offset) as f64;
    if advertised.is_finite() && advertised != expected {
        return err(
            ErrorKind::Size,
            "Der Update-Server hat eine unerwartete Downloadgröße angekündigt.",
        )
        .map_err(Into::into);
    }
    let mut file = open_part(part_path, offset > 0).map_err(|e| UpdateError::from_io(&e))?;
    let mut downloaded = offset;
    let mut last_progress: Option<Instant> = None;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        if options.cancel.load(Ordering::SeqCst) {
            return Err(UpdateError::cancelled("Der Update-Download wurde abgebrochen.").into());
        }
        // The JS deadline timer aborts the request mid-stream.
        if Instant::now() >= deadline {
            return Err(UpdateError::cancelled(
                "Der Update-Download hat das Zeitlimit überschritten.",
            )
            .into());
        }
        let read = match response.body.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                let idle_stall = error.kind() == std::io::ErrorKind::TimedOut;
                return Err(AttemptFailure {
                    error: UpdateError::from_io(&error),
                    idle_stall,
                });
            }
        };
        downloaded += read as u64;
        if downloaded > info.size_bytes {
            return err(
                ErrorKind::Size,
                "Der Update-Download ist größer als angekündigt.",
            )
            .map_err(Into::into);
        }
        file.write_all(&buffer[..read])
            .map_err(|e| UpdateError::from_io(&e))?;
        if let Some(progress) = options.progress.as_mut() {
            if last_progress.is_none_or(|at| at.elapsed() > Duration::from_millis(180))
                || downloaded == info.size_bytes
            {
                last_progress = Some(Instant::now());
                progress(downloaded, info.size_bytes);
            }
        }
    }
    file.flush().map_err(|e| UpdateError::from_io(&e))?;
    drop(file);
    let written = lstat_opt(part_path).filter(is_plain_file);
    if written.is_none_or(|meta| meta.len() != info.size_bytes) {
        return Err(UpdateError::new(
            ErrorKind::Network,
            "Das Update wurde nicht vollständig heruntergeladen.",
        )
        .with_code("ERR_STREAM_PREMATURE_CLOSE")
        .into());
    }
    Ok(())
}

/// Download `info` into `release_directory` and return the verified final path.
pub fn download_transfer(
    fetcher: &dyn Fetcher,
    info: &TransferInfo,
    release_directory: &Path,
    mut options: TransferOptions<'_>,
) -> Result<PathBuf> {
    let final_path = release_directory.join(&info.file_name);
    let part_path = release_directory.join(format!("{}.part", info.file_name));
    if let Some(existing) = lstat_opt(&final_path) {
        if is_plain_file(&existing)
            && existing.len() == info.size_bytes
            && sha256_file(&final_path)? == info.sha256
        {
            return Ok(final_path);
        }
        let _ = std::fs::remove_file(&final_path);
    }

    let deadline = Instant::now() + options.timeout;
    let mut attempts = 0u32;
    let mut stalls = 0u32;
    let mut last_error: Option<UpdateError> = None;
    let mut finished = false;
    while attempts < MAX_DOWNLOAD_ATTEMPTS && !finished {
        if options.cancel.load(Ordering::SeqCst) {
            return Err(UpdateError::cancelled(
                "Der Update-Download wurde abgebrochen.",
            ));
        }
        if Instant::now() >= deadline {
            return Err(last_error.unwrap_or_else(|| {
                UpdateError::new(
                    ErrorKind::Cancelled,
                    "Der Update-Download hat das Zeitlimit überschritten.",
                )
                .with_code("ETIMEDOUT")
            }));
        }
        attempts += 1;
        let mut offset = 0;
        match lstat_opt(&part_path) {
            Some(partial) if is_plain_file(&partial) => {
                if partial.len() == info.size_bytes {
                    finished = true;
                    break;
                }
                if partial.len() > 0 && partial.len() < info.size_bytes {
                    offset = partial.len();
                } else {
                    let _ = std::fs::remove_file(&part_path);
                }
            }
            Some(_) => {
                let _ = std::fs::remove_file(&part_path);
            }
            None => {}
        }
        if let Some(progress) = options.progress.as_mut() {
            progress(offset, info.size_bytes);
        }
        match attempt(fetcher, info, &mut options, &part_path, offset, deadline) {
            Ok(()) => finished = true,
            Err(AttemptFailure { error, idle_stall }) => {
                if options.cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
                    return Err(error);
                }
                let size_now = lstat_opt(&part_path)
                    .filter(is_plain_file)
                    .map_or(0, |m| m.len());
                let grew = size_now > offset;
                if !is_retryable_transfer_error(&error, idle_stall)
                    || attempts >= MAX_DOWNLOAD_ATTEMPTS
                {
                    return Err(error);
                }
                if !grew {
                    stalls += 1;
                    if stalls >= MAX_ZERO_PROGRESS_STALLS {
                        return Err(error);
                    }
                } else {
                    stalls = 0;
                }
                last_error = Some(error);
                std::thread::sleep(options.retry_delay);
            }
        }
    }
    if !finished {
        return Err(last_error.unwrap_or_else(|| {
            UpdateError::new(
                ErrorKind::Network,
                "Das Update wurde nicht vollständig heruntergeladen.",
            )
        }));
    }
    let meta = std::fs::metadata(&part_path)?;
    if !meta.is_file() || meta.len() != info.size_bytes {
        return err(
            ErrorKind::Size,
            "Das Update wurde nicht vollständig heruntergeladen.",
        );
    }
    if sha256_file(&part_path)? != info.sha256 {
        let _ = std::fs::remove_file(&part_path);
        return err(
            ErrorKind::Hash,
            "Die SHA-256-Prüfung des Downloads ist fehlgeschlagen. Die Datei wurde verworfen.",
        );
    }
    std::fs::rename(&part_path, &final_path)?;
    Ok(final_path)
}
