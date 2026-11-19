//! Port of `electron/delta.cjs`: the `fanotes-delta-v1` patch format.
//!
//! A patch is `MAGIC(16) | header_len(u32 BE) | header JSON | payload`. The
//! header lists the source and target file (kind, size, SHA-256) and an
//! operation plan of `copy` (from the installed file) and `data` (from the
//! payload) ranges that must rebuild the target exactly. Every step is
//! validated before a byte is written, and the result is re-hashed.

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use crate::error::{err, ErrorKind, Result, UpdateError};
use crate::manifest::DELTA_FORMAT;
use crate::util::{
    is_plain_file, lstat_opt, plain_object, read_exact_at, safe_integer, sha256_file, str_eq,
    write_all_at,
};
use crate::version::version_pattern_matches;

pub const DELTA_MAGIC: &[u8; 16] = b"FANOTESDELTA1\0\0\0";
pub const DELTA_PREFIX_BYTES: u64 = 16 + 4;
pub const MAX_DELTA_HEADER_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_DELTA_OPERATIONS: usize = 100_000;
pub const MAX_TARGET_BYTES: u64 = 1024 * 1024 * 1024;

static HASH_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-f0-9]{64}$").unwrap());
static TARGET_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z0-9._-]{1,160}$").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderFile {
    pub kind: String,
    pub size_bytes: u64,
    pub sha256: String,
    /// Only the target carries a file name.
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Copy { source_offset: u64, size_bytes: u64 },
    Data { data_offset: u64, size_bytes: u64 },
}

