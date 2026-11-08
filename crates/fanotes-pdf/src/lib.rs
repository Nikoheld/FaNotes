//! PDFium page rasters for the paper camera.
//!
//! A window paints only its own pixels, at every viewer rotation: PDFium turns
//! the page itself on top of the page's own `/Rotate`.
//! pdf.js keeps the selectable text layer; this crate only supplies pixels.

mod protocol;

use std::sync::{Mutex, OnceLock};

use base64::Engine;
use pdfium_bundled::pdfium_render::prelude::{
    PdfBitmap, PdfBitmapFormat, PdfColor, PdfDocument, PdfPageRenderRotation, PdfRenderConfig,
    Pdfium,
};
use serde::Deserialize;
use serde_json::Value;

pub use protocol::{read_frame, write_frame, Frame};

/// Same caps as `pdfDocument.ts`: a page edge and the pixel budget.
pub const MAX_EDGE: i32 = 16_384;
pub const MAX_PIXELS: i64 = 48_000_000;
pub const MAX_PDF_BYTES: usize = 96 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("PDFium ist nicht verfügbar: {0}")]
    Bind(String),
    #[error("Die PDF-Datei konnte nicht geöffnet werden: {0}")]
    Open(String),
    #[error("Die PDF-Seite liegt außerhalb des Dokuments.")]
    Page,
    #[error("Die PDF-Rastergröße ist ungültig.")]
    Size,
    #[error("Die PDF-Drehung ist ungültig.")]
    Rotation,
    #[error("Die PDF-Seite konnte nicht gerastert werden: {0}")]
    Render(String),
    #[error("Die PDF-Rasteranfrage ist unvollständig.")]
    Request,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub page_index: i32,
    pub pixel_width: i32,
    pub pixel_height: i32,
    pub page_pixel_width: i32,
    pub page_pixel_height: i32,
    pub origin_x: i32,
    pub origin_y: i32,
    #[serde(default)]
    pub rotation: i32,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone)]
