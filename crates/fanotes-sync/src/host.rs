//! `SyncHostApi`: what the app gives the engine.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq)]
pub struct ScanEntry {
    pub path: String,
    pub size: f64,
    pub mtime_ms: f64,
}

pub trait SyncHost: Send + Sync {
    fn vault_id(&self) -> Result<String, String>;
    fn scan(&self) -> Result<Vec<ScanEntry>, String>;
    fn read(&self, path: &str) -> Result<Vec<u8>, String>;
    fn write(&self, path: &str, bytes: &[u8], mtime_ms: f64) -> Result<ScanEntry, String>;
    fn remove(&self, path: &str) -> Result<(), String>;
    fn read_state(&self, vault_id: &str) -> Result<Option<String>, String>;
    fn write_state(&self, vault_id: &str, json: Option<&str>) -> Result<(), String>;
    fn read_secrets(&self) -> Result<Option<String>, String>;
    fn write_secrets(&self, json: Option<&str>) -> Result<(), String>;
}

#[derive(Default)]
struct MemoryInner {
    files: BTreeMap<String, (Vec<u8>, f64)>,
    order: Vec<String>,
    clock: f64,
    state: BTreeMap<String, String>,
    secrets: Option<String>,
}

/// The in-memory vault of `scripts/check-sync.mjs` (`createFakeHost`): the
/// clock starts at 1 700 000 000 000 and moves 1 s per put or unstamped write.
pub struct MemoryHost {
    id: String,
    inner: Mutex<MemoryInner>,
}

impl MemoryHost {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            inner: Mutex::new(MemoryInner {
                clock: 1_700_000_000_000.0,
                ..Default::default()
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MemoryInner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn put(&self, path: &str, bytes: &[u8]) {
        let mut inner = self.lock();
        inner.clock += 1000.0;
        let clock = inner.clock;
        if !inner.files.contains_key(path) {
            inner.order.push(path.to_owned());
        }
        inner.files.insert(path.to_owned(), (bytes.to_vec(), clock));
    }

    pub fn delete(&self, path: &str) {
        let mut inner = self.lock();
        inner.files.remove(path);
        inner.order.retain(|candidate| candidate != path);
    }

    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.lock().files.get(path).map(|(bytes, _)| bytes.clone())
    }

    /// Files in insertion order (a JavaScript `Map`).
    pub fn files(&self) -> Vec<(String, Vec<u8>, f64)> {
        let inner = self.lock();
        inner
            .order
            .iter()
            .map(|path| {
                (
                    path.clone(),
                    inner.files[path].0.clone(),
                    inner.files[path].1,
                )
            })
            .collect()
    }

    pub fn state_json(&self, vault_id: &str) -> Option<String> {
        self.lock().state.get(vault_id).cloned()
    }

    pub fn set_state_json(&self, vault_id: &str, json: &str) {
        self.lock()
            .state
            .insert(vault_id.to_owned(), json.to_owned());
    }

    pub fn secrets_json(&self) -> Option<String> {
        self.lock().secrets.clone()
    }
}

impl SyncHost for MemoryHost {
    fn vault_id(&self) -> Result<String, String> {
        Ok(format!("vault-{}", self.id))
    }
    fn scan(&self) -> Result<Vec<ScanEntry>, String> {
        let inner = self.lock();
        Ok(inner
            .order
            .iter()
            .map(|path| ScanEntry {
                path: path.clone(),
                size: inner.files[path].0.len() as f64,
                mtime_ms: inner.files[path].1,
            })
            .collect())
    }
    fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        self.lock()
            .files
            .get(path)
            .map(|(bytes, _)| bytes.clone())
            .ok_or_else(|| format!("missing {path}"))
    }
    fn write(&self, path: &str, bytes: &[u8], mtime_ms: f64) -> Result<ScanEntry, String> {
        let mut inner = self.lock();
        let mtime = if mtime_ms != 0.0 && !mtime_ms.is_nan() {
            mtime_ms
        } else {
            inner.clock += 1000.0;
            inner.clock
        };
        if !inner.files.contains_key(path) {
            inner.order.push(path.to_owned());
        }
        inner.files.insert(path.to_owned(), (bytes.to_vec(), mtime));
        Ok(ScanEntry {
            path: path.to_owned(),
            size: bytes.len() as f64,
            mtime_ms: mtime,
        })
    }
    fn remove(&self, path: &str) -> Result<(), String> {
        self.delete(path);
        Ok(())
    }
    fn read_state(&self, vault_id: &str) -> Result<Option<String>, String> {
        Ok(self.lock().state.get(vault_id).cloned())
    }
    fn write_state(&self, vault_id: &str, json: Option<&str>) -> Result<(), String> {
        let mut inner = self.lock();
        match json {
            Some(json) => inner.state.insert(vault_id.to_owned(), json.to_owned()),
            None => inner.state.remove(vault_id),
        };
        Ok(())
    }
    fn read_secrets(&self) -> Result<Option<String>, String> {
        Ok(self.lock().secrets.clone())
    }
    fn write_secrets(&self, json: Option<&str>) -> Result<(), String> {
        self.lock().secrets = json.map(str::to_owned);
        Ok(())
    }
}

