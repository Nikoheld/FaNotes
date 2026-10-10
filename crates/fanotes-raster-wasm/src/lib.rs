//! Browser and Electron entry for the viewport raster.
//!
//! A separate module from `fanotes-wasm`: the paper reducer loads at startup,
//! this one only when the viewport raster flag is on.

use fanotes_raster::{
    parse_svg_path, pressure_width, strokes_from_packed, to_rgba, zoom_bucket, IntRect, Scene,
    Symbol, TILE_BUDGET, TILE_PX,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct InkRaster {
    scene: Scene,
}

impl Default for InkRaster {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl InkRaster {
    #[wasm_bindgen(constructor)]
    pub fn new() -> InkRaster {
        InkRaster {
            scene: Scene::new(),
        }
    }

    /// Registers an art stamp (SVG paths in a 24 × 24 box). Returns its index.
    #[wasm_bindgen(js_name = addSymbol)]
    pub fn add_symbol(&mut self, paths: Vec<String>) -> u32 {
        let paths = paths
            .iter()
            .filter_map(|path| parse_svg_path(path))
            .collect();
        self.scene.add_symbol(Symbol { paths }) as u32
    }

    /// Replaces the page with packed strokes. Returns whether any committed pixel may have changed.
    #[wasm_bindgen(js_name = setScene)]
    pub fn set_scene(
        &mut self,
        layout_width: f64,
        layout_height: f64,
        smoothing: f64,
        header: &[f64],
        points: &[f64],
    ) -> bool {
        let strokes = strokes_from_packed(header, points, self.scene.symbols());
        self.scene
            .set_scene(layout_width, layout_height, smoothing, strokes)
    }

    /// `[x, y, width, height]` of the viewport bitmap that changed since `clearDirty`, or `[]`.
    #[wasm_bindgen(js_name = dirtyRegion)]
    pub fn dirty_region(
        &self,
        scale: f64,
        dpr: f64,
        origin_x: f64,
        origin_y: f64,
        width: u32,
        height: u32,
    ) -> Vec<i32> {
        match self
            .scene
            .dirty_region(scale, dpr, (origin_x, origin_y), width, height)
        {
            Some(rect) => vec![
                rect.x(),
                rect.y(),
                rect.width() as i32,
                rect.height() as i32,
            ],
            None => Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = clearDirty)]
    pub fn clear_dirty(&mut self) {
        self.scene.clear_dirty();
    }

    /// Straight RGBA of one region of the viewport bitmap.
    #[allow(clippy::too_many_arguments)]
    pub fn paint(
        &mut self,
        scale: f64,
        dpr: f64,
        origin_x: f64,
        origin_y: f64,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Vec<u8> {
        let Some(region) = IntRect::from_xywh(x, y, width, height) else {
            return Vec::new();
        };
        match self.scene.paint(scale, dpr, (origin_x, origin_y), region) {
            Some(pixmap) => to_rgba(&pixmap),
            None => Vec::new(),
        }
    }

    /// Zoom bucket the last paint used, or 0 when it painted at the exact scale.
    #[wasm_bindgen(js_name = lastBucket)]
    pub fn last_bucket(&self) -> f64 {
        self.scene.last_stats().bucket.unwrap_or(0.0)
    }

    #[wasm_bindgen(js_name = lastTilesRendered)]
    pub fn last_tiles_rendered(&self) -> u32 {
        self.scene.last_stats().tiles_rendered as u32
    }

    #[wasm_bindgen(js_name = tileCount)]
    pub fn tile_count(&self) -> u32 {
        self.scene.tile_count() as u32
    }
}

/// Tile bucket for a camera zoom, or 0 when the viewport is painted at the exact scale.
#[wasm_bindgen(js_name = zoomBucket)]
pub fn zoom_bucket_js(zoom: f64) -> f64 {
    zoom_bucket(zoom).unwrap_or(0.0)
}

#[wasm_bindgen(js_name = pressureWidth)]
pub fn pressure_width_js(base_width: f64, pressure_enabled: bool, pressure: f64) -> f64 {
    pressure_width(base_width, pressure_enabled, pressure)
}

#[wasm_bindgen(js_name = tilePx)]
pub fn tile_px() -> u32 {
    TILE_PX
}

#[wasm_bindgen(js_name = tileBudget)]
pub fn tile_budget() -> u32 {
    TILE_BUDGET as u32
}