impl Operation {
    pub fn size_bytes(self) -> u64 {
        match self {
            Operation::Copy { size_bytes, .. } | Operation::Data { size_bytes, .. } => size_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeltaHeader {
    pub platform: String,
    pub base_version: String,
    pub target_version: String,
    pub source: HeaderFile,
    pub target: HeaderFile,
    pub operations: Vec<Operation>,
    pub payload_bytes: u64,
}

/// Bindings the signed manifest imposes on a patch header. `None` fields are not checked.
#[derive(Debug, Clone, Default)]
pub struct ExpectedHeader {
    pub platform: Option<String>,
    pub base_version: Option<String>,
    pub target_version: Option<String>,
    pub source: Option<ExpectedFile>,
    pub target: Option<ExpectedFile>,
}

#[derive(Debug, Clone, Default)]
pub struct ExpectedFile {
    pub kind: Option<String>,
    pub file_name: Option<String>,
    pub size_bytes: Option<u64>,
    pub sha256: Option<String>,
}

impl From<&crate::manifest::DeltaFile> for ExpectedFile {
    fn from(file: &crate::manifest::DeltaFile) -> Self {
        Self {
            kind: Some(file.kind.clone()),
            file_name: file.file_name.clone(),
            size_bytes: Some(file.size_bytes),
            sha256: Some(file.sha256.clone()),
        }
    }
}

fn is_safe_size(value: Option<&Value>) -> Option<u64> {
    safe_integer(value).filter(|size| *size > 0 && *size <= MAX_TARGET_BYTES)
}

fn validate_file_descriptor(candidate: Option<&Value>, label: &str) -> Result<HeaderFile> {
    let Some(object) = plain_object(candidate) else {
        return err(
            ErrorKind::Delta,
            format!("Die {label}-Beschreibung des Delta-Updates fehlt."),
        );
    };
    let kind = match object.get("kind").and_then(Value::as_str) {
        Some(kind @ ("appimage" | "app-asar")) => kind,
        _ => {
            return err(
                ErrorKind::Delta,
                format!("Der {label}-Typ des Delta-Updates ist ungültig."),
            )
        }
    };
    let Some(size_bytes) = is_safe_size(object.get("sizeBytes")) else {
        return err(
            ErrorKind::Size,
            format!("Die {label}-Größe des Delta-Updates ist ungültig."),
        );
    };
    let sha256 = match object.get("sha256").and_then(Value::as_str) {
        Some(hash) if HASH_PATTERN.is_match(hash) => hash.to_owned(),
        _ => {
            return err(
                ErrorKind::Delta,
                format!("Die {label}-Prüfsumme des Delta-Updates ist ungültig."),
            )
        }
    };
    let mut file_name = None;
    if label == "Zieldatei" {
        match object.get("fileName").and_then(Value::as_str) {
            Some(name) if TARGET_NAME.is_match(name) => file_name = Some(name.to_owned()),
            _ => {
                return err(
                    ErrorKind::Delta,
                    "Der Zieldateiname des Delta-Updates ist ungültig.",
                )
            }
        }
    }
    Ok(HeaderFile {
        kind: kind.to_owned(),
        size_bytes,
        sha256,
        file_name,
    })
}

/// Validate a parsed patch header against the patch file size and payload start.
///
/// Unlike JavaScript's `RegExp.test`, version fields must be real JSON strings.
pub fn validate_delta_header(
    candidate: &Value,
    patch_size: u64,
    data_start: u64,
) -> Result<DeltaHeader> {
    let Some(object) = candidate
        .as_object()
        .filter(|o| str_eq(o.get("format"), DELTA_FORMAT))
    else {
        return err(
            ErrorKind::Delta,
            "Das Delta-Paket besitzt ein unbekanntes Format.",
        );
    };
    let platform = match object.get("platform").and_then(Value::as_str) {
        Some(p @ ("linux" | "windows")) => p,
        _ => {
            return err(
                ErrorKind::Delta,
                "Das Delta-Paket gehört zu einer unbekannten Plattform.",
            )
        }
    };
    let version = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| version_pattern_matches(v))
    };
    let (Some(base_version), Some(target_version)) =
        (version("baseVersion"), version("targetVersion"))
    else {
        return err(
            ErrorKind::Delta,
            "Das Delta-Paket besitzt ungültige Versionsangaben.",
        );
    };
    let source = validate_file_descriptor(object.get("source"), "Quelldatei")?;
    let target = validate_file_descriptor(object.get("target"), "Zieldatei")?;
    let kinds_match = match platform {
        "linux" => source.kind == "appimage" && target.kind == "appimage",
        _ => source.kind == "app-asar" && target.kind == "app-asar",
    };
    if !kinds_match {
        return err(
            ErrorKind::Delta,
            "Die Dateitypen des Delta-Pakets passen nicht zur Plattform.",
        );
    }
    let Some(raw_operations) = object
        .get("operations")
        .and_then(Value::as_array)
        .filter(|o| !o.is_empty() && o.len() <= MAX_DELTA_OPERATIONS)
    else {
        return err(ErrorKind::Delta, "Der Delta-Operationsplan ist ungültig.");
    };

    let mut target_bytes = 0u64;
    let mut payload_bytes = 0u64;
    let mut operations = Vec::with_capacity(raw_operations.len());
    for raw in raw_operations {
        let object = raw.as_object();
        let Some(size) = object.and_then(|o| is_safe_size(o.get("sizeBytes"))) else {
            return err(
                ErrorKind::Delta,
                "Das Delta-Paket enthält eine ungültige Operation.",
            );
        };
        let object = object.expect("checked above");
        target_bytes += size;
        if target_bytes > target.size_bytes {
            return err(
                ErrorKind::Delta,
                "Der Delta-Operationsplan überschreitet die Zieldatei.",
            );
        }
        match object.get("kind").and_then(Value::as_str) {
            Some("copy") => {
                let offset = safe_integer(object.get("sourceOffset"))
                    .filter(|offset| offset + size <= source.size_bytes);
                let Some(source_offset) = offset else {
                    return err(ErrorKind::Delta, "Eine lokale Kopieroperation des Delta-Pakets liegt außerhalb der Quelldatei.");
                };
                operations.push(Operation::Copy {
                    source_offset,
                    size_bytes: size,
                });
            }
            Some("data") => {
                let Some(data_offset) = safe_integer(object.get("dataOffset"))
                    .filter(|offset| *offset == payload_bytes)
                else {
                    return err(
                        ErrorKind::Delta,
                        "Die Nutzdaten des Delta-Pakets sind nicht lückenlos angeordnet.",
                    );
                };
                payload_bytes += size;
                operations.push(Operation::Data {
                    data_offset,
                    size_bytes: size,
                });
            }
            _ => {
                return err(
                    ErrorKind::Delta,
                    "Das Delta-Paket enthält einen unbekannten Operationstyp.",
                )
            }
        }
    }
    if target_bytes != target.size_bytes {
        return err(
            ErrorKind::Delta,
            "Der Delta-Operationsplan rekonstruiert nicht die vollständige Zieldatei.",
        );
    }
    if data_start + payload_bytes != patch_size {
        return err(
            ErrorKind::Delta,
            "Die Größe der Delta-Nutzdaten stimmt nicht mit dem Operationsplan überein.",
        );
    }
    Ok(DeltaHeader {
        platform: platform.to_owned(),
        base_version: base_version.to_owned(),
        target_version: target_version.to_owned(),
        source,
        target,
        operations,
        payload_bytes,
    })
}

fn unexpected_end(error: std::io::Error) -> UpdateError {
    if error.kind() == std::io::ErrorKind::UnexpectedEof {
        UpdateError::new(
            ErrorKind::Delta,
            "Das Delta-Paket oder seine Quelldatei endet unerwartet.",
        )
    } else {
        UpdateError::from_io(&error)
    }
}

pub struct InspectedPatch {
    pub header: DeltaHeader,
    pub data_start: u64,
    pub patch_size: u64,
}

/// Read and validate the header of a patch file. Never follows symlinks.
pub fn inspect_delta_patch(patch_path: &Path) -> Result<InspectedPatch> {
    let unsafe_file = || {
        UpdateError::new(
            ErrorKind::Delta,
            "Das Delta-Paket ist keine sichere reguläre Datei.",
        )
    };
    let meta = std::fs::symlink_metadata(patch_path)?;
    if !is_plain_file(&meta) || meta.len() < DELTA_PREFIX_BYTES + 2 {
        return Err(unsafe_file());
    }
    let size = meta.len();
    let file = File::open(patch_path)?;
    let mut prefix = [0u8; DELTA_PREFIX_BYTES as usize];
    read_exact_at(&file, &mut prefix, 0).map_err(unexpected_end)?;
    if &prefix[..16] != DELTA_MAGIC {
        return err(
            ErrorKind::Delta,
            "Das Delta-Paket besitzt keine gültige FaNotes-Kennung.",
        );
    }
    let header_bytes = u64::from(u32::from_be_bytes([
        prefix[16], prefix[17], prefix[18], prefix[19],
    ]));
    if header_bytes == 0
        || header_bytes > MAX_DELTA_HEADER_BYTES
        || DELTA_PREFIX_BYTES + header_bytes >= size
    {
        return err(
            ErrorKind::Delta,
            "Der Kopf des Delta-Pakets ist ungültig groß.",
        );
    }
    let mut encoded = vec![0u8; header_bytes as usize];
    read_exact_at(&file, &mut encoded, DELTA_PREFIX_BYTES).map_err(unexpected_end)?;
    let Ok(candidate) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&encoded)) else {
        return err(
            ErrorKind::Delta,
            "Der Kopf des Delta-Pakets enthält kein gültiges JSON.",
        );
    };
    let data_start = DELTA_PREFIX_BYTES + header_bytes;
    Ok(InspectedPatch {
        header: validate_delta_header(&candidate, size, data_start)?,
        data_start,
        patch_size: size,
    })
}

