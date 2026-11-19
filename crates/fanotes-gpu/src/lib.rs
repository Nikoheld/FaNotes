//! FaNotes native page engine.
//!
//! One frame = sheet + ruling, PDF page textures, committed ink and the wet
//! stroke, all seen through one [`Camera`] (zoom, scroll and origin pad from
//! `fanotes-paper`). Three interchangeable [`Renderer`]s draw it:
//! vello_hybrid on wgpu (feature `gpu`), vello_cpu, and the tiny-skia painter
//! of `fanotes-raster` as the reference the others are tested against.
//!
//! - [`stroke`]: `drawInkStroke` as draw ops, committed ([`build_stroke_ops`])
//!   and incremental ([`LiveStroke`], O(1) per sample).
//! - [`scene`]: committed ink in page px with a cell index and a dirty log;
//!   mirrors an `InkDocument` (erase, undo, redo, grow).
//! - [`tiles`]: 512 page-px tiles at zoom buckets, dropped only where ink changed.
//!
//! No app wiring: the shipping app does not use this crate yet.

// `!(x > 0.0)` is kept from the TypeScript painter: it is also true for NaN.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod backend;
pub mod camera;
pub mod fixtures;
pub mod image;
pub mod ops;
#[cfg(feature = "pdf")]
pub mod pdf;
pub mod ruling;
pub mod scene;
pub mod stroke;
pub mod tiles;

pub use backend::{
    BackendKind, CpuRenderer, FrameStats, MemoryStats, ReferenceRenderer, RenderError, Renderer,
};
#[cfg(feature = "gpu")]
pub use backend::{GpuContext, HybridRenderer};
pub use camera::Camera;
pub use fanotes_raster::{pressure_width, Brush, Effect, InkPoint, InkStroke, Symbol};
pub use image::{ImageDiff, PageImage, RgbaImage};
pub use ruling::PaperStyle;
pub use scene::{PageScene, StrokeKey, TILE_PAGE_PX};
pub use stroke::{build_stroke_ops, LiveStroke};
pub use tiles::{zoom_bucket, TileKey, ZOOM_BUCKETS};

/// Every backend this build can make, best first. GPU creation errors are returned, not hidden.
pub fn available_renderers() -> Vec<Result<Box<dyn Renderer>, RenderError>> {
    let cpu: Vec<Result<Box<dyn Renderer>, RenderError>> = vec![
        Ok(Box::new(CpuRenderer::new(None))),
        Ok(Box::new(ReferenceRenderer::new())),
    ];
    #[cfg(feature = "gpu")]
    let cpu = {
        let mut all = vec![
            HybridRenderer::headless().map(|renderer| Box::new(renderer) as Box<dyn Renderer>)
        ];
        all.extend(cpu);
        all
    };
    cpu
}
