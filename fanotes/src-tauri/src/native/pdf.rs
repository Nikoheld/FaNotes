//! `fanotes-native:pdf-*`: PDFium page rasters for the webview (WP8).
//!
//! The renderer reaches these through the optional `FaNotesApi.pdfNative`
//! capability and uses them only behind the desktop flag
//! (`localStorage['fanotes.native-pdf'] = '1'` or `VITE_FANOTES_NATIVE_PDF=1`).
//! pdf.js keeps the text layer, selection, camera and ink; these commands
//! only fill the page canvases the painter already planned.
//!
//! All PDFium work runs on one `fanotes_pdf::service` worker thread. The
//! commands are async, so neither the UI thread nor the host lock waits for
//! a paint. A render answers with raw RGBA bytes (an `ArrayBuffer` in the
//! webview), not base64 JSON.

use std::sync::OnceLock;

use fanotes_pdf::service::PdfService;
use fanotes_pdf::RenderRequest;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

use crate::HostState;

fn service(app: &AppHandle) -> &'static PdfService {
    static SERVICE: OnceLock<PdfService> = OnceLock::new();
    SERVICE.get_or_init(|| {
        // A bundle ships the pinned library as the `pdfium/` resource.
        if let Ok(dir) = app.path().resource_dir() {
            fanotes_pdf::add_library_dir(dir.join("pdfium"));
        }
        PdfService::start()
    })
}

async fn wait<T: Send + 'static>(
    submit: impl FnOnce(fanotes_pdf::service::Reply<T>),
) -> Result<T, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    submit(Box::new(move |result| {
        let _ = sender.blocking_send(result);
    }));
    match receiver.recv().await {
        Some(result) => result.map_err(|error| error.to_string()),
        None => Err(fanotes_pdf::Error::Cancelled.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    path: String,
    #[serde(default)]
    password: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRequest {
    doc: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderWindow {
    doc: u64,
    page_index: i32,
    pixel_width: i32,
    pixel_height: i32,
    page_pixel_width: i32,
    page_pixel_height: i32,
    origin_x: i32,
    origin_y: i32,
    #[serde(default)]
    rotation: i32,
    #[serde(default)]
    slot: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    #[serde(default)]
    slot: Option<String>,
    #[serde(default)]
    doc: Option<u64>,
}

fn checked_slot(slot: Option<String>) -> Result<Option<String>, String> {
    match slot {
        Some(slot) if slot.is_empty() || slot.len() > 256 => {
            Err(fanotes_pdf::Error::Request.to_string())
        }
        other => Ok(other),
    }
}

/// Open (or reuse) a vault PDF: `{ doc, pageCount, reused }`.
#[tauri::command(rename = "fanotes-native:pdf-open")]
pub async fn pdf_open(
    app: AppHandle,
    state: State<'_, HostState>,
    request: OpenRequest,
) -> Result<Value, String> {
    if request.path.is_empty() || request.path.len() > 4096 {
        return Err(fanotes_pdf::Error::Request.to_string());
    }
    let file = state
        .0
        .lock()
        .map_err(|_| "Der Host ist belegt.".to_owned())?
        .resolve_vault_pdf(&request.path)?;
    // Same limit as the desktop: `password.slice(0, 1024)`; a non-string is none.
    let password = match request.password {
        Some(Value::String(text)) => {
            String::from_utf16_lossy(&text.encode_utf16().take(1024).collect::<Vec<u16>>())
        }
        _ => String::new(),
    };
    let pdf = service(&app);
    let info = wait(|reply| pdf.open(file, password, reply)).await?;
    Ok(json!({ "doc": info.doc, "pageCount": info.page_count, "reused": info.reused }))
}

/// Page boxes in PDF points: `[[width, height], ...]`.
#[tauri::command(rename = "fanotes-native:pdf-page-sizes")]
pub async fn pdf_page_sizes(app: AppHandle, request: DocRequest) -> Result<Value, String> {
    let pdf = service(&app);
    let sizes = wait(|reply| pdf.page_sizes(request.doc, reply)).await?;
    Ok(Value::from(
        sizes
            .into_iter()
            .map(|(width, height)| json!([width, height]))
            .collect::<Vec<_>>(),
    ))
}

/// One camera window as tightly packed RGBA (`pixelWidth × pixelHeight × 4`).
#[tauri::command(rename = "fanotes-native:pdf-render")]
pub async fn pdf_render(app: AppHandle, request: RenderWindow) -> Result<Response, String> {
    let slot = checked_slot(request.slot)?;
    let job = RenderRequest {
        page_index: request.page_index,
        pixel_width: request.pixel_width,
        pixel_height: request.pixel_height,
        page_pixel_width: request.page_pixel_width,
        page_pixel_height: request.page_pixel_height,
        origin_x: request.origin_x,
        origin_y: request.origin_y,
        rotation: request.rotation,
        password: String::new(),
    };
    let pdf = service(&app);
    let bitmap = wait(|reply| pdf.render(request.doc, job, slot, reply)).await?;
    Ok(Response::new(bitmap.rgba.clone()))
}

/// Drop queued windows for a painter layer (`slot`) or a whole document.
#[tauri::command(rename = "fanotes-native:pdf-cancel")]
pub fn pdf_cancel(app: AppHandle, request: CancelRequest) -> Result<usize, String> {
    let pdf = service(&app);
    let mut dropped = 0;
    if let Some(slot) = checked_slot(request.slot)? {
        dropped += pdf.cancel_slot(&slot);
    }
    if let Some(doc) = request.doc {
        dropped += pdf.cancel_doc(doc);
    }
    Ok(dropped)
}

/// Forget a document and its cached windows.
#[tauri::command(rename = "fanotes-native:pdf-close")]
pub fn pdf_close(app: AppHandle, request: DocRequest) {
    service(&app).close(request.doc);
}
