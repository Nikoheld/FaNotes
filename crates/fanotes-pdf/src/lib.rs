//! PDFium page rasters for the paper camera.
//!
//! A page is rendered at the camera's pixel size, then clipped to the paint
//! window the PDF painter already planned (`planPdfPagePaint`). pdf.js keeps
//! the selectable text layer; this crate only supplies pixels.

mod protocol;

use std::sync::{Mutex, OnceLock};

use base64::Engine;
use pdfium_bundled::pdfium_render::prelude::{PdfBitmap, Pdfium};
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

/// Rasterize one page to `request`'s bitmap size. PDFium paints the upright
/// page; a 90/180/270 viewer rotation is applied to those pixels so the crop
/// window matches the paper camera. Pixels outside the page are white.
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
    let pages = document.pages();
    if request.page_index < 0 || request.page_index >= pages.len() {
        return Err(Error::Page);
    }
    let page = pages
        .get(request.page_index)
        .map_err(|error| Error::Render(error.to_string()))?;
    let rotation = normalized_rotation(request.rotation)?;
    let (src_w, src_h) = match rotation {
        90 | 270 => (request.page_pixel_height, request.page_pixel_width),
        _ => (request.page_pixel_width, request.page_pixel_height),
    };
    let rendered = page
        .render(src_w, src_h, None)
        .map_err(|error| Error::Render(error.to_string()))?;
    if rendered.width() != src_w || rendered.height() != src_h {
        return Err(Error::Render(
            "PDFium hat nicht die angeforderte Seitengröße geliefert.".to_owned(),
        ));
    }
    let upright = tight_rgba(&rendered)?;
    let oriented = if rotation == 0 {
        upright
    } else {
        rotate_rgba(&upright, src_w, src_h, rotation)?
    };
    let rgba = window_rgba(
        &oriented,
        request.page_pixel_width,
        request.page_pixel_height,
        request.origin_x,
        request.origin_y,
        request.pixel_width,
        request.pixel_height,
    );
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

fn rotate_rgba(src: &[u8], width: i32, height: i32, rotation: i32) -> Result<Vec<u8>, Error> {
    let width_us = width as usize;
    let height_us = height as usize;
    match rotation {
        180 => {
            let mut out = vec![255u8; src.len()];
            let pixels = width_us * height_us;
            for index in 0..pixels {
                let from = index * 4;
                let to = (pixels - 1 - index) * 4;
                out[to..to + 4].copy_from_slice(&src[from..from + 4]);
            }
            Ok(out)
        }
        90 => Ok(rotate_clockwise(src, width_us, height_us)),
        270 => Ok(rotate_counter_clockwise(src, width_us, height_us)),
        _ => Err(Error::Rotation),
    }
}

fn rotate_clockwise(src: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = vec![255u8; src.len()];
    for y in 0..height {
        for x in 0..width {
            let from = (y * width + x) * 4;
            let to = (x * height + (height - 1 - y)) * 4;
            out[to..to + 4].copy_from_slice(&src[from..from + 4]);
        }
    }
    out
}

fn rotate_counter_clockwise(src: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = vec![255u8; src.len()];
    for y in 0..height {
        for x in 0..width {
            let from = (y * width + x) * 4;
            let to = ((width - 1 - x) * height + y) * 4;
            out[to..to + 4].copy_from_slice(&src[from..from + 4]);
        }
    }
    out
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

fn tight_rgba(bitmap: &PdfBitmap) -> Result<Vec<u8>, Error> {
    let width = bitmap.width();
    let height = bitmap.height();
    if width <= 0 || height <= 0 {
        return Err(Error::Render(
            "PDFium lieferte eine leere Bitmap.".to_owned(),
        ));
    }
    let raw = bitmap.as_rgba_bytes();
    let row = (width as usize).checked_mul(4).ok_or(Error::Size)?;
    let height_us = height as usize;
    if height_us == 0 || raw.len() < row.saturating_mul(height_us) || raw.len() % height_us != 0 {
        return Err(Error::Render(
            "Die Bitmap-Zeilenlänge passt nicht.".to_owned(),
        ));
    }
    let stride = raw.len() / height_us;
    if stride < row {
        return Err(Error::Render(
            "Die Bitmap-Zeilenlänge passt nicht.".to_owned(),
        ));
    }
    let mut out = Vec::with_capacity(row * height_us);
    for y in 0..height_us {
        let start = y * stride;
        out.extend_from_slice(&raw[start..start + row]);
    }
    for pixel in out.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    Ok(out)
}

fn window_rgba(
    src: &[u8],
    src_w: i32,
    src_h: i32,
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
) -> Vec<u8> {
    if origin_x == 0 && origin_y == 0 && width == src_w && height == src_h {
        return src.to_vec();
    }
    let dest_row = width as usize * 4;
    let mut out = vec![255u8; dest_row * height as usize];
    let src_row = src_w as usize * 4;
    for y in 0..height {
        let sy = origin_y + y;
        if sy < 0 || sy >= src_h {
            continue;
        }
        let x_start = origin_x.max(0);
        let x_end = (origin_x + width).min(src_w);
        if x_end <= x_start {
            continue;
        }
        let src_off = sy as usize * src_row + x_start as usize * 4;
        let dst_off = y as usize * dest_row + (x_start - origin_x) as usize * 4;
        let len = (x_end - x_start) as usize * 4;
        out[dst_off..dst_off + len].copy_from_slice(&src[src_off..src_off + len]);
    }
    out
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
