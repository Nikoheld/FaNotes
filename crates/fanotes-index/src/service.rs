//! The running index of one vault: initial scan in parallel, then incremental
//! passes after file changes (watcher and explicit notifications, debounced),
//! persisted as a rebuildable cache outside the vault.
//!
//! Every pass lists the vault (cheap: directory reads and `stat`), drops
//! documents that are gone, and re-reads only documents whose fingerprint
//! changed. A cache that is missing, from another engine version, for another
//! vault, truncated or with a wrong checksum is ignored and rebuilt.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::index::{DocIndex, IndexUnit, PreparedUnit, SearchResult};
use crate::vault::{extract, list_sources, sort_paths, utf16_cmp, DocSource, DocStatus, Extracted};

/// Bump when extraction or the cache layout changes: every document is read again.
pub const ENGINE_VERSION: u32 = 1;
const CACHE_FORMAT: &str = "fanotes-index-cache-v1";
const DEBOUNCE: Duration = Duration::from_millis(400);
const MAX_DEBOUNCE: Duration = Duration::from_secs(3);
const SAVE_AFTER: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocState {
    pub source: DocSource,
    pub status: DocStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub issues: Vec<String>,
}

/// The index plus what each document was built from.
#[derive(Default)]
pub struct Engine {
    pub index: DocIndex,
    pub docs: HashMap<String, DocState>,
}

fn prepare(
    root: &Path,
    sources: &[DocSource],
    threads: usize,
) -> Vec<(Extracted, Vec<PreparedUnit>)> {
    let next = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<(Extracted, Vec<PreparedUnit>)>>> =
        sources.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..threads.clamp(1, 64).min(sources.len().max(1)) {
            scope.spawn(|| loop {
                let at = next.fetch_add(1, Ordering::Relaxed);
                let Some(source) = sources.get(at) else { break };
                let mut extracted = extract(root, source);
                let prepared = std::mem::take(&mut extracted.units)
                    .into_iter()
                    .map(PreparedUnit::new)
                    .collect();
                *slots[at].lock().unwrap_or_else(|e| e.into_inner()) = Some((extracted, prepared));
            });
        }
    });
    slots
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .unwrap_or_else(|e| e.into_inner())
                .unwrap_or_else(|| {
                    (
                        Extracted {
                            units: Vec::new(),
                            status: DocStatus::Failed,
                            reason: Some("worker".into()),
                            issues: Vec::new(),
                        },
                        Vec::new(),
                    )
                })
        })
        .collect()
}

impl Engine {
    /// One incremental pass. Returns the number of documents added, changed or removed.
    pub fn refresh(
        lock: &RwLock<Engine>,
        root: &Path,
        threads: usize,
        progress: &dyn Fn(usize, usize),
    ) -> usize {
        let sources = list_sources(root);
        let wanted: HashSet<&str> = sources.iter().map(|source| source.path.as_str()).collect();
        let (gone, changed): (Vec<String>, Vec<DocSource>) = {
            let engine = lock.read().unwrap_or_else(|e| e.into_inner());
            let gone = engine
                .docs
                .keys()
                .filter(|path| !wanted.contains(path.as_str()))
                .cloned()
                .collect();
            let changed = sources
                .iter()
                .filter(|source| {
                    engine
                        .docs
                        .get(&source.path)
                        .is_none_or(|known| known.source != **source)
                })
                .cloned()
                .collect();
            (gone, changed)
        };
        if !gone.is_empty() {
            let mut engine = lock.write().unwrap_or_else(|e| e.into_inner());
            for path in &gone {
                engine.index.remove_doc(path, false);
                engine.docs.remove(path);
            }
        }
        // Batches keep memory bounded and let queries see progress.
        let batch = (threads * 64).max(64);
        let mut done = 0;
        for part in changed.chunks(batch) {
            progress(done, changed.len());
            let prepared = prepare(root, part, threads);
            let mut engine = lock.write().unwrap_or_else(|e| e.into_inner());
            for (source, (extracted, units)) in part.iter().zip(prepared) {
                engine.apply(source.clone(), extracted, units);
            }
            done += part.len();
        }
        progress(done, changed.len());
        gone.len() + changed.len()
    }