/// A vault folder on disk, scanned like `electron/sync.cjs` (dot entries except
/// `.fanotes`, `.fanotes/{history,tree-cache,trash}`, `*.tmp` and symlinks
/// skipped; writes are temp file + fsync + rename). State and secrets live in
/// `data_dir` as plain files: this host is for the CLI and benchmarks only. The
/// desktop app uses the Tauri host, which keeps secrets in the OS keyring.
pub struct FsHost {
    root: PathBuf,
    data_dir: PathBuf,
}

impl FsHost {
    pub fn new(root: impl Into<PathBuf>, data_dir: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            data_dir: data_dir.into(),
        }
    }

    fn resolve(&self, relative: &str) -> Result<PathBuf, String> {
        let normalized = relative.replace('\\', "/");
        let normalized = normalized.trim_matches('/');
        if normalized.is_empty()
            || normalized
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || normalized.contains('\0')
        {
            return Err("Ungültiger Sync-Pfad.".to_owned());
        }
        let mut cursor = self.root.clone();
        for part in normalized.split('/') {
            cursor.push(part);
            if let Ok(meta) = std::fs::symlink_metadata(&cursor) {
                if meta.file_type().is_symlink() {
                    return Err("Symbolische Links sind im Vault nicht erlaubt.".to_owned());
                }
            }
        }
        Ok(cursor)
    }

    fn scan_dir(&self, dir: &Path, depth: usize, out: &mut Vec<ScanEntry>) -> Result<(), String> {
        let incomplete = || "Der Vault wurde unvollständig gelesen.".to_owned();
        if depth > 40 || out.len() >= 100_000 {
            return Err(incomplete());
        }
        let entries = std::fs::read_dir(dir).map_err(|_| incomplete())?;
        for entry in entries {
            let entry = entry.map_err(|_| incomplete())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink()
                || (name.starts_with('.') && !(depth == 0 && name == ".fanotes"))
            {
                continue;
            }
            if depth == 1
                && dir.file_name().is_some_and(|parent| parent == ".fanotes")
                && matches!(name.as_str(), "history" | "tree-cache" | "trash")
            {
                continue;
            }
            if meta.is_dir() {
                self.scan_dir(&path, depth + 1, out)?;
                continue;
            }
            if !meta.is_file() || name.to_ascii_lowercase().ends_with(".tmp") {
                continue;
            }
            let relative = path
                .strip_prefix(&self.root)
                .map_err(|_| incomplete())?
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push(ScanEntry {
                path: relative,
                size: meta.len() as f64,
                mtime_ms: mtime_ms(&meta),
            });
        }
        Ok(())
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| (elapsed.as_secs_f64() * 1000.0).round())
        .unwrap_or(0.0)
}

fn atomic_write(target: &Path, bytes: &[u8], mtime: Option<f64>) -> Result<(), String> {
    use std::io::Write;
    let dir = target.parent().ok_or("Ungültiger Sync-Pfad.")?;
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        crate::crypto::to_hex(&crate::crypto::random_bytes(8))
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(ms) = mtime.filter(|ms| ms.is_finite() && *ms > 0.0) {
            let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs_f64(ms / 1000.0);
            let _ = file.set_modified(time);
        }
        drop(file);
        std::fs::rename(&temp, target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(|error| error.to_string())
}

impl SyncHost for FsHost {
    fn vault_id(&self) -> Result<String, String> {
        let absolute = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
        Ok(crate::crypto::sha256_hex(absolute.to_string_lossy().as_bytes())[..32].to_owned())
    }
    fn scan(&self) -> Result<Vec<ScanEntry>, String> {
        let mut out = Vec::new();
        self.scan_dir(&self.root, 0, &mut out)?;
        Ok(out)
    }
    fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        let target = self.resolve(path)?;
        let meta = std::fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
        if !meta.is_file() {
            return Err("Die Datei ist keine reguläre Datei.".to_owned());
        }
        if meta.len() > 100 * 1024 * 1024 {
            return Err("Die Datei ist zu groß für den Sync.".to_owned());
        }
        std::fs::read(&target).map_err(|error| error.to_string())
    }
    fn write(&self, path: &str, bytes: &[u8], mtime_ms: f64) -> Result<ScanEntry, String> {
        let target = self.resolve(path)?;
        atomic_write(&target, bytes, Some(mtime_ms))?;
        let meta = std::fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
        Ok(ScanEntry {
            path: path.trim_matches('/').to_owned(),
            size: meta.len() as f64,
            mtime_ms: self::mtime_ms(&meta),
        })
    }
    fn remove(&self, path: &str) -> Result<(), String> {
        let target = self.resolve(path)?;
        match std::fs::remove_file(&target) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }
    fn read_state(&self, vault_id: &str) -> Result<Option<String>, String> {
        match std::fs::read_to_string(self.data_dir.join(format!("state-{vault_id}.json"))) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    fn write_state(&self, vault_id: &str, json: Option<&str>) -> Result<(), String> {
        let target = self.data_dir.join(format!("state-{vault_id}.json"));
        match json {
            Some(json) => atomic_write(&target, json.as_bytes(), None),
            None => std::fs::remove_file(&target).or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error.to_string())
                }
            }),
        }
    }
    fn read_secrets(&self) -> Result<Option<String>, String> {
        match std::fs::read_to_string(self.data_dir.join("account.json")) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    fn write_secrets(&self, json: Option<&str>) -> Result<(), String> {
        let target = self.data_dir.join("account.json");
        match json {
            Some(json) => atomic_write(&target, json.as_bytes(), None),
            None => std::fs::remove_file(&target).or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error.to_string())
                }
            }),
        }
    }
}
