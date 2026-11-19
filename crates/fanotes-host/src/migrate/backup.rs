//! Verified backup of the Electron profile in `migration-backup/<id>/`.
//!
//! `files/` mirrors the profile minus caches and re-downloadable files
//! (`EXCLUDED`). `manifest.json` lists every file with size and SHA-256;
//! `VERIFIED` is written only after every copied file was read back and
//! matched. The source is only read. A backup without `VERIFIED` is a
//! leftover of a crash and is redone.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::notes;

pub const BACKUP_DIR: &str = "migration-backup";

/// Top-level profile entries left out: Chromium caches and locks, network
/// state the app does not use, downloaded models and app caches that are rebuilt.
pub const EXCLUDED: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache",
    "Crashpad",
    "blob_storage",
    "Session Storage",
    "Shared Dictionary",
    "Dictionaries",
    "Service Worker",
    "Network",
    "Network Persistent State",
    "Cookies",
    "Cookies-journal",
    "Trust Tokens",
    "Trust Tokens-journal",
    "DIPS",
    "DIPS-journal",
    "SharedStorage",
    "TransportSecurity",
    "Reporting and NEL",
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "lockfile",
    "models",
    "updates",
    "tool-cache",
    "tree-cache-v1",
];

pub enum Carried {
    Copied,
    Same,
    KeptExisting,
}

/// Writes `bytes` to `target` only when nothing is there; never replaces a file.
pub fn carry(bytes: &[u8], target: &Path) -> Result<Carried, String> {
    match fs::read(target) {
        Ok(existing) if existing == bytes => Ok(Carried::Same),
        Ok(_) => Ok(Carried::KeptExisting),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("{}: {error}", parent.display()))?;
            }
            notes::atomic_write(target, bytes, 0o600)?;
            Ok(Carried::Copied)
        }
        Err(error) => Err(format!("{}: {error}", target.display())),
    }
}