    /// `processOne`: old text goes first, the record keeps its place.
    pub fn apply(&mut self, source: DocSource, extracted: Extracted, units: Vec<PreparedUnit>) {
        self.index.remove_doc(&source.path, true);
        self.index.set_doc(&source.path, &source.title);
        for unit in units {
            if unit.unit.path == source.path {
                self.index.add_prepared(unit);
            }
        }
        self.docs.insert(
            source.path.clone(),
            DocState {
                source,
                status: extracted.status,
                reason: extracted.reason,
                issues: extracted.issues,
            },
        );
    }

    /// A fresh index of `root`, documents in UTF-16 path order.
    pub fn build(root: &Path, threads: usize) -> Engine {
        let lock = RwLock::new(Engine::default());
        Engine::refresh(&lock, root, threads, &|_, _| {});
        lock.into_inner().unwrap_or_else(|e| e.into_inner())
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchResult> {
        self.index.search(query, limit)
    }

    pub fn counts(&self) -> Value {
        let mut counts = HashMap::<&str, usize>::new();
        let mut issues = 0;
        for doc in self.docs.values() {
            let key = match doc.status {
                DocStatus::Indexed => "indexed",
                DocStatus::Partial => "partial",
                DocStatus::Unsupported => "unsupported",
                DocStatus::Failed => "failed",
            };
            *counts.entry(key).or_default() += 1;
            issues += doc.issues.len();
        }
        json!({
            "indexed": counts.get("indexed").copied().unwrap_or(0),
            "partial": counts.get("partial").copied().unwrap_or(0),
            "unsupported": counts.get("unsupported").copied().unwrap_or(0),
            "failed": counts.get("failed").copied().unwrap_or(0),
            "units": self.index.unit_count(),
            "ocrPages": 0,
            "issues": issues,
        })
    }

    pub fn problems(&self) -> Vec<Value> {
        let mut list: Vec<&DocState> = self
            .docs
            .values()
            .filter(|doc| {
                matches!(doc.status, DocStatus::Unsupported | DocStatus::Failed)
                    || !doc.issues.is_empty()
            })
            .collect();
        list.sort_by(|a, b| utf16_cmp(&a.source.path, &b.source.path));
        list.into_iter().take(200).map(|doc| json!({ "path": doc.source.path, "title": doc.source.title, "status": doc.status, "reason": doc.reason, "issues": doc.issues })).collect()
    }

    // ---------- cache ----------

    pub fn save(&self, file: &Path, vault: &Path) -> std::io::Result<()> {
        #[derive(Serialize)]
        struct Out<'a> {
            format: &'a str,
            engine: u32,
            vault: String,
            docs: Vec<&'a DocState>,
            units: Vec<&'a IndexUnit>,
        }
        let mut docs: Vec<&DocState> = self
            .index
            .doc_paths()
            .filter_map(|path| self.docs.get(path))
            .collect();
        // Documents without an index record cannot happen; keep the file self-consistent anyway.
        docs.dedup_by(|a, b| a.source.path == b.source.path);
        let body = serde_json::to_vec(&Out {
            format: CACHE_FORMAT,
            engine: ENGINE_VERSION,
            vault: vault.display().to_string(),
            docs,
            units: self.index.units_in_order().collect(),
        })?;
        let digest: String = Sha256::digest(&body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let directory = file
            .parent()
            .ok_or_else(|| std::io::Error::other("cache path"))?;
        std::fs::create_dir_all(directory)?;
        let temporary = directory.join(format!(
            ".{}.{}.tmp",
            file.file_name().and_then(|n| n.to_str()).unwrap_or("index"),
            std::process::id()
        ));
        {
            use std::io::Write;
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .or_else(|_| {
                    let _ = std::fs::remove_file(&temporary);
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temporary)
                })?;
            out.write_all(&body)?;
            out.write_all(b"\n")?;
            out.write_all(digest.as_bytes())?;
            out.sync_all()?;
        }
        std::fs::rename(&temporary, file)?;
        if let Ok(dir) = std::fs::File::open(directory) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    /// The cached index, or an error string saying why it was not usable.
    pub fn load(file: &Path, vault: &Path) -> Result<Engine, String> {
        #[derive(Deserialize)]
        struct In {
            format: String,
            engine: u32,
            vault: String,
            docs: Vec<DocState>,
            units: Vec<IndexUnit>,
        }
        let bytes = std::fs::read(file).map_err(|error| format!("read: {}", error.kind()))?;
        if bytes.len() < 66 || bytes[bytes.len() - 65] != b'\n' {
            return Err("truncated".into());
        }
        let (body, tail) = bytes.split_at(bytes.len() - 65);
        let digest: String = Sha256::digest(body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest.as_bytes() != &tail[1..] {
            return Err("checksum".into());
        }
        let cached: In = serde_json::from_slice(body).map_err(|error| format!("parse: {error}"))?;
        if cached.format != CACHE_FORMAT || cached.engine != ENGINE_VERSION {
            return Err("version".into());
        }
        if cached.vault != vault.display().to_string() {
            return Err("other vault".into());
        }
        let mut engine = Engine::default();
        for doc in cached.docs {
            engine.index.set_doc(&doc.source.path, &doc.source.title);
            engine.docs.insert(doc.source.path.clone(), doc);
        }
        let units: Vec<IndexUnit> = cached
            .units
            .into_iter()
            .filter(|unit| engine.docs.contains_key(&unit.path))
            .collect();
        // Folding is the expensive part; do it in parallel, insert in the stored order.
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(1, 4);
        let size = units.len().div_ceil(threads).max(1);
        let mut parts: Vec<Vec<IndexUnit>> = Vec::new();
        let mut units = units.into_iter().peekable();
        while units.peek().is_some() {
            parts.push(units.by_ref().take(size).collect());
        }
        let prepared: Vec<Vec<PreparedUnit>> = std::thread::scope(|scope| {
            let handles: Vec<_> = parts
                .into_iter()
                .map(|part| {
                    scope.spawn(move || part.into_iter().map(PreparedUnit::new).collect::<Vec<_>>())
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap_or_default())
                .collect()
        });
        for unit in prepared.into_iter().flatten() {
            engine.index.add_prepared(unit);
        }
        Ok(engine)
    }
}

/// `<cache dir>/search-index/<sha256(platform, vault)[0..12]>.json`, never inside the vault.
pub fn cache_file(cache_dir: &Path, vault: &Path) -> Option<PathBuf> {
    let digest =
        Sha256::digest(format!("{}\n{}", std::env::consts::OS, vault.display()).as_bytes());
    let key: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
    let file = cache_dir.join("search-index").join(format!("{key}.json"));
    let real_cache = std::fs::canonicalize(cache_dir).ok();
    if cache_dir.starts_with(vault) || real_cache.is_some_and(|real| real.starts_with(vault)) {
        return None;
    }
    Some(file)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Loading,
    Scanning,
    Indexing,
    Idle,
    Error,
}

#[derive(Default)]
struct Signal {
    dirty: bool,
    rebuild: bool,
    stop: bool,
    first_event: Option<Instant>,
    last_event: Option<Instant>,
}

struct Shared {
    root: PathBuf,
    cache: Option<PathBuf>,
    threads: usize,
    engine: RwLock<Engine>,
    progress: Mutex<(State, usize, usize, Option<String>, &'static str, u64)>,
    signal: Mutex<Signal>,
    wake: Condvar,
    generation: AtomicU64,
}

impl Shared {
    fn set(&self, state: State, total: usize, pending: usize) {
        let mut progress = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        progress.0 = state;
        progress.1 = total;
        progress.2 = pending;
    }

    fn mark_dirty(&self, rebuild: bool) {
        let mut signal = self.signal.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        signal.dirty = true;
        signal.rebuild |= rebuild;
        signal.first_event.get_or_insert(now);
        signal.last_event = Some(now);
        self.wake.notify_all();
    }
}

/// Paths whose change can change what the index holds.
fn relevant(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut parts = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy());
    let Some(first) = parts.next() else {
        return true;
    };
    if first == ".fanotes" {
        return matches!(
            parts.next().as_deref(),
            Some("page-text") | Some("worksheets")
        );
    }
    !first.starts_with('.')
        && !relative
            .components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}

pub struct Options {
    pub threads: usize,
    pub watch: bool,
}

impl Default for Options {
    fn default() -> Self {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2);
        Self {
            threads: cores.clamp(1, 4),
            watch: true,
        }
    }
}

/// The index of one open vault, kept current in the background.
pub struct IndexService {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
    _watcher: Option<notify::RecommendedWatcher>,
}

impl IndexService {
    pub fn open(vault: &Path, cache_dir: Option<&Path>, options: Options) -> IndexService {
        let root = std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
        let shared = Arc::new(Shared {
            cache: cache_dir.and_then(|dir| cache_file(dir, &root)),
            root,
            threads: options.threads.max(1),
            engine: RwLock::new(Engine::default()),
            progress: Mutex::new((State::Loading, 0, 0, None, "none", 0)),
            signal: Mutex::new(Signal::default()),
            wake: Condvar::new(),
            generation: AtomicU64::new(0),
        });
        let watcher = if options.watch {
            Self::watch(&shared)
        } else {
            None
        };
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("fanotes-index".into())
            .spawn(move || run(&worker_shared))
            .ok();
        IndexService {
            shared,
            worker,
            _watcher: watcher,
        }
    }

    fn watch(shared: &Arc<Shared>) -> Option<notify::RecommendedWatcher> {
        use notify::Watcher;
        let weak = Arc::downgrade(shared);
        let root = shared.root.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Some(shared) = weak.upgrade() else { return };
                match event {
                    Ok(event) if matches!(event.kind, notify::EventKind::Access(_)) => {}
                    Ok(event) if event.need_rescan() => shared.mark_dirty(false),
                    Ok(event) => {
                        if event.paths.iter().any(|path| relevant(&root, path)) {
                            shared.mark_dirty(false);
                        }
                    }
                    Err(_) => shared.mark_dirty(false),
                }
            })
            .ok()?;
        watcher
            .watch(&shared.root, notify::RecursiveMode::Recursive)
            .ok()?;
        Some(watcher)
    }

