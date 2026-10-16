//! Viewport raster: a page of strokes, a 512 px tile cache, and region paints.
//!
//! The host asks for a region of a viewport bitmap at `scale` device px per
//! layout px. Committed ink comes from tiles rasterised at a zoom bucket
//! (1×, 2×, 4× of the device pixel ratio) and resampled into the region. A
//! bucket is only used while it is at least 85 % and at most 200 % of the
//! screen density; outside that range (above about 4.7× zoom, below 0.5×) the
//! region is painted at the exact device scale, which keeps 500 % sharp and
//! never allocates more than the region itself.

use std::collections::HashMap;
use std::sync::Arc;

use tiny_skia::{
    BlendMode, Color, FilterQuality, IntRect, Paint, Pattern, Pixmap, PixmapMut, Rect, SpreadMode,
    Transform,
};

use crate::paint::draw_ink_stroke;
use crate::stroke::{ink_stroke_paint_margin, InkStroke, Symbol};

/// Tile edge in tile pixels.
pub const TILE_PX: u32 = 512;
/// Extra rows and columns around a tile so bilinear sampling across a tile edge is seamless.
pub const TILE_GUTTER: u32 = 2;
/// Tile densities, as multiples of the device pixel ratio.
pub const ZOOM_BUCKETS: [f64; 3] = [1.0, 2.0, 4.0];
/// Lowest tile density allowed, relative to the screen (the `check:zoom-500-sharp` bar).
pub const BUCKET_MIN_SHARPNESS: f64 = 0.85;
/// Highest tile density allowed, relative to the screen.
pub const BUCKET_MAX_OVERSAMPLE: f64 = 2.0;
/// Tiles kept across paints. One tile is about 1 MiB.
pub const TILE_BUDGET: usize = 64;

const KEY_PX_STEPS: f64 = 256.0;