pub struct PageBitmap {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl PageBitmap {
    pub fn rgba_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(&self.rgba)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultRenderRequest {
    path: String,
    #[serde(flatten)]
    job: RenderRequest,
}

pub fn parse_vault_request(value: &Value) -> Result<(String, RenderRequest), Error> {
    let mut value = value.clone();
    {
        let Some(object) = value.as_object_mut() else {
            return Err(Error::Request);
        };
        for key in [
            "pageIndex",
            "pixelWidth",
            "pixelHeight",
            "pagePixelWidth",
            "pagePixelHeight",
            "originX",
            "originY",
            "rotation",
        ] {
            // `Number.isSafeInteger` keeps a whole number such as `16.0`.
            let Some(number) = object.get(key).and_then(json_safe_i32) else {
                return Err(Error::Request);
            };
            object.insert(key.to_owned(), Value::from(number));
        }
        // A non-string password is ignored, the same way the desktop does.
        if object
            .get("password")
            .is_some_and(|password| !password.is_string())
        {
            object.insert("password".to_owned(), Value::String(String::new()));
        }
    }
    let parsed: VaultRenderRequest = serde_json::from_value(value).map_err(|_| Error::Request)?;
    Ok((parsed.path, parsed.job))
}

/// A parsed document. The sidecar keeps one of these per open file so a large
/// PDF is not read and parsed again on every scroll.
pub struct OpenedPdf {
    document: PdfDocument<'static>,
}

/// Parse `bytes` once. The document keeps the buffer.
pub fn open_pdf(bytes: Vec<u8>, password: &str) -> Result<OpenedPdf, Error> {
    if bytes.is_empty() || bytes.len() > MAX_PDF_BYTES {
        return Err(Error::Open(
            "Die PDF-Datei ist leer oder zu groß.".to_owned(),
        ));
    }
    let _render = RENDER.lock().unwrap_or_else(|error| error.into_inner());
    let pdfium = library()?;
    let password = truncate_utf16(password, 1024);
    let password = if password.is_empty() {
        None
    } else {
        Some(password.as_str())
    };
    let document = pdfium
        .load_pdf_from_byte_vec(bytes, password)
        .map_err(|error| Error::Open(error.to_string()))?;
    Ok(OpenedPdf { document })
}

/// Rasterize one page of an already open document.
pub fn render_opened(opened: &OpenedPdf, request: &RenderRequest) -> Result<PageBitmap, Error> {
    validate_request(request)?;
    let _render = RENDER.lock().unwrap_or_else(|error| error.into_inner());
    render_document(&opened.document, request)
}

/// Rasterize one page to `request`'s bitmap size: the window at `origin` in a
/// page that is `page_pixel_*` large once turned. Pixels outside the page are white.
pub fn render_pdf_page(pdf: &[u8], request: &RenderRequest) -> Result<PageBitmap, Error> {
    validate_request(request)?;
    if pdf.is_empty() || pdf.len() > MAX_PDF_BYTES {
        return Err(Error::Open(
            "Die PDF-Datei ist leer oder zu groß.".to_owned(),
        ));
    }
    let _render = RENDER.lock().unwrap_or_else(|error| error.into_inner());
    let pdfium = library()?;
    let password = truncate_utf16(&request.password, 1024);
    let password = if password.is_empty() {
        None
    } else {
        Some(password.as_str())
    };
    let document = pdfium
        .load_pdf_from_byte_slice(pdf, password)
        .map_err(|error| Error::Open(error.to_string()))?;
    render_document(&document, request)
}

/// The window is drawn straight into a bitmap of its own size, at every turn.
/// Painting the whole page first, turning it in software, and copying the
/// window out held up to three page-sized buffers per paint.
fn render_document(
    document: &PdfDocument<'_>,
    request: &RenderRequest,
) -> Result<PageBitmap, Error> {
    let pages = document.pages();
    if request.page_index < 0 || request.page_index >= pages.len() {
        return Err(Error::Page);
    }
    let page = pages
        .get(request.page_index)
        .map_err(|error| Error::Render(error.to_string()))?;
    let rotation = match normalized_rotation(request.rotation)? {
        90 => Some(PdfPageRenderRotation::Degrees90),
        180 => Some(PdfPageRenderRotation::Degrees180),
        270 => Some(PdfPageRenderRotation::Degrees270),
        _ => None,
    };
    let bytes = checked_pixels(request.pixel_width, request.pixel_height)?
        .checked_mul(4)
        .ok_or(Error::Size)?;
    // White first, so a window past the page edge stays paper.
    let mut rgba = vec![255u8; bytes];
    {
        let mut bitmap = PdfBitmap::from_bytes(
            request.pixel_width,
            request.pixel_height,
            PdfBitmapFormat::BGRA,
            &mut rgba,
        )
        .map_err(|error| Error::Render(error.to_string()))?;
        let mut config = PdfRenderConfig::new()
            .set_fixed_size(request.page_pixel_width, request.page_pixel_height)
            .set_origin(
                request.origin_x.saturating_neg(),
                request.origin_y.saturating_neg(),
            )
            .set_clear_color(PdfColor::WHITE)
            .set_reverse_byte_order(true);
        if let Some(rotation) = rotation {
            config = config.rotate(rotation, false);
        }
        page.render_into_bitmap_with_config(&mut bitmap, &config)
            .map_err(|error| Error::Render(error.to_string()))?;
    }
    for pixel in rgba.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    Ok(PageBitmap {
        width: request.pixel_width as u32,
        height: request.pixel_height as u32,
        rgba,
    })
}

/// `Number.isSafeInteger` for a geometry field, including `16.0` and `-1.0`.
fn json_safe_i32(value: &Value) -> Option<i32> {
    let number = value.as_f64()?;
    if number.is_finite()
        && number.fract() == 0.0
        && (i32::MIN as f64..=i32::MAX as f64).contains(&number)
    {
        Some(number as i32)
    } else {
        None
    }
}

fn validate_request(request: &RenderRequest) -> Result<(), Error> {
    checked_pixels(request.pixel_width, request.pixel_height)?;
    checked_pixels(request.page_pixel_width, request.page_pixel_height)?;
    normalized_rotation(request.rotation).map(|_| ())
}

/// Desktop `password.slice(0, 1024)` counts UTF-16 units.
fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if units + width > max_units {
            break;
        }
        units += width;
        end = index + character.len_utf8();
    }
    value[..end].to_owned()
}