/// Regular files under `root` as (`/`-separated relative path, absolute path). Symlinks are skipped.
pub fn walk(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut out = Vec::new();
    match fs::symlink_metadata(root) {
        Err(_) => return Ok(out),
        Ok(meta) if meta.is_file() => return Ok(vec![(String::new(), root.to_path_buf())]),
        Ok(meta) if !meta.is_dir() => return Ok(out),
        Ok(_) => {}
    }
    let mut stack = vec![(String::new(), root.to_path_buf())];
    while let Some((prefix, directory)) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(&directory)
            .map_err(|error| format!("{}: {error}", directory.display()))?
            .flatten()
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                stack.push((relative, entry.path()));
            } else if meta.is_file() {
                out.push((relative, entry.path()));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((size, hex(&hasher.finalize())))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn stamp(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let meta = fs::symlink_metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// Copies one file, hashing what was written, and checks the source did not change meanwhile.
fn copy_file(source: &Path, target: &Path) -> Result<(u64, String), String> {
    let before = stamp(source);
    let mut input =
        fs::File::open(source).map_err(|error| format!("{}: {error}", source.display()))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let temporary = target.with_file_name(format!(
        ".{}.copy.tmp",
        target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&temporary)
        .map_err(|error| format!("{}: {error}", temporary.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("{}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("{}: {error}", temporary.display()))?;
        size += read as u64;
    }
    output
        .sync_all()
        .map_err(|error| format!("{}: {error}", temporary.display()))?;
    drop(output);
    if stamp(source) != before || before.map(|(length, _)| length) != Some(size) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("{} changed while it was copied", source.display()));
    }
    fs::rename(&temporary, target).map_err(|error| format!("{}: {error}", target.display()))?;
    Ok((size, hex(&hasher.finalize())))
}

fn new_id(root: &Path) -> String {
    let base: String = notes::iso_now()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let mut id = base.clone();
    let mut counter = 1;
    while root.join(&id).exists() {
        id = format!("{base}-{counter}");
        counter += 1;
    }
    id
}

/// Copies the profile, writes the manifest, reads every copy back, then marks it verified.
pub fn create(app_data: &Path, source: &Path) -> Result<Value, String> {
    let root = app_data.join(BACKUP_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("{}: {error}", root.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&root, fs::Permissions::from_mode(0o700));
    }
    // A backup without VERIFIED was cut off by a crash. It is only a partial copy of a profile that is still there.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() && !entry.path().join("VERIFIED").is_file() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let id = new_id(&root);
    let directory = root.join(&id);
    let files_dir = directory.join("files");
    let mut files = Vec::new();
    let mut excluded = Vec::new();
    let mut bytes = 0u64;
    let mut top: Vec<_> = fs::read_dir(source)
        .map_err(|error| format!("{}: {error}", source.display()))?
        .flatten()
        .collect();
    top.sort_by_key(|entry| entry.file_name());
    for entry in top {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if EXCLUDED.contains(&name.as_str()) {
            excluded.push(json!(name));
            continue;
        }
        for (relative, path) in walk(&entry.path())? {
            let relative = if relative.is_empty() {
                name.clone()
            } else {
                format!("{name}/{relative}")
            };
            if relative.rsplit('/').next() == Some("LOCK") {
                continue;
            }
            let (size, digest) = copy_file(&path, &files_dir.join(&relative))?;
            bytes += size;
            files.push(json!({"path": relative, "size": size, "sha256": digest}));
        }
    }
    let manifest = json!({
        "version": 1,
        "id": id,
        "source": source.to_string_lossy(),
        "createdAt": notes::iso_now(),
        "files": files,
        "fileCount": files.len(),
        "bytes": bytes,
        "excluded": excluded,
    });
    let text = serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
    notes::atomic_write(&directory.join("manifest.json"), text.as_bytes(), 0o600)?;
    verify(&directory)?;
    notes::atomic_write(
        &directory.join("VERIFIED"),
        format!("{}\n", notes::iso_now()).as_bytes(),
        0o600,
    )?;
    Ok(json!({
        "id": id,
        "path": directory.to_string_lossy(),
        "files": files_dir.to_string_lossy(),
        "fileCount": manifest["fileCount"],
        "bytes": bytes,
        "excluded": manifest["excluded"],
        "verified": true,
    }))
}

/// Every file in the manifest is present with the recorded size and SHA-256.
pub fn verify(directory: &Path) -> Result<Value, String> {
    let manifest: Value = serde_json::from_slice(
        &fs::read(directory.join("manifest.json"))
            .map_err(|_| "the backup has no manifest".to_owned())?,
    )
    .map_err(|_| "the backup manifest is damaged".to_owned())?;
    for file in manifest["files"].as_array().into_iter().flatten() {
        let relative = file["path"].as_str().unwrap_or_default();
        if relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("the backup manifest names an invalid path".to_owned());
        }
        let (size, digest) = hash_file(&directory.join("files").join(relative))?;
        if Some(size) != file["size"].as_u64() || Some(digest.as_str()) != file["sha256"].as_str() {
            return Err(format!(
                "backup file {relative} does not match its manifest"
            ));
        }
    }
    Ok(manifest)
}

/// Rollback: writes a verified backup back as a profile into an empty or missing directory.
pub fn restore(app_data: &Path, id: &str, destination: &Path) -> Result<usize, String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid backup id".to_owned());
    }
    let directory = app_data.join(BACKUP_DIR).join(id);
    if !directory.join("VERIFIED").is_file() {
        return Err("this backup was never verified".to_owned());
    }
    let manifest = verify(&directory)?;
    if fs::read_dir(destination).is_ok_and(|mut entries| entries.next().is_some()) {
        return Err("the destination is not empty; nothing was written".to_owned());
    }
    let mut count = 0;
    for file in manifest["files"].as_array().into_iter().flatten() {
        let relative = file["path"].as_str().unwrap_or_default();
        let (_, digest) = copy_file(
            &directory.join("files").join(relative),
            &destination.join(relative),
        )?;
        if Some(digest.as_str()) != file["sha256"].as_str() {
            return Err(format!("restored {relative} does not match the backup"));
        }
        count += 1;
    }
    Ok(count)
}

pub fn list(app_data: &Path) -> Value {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(app_data.join(BACKUP_DIR)) {
        for entry in entries.flatten() {
            let Ok(manifest) = fs::read(entry.path().join("manifest.json")) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_slice::<Value>(&manifest) else {
                continue;
            };
            out.push(json!({
                "id": manifest["id"],
                "createdAt": manifest["createdAt"],
                "source": manifest["source"],
                "fileCount": manifest["fileCount"],
                "bytes": manifest["bytes"],
                "verified": entry.path().join("VERIFIED").is_file(),
            }));
        }
    }
    out.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    Value::Array(out)
}

/// Electron holds `SingletonLock` (Linux: a `host-pid` symlink) or `lockfile` (Windows) while it runs.
pub fn electron_running(source: &Path) -> bool {
    #[cfg(unix)]
    {
        if let Ok(target) = fs::read_link(source.join("SingletonLock")) {
            let target = target.to_string_lossy().into_owned();
            let Some((host, pid)) = target.rsplit_once('-') else {
                return true;
            };
            let Ok(pid) = pid.parse::<u32>() else {
                return true;
            };
            if host != hostname() {
                return true;
            }
            return Path::new(&format!("/proc/{pid}")).exists();
        }
        false
    }
    #[cfg(windows)]
    {
        let lock = source.join("lockfile");
        if !lock.exists() {
            return false;
        }
        matches!(fs::File::open(&lock), Err(error) if error.raw_os_error() == Some(32))
    }
}

#[cfg(unix)]
fn hostname() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname NUL-terminates on success.
    let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
    if !ok {
        return String::new();
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}
