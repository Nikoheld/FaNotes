//! FaNotes ink raster.
//!
//! `paint` is a port of `drawInkStroke` / `pressureWidth` from
//! `fanotes/src/lib/inkStrokePaint.ts` onto tiny-skia, including every brush.
//! `scene` keeps a page of strokes and serves viewport regions from 512 px
//! tiles at 1×/2×/4× zoom buckets, invalidated only where strokes changed.

// `!(x > 0.0)` is kept from the TypeScript painter: it is also true for NaN.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

mod blur;
mod packed;
mod paint;
mod scene;
mod stroke;
mod svg;

pub use packed::{pack_strokes, strokes_from_packed, PACKED_POINT_FIELDS, PACKED_STROKE_FIELDS};
pub use paint::draw_ink_stroke;
pub use scene::{
    rasterize, to_rgba, zoom_bucket, LayoutRect, PaintStats, Scene, BUCKET_MAX_OVERSAMPLE,
    BUCKET_MIN_SHARPNESS, TILE_BUDGET, TILE_GUTTER, TILE_PX, ZOOM_BUCKETS,
};
pub use stroke::{
    ink_stroke_bitmap_width, ink_stroke_is_translucent, ink_stroke_paint_margin,
    ink_stroke_paint_scale, pressure_width, Brush, Effect, InkPoint, InkStroke, Symbol,
    INK_MIN_BITMAP_PX,
};
pub use svg::parse_svg_path;
pub use tiny_skia::{IntRect, Pixmap};