fn assert_expected_header(header: &DeltaHeader, expected: Option<&ExpectedHeader>) -> Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    for (key, wanted, actual) in [
        ("platform", &expected.platform, &header.platform),
        ("baseVersion", &expected.base_version, &header.base_version),
        (
            "targetVersion",
            &expected.target_version,
            &header.target_version,
        ),
    ] {
        if wanted.as_ref().is_some_and(|wanted| wanted != actual) {
            return err(
                ErrorKind::Delta,
                format!("Das Delta-Paket besitzt eine unerwartete {key}-Bindung."),
            );
        }
    }
    for (side, wanted, actual) in [
        ("source", &expected.source, &header.source),
        ("target", &expected.target, &header.target),
    ] {
        let Some(wanted) = wanted else { continue };
        let mismatch = wanted.kind.as_ref().is_some_and(|v| *v != actual.kind)
            || wanted
                .file_name
                .as_ref()
                .is_some_and(|v| Some(v) != actual.file_name.as_ref())
            || wanted.size_bytes.is_some_and(|v| v != actual.size_bytes)
            || wanted.sha256.as_ref().is_some_and(|v| *v != actual.sha256);
        if mismatch {
            return err(
                ErrorKind::Delta,
                format!("Die {side}-Bindung des Delta-Pakets stimmt nicht mit dem signierten Manifest überein."),
            );
        }
    }
    Ok(())
}

