//! The page scene: committed ink, the wet stroke, ruling and page images.
//!
//! Strokes are stored in page px. A 512 page-px cell index answers "which
//! strokes can touch this rect" without scanning the page, and every change
//! (add, erase, undo, section shift) appends the page rect it can repaint to a
//! dirty log, which tile caches replay to drop only the tiles it touches.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use fanotes_ink::{InkDocument, StrokeId};
use fanotes_raster::{parse_svg_path, Brush, Effect, InkPoint, InkStroke, Symbol};
use kurbo::Rect;
use serde_json::Value;

use crate::image::PageImage;
use crate::ruling::PaperStyle;
use crate::stroke::{reach_page_px, LiveStroke};

/// Edge of an index cell and of a committed-ink tile, in page px.
pub const TILE_PAGE_PX: f64 = 512.0;
/// Lowest tile density any cache uses; dirty rects are padded for it.
pub const MIN_DENSITY: f64 = 0.25;
/// Dirty-log entries kept; a cache further behind drops everything.
const DIRTY_LOG_CAP: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StrokeKey(pub u64);

#[derive(Clone, Debug)]
pub struct SceneStroke {
    /// Points in page px.
    pub stroke: InkStroke,
    /// Point bounds, page px.
    pub bounds: Rect,
    /// Everything any paint can touch at [`MIN_DENSITY`] or denser, page px.
    pub reach: Rect,
    /// Paint order.
    pub z: u64,
}

/// What a cache must drop since its last look.
#[derive(Clone, Debug, PartialEq)]
pub enum Dirty<'a> {
    Nothing,
    Rects(&'a [(u64, Rect)]),
    All,
}

#[derive(Clone, Debug)]
pub struct PageScene {
    page: (f64, f64),
    pub paper: PaperStyle,
    /// 0xRRGGBB of the sheet.
    pub background: u32,
    pub smoothing: f64,
    strokes: HashMap<StrokeKey, SceneStroke>,
    cells: HashMap<(i32, i32), Vec<StrokeKey>>,
    next_key: u64,
    next_z: u64,
    revision: u64,
    full_revision: u64,
    dirty: Vec<(u64, Rect)>,
    has_gradient: usize,
    live: Option<LiveStroke>,
    images: Vec<PageImage>,
    ink: InkSync,
}

#[derive(Clone, Debug, Default)]
struct InkSync {
    keys: HashMap<StrokeId, StrokeKey>,
    order: Vec<StrokeId>,
    page: Option<(f64, f64, f64, f64)>,
    live_id: Option<StrokeId>,
    symbols: HashMap<String, Arc<Symbol>>,
}

fn cell_range(rect: Rect) -> (i32, i32, i32, i32) {
    (
        (rect.x0 / TILE_PAGE_PX).floor() as i32,
        (rect.y0 / TILE_PAGE_PX).floor() as i32,
        (rect.x1 / TILE_PAGE_PX).floor() as i32,
        (rect.y1 / TILE_PAGE_PX).floor() as i32,
    )
}

