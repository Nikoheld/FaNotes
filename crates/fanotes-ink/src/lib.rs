//! Ink document.
//!
//! Points live in one arena. Strokes are [`SlotMap`] entries that hold a range
//! into that arena. Undo and redo frames store stroke ids, capped at 80, the
//! same limit `DrawingBoard.tsx` uses when it pushes `undoRef`.
//!
//! A page grow remaps every point once. A stroke that exists only inside an
//! undo frame still moves, which is the history-remap fix: erasing a line,
//! growing the page, then undoing must put the line back on its old paper pixel.

mod pointer;

pub use pointer::PointerKind;

use fanotes_paper::keep_mark_on_page;
use serde_json::{Map, Value};
use slotmap::{new_key_type, SlotMap};
use thiserror::Error;

pub const UNDO_CAP: usize = 80;
pub const SCHEMA_VERSION: u64 = 1;

new_key_type! {
    /// Identity of one stroke. Undo frames store these, not point copies.
    pub struct StrokeId;
}

#[derive(Clone, Debug, PartialEq)]
pub struct StrokePoint {
    pub x: f64,
    pub y: f64,
    pub t: f64,
    pub pressure: f32,
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub pointer: PointerKind,
}

#[derive(Clone, Debug)]
struct Stroke {
    start: u32,
    len: u32,
    base_width: f64,
    pressure_enabled: bool,
    color: String,
    raw: Map<String, Value>,
}

#[derive(Clone, Debug)]
struct UndoFrame {
    live: Vec<StrokeId>,
}

/// Section edges are ordinary arena points, so a grow remaps them with the ink.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Section {
    pub id: String,
    pub top: usize,
    pub body_top: usize,
    pub collapsed: bool,
}

#[derive(Debug, Error)]
pub enum InkError {
    #[error("drawing JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("drawing schemaVersion must be 1")]
    Schema,
    #[error("drawing title is missing")]
    Title,
    #[error("drawing strokes are missing")]
    Strokes,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug)]
pub struct InkDocument {
    points: Vec<StrokePoint>,
    strokes: SlotMap<StrokeId, Stroke>,
    live: Vec<StrokeId>,
    undo: Vec<UndoFrame>,
    redo: Vec<UndoFrame>,
    active: Option<StrokeId>,
    sections: Vec<Section>,
    page_width: f64,
    page_height: f64,
    origin_x: f64,
    origin_y: f64,
    raw: Map<String, Value>,
}

impl InkDocument {
    pub fn new(page_width: f64, page_height: f64) -> Self {
        let mut raw = Map::new();
        raw.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
        raw.insert("title".into(), Value::from("Untitled"));
        raw.insert("paperStyle".into(), Value::from("lines"));
        raw.insert("createdAt".into(), Value::from("2026-10-10T00:00:00.000Z"));
        raw.insert("updatedAt".into(), Value::from("2026-10-10T00:00:00.000Z"));
        Self {
            points: Vec::new(),
            strokes: SlotMap::with_key(),
            live: Vec::new(),
            undo: Vec::new(),
            redo: Vec::new(),
            active: None,
            sections: Vec::new(),
            page_width,
            page_height,
            origin_x: 0.0,
            origin_y: 0.0,
            raw,
        }
    }

    pub fn page_width(&self) -> f64 {
        self.page_width
    }

    pub fn page_height(&self) -> f64 {
        self.page_height
    }

    pub fn origin_x(&self) -> f64 {
        self.origin_x
    }

    pub fn origin_y(&self) -> f64 {
        self.origin_y
    }

    pub fn live_ids(&self) -> &[StrokeId] {
        &self.live
    }

    pub fn undo_len(&self) -> usize {
        self.undo.len()
    }

    pub fn redo_len(&self) -> usize {
        self.redo.len()
    }

    pub fn sections(&self) -> &[Section] {
        &self.sections
    }

    pub fn point(&self, index: usize) -> Option<&StrokePoint> {
        self.points.get(index)
    }