    pub fn vault(&self) -> &Path {
        &self.shared.root
    }

    /// Something in the vault changed (a save, an import, a sync). Coalesced.
    pub fn notify_changed(&self) {
        self.shared.mark_dirty(false);
    }

    /// Throw the index and its cache away and read everything again.
    pub fn rebuild(&self) {
        self.shared.mark_dirty(true);
    }

    pub fn generation(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }

    pub fn query(&self, query: &str, limit: usize) -> Vec<SearchResult> {
        self.shared
            .engine
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .search(query, limit)
    }

    /// Progress in the shape of the TS `IndexerProgress`, plus engine details.
    pub fn status(&self) -> Value {
        let (state, total, pending, last_error, cache, build_ms) = self
            .shared
            .progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let engine = self.shared.engine.read().unwrap_or_else(|e| e.into_inner());
        let mut status = json!({
            "state": state,
            "total": if total == 0 { engine.docs.len() } else { total },
            "pending": pending,
            "counts": engine.counts(),
            "generation": self.generation(),
            "documents": engine.index.document_count(),
            "cache": cache,
            "buildMs": build_ms,
            "problems": engine.problems(),
        });
        if let Some(error) = last_error {
            status["lastError"] = Value::String(error);
        }
        status
    }

    /// Waits until the index is idle (tests, benchmarks).
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            let state = self
                .shared
                .progress
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .0;
            let dirty = self
                .shared
                .signal
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .dirty;
            if state == State::Idle && !dirty {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

impl Drop for IndexService {
    fn drop(&mut self) {
        {
            let mut signal = self.shared.signal.lock().unwrap_or_else(|e| e.into_inner());
            signal.stop = true;
            self.shared.wake.notify_all();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn save(shared: &Shared) {
    if let Some(file) = &shared.cache {
        let engine = shared.engine.read().unwrap_or_else(|e| e.into_inner());
        if let Err(error) = engine.save(file, &shared.root) {
            shared.progress.lock().unwrap_or_else(|e| e.into_inner()).3 = Some(format!(
                "Suchindex-Cache nicht gespeichert: {}",
                error.kind()
            ));
        }
    }
}

fn pass(shared: &Shared) {
    shared.set(State::Scanning, 0, 0);
    let started = Instant::now();
    let changed = Engine::refresh(
        &shared.engine,
        &shared.root,
        shared.threads,
        &|done, total| shared.set(State::Indexing, total, total - done),
    );
    if changed > 0 {
        shared.generation.fetch_add(1, Ordering::AcqRel);
    }
    let mut progress = shared.progress.lock().unwrap_or_else(|e| e.into_inner());
    progress.5 = started.elapsed().as_millis() as u64;
    if !shared.root.is_dir() {
        progress.3 = Some("Vault konnte nicht gelesen werden.".into());
    }
}

fn run(shared: &Shared) {
    shared.set(State::Loading, 0, 0);
    if let Some(file) = &shared.cache {
        match Engine::load(file, &shared.root) {
            Ok(engine) => {
                *shared.engine.write().unwrap_or_else(|e| e.into_inner()) = engine;
                shared.progress.lock().unwrap_or_else(|e| e.into_inner()).4 = "loaded";
                shared.generation.fetch_add(1, Ordering::AcqRel);
            }
            Err(reason) => {
                // Corrupt, stale or missing: start over. Never fatal.
                if file.exists() {
                    let _ = std::fs::remove_file(file);
                    shared.progress.lock().unwrap_or_else(|e| e.into_inner()).4 = "rebuilt";
                    let _ = reason;
                }
            }
        }
    }
    pass(shared);
    save(shared);
    shared.set(State::Idle, 0, 0);
    let mut unsaved_since: Option<Instant> = None;
    loop {
        let rebuild;
        {
            let mut signal = shared.signal.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if signal.stop {
                    drop(signal);
                    if unsaved_since.is_some() {
                        save(shared);
                    }
                    return;
                }
                if signal.dirty {
                    let now = Instant::now();
                    let quiet = signal.last_event.is_none_or(|at| now - at >= DEBOUNCE);
                    let waited = signal.first_event.is_none_or(|at| now - at >= MAX_DEBOUNCE);
                    if quiet || waited {
                        break;
                    }
                    signal = shared
                        .wake
                        .wait_timeout(signal, DEBOUNCE)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                    continue;
                }
                let timeout = match unsaved_since {
                    Some(at) => SAVE_AFTER.saturating_sub(at.elapsed()),
                    None => Duration::from_secs(3600),
                };
                if unsaved_since.is_some() && timeout.is_zero() {
                    drop(signal);
                    save(shared);
                    unsaved_since = None;
                    signal = shared.signal.lock().unwrap_or_else(|e| e.into_inner());
                    continue;
                }
                signal = shared
                    .wake
                    .wait_timeout(signal, timeout.max(Duration::from_millis(1)))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            rebuild = signal.rebuild;
            signal.dirty = false;
            signal.rebuild = false;
            signal.first_event = None;
            signal.last_event = None;
        }
        if rebuild {
            if let Some(file) = &shared.cache {
                let _ = std::fs::remove_file(file);
            }
            shared
                .engine
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .clear_all();
            shared.generation.fetch_add(1, Ordering::AcqRel);
        }
        let before = shared.generation.load(Ordering::Acquire);
        pass(shared);
        if shared.generation.load(Ordering::Acquire) != before || rebuild {
            unsaved_since.get_or_insert_with(Instant::now);
        }
        shared.set(State::Idle, 0, 0);
    }
}

impl Engine {
    fn clear_all(&mut self) {
        self.index.clear();
        self.docs.clear();
    }

    /// The sources this engine was built from, in path order (tests).
    pub fn sources(&self) -> Vec<DocSource> {
        let mut list: Vec<DocSource> = self.docs.values().map(|doc| doc.source.clone()).collect();
        sort_paths(&mut list);
        list
    }
}