fn point_bounds(points: &[InkPoint]) -> Rect {
    let mut rect = Rect::new(
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for point in points {
        rect.x0 = rect.x0.min(point.x);
        rect.y0 = rect.y0.min(point.y);
        rect.x1 = rect.x1.max(point.x);
        rect.y1 = rect.y1.max(point.y);
    }
    if rect.x0.is_finite() {
        rect
    } else {
        Rect::ZERO
    }
}

impl PageScene {
    pub fn new(page_width: f64, page_height: f64) -> Self {
        Self {
            page: (page_width, page_height),
            paper: PaperStyle::Lines,
            background: 0xffffff,
            smoothing: 0.5,
            strokes: HashMap::new(),
            cells: HashMap::new(),
            next_key: 1,
            next_z: 1,
            revision: 1,
            full_revision: 1,
            dirty: Vec::new(),
            has_gradient: 0,
            live: None,
            images: Vec::new(),
            ink: InkSync::default(),
        }
    }

    pub fn page_size(&self) -> (f64, f64) {
        self.page
    }

    pub fn stroke_count(&self) -> usize {
        self.strokes.len()
    }

    pub fn point_count(&self) -> usize {
        self.strokes
            .values()
            .map(|stroke| stroke.stroke.points.len())
            .sum()
    }

    pub fn stroke(&self, key: StrokeKey) -> Option<&SceneStroke> {
        self.strokes.get(&key)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Page rects changed after `seen`.
    pub fn dirty_since(&self, seen: u64) -> Dirty<'_> {
        if seen >= self.revision {
            return Dirty::Nothing;
        }
        if seen < self.full_revision {
            return Dirty::All;
        }
        let oldest = self
            .dirty
            .first()
            .map(|entry| entry.0)
            .unwrap_or(self.revision);
        if seen + 1 < oldest {
            return Dirty::All;
        }
        let start = self.dirty.partition_point(|entry| entry.0 <= seen);
        Dirty::Rects(&self.dirty[start..])
    }

    fn mark(&mut self, rect: Rect) {
        self.revision += 1;
        self.dirty.push((self.revision, rect));
        if self.dirty.len() > DIRTY_LOG_CAP {
            let drop = self.dirty.len() - DIRTY_LOG_CAP / 2;
            self.dirty.drain(..drop);
        }
    }

    /// Everything repaints: page grow with a new origin pad, smoothing change, …
    pub fn invalidate_all(&mut self) {
        self.revision += 1;
        self.full_revision = self.revision;
        self.dirty.clear();
    }

    pub fn set_smoothing(&mut self, smoothing: f64) {
        if smoothing != self.smoothing {
            self.smoothing = smoothing;
            self.invalidate_all();
        }
    }

    /// New sheet size. Page-px ink does not move; special inks span the sheet, so they repaint.
    pub fn set_page_size(&mut self, width: f64, height: f64) {
        if (width, height) != self.page {
            self.page = (width, height);
            if self.has_gradient > 0 {
                self.invalidate_all();
            }
        }
    }

    fn index(&mut self, key: StrokeKey, reach: Rect) {
        let (c0, r0, c1, r1) = cell_range(reach);
        for row in r0..=r1 {
            for col in c0..=c1 {
                self.cells.entry((col, row)).or_default().push(key);
            }
        }
    }

    fn unindex(&mut self, key: StrokeKey, reach: Rect) {
        let (c0, r0, c1, r1) = cell_range(reach);
        for row in r0..=r1 {
            for col in c0..=c1 {
                if let Some(list) = self.cells.get_mut(&(col, row)) {
                    if let Some(at) = list.iter().position(|item| *item == key) {
                        list.swap_remove(at);
                    }
                    if list.is_empty() {
                        self.cells.remove(&(col, row));
                    }
                }
            }
        }
    }

    /// Add a committed stroke on top. Points are page px.
    pub fn add_stroke(&mut self, stroke: InkStroke) -> StrokeKey {
        let key = StrokeKey(self.next_key);
        self.next_key += 1;
        let z = self.next_z;
        self.next_z += 1;
        self.insert(key, stroke, z, true);
        key
    }

    fn insert(&mut self, key: StrokeKey, stroke: InkStroke, z: u64, mark: bool) {
        let bounds = point_bounds(&stroke.points);
        let margin = reach_page_px(&stroke, MIN_DENSITY);
        let reach = bounds.inflate(margin, margin);
        if stroke.effect.stops().is_some() {
            self.has_gradient += 1;
        }
        self.index(key, reach);
        if mark {
            self.mark(reach);
        }
        self.strokes.insert(
            key,
            SceneStroke {
                stroke,
                bounds,
                reach,
                z,
            },
        );
    }

    /// Erase a committed stroke. Only its reach repaints.
    pub fn remove_stroke(&mut self, key: StrokeKey) -> Option<InkStroke> {
        let removed = self.strokes.remove(&key)?;
        if removed.stroke.effect.stops().is_some() {
            self.has_gradient -= 1;
        }
        self.unindex(key, removed.reach);
        self.mark(removed.reach);
        Some(removed.stroke)
    }

    /// Section collapse/expand: every stroke whose top is at or below `from_y`
    /// moves by `dy`. The band from `from_y` down repaints.
    pub fn shift_section(&mut self, from_y: f64, dy: f64) -> usize {
        if dy == 0.0 {
            return 0;
        }
        let moved: Vec<StrokeKey> = self
            .strokes
            .iter()
            .filter(|(_, stroke)| stroke.bounds.y0 >= from_y)
            .map(|(key, _)| *key)
            .collect();
        let mut band: Option<Rect> = None;
        for key in &moved {
            let stroke = self.strokes.remove(key).expect("stroke");
            self.unindex(*key, stroke.reach);
            if stroke.stroke.effect.stops().is_some() {
                self.has_gradient -= 1;
            }
            let mut next = stroke.stroke;
            for point in &mut next.points {
                point.y += dy;
            }
            let reach = stroke.reach;
            band = Some(band.map_or(reach, |band| band.union(reach)));
            self.insert(*key, next, stroke.z, false);
        }
        if let Some(band) = band {
            // One dirty band instead of one rect per stroke: old and new places, full width.
            let moved_band = Rect::new(
                f64::NEG_INFINITY,
                band.y0.min(band.y0 + dy),
                f64::INFINITY,
                f64::INFINITY,
            );
            self.mark(moved_band);
        }
        moved.len()
    }

    /// Strokes whose reach meets `rect`, in paint order.
    pub fn strokes_in(&self, rect: Rect) -> Vec<(StrokeKey, &SceneStroke)> {
        let (c0, r0, c1, r1) = cell_range(rect);
        let cell_count = (c1 - c0 + 1) as i64 * (r1 - r0 + 1) as i64;
        let mut seen = HashSet::new();
        let mut found: Vec<(StrokeKey, &SceneStroke)> = Vec::new();
        let mut take = |key: StrokeKey, stroke: &'_ SceneStroke| {
            stroke.reach.overlaps(rect) && seen.insert(key)
        };
        if cell_count > self.cells.len() as i64 {
            for (key, stroke) in &self.strokes {
                if take(*key, stroke) {
                    found.push((*key, stroke));
                }
            }
        } else {
            for row in r0..=r1 {
                for col in c0..=c1 {
                    if let Some(list) = self.cells.get(&(col, row)) {
                        for key in list {
                            let stroke = &self.strokes[key];
                            if take(*key, stroke) {
                                found.push((*key, stroke));
                            }
                        }
                    }
                }
            }
        }
        found.sort_unstable_by_key(|(_, stroke)| stroke.z);
        found
    }

    pub fn images(&self) -> &[PageImage] {
        &self.images
    }

    pub fn set_images(&mut self, images: Vec<PageImage>) {
        self.images = images;
    }

    pub fn live(&self) -> Option<&LiveStroke> {
        self.live.as_ref()
    }

    /// Start the wet stroke, built for `scale` device px per page px.
    pub fn begin_live(&mut self, style: &InkStroke, scale: f64) {
        self.live = Some(LiveStroke::new(style, self.page, scale, self.smoothing));
    }

    /// One pen sample, page px. O(1).
    pub fn push_live(&mut self, point: InkPoint) {
        if let Some(live) = &mut self.live {
            live.push(point);
        }
    }

    pub fn cancel_live(&mut self) {
        self.live = None;
    }

    /// Pen up: the wet stroke becomes committed ink.
    pub fn commit_live(&mut self) -> Option<StrokeKey> {
        let live = self.live.take()?;
        if live.points().is_empty() {
            return None;
        }
        Some(self.add_stroke(live.to_stroke()))
    }

    /// Mirror an ink document: erase, undo and redo become stroke diffs, a new
    /// origin pad repaints everything, the active stroke becomes the wet stroke.
    pub fn sync_ink(&mut self, doc: &InkDocument, live_scale: f64) {
        let page = (
            doc.page_width(),
            doc.page_height(),
            doc.origin_x(),
            doc.origin_y(),
        );
        if self.ink.page != Some(page) {
            let origin_moved = self
                .ink
                .page
                .is_none_or(|old| old.2 != page.2 || old.3 != page.3);
            self.ink.page = Some(page);
            if origin_moved {
                for (_, key) in std::mem::take(&mut self.ink.keys) {
                    self.remove_stroke(key);
                }
                self.ink.order.clear();
                self.page = (page.0, page.1);
                self.invalidate_all();
                self.live = None;
                self.ink.live_id = None;
            } else {
                self.set_page_size(page.0, page.1);
            }
        }
        let live_ids = doc.live_ids();
        if live_ids != self.ink.order.as_slice() {
            let next: HashSet<StrokeId> = live_ids.iter().copied().collect();
            let removed: Vec<StrokeId> = self
                .ink
                .order
                .iter()
                .filter(|id| !next.contains(id))
                .copied()
                .collect();
            for id in removed {
                if let Some(key) = self.ink.keys.remove(&id) {
                    self.remove_stroke(key);
                }
            }
            // Kept strokes in their old order plus new ones at the end is the common case.
            let kept: Vec<StrokeId> = live_ids
                .iter()
                .filter(|id| self.ink.keys.contains_key(id))
                .copied()
                .collect();
            let old_kept: Vec<StrokeId> = self
                .ink
                .order
                .iter()
                .filter(|id| next.contains(id))
                .copied()
                .collect();
            let appended_only = kept == old_kept && live_ids[..kept.len()] == kept[..];
            for id in live_ids {
                if self.ink.keys.contains_key(id) {
                    continue;
                }
                let stroke = self.ink_stroke(doc, *id);
                let key = self.add_stroke(stroke);
                self.ink.keys.insert(*id, key);
            }
            if !appended_only {
                // Undo put a stroke back under others: renumber paint order.
                for (z, id) in live_ids.iter().enumerate() {
                    let key = self.ink.keys[id];
                    if let Some(stroke) = self.strokes.get_mut(&key) {
                        stroke.z = z as u64 + 1;
                    }
                }
                self.next_z = live_ids.len() as u64 + 1;
            }
            self.ink.order = live_ids.to_vec();
        }
        match (doc.active_id(), doc.active_points()) {
            (Some(id), Some(points)) => {
                if self.ink.live_id != Some(id) {
                    let mut style = self.ink_stroke(doc, id);
                    style.points.clear();
                    self.begin_live(&style, live_scale);
                    self.ink.live_id = Some(id);
                }
                let have = self.live.as_ref().map_or(0, |live| live.points().len());
                let (w, h) = self.page;
                for point in &points[have.min(points.len())..] {
                    self.push_live(InkPoint {
                        x: point.x * w,
                        y: point.y * h,
                        pressure: point.pressure as f64,
                    });
                }
            }
            _ => {
                if self.ink.live_id.take().is_some() {
                    self.live = None;
                }
            }
        }
    }

    /// A document stroke as page-px ink with every brush field.
    fn ink_stroke(&mut self, doc: &InkDocument, id: StrokeId) -> InkStroke {
        let (w, h) = self.page;
        let points = doc
            .stroke_points(id)
            .unwrap_or(&[])
            .iter()
            .map(|point| InkPoint {
                x: point.x * w,
                y: point.y * h,
                pressure: point.pressure as f64,
            })
            .collect();
        let color = parse_hex_color(doc.stroke_color(id).unwrap_or("#1a1a1a")).unwrap_or(0x1a1a1a);
        let mut stroke = InkStroke::pen(points, doc.stroke_base_width(id).unwrap_or(4.0), color);
        stroke.pressure_enabled = doc.stroke_pressure_enabled(id).unwrap_or(true);
        if let Some(fields) = doc.stroke_fields(id) {
            apply_fields(&mut stroke, fields, &mut self.ink.symbols);
        }
        stroke
    }
}