    pub fn stroke_points(&self, id: StrokeId) -> Option<&[StrokePoint]> {
        let stroke = self.strokes.get(id)?;
        let start = stroke.start as usize;
        let end = start + stroke.len as usize;
        self.points.get(start..end)
    }

    pub fn stroke_color(&self, id: StrokeId) -> Option<&str> {
        self.strokes.get(id).map(|stroke| stroke.color.as_str())
    }

    pub fn stroke_base_width(&self, id: StrokeId) -> Option<f64> {
        self.strokes.get(id).map(|stroke| stroke.base_width)
    }

    pub fn active_points(&self) -> Option<&[StrokePoint]> {
        let id = self.active?;
        self.stroke_points(id)
    }

    /// Snapshot the current live ids, then drop the oldest frame past [`UNDO_CAP`].
    pub fn push_undo(&mut self) {
        self.redo.clear();
        self.undo.push(UndoFrame {
            live: self.live.clone(),
        });
        if self.undo.len() > UNDO_CAP {
            self.undo.remove(0);
        }
    }

    pub fn begin_stroke(
        &mut self,
        base_width: f64,
        pressure_enabled: bool,
        color: &str,
    ) -> StrokeId {
        self.cancel_active();
        let start = self.points.len() as u32;
        let mut raw = Map::new();
        raw.insert("baseWidth".into(), json_number(base_width));
        raw.insert("pressureEnabled".into(), Value::Bool(pressure_enabled));
        raw.insert("color".into(), Value::from(color));
        let id = self.strokes.insert(Stroke {
            start,
            len: 0,
            base_width,
            pressure_enabled,
            color: color.to_string(),
            raw,
        });
        self.active = Some(id);
        id
    }

    pub fn push_point(&mut self, point: StrokePoint) -> bool {
        let Some(id) = self.active else {
            return false;
        };
        if !self.strokes.contains_key(id) {
            return false;
        }
        let empty = self.strokes.get(id).is_some_and(|stroke| stroke.len == 0);
        if empty {
            let start = self.points.len() as u32;
            self.strokes.get_mut(id).expect("stroke").start = start;
        }
        self.strokes.get_mut(id).expect("stroke").len += 1;
        self.points.push(point);
        true
    }

    /// Commit the active stroke. The undo frame is the live set from before it landed.
    pub fn end_stroke(&mut self) -> Option<StrokeId> {
        let id = self.active.take()?;
        let empty = self
            .strokes
            .get(id)
            .map(|stroke| stroke.len == 0)
            .unwrap_or(true);
        if empty {
            self.strokes.remove(id);
            return None;
        }
        self.push_undo();
        self.live.push(id);
        Some(id)
    }

    pub fn cancel_active(&mut self) {
        let Some(id) = self.active.take() else {
            return;
        };
        if let Some(stroke) = self.strokes.remove(id) {
            let start = stroke.start as usize;
            let end = start + stroke.len as usize;
            if end == self.points.len() && start <= self.points.len() {
                self.points.truncate(start);
            }
        }
    }

    pub fn commit_stroke(
        &mut self,
        points: &[StrokePoint],
        base_width: f64,
        pressure_enabled: bool,
        color: &str,
    ) -> Option<StrokeId> {
        if points.is_empty() {
            return None;
        }
        self.begin_stroke(base_width, pressure_enabled, color);
        for point in points {
            self.push_point(point.clone());
        }
        self.end_stroke()
    }

    /// Remove a live stroke. Its points stay in the arena so a later grow can remap them.
    pub fn erase_stroke(&mut self, id: StrokeId) -> bool {
        if !self.live.contains(&id) {
            return false;
        }
        self.push_undo();
        self.live.retain(|live| *live != id);
        true
    }

    pub fn erase_last(&mut self) -> bool {
        let Some(id) = self.live.last().copied() else {
            return false;
        };
        self.erase_stroke(id)
    }

