//! PDF page textures through PDFium (`fanotes-pdf`), feature `pdf`.
//!
//! A page is rasterized once per density and placed on the paper as a
//! [`PageImage`]; the frame samples it like any other texture, so PDF and ink
//! move under one camera.

use std::sync::Arc;

use fanotes_pdf::{render_opened, OpenedPdf, RenderRequest};
use kurbo::Rect;

use crate::image::{PageImage, RgbaImage};

pub use fanotes_pdf::{open_pdf, Error as PdfError};

/// Rasterize page `page_index` to cover `rect` (page px) at `density`
/// device px per page px. `id` names the texture.
pub fn pdf_page_image(
    opened: &OpenedPdf,
    page_index: i32,
    rect: Rect,
    density: f64,
    id: u64,
) -> Result<PageImage, PdfError> {
    let width = (rect.width() * density).round().max(1.0) as i32;
    let height = (rect.height() * density).round().max(1.0) as i32;
    let bitmap = render_opened(
        opened,
        &RenderRequest {
            page_index,
            pixel_width: width,
            pixel_height: height,
            page_pixel_width: width,
            page_pixel_height: height,
            origin_x: 0,
            origin_y: 0,
            rotation: 0,
            password: String::new(),
        },
    )?;
    Ok(PageImage {
        id,
        rect,
        image: Arc::new(RgbaImage {
            width: bitmap.width,
            height: bitmap.height,
            data: bitmap.rgba,
        }),
    })
}
