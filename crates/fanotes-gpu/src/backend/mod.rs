//! The renderer trait and its three backends.
//!
//! - [`HybridRenderer`] (feature `gpu`): vello_hybrid on wgpu. Paths become
//!   sparse strips on the CPU, the GPU rasterizes and composites; tiles are
//!   wgpu textures sampled with `draw_texture_rects`.
//! - [`CpuRenderer`]: vello_cpu, multithreaded SIMD. The fallback for VMs and broken GPUs.
//! - [`ReferenceRenderer`]: the existing `fanotes-raster` tiny-skia painter,
//!   which is itself checked against `inkStrokePaint.ts`. Goldens come from it.
//!
//! Every frame is: sheet + ruling, page images (PDF), committed ink (tiles at a
//! zoom bucket, or exact), then the wet stroke — all through one [`Camera`].

mod cpu;
#[cfg(feature = "gpu")]
mod gpu;
mod reference;
mod vello;

pub use cpu::CpuRenderer;
#[cfg(feature = "gpu")]
pub use gpu::{GpuContext, HybridRenderer};
pub use reference::ReferenceRenderer;

use thiserror::Error;

use crate::camera::Camera;
use crate::image::RgbaImage;
use crate::scene::PageScene;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BackendKind {
    VelloHybrid,
    VelloCpu,
    TinySkia,
}

impl BackendKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::VelloHybrid => "vello_hybrid (wgpu)",
            Self::VelloCpu => "vello_cpu",
            Self::TinySkia => "tiny-skia reference",
        }
    }
}

#[derive(Debug, Error)]
pub enum RenderError {
    #[error("no usable GPU adapter: {0}")]
    NoAdapter(String),
    #[error("GPU error: {0}")]
    Gpu(String),
    #[error("frame size {0}x{1} is not supported")]
    Size(u32, u32),
    #[error("nothing rendered yet")]
    NoFrame,
}

/// What one frame did.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameStats {
    /// Density of the tiles used, or `None` for an exact paint.
    pub bucket_density: Option<f64>,
    pub tiles_used: usize,
    pub tiles_rendered: usize,
    /// Strokes encoded this frame (exact paint plus tile renders).
    pub strokes_encoded: usize,
}

/// Memory the renderer holds on purpose (tiles, textures, frame targets).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MemoryStats {
    pub tiles: usize,
    pub tile_bytes: usize,
    /// Frame targets, page-image textures and other buffers.
    pub other_bytes: usize,
}

pub trait Renderer {
    fn kind(&self) -> BackendKind;

    /// Paint one frame of `scene` through `camera`. The viewport size is the camera's.
    fn render(&mut self, scene: &PageScene, camera: &Camera) -> Result<FrameStats, RenderError>;

    /// The last frame as straight RGBA8.
    fn read_rgba(&mut self) -> Result<RgbaImage, RenderError>;

    fn memory(&self) -> MemoryStats;

    /// Use the committed-ink tile cache when the zoom has a bucket (default on).
    fn set_tiling(&mut self, enabled: bool);

    /// Drop every cached tile and texture.
    fn clear_cache(&mut self);
}

/// Page-px margin around the viewport when picking strokes for an exact paint.
pub(crate) fn exact_query_margin(scale: f64) -> f64 {
    (2.0 / scale).max(16.0)
}