    pub fn undo(&mut self) -> bool {
        self.cancel_active();
        let Some(frame) = self.undo.pop() else {
            return false;
        };
        self.redo.push(UndoFrame {
            live: self.live.clone(),
        });
        self.live = frame.live;
        true
    }

    pub fn redo(&mut self) -> bool {
        self.cancel_active();
        let Some(frame) = self.redo.pop() else {
            return false;
        };
        self.undo.push(UndoFrame {
            live: self.live.clone(),
        });
        if self.undo.len() > UNDO_CAP {
            self.undo.remove(0);
        }
        self.live = frame.live;
        true
    }

    /// Remap every arena point once, including strokes that only an undo frame still holds.
    pub fn remap_after_grow(
        &mut self,
        prev_w: f64,
        prev_h: f64,
        next_w: f64,
        next_h: f64,
        pad_x: f64,
        pad_y: f64,
    ) {
        for point in &mut self.points {
            point.x = keep_mark_on_page(point.x, prev_w, next_w, pad_x);
            point.y = keep_mark_on_page(point.y, prev_h, next_h, pad_y);
        }
        self.page_width = next_w;
        self.page_height = next_h;
        self.origin_x += pad_x.max(0.0);
        self.origin_y += pad_y.max(0.0);
    }

    /// Second remap path from `scaleNormalizedSpace`: every tracked point, once.
    pub fn scale_normalized(&mut self, scale_x: f64, scale_y: f64) {
        for point in &mut self.points {
            point.x *= scale_x;
            point.y *= scale_y;
        }
    }

    pub fn add_section(&mut self, id: impl Into<String>, top_y: f64, body_top_y: f64) -> Section {
        let top = self.points.len();
        self.points.push(section_point(top_y));
        let body_top = self.points.len();
        self.points.push(section_point(body_top_y));
        let section = Section {
            id: id.into(),
            top,
            body_top,
            collapsed: false,
        };
        self.sections.push(section.clone());
        section
    }

