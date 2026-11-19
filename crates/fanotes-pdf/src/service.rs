//! PDFium page rasters for an in-process desktop host (the Tauri shell).
//!
//! One worker thread owns PDFium and every open document. Callers submit
//! jobs and get the result through a callback, so a webview command never
//! blocks the UI thread and never holds a host lock while PDFium paints.
//!
//! Fast scrolling asks for many windows that are stale a moment later. Each
//! render may name a `slot` (one painter layer). A newer render for the same
//! slot cancels the older one while it is still queued; one that is already
//! painting finishes into the raster cache, but its pixels are not sent.
//! `cancel_slot` / `cancel_doc` drop queued work when a page leaves the view.
//!
//! Caches: up to [`MAX_DOCS`] parsed documents (keyed by path, size, mtime and
//! password, so a scroll never re-reads or re-parses the file) and an LRU of
//! finished windows up to [`RASTER_CACHE_BYTES`], so scrolling back is free.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::SystemTime;

use crate::{open_pdf, read_pdf_file, render_opened, Error, OpenedPdf, PageBitmap, RenderRequest};

pub const MAX_DOCS: usize = 6;
pub const MAX_DOC_BYTES: usize = 256 * 1024 * 1024;
pub const RASTER_CACHE_BYTES: usize = 64 * 1024 * 1024;

