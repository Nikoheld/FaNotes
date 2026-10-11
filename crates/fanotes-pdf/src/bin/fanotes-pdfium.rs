//! `fanotes-pdfium`: PDFium sidecar for the Electron host.
//!
//! `fanotes/electron/pdfium.cjs` starts it on the first PDF paint. Frames are
//! the same layout as `fanotes-ort`: u32 LE header length, JSON, u32 LE payload
//! length, payload. The process exits when stdin closes. PDFium is loaded on
//! the first `render`, not at process start.

use std::collections::{HashMap, VecDeque};
use std::io::{self, BufReader, BufWriter, Write};
use std::process::ExitCode;

use fanotes_pdf::{read_frame, render_pdf_page, write_frame, Error, RenderRequest, MAX_PDF_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_DOCS: usize = 4;
const MAX_CACHED_BYTES: usize = 80 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestHeader {
    id: u64,
    op: String,
    key: String,
    #[serde(default)]
    page_index: i32,
    #[serde(default)]
    pixel_width: i32,
    #[serde(default)]
    pixel_height: i32,
    #[serde(default)]
    page_pixel_width: i32,
    #[serde(default)]
    page_pixel_height: i32,
    #[serde(default)]
    origin_x: i32,
    #[serde(default)]
    origin_y: i32,
    #[serde(default)]
    rotation: i32,
    #[serde(default)]
    password: String,
}

struct Docs {
    order: VecDeque<String>,
    bytes: HashMap<String, Vec<u8>>,
    total: usize,
}

impl Docs {
    fn new() -> Self {
        Self {
            order: VecDeque::new(),
            bytes: HashMap::new(),
            total: 0,
        }
    }

    fn insert(&mut self, key: String, bytes: Vec<u8>) -> Result<(), Error> {
        if bytes.is_empty() || bytes.len() > MAX_PDF_BYTES {
            return Err(Error::Open(
                "Die PDF-Datei ist leer oder zu groß.".to_owned(),
            ));
        }
        if let Some(previous) = self.bytes.remove(&key) {
            self.total -= previous.len();
            self.order.retain(|item| item != &key);
        }
        self.total += bytes.len();
        self.order.push_back(key.clone());
        self.bytes.insert(key, bytes);
        while self.order.len() > 1 && (self.bytes.len() > MAX_DOCS || self.total > MAX_CACHED_BYTES)
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(dropped) = self.bytes.remove(&oldest) {
                self.total -= dropped.len();
            }
        }
        Ok(())
    }
}

fn reply(id: u64, result: Result<Option<fanotes_pdf::PageBitmap>, Error>) -> (Value, Vec<u8>) {
    match result {
        Ok(Some(bitmap)) => (
            json!({
                "id": id,
                "ok": true,
                "width": bitmap.width,
                "height": bitmap.height,
            }),
            bitmap.rgba,
        ),
        Ok(None) => (json!({ "id": id, "ok": true }), Vec::new()),
        Err(error) => (
            json!({
                "id": id,
                "ok": false,
                "error": error.to_string(),
            }),
            Vec::new(),
        ),
    }
}

fn handle(docs: &mut Docs, header: RequestHeader, payload: Vec<u8>) -> (Value, Vec<u8>) {
    if header.key.is_empty() || header.key.len() > 4096 {
        return reply(header.id, Err(Error::Request));
    }
    let result = match header.op.as_str() {
        "open" => docs.insert(header.key, payload).map(|()| None),
        "close" => {
            if let Some(bytes) = docs.bytes.remove(&header.key) {
                docs.total -= bytes.len();
                docs.order.retain(|item| item != &header.key);
            }
            Ok(None)
        }
        "render" => {
            let Some(bytes) = docs.bytes.get(&header.key) else {
                return reply(
                    header.id,
                    Err(Error::Open("Das PDF ist nicht geöffnet.".to_owned())),
                );
            };
            let request = RenderRequest {
                page_index: header.page_index,
                pixel_width: header.pixel_width,
                pixel_height: header.pixel_height,
                page_pixel_width: header.page_pixel_width,
                page_pixel_height: header.page_pixel_height,
                origin_x: header.origin_x,
                origin_y: header.origin_y,
                rotation: header.rotation,
                password: header.password,
            };
            render_pdf_page(bytes, &request).map(Some)
        }
        _ => Err(Error::Request),
    };
    reply(header.id, result)
}

fn main() -> ExitCode {
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    let mut docs = Docs::new();
    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => return ExitCode::SUCCESS,
            Err(error) => {
                let _ = writeln!(io::stderr(), "fanotes-pdfium: {error}");
                return ExitCode::from(1);
            }
        };
        let header: RequestHeader = match serde_json::from_slice(&frame.header) {
            Ok(header) => header,
            Err(_) => {
                let header = serde_json::to_vec(&json!({
                    "id": 0,
                    "ok": false,
                    "error": "Die PDF-Rasteranfrage ist unvollständig.",
                }))
                .unwrap_or_else(|_| b"{}".to_vec());
                let _ = write_frame(&mut output, &header, b"");
                continue;
            }
        };
        let id = header.id;
        let (json_header, payload) = handle(&mut docs, header, frame.payload);
        let encoded = match serde_json::to_vec(&json_header) {
            Ok(encoded) => encoded,
            Err(_) => {
                let header = serde_json::to_vec(&json!({
                    "id": id,
                    "ok": false,
                    "error": "Die PDF-Antwort konnte nicht geschrieben werden.",
                }))
                .unwrap_or_else(|_| b"{}".to_vec());
                let _ = write_frame(&mut output, &header, b"");
                continue;
            }
        };
        if write_frame(&mut output, &encoded, &payload).is_err() {
            return ExitCode::from(1);
        }
    }
}