    pub fn from_json(text: &str) -> Result<Self, InkError> {
        let value: Value = serde_json::from_str(text)?;
        let Value::Object(raw) = value else {
            return Err(InkError::Schema);
        };
        let schema = raw
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if schema != SCHEMA_VERSION {
            return Err(InkError::Schema);
        }
        let title = raw.get("title").and_then(Value::as_str).unwrap_or("");
        if title.trim().is_empty() {
            return Err(InkError::Title);
        }
        let strokes_json = raw
            .get("strokes")
            .and_then(Value::as_array)
            .ok_or(InkError::Strokes)?
            .clone();
        let page_width = raw
            .get("sourceWidth")
            .and_then(Value::as_f64)
            .unwrap_or(900.0);
        let page_height = raw
            .get("sourceHeight")
            .and_then(Value::as_f64)
            .unwrap_or(1273.0);
        let origin_x = raw
            .get("sourceOriginX")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        let origin_y = raw
            .get("sourceOriginY")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        let mut doc = Self {
            points: Vec::new(),
            strokes: SlotMap::with_key(),
            live: Vec::new(),
            undo: Vec::new(),
            redo: Vec::new(),
            active: None,
            sections: Vec::new(),
            page_width,
            page_height,
            origin_x,
            origin_y,
            raw,
        };
        for entry in &strokes_json {
            let Some(object) = entry.as_object() else {
                continue;
            };
            let Some(points) = points_from_json(object.get("points")) else {
                continue;
            };
            if points.is_empty() {
                continue;
            }
            let start = doc.points.len() as u32;
            let len = points.len() as u32;
            doc.points.extend(points);
            let base_width = object
                .get("baseWidth")
                .and_then(Value::as_f64)
                .unwrap_or(4.0)
                .clamp(0.5, 48.0);
            let pressure_enabled = object
                .get("pressureEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let color = object
                .get("color")
                .and_then(Value::as_str)
                .filter(|value| is_hex_color(value))
                .unwrap_or("#1a1a1a")
                .to_string();
            let id = doc.strokes.insert(Stroke {
                start,
                len,
                base_width,
                pressure_enabled,
                color,
                raw: object.clone(),
            });
            doc.live.push(id);
        }
        Ok(doc)
    }

    pub fn to_json(&self) -> Result<String, InkError> {
        let mut raw = self.raw.clone();
        raw.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
        raw.insert("sourceWidth".into(), json_number(self.page_width));
        raw.insert("sourceHeight".into(), json_number(self.page_height));
        if self.origin_x > 0.0 {
            raw.insert("sourceOriginX".into(), json_number(self.origin_x));
        }
        if self.origin_y > 0.0 {
            raw.insert("sourceOriginY".into(), json_number(self.origin_y));
        }
        let strokes = self
            .live
            .iter()
            .filter_map(|id| self.stroke_json(*id))
            .collect::<Vec<_>>();
        raw.insert("strokes".into(), Value::Array(strokes));
        Ok(serde_json::to_string(&Value::Object(raw))?)
    }

    pub fn touch_updated_at(&mut self, iso_timestamp: &str) {
        self.raw
            .insert("updatedAt".into(), Value::from(iso_timestamp));
    }

    pub fn to_json_pretty(&self) -> Result<String, InkError> {
        let compact = self.to_json()?;
        let value: Value = serde_json::from_str(&compact)?;
        Ok(serde_json::to_string_pretty(&value)?)
    }

    fn stroke_json(&self, id: StrokeId) -> Option<Value> {
        let stroke = self.strokes.get(id)?;
        let mut raw = stroke.raw.clone();
        let points = self.stroke_points(id)?.iter().map(point_json).collect();
        raw.insert("points".into(), Value::Array(points));
        raw.insert("baseWidth".into(), json_number(stroke.base_width));
        raw.insert(
            "pressureEnabled".into(),
            Value::Bool(stroke.pressure_enabled),
        );
        raw.insert("color".into(), Value::from(stroke.color.as_str()));
        Some(Value::Object(raw))
    }
}

fn section_point(y: f64) -> StrokePoint {
    StrokePoint {
        x: 0.0,
        y,
        t: 0.0,
        pressure: 0.0,
        tilt_x: 0.0,
        tilt_y: 0.0,
        pointer: PointerKind::Section,
    }
}

fn point_json(point: &StrokePoint) -> Value {
    let mut object = Map::new();
    object.insert("x".into(), json_number(point.x));
    object.insert("y".into(), json_number(point.y));
    object.insert("t".into(), json_number(point.t));
    object.insert("pressure".into(), json_number(f64::from(point.pressure)));
    object.insert("tiltX".into(), json_number(f64::from(point.tilt_x)));
    object.insert("tiltY".into(), json_number(f64::from(point.tilt_y)));
    object.insert("pointerType".into(), Value::from(point.pointer.as_str()));
    Value::Object(object)
}

fn points_from_json(value: Option<&Value>) -> Option<Vec<StrokePoint>> {
    let array = value?.as_array()?;
    let mut points = Vec::new();
    for entry in array {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let x = object
            .get("x")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        let y = object
            .get("y")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        points.push(StrokePoint {
            x,
            y,
            t: object.get("t").and_then(Value::as_f64).unwrap_or(0.0),
            pressure: object
                .get("pressure")
                .and_then(Value::as_f64)
                .unwrap_or(0.5)
                .clamp(0.0, 1.0) as f32,
            tilt_x: object
                .get("tiltX")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .clamp(-90.0, 90.0) as f32,
            tilt_y: object
                .get("tiltY")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .clamp(-90.0, 90.0) as f32,
            pointer: PointerKind::parse(
                object
                    .get("pointerType")
                    .and_then(Value::as_str)
                    .unwrap_or("pen"),
            ),
        });
    }
    Some(points)
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn json_number(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::from(0))
}