pub type Reply<T> = Box<dyn FnOnce(Result<T, Error>) + Send + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocInfo {
    pub doc: u64,
    pub page_count: i32,
    /// The same file was already open; nothing was read or parsed.
    pub reused: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ServiceStats {
    pub opened: u64,
    pub rendered: u64,
    pub cache_hits: u64,
    pub cancelled: u64,
}

enum Work {
    Open {
        path: PathBuf,
        password: String,
        reply: Reply<DocInfo>,
    },
    PageSizes {
        doc: u64,
        reply: Reply<Vec<(f32, f32)>>,
    },
    Render {
        doc: u64,
        request: RenderRequest,
        reply: Reply<Arc<PageBitmap>>,
    },
    Close {
        doc: u64,
    },
}

impl Work {
    fn cancel(self) {
        match self {
            Work::Open { reply, .. } => reply(Err(Error::Cancelled)),
            Work::PageSizes { reply, .. } => reply(Err(Error::Cancelled)),
            Work::Render { reply, .. } => reply(Err(Error::Cancelled)),
            Work::Close { .. } => {}
        }
    }

    fn doc(&self) -> Option<u64> {
        match self {
            Work::PageSizes { doc, .. } | Work::Render { doc, .. } | Work::Close { doc } => {
                Some(*doc)
            }
            Work::Open { .. } => None,
        }
    }
}

struct Job {
    ticket: u64,
    slot: Option<String>,
    work: Work,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    /// The newest render ticket per slot. A finished render whose ticket is
    /// no longer here was superseded or cancelled while it painted.
    latest: HashMap<String, u64>,
    next_ticket: u64,
    stats: ServiceStats,
    shutdown: bool,
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

pub struct PdfService {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl Default for PdfService {
    fn default() -> Self {
        Self::start()
    }
}

impl PdfService {
    /// Starts the worker. PDFium itself loads on the first open.
    pub fn start() -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("fanotes-pdfium".to_owned())
            .spawn(move || Worker::new(worker_shared).run())
            .expect("spawn the PDFium worker");
        Self {
            shared,
            worker: Some(worker),
        }
    }

    fn submit(&self, slot: Option<String>, work: Work) {
        let mut superseded = Vec::new();
        {
            let mut state = self.shared.lock();
            if state.shutdown {
                drop(state);
                work.cancel();
                return;
            }
            state.next_ticket += 1;
            let ticket = state.next_ticket;
            if let Some(slot) = &slot {
                state.latest.insert(slot.clone(), ticket);
                let mut index = 0;
                while index < state.queue.len() {
                    if state.queue[index].slot.as_deref() == Some(slot.as_str()) {
                        if let Some(job) = state.queue.remove(index) {
                            superseded.push(job);
                        }
                    } else {
                        index += 1;
                    }
                }
                state.stats.cancelled += superseded.len() as u64;
            }
            state.queue.push_back(Job { ticket, slot, work });
        }
        self.shared.wake.notify_one();
        for job in superseded {
            job.work.cancel();
        }
    }

    /// Open (or reuse) a confined vault PDF. The worker reads the file.
    pub fn open(&self, path: PathBuf, password: String, reply: Reply<DocInfo>) {
        self.submit(
            None,
            Work::Open {
                path,
                password,
                reply,
            },
        );
    }

    pub fn page_sizes(&self, doc: u64, reply: Reply<Vec<(f32, f32)>>) {
        self.submit(None, Work::PageSizes { doc, reply });
    }

    /// Paint one window; `slot` names the painter layer it is for.
    pub fn render(
        &self,
        doc: u64,
        request: RenderRequest,
        slot: Option<String>,
        reply: Reply<Arc<PageBitmap>>,
    ) {
        self.submit(
            slot,
            Work::Render {
                doc,
                request,
                reply,
            },
        );
    }

    /// Drop queued renders for `slot`; one already painting is not sent.
    pub fn cancel_slot(&self, slot: &str) -> usize {
        self.cancel_where(
            |job| job.slot.as_deref() == Some(slot),
            |state| {
                state.latest.remove(slot);
            },
        )
    }

    /// Drop queued work for `doc` (the view closed).
    pub fn cancel_doc(&self, doc: u64) -> usize {
        self.cancel_where(
            |job| job.work.doc() == Some(doc) && !matches!(job.work, Work::Close { .. }),
            |state| {
                let slots: Vec<String> = state
                    .queue
                    .iter()
                    .filter(|job| job.work.doc() == Some(doc))
                    .filter_map(|job| job.slot.clone())
                    .collect();
                for slot in slots {
                    state.latest.remove(&slot);
                }
            },
        )
    }

    fn cancel_where(
        &self,
        matches: impl Fn(&Job) -> bool,
        before: impl FnOnce(&mut State),
    ) -> usize {
        let mut dropped = Vec::new();
        {
            let mut state = self.shared.lock();
            before(&mut state);
            let mut index = 0;
            while index < state.queue.len() {
                if matches(&state.queue[index]) {
                    if let Some(job) = state.queue.remove(index) {
                        dropped.push(job);
                    }
                } else {
                    index += 1;
                }
            }
            state.stats.cancelled += dropped.len() as u64;
        }
        let count = dropped.len();
        for job in dropped {
            job.work.cancel();
        }
        count
    }

    /// Forget a document and its cached windows.
    pub fn close(&self, doc: u64) {
        self.cancel_doc(doc);
        self.submit(None, Work::Close { doc });
    }

    pub fn stats(&self) -> ServiceStats {
        self.shared.lock().stats
    }

    pub fn open_blocking(&self, path: PathBuf, password: &str) -> Result<DocInfo, Error> {
        let (sender, receiver) = mpsc::channel();
        self.open(
            path,
            password.to_owned(),
            Box::new(move |result| {
                let _ = sender.send(result);
            }),
        );
        receiver.recv().unwrap_or(Err(Error::Cancelled))
    }

    pub fn page_sizes_blocking(&self, doc: u64) -> Result<Vec<(f32, f32)>, Error> {
        let (sender, receiver) = mpsc::channel();
        self.page_sizes(
            doc,
            Box::new(move |result| {
                let _ = sender.send(result);
            }),
        );
        receiver.recv().unwrap_or(Err(Error::Cancelled))
    }

    pub fn render_blocking(
        &self,
        doc: u64,
        request: RenderRequest,
        slot: Option<String>,
    ) -> Result<Arc<PageBitmap>, Error> {
        let (sender, receiver) = mpsc::channel();
        self.render(
            doc,
            request,
            slot,
            Box::new(move |result| {
                let _ = sender.send(result);
            }),
        );
        receiver.recv().unwrap_or(Err(Error::Cancelled))
    }
}

impl Drop for PdfService {
    fn drop(&mut self) {
        let pending: Vec<Job> = {
            let mut state = self.shared.lock();
            state.shutdown = true;
            state.queue.drain(..).collect()
        };
        self.shared.wake.notify_all();
        for job in pending {
            job.work.cancel();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct FileKey {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    password: String,
}

struct OpenDoc {
    key: FileKey,
    opened: OpenedPdf,
    bytes: usize,
    page_count: i32,
    used: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct RasterKey {
    doc: u64,
    page_index: i32,
    pixel_width: i32,
    pixel_height: i32,
    page_pixel_width: i32,
    page_pixel_height: i32,
    origin_x: i32,
    origin_y: i32,
    rotation: i32,
}

impl RasterKey {
    fn of(doc: u64, request: &RenderRequest) -> Self {
        Self {
            doc,
            page_index: request.page_index,
            pixel_width: request.pixel_width,
            pixel_height: request.pixel_height,
            page_pixel_width: request.page_pixel_width,
            page_pixel_height: request.page_pixel_height,
            origin_x: request.origin_x,
            origin_y: request.origin_y,
            rotation: request.rotation.rem_euclid(360),
        }
    }
}

struct Worker {
    shared: Arc<Shared>,
    docs: HashMap<u64, OpenDoc>,
    next_doc: u64,
    rasters: HashMap<RasterKey, (Arc<PageBitmap>, u64)>,
    raster_bytes: usize,
    clock: u64,
}

impl Worker {
    fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            docs: HashMap::new(),
            next_doc: 1,
            rasters: HashMap::new(),
            raster_bytes: 0,
            clock: 0,
        }
    }

    fn run(mut self) {
        loop {
            let job = {
                let mut state = self.shared.lock();
                loop {
                    if state.shutdown {
                        return;
                    }
                    if let Some(job) = state.queue.pop_front() {
                        break job;
                    }
                    state = self
                        .shared
                        .wake
                        .wait(state)
                        .unwrap_or_else(|error| error.into_inner());
                }
            };
            self.clock += 1;
            match job.work {
                Work::Open {
                    path,
                    password,
                    reply,
                } => reply(self.open(path, password)),
                Work::PageSizes { doc, reply } => reply(match self.docs.get(&doc) {
                    Some(open) => open.opened.page_sizes(),
                    None => Err(Error::NotOpen),
                }),
                Work::Render {
                    doc,
                    request,
                    reply,
                } => {
                    let result = self.render(doc, &request);
                    let current = {
                        let mut state = self.shared.lock();
                        let current = match &job.slot {
                            Some(slot) if state.latest.get(slot) == Some(&job.ticket) => {
                                state.latest.remove(slot);
                                true
                            }
                            Some(_) => false,
                            None => true,
                        };
                        if !current {
                            state.stats.cancelled += 1;
                        }
                        current
                    };
                    reply(if current {
                        result
                    } else {
                        Err(Error::Cancelled)
                    });
                }
                Work::Close { doc } => self.forget(doc),
            }
        }
    }

    fn open(&mut self, path: PathBuf, password: String) -> Result<DocInfo, Error> {
        let meta =
            std::fs::symlink_metadata(&path).map_err(|error| Error::Read(error.to_string()))?;
        let key = FileKey {
            path,
            len: meta.len(),
            modified: meta.modified().ok(),
            password,
        };
        let clock = self.clock;
        if let Some((&doc, open)) = self.docs.iter_mut().find(|(_, open)| open.key == key) {
            open.used = clock;
            return Ok(DocInfo {
                doc,
                page_count: open.page_count,
                reused: true,
            });
        }
        let bytes = read_pdf_file(&key.path)?;
        let size = bytes.len();
        let opened = open_pdf(bytes, &key.password)?;
        let page_count = opened.page_count();
        let doc = self.next_doc;
        self.next_doc += 1;
        self.docs.insert(
            doc,
            OpenDoc {
                key,
                opened,
                bytes: size,
                page_count,
                used: clock,
            },
        );
        self.shared.lock().stats.opened += 1;
        self.evict_docs(doc);
        Ok(DocInfo {
            doc,
            page_count,
            reused: false,
        })
    }

    fn evict_docs(&mut self, keep: u64) {
        loop {
            let total: usize = self.docs.values().map(|open| open.bytes).sum();
            if self.docs.len() <= MAX_DOCS && total <= MAX_DOC_BYTES {
                return;
            }
            let Some(oldest) = self
                .docs
                .iter()
                .filter(|(&doc, _)| doc != keep)
                .min_by_key(|(_, open)| open.used)
                .map(|(&doc, _)| doc)
            else {
                return;
            };
            self.forget(oldest);
        }
    }

    fn forget(&mut self, doc: u64) {
        self.docs.remove(&doc);
        let before = self.rasters.len();
        self.rasters.retain(|key, _| key.doc != doc);
        if self.rasters.len() != before {
            self.raster_bytes = self
                .rasters
                .values()
                .map(|(bitmap, _)| bitmap.rgba.len())
                .sum();
        }
    }

    fn render(&mut self, doc: u64, request: &RenderRequest) -> Result<Arc<PageBitmap>, Error> {
        let clock = self.clock;
        let Some(open) = self.docs.get_mut(&doc) else {
            return Err(Error::NotOpen);
        };
        open.used = clock;
        let key = RasterKey::of(doc, request);
        if let Some((bitmap, used)) = self.rasters.get_mut(&key) {
            *used = clock;
            self.shared.lock().stats.cache_hits += 1;
            return Ok(Arc::clone(bitmap));
        }
        let bitmap = Arc::new(render_opened(&open.opened, request)?);
        self.shared.lock().stats.rendered += 1;
        let size = bitmap.rgba.len();
        if size <= RASTER_CACHE_BYTES / 2 {
            self.raster_bytes += size;
            self.rasters.insert(key, (Arc::clone(&bitmap), clock));
            while self.raster_bytes > RASTER_CACHE_BYTES {
                let Some(oldest) = self
                    .rasters
                    .iter()
                    .min_by_key(|(_, (_, used))| *used)
                    .map(|(key, _)| *key)
                else {
                    break;
                };
                if let Some((dropped, _)) = self.rasters.remove(&oldest) {
                    self.raster_bytes -= dropped.rgba.len();
                }
            }
        }
        Ok(bitmap)
    }
}