const BRUSH_IDS: [&str; 8] = [
    "fineliner",
    "pencil",
    "marker",
    "paintbrush",
    "calligraphy",
    "highlighter",
    "watercolor",
    "spray",
];
const EFFECT_IDS: [&str; 8] = [
    "solid", "rainbow", "aurora", "sunset", "ocean", "gold", "silver", "neon",
];

/// Brush fields of a `DrawingStroke` JSON object, as `viewportRaster.ts` packs them.
pub fn apply_fields(
    stroke: &mut InkStroke,
    fields: &serde_json::Map<String, Value>,
    symbols: &mut HashMap<String, Arc<Symbol>>,
) {
    stroke.art = fields.get("purpose").and_then(Value::as_str) == Some("art");
    stroke.brush = fields
        .get("brush")
        .and_then(Value::as_str)
        .and_then(|name| BRUSH_IDS.iter().position(|id| *id == name))
        .and_then(|index| Brush::from_id(index as i64));
    stroke.effect = fields
        .get("colorEffect")
        .and_then(Value::as_str)
        .and_then(|name| EFFECT_IDS.iter().position(|id| *id == name))
        .map(|index| Effect::from_id(index as i64))
        .unwrap_or(Effect::Solid);
    stroke.opacity = fields.get("opacity").and_then(Value::as_f64);
    stroke.texture_seed = fields.get("textureSeed").and_then(Value::as_f64);
    stroke.symbol_rotation = fields
        .get("symbolRotation")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if let Some(paths) = fields.get("symbolPaths").and_then(Value::as_array) {
        let texts: Vec<&str> = paths.iter().filter_map(Value::as_str).collect();
        if !texts.is_empty() {
            let joined = texts.join("\n");
            let symbol = symbols
                .entry(joined)
                .or_insert_with(|| {
                    Arc::new(Symbol {
                        paths: texts
                            .iter()
                            .filter_map(|text| parse_svg_path(text))
                            .collect(),
                    })
                })
                .clone();
            stroke.symbol = Some(symbol);
        }
    }
}

/// `#rgb` or `#rrggbb` → 0xRRGGBB.
pub fn parse_hex_color(text: &str) -> Option<u32> {
    let hex = text.strip_prefix('#')?;
    match hex.len() {
        6 => u32::from_str_radix(hex, 16).ok(),
        3 => {
            let value = u32::from_str_radix(hex, 16).ok()?;
            let (r, g, b) = ((value >> 8) & 0xf, (value >> 4) & 0xf, value & 0xf);
            Some(((r * 17) << 16) | ((g * 17) << 8) | (b * 17))
        }
        _ => None,
    }
}