fn checked_pixels(width: i32, height: i32) -> Result<usize, Error> {
    if width <= 0 || height <= 0 || width > MAX_EDGE || height > MAX_EDGE {
        return Err(Error::Size);
    }
    let pixels = (width as i64)
        .checked_mul(height as i64)
        .ok_or(Error::Size)?;
    if pixels > MAX_PIXELS {
        return Err(Error::Size);
    }
    Ok(pixels as usize)
}

fn normalized_rotation(degrees: i32) -> Result<i32, Error> {
    match degrees.rem_euclid(360) {
        degrees @ (0 | 90 | 180 | 270) => Ok(degrees),
        _ => Err(Error::Rotation),
    }
}

fn library() -> Result<&'static Pdfium, Error> {
    static LIBRARY: OnceLock<Pdfium> = OnceLock::new();
    if let Some(existing) = LIBRARY.get() {
        return Ok(existing);
    }
    let loaded =
        pdfium_bundled::bind_pdfium_silent().map_err(|error| Error::Bind(error.to_string()))?;
    let _ = LIBRARY.set(loaded);
    LIBRARY
        .get()
        .ok_or_else(|| Error::Bind("PDFium wurde nicht gespeichert.".to_owned()))
}

static RENDER: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn request(width: i32, height: i32) -> RenderRequest {
        RenderRequest {
            page_index: 0,
            pixel_width: width,
            pixel_height: height,
            page_pixel_width: width,
            page_pixel_height: height,
            origin_x: 0,
            origin_y: 0,
            rotation: 0,
            password: String::new(),
        }
    }

    #[test]
    fn rejects_a_zero_bitmap_before_pdfium_loads() {
        let error = render_pdf_page(b"%PDF", &request(0, 16)).unwrap_err();
        assert!(matches!(error, Error::Size));
    }

    #[test]
    fn rejects_an_incomplete_vault_request() {
        let error = parse_vault_request(&Value::Null).unwrap_err();
        assert!(matches!(error, Error::Request));
        let mut request = serde_json::json!({
            "path": "Seite.pdf",
            "pageIndex": 0,
            "pixelWidth": 16,
            "pixelHeight": 16,
            "pagePixelWidth": 16,
            "pagePixelHeight": 16,
            "originX": 0,
            "originY": 0,
            "rotation": 0
        });
        request.as_object_mut().unwrap().remove("rotation");
        assert!(matches!(
            parse_vault_request(&request).unwrap_err(),
            Error::Request
        ));
        let mut whole = serde_json::json!({
            "path": "../secret.pdf",
            "pageIndex": 0.0,
            "pixelWidth": 16.0,
            "pixelHeight": 16,
            "pagePixelWidth": 16,
            "pagePixelHeight": 16,
            "originX": -1.0,
            "originY": 0,
            "rotation": 0.0
        });
        let (path, job) = parse_vault_request(&whole).unwrap();
        assert_eq!(path, "../secret.pdf");
        assert_eq!(job.pixel_width, 16);
        assert_eq!(job.origin_x, -1);
        assert_eq!(job.page_index, 0);
        whole["pixelWidth"] = serde_json::json!(16.5);
        assert!(matches!(
            parse_vault_request(&whole).unwrap_err(),
            Error::Request
        ));
        let long = format!("{}.pdf", "ä".repeat(3000));
        let mut request = request;
        request["rotation"] = serde_json::json!(0);
        request["path"] = serde_json::json!(long);
        request["password"] = serde_json::json!(1);
        let (path, job) = parse_vault_request(&request).unwrap();
        assert_eq!(path.chars().count(), 3004);
        assert!(job.password.is_empty());
    }

    #[test]
    fn a_long_pdf_password_is_shortened_like_the_desktop() {
        let ascii = "a".repeat(1025);
        assert_eq!(truncate_utf16(&ascii, 1024).len(), 1024);
        let marks = "ä".repeat(1025);
        let shortened = truncate_utf16(&marks, 1024);
        assert_eq!(shortened.chars().count(), 1024);
        assert_eq!(shortened.encode_utf16().count(), 1024);
        let mut job = request(16, 16);
        job.password = marks;
        let error = render_pdf_page(b"", &job).unwrap_err();
        assert!(error.to_string().contains("leer oder zu groß"), "{error}");
    }
}