fn open_output(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

#[derive(Default)]
pub struct ApplyOptions<'a> {
    pub expected: Option<&'a ExpectedHeader>,
    pub cancel: Option<&'a AtomicBool>,
    pub progress: Option<&'a mut dyn FnMut(u64, u64)>,
}

/// Rebuild the target file from the installed source file and a patch.
///
/// Checks, in order: patch header, manifest bindings, source file (regular,
/// not a symlink, exact size, SHA-256), output not a symlink; then writes the
/// plan and verifies the output size and SHA-256. On any failure the partial
/// output is deleted.
pub fn apply_delta_patch(
    patch_path: &Path,
    source_path: &Path,
    output_path: &Path,
    mut options: ApplyOptions<'_>,
) -> Result<DeltaHeader> {
    let InspectedPatch {
        header, data_start, ..
    } = inspect_delta_patch(patch_path)?;
    assert_expected_header(&header, options.expected)?;
    let source_meta = std::fs::symlink_metadata(source_path)?;
    if !is_plain_file(&source_meta) || source_meta.len() != header.source.size_bytes {
        return err(
            ErrorKind::Delta,
            "Die installierte Quelldatei passt nicht zum Delta-Update.",
        );
    }
    if sha256_file(source_path)? != header.source.sha256 {
        return err(ErrorKind::Hash, "Die installierte Version wurde verändert und kann nicht als Delta-Basis verwendet werden.");
    }
    if lstat_opt(output_path).is_some_and(|m| m.file_type().is_symlink()) {
        return err(
            ErrorKind::Delta,
            "Das Delta-Ziel darf kein symbolischer Link sein.",
        );
    }

    let source = File::open(source_path)?;
    let patch = File::open(patch_path)?;
    let output = open_output(output_path)?;
    let result = (|| -> Result<()> {
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut output_offset = 0u64;
        let mut last_progress: Option<Instant> = None;
        for operation in &header.operations {
            let (input, mut input_offset) = match *operation {
                Operation::Copy { source_offset, .. } => (&source, source_offset),
                Operation::Data { data_offset, .. } => (&patch, data_start + data_offset),
            };
            let mut remaining = operation.size_bytes();
            while remaining > 0 {
                if options.cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                    return Err(UpdateError::cancelled(
                        "Die Delta-Rekonstruktion wurde abgebrochen.",
                    ));
                }
                let length = remaining.min(buffer.len() as u64) as usize;
                let chunk = &mut buffer[..length];
                read_exact_at(input, chunk, input_offset).map_err(unexpected_end)?;
                write_all_at(&output, chunk, output_offset).map_err(|e| {
                    if e.kind() == std::io::ErrorKind::WriteZero {
                        UpdateError::new(ErrorKind::Io, "Die rekonstruierte Update-Datei konnte nicht vollständig geschrieben werden.")
                    } else {
                        UpdateError::from_io(&e)
                    }
                })?;
                input_offset += length as u64;
                output_offset += length as u64;
                remaining -= length as u64;
                if let Some(progress) = options.progress.as_mut() {
                    let due =
                        last_progress.is_none_or(|at| at.elapsed() > Duration::from_millis(180));
                    if due || output_offset == header.target.size_bytes {
                        last_progress = Some(Instant::now());
                        progress(output_offset, header.target.size_bytes);
                    }
                }
            }
        }
        output.sync_all()?;
        Ok(())
    })();
    drop((source, patch, output));
    if let Err(error) = result {
        let _ = std::fs::remove_file(output_path);
        return Err(error);
    }
    let verified = std::fs::symlink_metadata(output_path)
        .ok()
        .filter(|m| is_plain_file(m) && m.len() == header.target.size_bytes)
        .is_some()
        && sha256_file(output_path).is_ok_and(|hash| hash == header.target.sha256);
    if !verified {
        let _ = std::fs::remove_file(output_path);
        return err(ErrorKind::Hash, "Die rekonstruierte Update-Datei hat die abschließende SHA-256-Prüfung nicht bestanden.");
    }
    Ok(header)
}