/// Tile bucket for a camera zoom, or `None` when the viewport is painted at the exact scale.
pub fn zoom_bucket(zoom: f64) -> Option<f64> {
    if !zoom.is_finite() || !(zoom > 0.0) {
        return None;
    }
    ZOOM_BUCKETS.into_iter().find(|bucket| {
        *bucket >= BUCKET_MIN_SHARPNESS * zoom - 1e-9
            && *bucket <= BUCKET_MAX_OVERSAMPLE * zoom + 1e-9
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayoutRect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl LayoutRect {
    fn expand(self, margin: f64) -> Self {
        Self {
            x0: self.x0 - margin,
            y0: self.y0 - margin,
            x1: self.x1 + margin,
            y1: self.y1 + margin,
        }
    }

    fn intersects(&self, other: &LayoutRect) -> bool {
        self.x0 < other.x1 && other.x0 < self.x1 && self.y0 < other.y1 && other.y0 < self.y1
    }
}

/// What the paint reach of a stroke depends on, without its points.
#[derive(Clone, Copy, Debug)]
struct Reach {
    bounds: LayoutRect,
    probe: (f64, bool, bool, bool),
}

impl Reach {
    fn of(stroke: &InkStroke, bounds: LayoutRect) -> Self {
        Self {
            bounds,
            probe: (
                stroke.base_width,
                stroke.pressure_enabled,
                stroke.has_symbol(),
                stroke.effect == crate::stroke::Effect::Neon,
            ),
        }
    }

    /// Layout box any paint of the stroke can touch at `density` px per layout px.
    fn at(&self, density: f64) -> LayoutRect {
        let (base_width, pressure_enabled, symbol, neon) = self.probe;
        let mut probe = InkStroke::pen(Vec::new(), base_width, 0);
        probe.pressure_enabled = pressure_enabled;
        if neon {
            probe.effect = crate::stroke::Effect::Neon;
        }
        let margin = if symbol {
            base_width * density * std::f64::consts::SQRT_2 + 2.0
        } else {
            ink_stroke_paint_margin(&probe, density)
        };
        // Pencil grain and spray particles reach up to ~0.9 px past the pass width.
        self.bounds.expand(margin / density + 1.0)
    }
}

struct SceneStroke {
    stroke: InkStroke,
    key: u64,
    reach: Reach,
}

fn fnv(mut hash: u64, value: u64) -> u64 {
    for byte in value.to_le_bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

impl SceneStroke {
    fn new(stroke: InkStroke, layout: (f64, f64)) -> Self {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        let quantize = |value: f64| (value * KEY_PX_STEPS).round() as i64 as u64;
        let (mut x0, mut y0, mut x1, mut y1) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        let mut include = |x: f64, y: f64| {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        };
        for point in &stroke.points {
            let x = point.x * layout.0;
            let y = point.y * layout.1;
            hash = fnv(hash, quantize(x));
            hash = fnv(hash, quantize(y));
            hash = fnv(hash, (point.pressure * 4096.0).round() as i64 as u64);
            include(x, y);
        }
        for value in [
            stroke.base_width.to_bits(),
            stroke.pressure_enabled as u64,
            stroke.color as u64,
            stroke.art as u64,
            stroke.brush.map(|brush| brush.id() as u64 + 1).unwrap_or(0),
            stroke.effect.id() as u64,
            stroke.opacity.map(f64::to_bits).unwrap_or(1),
            stroke.texture_seed.map(f64::to_bits).unwrap_or(1),
            stroke
                .symbol
                .as_ref()
                .map(|symbol| Arc::as_ptr(symbol) as usize as u64)
                .unwrap_or(0),
            stroke.symbol_rotation.to_bits(),
            stroke.points.len() as u64,
        ] {
            hash = fnv(hash, value);
        }
        if stroke.effect.stops().is_some() {
            // Gradient inks are laid across the whole page.
            hash = fnv(hash, layout.0.to_bits());
            hash = fnv(hash, layout.1.to_bits());
        }
        let bounds = if x0.is_finite() {
            LayoutRect { x0, y0, x1, y1 }
        } else {
            LayoutRect {
                x0: 0.0,
                y0: 0.0,
                x1: 0.0,
                y1: 0.0,
            }
        };
        let reach = Reach::of(&stroke, bounds);
        Self {
            stroke,
            key: hash,
            reach,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct TileKey {
    density: u64,
    col: i64,
    row: i64,
}

struct Tile {
    pixmap: Pixmap,
    valid: bool,
    used: u64,
}

impl TileKey {
    fn layout_rect(&self) -> LayoutRect {
        let density = f64::from_bits(self.density);
        let x = (self.col * TILE_PX as i64 - TILE_GUTTER as i64) as f64;
        let y = (self.row * TILE_PX as i64 - TILE_GUTTER as i64) as f64;
        let span = (TILE_PX + 2 * TILE_GUTTER) as f64;
        LayoutRect {
            x0: x / density,
            y0: y / density,
            x1: (x + span) / density,
            y1: (y + span) / density,
        }
    }
}

/// What a region paint used, for tests and memory checks.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PaintStats {
    pub bucket: Option<f64>,
    pub tiles_used: usize,
    pub tiles_rendered: usize,
}

#[derive(Default)]
pub struct Scene {
    layout: (f64, f64),
    smoothing: f64,
    initialized: bool,
    strokes: Vec<SceneStroke>,
    symbols: Vec<Arc<Symbol>>,
    tiles: HashMap<TileKey, Tile>,
    clock: u64,
    pending: Vec<Reach>,
    pending_all: bool,
    last_stats: PaintStats,
}

impl Scene {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_symbol(&mut self, symbol: Symbol) -> usize {
        self.symbols.push(Arc::new(symbol));
        self.symbols.len() - 1
    }

    pub fn symbols(&self) -> &[Arc<Symbol>] {
        &self.symbols
    }

    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    pub fn last_stats(&self) -> PaintStats {
        self.last_stats
    }

    /// Replaces the page. Only strokes that changed (by position in the list,
    /// compared from both ends) invalidate tiles; an unchanged page keeps them.
    /// Returns whether any committed pixel may have changed.
    pub fn set_scene(
        &mut self,
        layout_width: f64,
        layout_height: f64,
        smoothing: f64,
        strokes: Vec<InkStroke>,
    ) -> bool {
        let layout = (layout_width.max(1.0), layout_height.max(1.0));
        let next: Vec<SceneStroke> = strokes
            .into_iter()
            .map(|stroke| SceneStroke::new(stroke, layout))
            .collect();
        if !self.initialized || smoothing.to_bits() != self.smoothing.to_bits() {
            self.initialized = true;
            self.smoothing = smoothing;
            self.layout = layout;
            self.strokes = next;
            self.tiles.clear();
            self.pending.clear();
            self.pending_all = true;
            return true;
        }
        let previous = &self.strokes;
        let mut prefix = 0;
        while prefix < previous.len()
            && prefix < next.len()
            && previous[prefix].key == next[prefix].key
        {
            prefix += 1;
        }
        let mut suffix = 0;
        while suffix < previous.len() - prefix
            && suffix < next.len() - prefix
            && previous[previous.len() - 1 - suffix].key == next[next.len() - 1 - suffix].key
        {
            suffix += 1;
        }
        let appended_only = prefix == previous.len() && suffix == 0;
        let changed: Vec<Reach> = previous[prefix..previous.len() - suffix]
            .iter()
            .chain(&next[prefix..next.len() - suffix])
            .map(|stroke| stroke.reach)
            .collect();
        self.layout = layout;
        self.strokes = next;
        if changed.is_empty() {
            return false;
        }
        let Scene {
            tiles,
            strokes,
            layout,
            smoothing,
            ..
        } = self;
        for (key, tile) in tiles.iter_mut() {
            if !tile.valid {
                continue;
            }
            let density = f64::from_bits(key.density);
            let rect = key.layout_rect();
            if appended_only {
                // New strokes go on top of everything, so painting them onto
                // the tile equals repainting it.
                for item in &strokes[prefix..] {
                    if item.reach.at(density).intersects(&rect) {
                        paint_on_tile(&mut tile.pixmap, item, *layout, *smoothing, density, key);
                    }
                }
            } else if changed
                .iter()
                .any(|reach| reach.at(density).intersects(&rect))
            {
                tile.valid = false;
            }
        }
        self.pending.extend(changed);
        true
    }

    /// Region of a `width` × `height` viewport bitmap at `origin` whose pixels
    /// changed since the last [`Scene::clear_dirty`], or `None` when clean.
    pub fn dirty_region(
        &self,
        scale: f64,
        dpr: f64,
        origin: (f64, f64),
        width: u32,
        height: u32,
    ) -> Option<IntRect> {
        if width == 0 || height == 0 {
            return None;
        }
        if self.pending_all {
            return IntRect::from_xywh(0, 0, width, height);
        }
        if self.pending.is_empty() {
            return None;
        }
        let bucket_density = zoom_bucket(scale / dpr).map(|bucket| bucket * dpr);
        let (mut x0, mut y0, mut x1, mut y1) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for reach in &self.pending {
            let mut rect = reach.at(scale);
            if let Some(density) = bucket_density {
                let tiled = reach.at(density);
                rect = LayoutRect {
                    x0: rect.x0.min(tiled.x0),
                    y0: rect.y0.min(tiled.y0),
                    x1: rect.x1.max(tiled.x1),
                    y1: rect.y1.max(tiled.y1),
                };
            }
            x0 = x0.min(rect.x0);
            y0 = y0.min(rect.y0);
            x1 = x1.max(rect.x1);
            y1 = y1.max(rect.y1);
        }
        // One extra px: a resampled tile texel reaches its neighbour.
        let left = ((x0 * scale - origin.0).floor() - 1.0).max(0.0);
        let top = ((y0 * scale - origin.1).floor() - 1.0).max(0.0);
        let right = ((x1 * scale - origin.0).ceil() + 1.0).min(width as f64);
        let bottom = ((y1 * scale - origin.1).ceil() + 1.0).min(height as f64);
        if right <= left || bottom <= top {
            return None;
        }
        IntRect::from_xywh(
            left as i32,
            top as i32,
            (right - left) as u32,
            (bottom - top) as u32,
        )
    }

    pub fn clear_dirty(&mut self) {
        self.pending.clear();
        self.pending_all = false;
    }

    /// Paints `region` of a viewport bitmap whose top-left sits at `origin`
    /// (device px) in a page drawn at `scale` device px per layout px.
    pub fn paint(
        &mut self,
        scale: f64,
        dpr: f64,
        origin: (f64, f64),
        region: IntRect,
    ) -> Option<Pixmap> {
        let mut out = Pixmap::new(region.width(), region.height())?;
        let region_origin = (origin.0 + region.x() as f64, origin.1 + region.y() as f64);
        let dpr = if dpr.is_finite() && dpr > 0.0 {
            dpr
        } else {
            1.0
        };
        let bucket = zoom_bucket(scale / dpr);
        self.last_stats = PaintStats {
            bucket,
            tiles_used: 0,
            tiles_rendered: 0,
        };
        if let Some(bucket) = bucket {
            if self.paint_from_tiles(&mut out, scale, bucket * dpr, region_origin) {
                return Some(out);
            }
            self.last_stats.bucket = None;
        }
        self.paint_exact(&mut out.as_mut(), scale, region_origin);
        Some(out)
    }

    fn paint_exact(&self, target: &mut PixmapMut, scale: f64, origin: (f64, f64)) {
        let rect = LayoutRect {
            x0: origin.0 / scale,
            y0: origin.1 / scale,
            x1: (origin.0 + target.width() as f64) / scale,
            y1: (origin.1 + target.height() as f64) / scale,
        };
        let (width, height) = (self.layout.0 * scale, self.layout.1 * scale);
        for item in &self.strokes {
            if item.reach.at(scale).intersects(&rect) {
                draw_ink_stroke(
                    target,
                    &item.stroke,
                    width,
                    height,
                    self.smoothing,
                    1,
                    self.layout.0,
                    self.layout.0,
                    item.stroke.points.len(),
                    origin,
                );
            }
        }
    }

    fn paint_from_tiles(
        &mut self,
        out: &mut Pixmap,
        scale: f64,
        density: f64,
        origin: (f64, f64),
    ) -> bool {
        let k = scale / density;
        let tile = TILE_PX as f64;
        let (x0, y0) = (origin.0 / k, origin.1 / k);
        let (x1, y1) = (
            (origin.0 + out.width() as f64) / k,
            (origin.1 + out.height() as f64) / k,
        );
        let (col0, row0) = ((x0 / tile).floor() as i64, (y0 / tile).floor() as i64);
        let (col1, row1) = (
            ((x1 - 1e-6) / tile).floor() as i64,
            ((y1 - 1e-6) / tile).floor() as i64,
        );
        let needed = ((col1 - col0 + 1).max(0) * (row1 - row0 + 1).max(0)) as usize;
        if needed > TILE_BUDGET {
            return false;
        }
        self.clock += 1;
        let clock = self.clock;
        let exact = (k - 1.0).abs() < 1e-9 && origin.0.fract() == 0.0 && origin.1.fract() == 0.0;
        let Scene {
            tiles,
            strokes,
            layout,
            smoothing,
            last_stats,
            ..
        } = self;
        for row in row0..=row1 {
            for col in col0..=col1 {
                let key = TileKey {
                    density: density.to_bits(),
                    col,
                    row,
                };
                let entry = tiles.entry(key).or_insert_with(|| Tile {
                    pixmap: Pixmap::new(TILE_PX + 2 * TILE_GUTTER, TILE_PX + 2 * TILE_GUTTER)
                        .expect("tile pixmap"),
                    valid: false,
                    used: 0,
                });
                if !entry.valid {
                    render_tile(
                        &mut entry.pixmap,
                        strokes,
                        *layout,
                        *smoothing,
                        density,
                        &key,
                    );
                    entry.valid = true;
                    last_stats.tiles_rendered += 1;
                }
                entry.used = clock;
                last_stats.tiles_used += 1;
                compose_tile(out, &entry.pixmap, &key, k, origin, exact);
            }
        }
        if tiles.len() > TILE_BUDGET {
            let mut ages: Vec<(u64, TileKey)> = tiles
                .iter()
                .filter(|(_, tile)| tile.used != clock)
                .map(|(key, tile)| (tile.used, *key))
                .collect();
            ages.sort_by_key(|(used, _)| *used);
            for (_, key) in ages.into_iter().take(tiles.len() - TILE_BUDGET) {
                tiles.remove(&key);
            }
        }
        true
    }
}

fn paint_on_tile(
    pixmap: &mut Pixmap,
    item: &SceneStroke,
    layout: (f64, f64),
    smoothing: f64,
    density: f64,
    key: &TileKey,
) {
    let origin = (
        (key.col * TILE_PX as i64 - TILE_GUTTER as i64) as f64,
        (key.row * TILE_PX as i64 - TILE_GUTTER as i64) as f64,
    );
    draw_ink_stroke(
        &mut pixmap.as_mut(),
        &item.stroke,
        layout.0 * density,
        layout.1 * density,
        smoothing,
        1,
        layout.0,
        layout.0,
        item.stroke.points.len(),
        origin,
    );
}

fn render_tile(
    pixmap: &mut Pixmap,
    strokes: &[SceneStroke],
    layout: (f64, f64),
    smoothing: f64,
    density: f64,
    key: &TileKey,
) {
    pixmap.fill(Color::TRANSPARENT);
    let rect = key.layout_rect();
    for item in strokes {
        if item.reach.at(density).intersects(&rect) {
            paint_on_tile(pixmap, item, layout, smoothing, density, key);
        }
    }
}

/// Puts a tile's content area into the region. Adjacent tiles meet on whole
/// output pixels, so every pixel is written by exactly one tile.
fn compose_tile(
    out: &mut Pixmap,
    tile: &Pixmap,
    key: &TileKey,
    k: f64,
    origin: (f64, f64),
    exact: bool,
) {
    let size = TILE_PX as f64;
    let (left, top) = (
        (key.col as f64 * size) * k - origin.0,
        (key.row as f64 * size) * k - origin.1,
    );
    let (right, bottom) = (
        ((key.col + 1) as f64 * size) * k - origin.0,
        ((key.row + 1) as f64 * size) * k - origin.1,
    );
    let x0 = left.round().max(0.0);
    let y0 = top.round().max(0.0);
    let x1 = right.round().min(out.width() as f64);
    let y1 = bottom.round().min(out.height() as f64);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    if exact {
        let (x0, y0, x1, y1) = (x0 as usize, y0 as usize, x1 as usize, y1 as usize);
        let out_width = out.width() as usize;
        let tile_width = tile.width() as usize;
        let source_x = (x0 as f64 - left) as usize + TILE_GUTTER as usize;
        let source_y = (y0 as f64 - top) as usize + TILE_GUTTER as usize;
        let row_bytes = (x1 - x0) * 4;
        let source = tile.data();
        let target = out.data_mut();
        for row in 0..(y1 - y0) {
            let from = ((source_y + row) * tile_width + source_x) * 4;
            let to = ((y0 + row) * out_width + x0) * 4;
            target[to..to + row_bytes].copy_from_slice(&source[from..from + row_bytes]);
        }
        return;
    }
    let gutter = TILE_GUTTER as f64;
    let transform = Transform::from_row(
        k as f32,
        0.0,
        0.0,
        k as f32,
        ((key.col as f64 * size - gutter) * k - origin.0) as f32,
        ((key.row as f64 * size - gutter) * k - origin.1) as f32,
    );
    let paint = Paint {
        shader: Pattern::new(
            tile.as_ref(),
            SpreadMode::Pad,
            FilterQuality::Bilinear,
            1.0,
            transform,
        ),
        blend_mode: BlendMode::Source,
        anti_alias: false,
        force_hq_pipeline: false,
    };
    if let Some(rect) = Rect::from_ltrb(x0 as f32, y0 as f32, x1 as f32, y1 as f32) {
        out.fill_rect(rect, &paint, Transform::identity(), None);
    }
}

/// Straight (not premultiplied) RGBA, row-major: what `ImageData` expects.
pub fn to_rgba(pixmap: &Pixmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixmap.pixels().len() * 4);
    for pixel in pixmap.pixels() {
        match pixel.alpha() {
            0 => out.extend_from_slice(&[0, 0, 0, 0]),
            255 => out.extend_from_slice(&[pixel.red(), pixel.green(), pixel.blue(), 255]),
            _ => {
                let color = pixel.demultiply();
                out.extend_from_slice(&[color.red(), color.green(), color.blue(), color.alpha()]);
            }
        }
    }
    out
}

/// Paints `strokes` into a `width` × `height` bitmap of a page `layout_width`
/// layout px wide, through the same scene and tiles the viewport uses.
pub fn rasterize(
    strokes: Vec<InkStroke>,
    width: u32,
    height: u32,
    layout_width: f64,
    smoothing: f64,
) -> Option<Pixmap> {
    let layout_width = if layout_width > 1.0 {
        layout_width
    } else {
        width as f64
    };
    let scale = width as f64 / layout_width;
    let mut scene = Scene::new();
    scene.set_scene(layout_width, height as f64 / scale, smoothing, strokes);
    scene.paint(
        scale,
        scale,
        (0.0, 0.0),
        IntRect::from_xywh(0, 0, width, height)?,
    )
}
