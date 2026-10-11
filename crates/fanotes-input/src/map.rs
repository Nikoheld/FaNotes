use fanotes_paper::SCROLL_ROOM;

use crate::jump::{resolve_ink_jump_append, JumpAction};

#[derive(Clone, Debug, PartialEq)]
pub struct PaperSurface {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub offset_width: Option<f64>,
    pub offset_height: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PointerEvent {
    pub kind: Option<String>,
    pub client_x: Option<f64>,
    pub client_y: Option<f64>,
    pub time_stamp: Option<f64>,
    pub pressure: Option<f64>,
    pub pointer_type: Option<String>,
    pub tilt_x: Option<f64>,
    pub tilt_y: Option<f64>,
    pub predicted: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MappedInkPoint {
    pub x: f64,
    pub y: f64,
    pub t: f64,
    pub pressure: f64,
    pub tilt_x: f64,
    pub tilt_y: f64,
    pub pointer_type: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PointerDown {
    pub first_point: Option<MappedInkPoint>,
    pub open_stroke: bool,
    pub commit_first: bool,
}

pub fn resolve_ink_finish_sample(
    kind: Option<&str>,
    client_x: Option<f64>,
    client_y: Option<f64>,
) -> Option<(f64, f64)> {
    let kind = kind.unwrap_or("");
    if kind == "pointercancel" || kind == "lostpointercapture" {
        return None;
    }
    let (Some(x), Some(y)) = (client_x, client_y) else {
        return None;
    };
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some((x, y))
}

pub fn resolve_ink_pointer_down(
    event: &PointerEvent,
    surface: Option<&PaperSurface>,
    rotation: f64,
) -> PointerDown {
    if event.kind.as_deref() == Some("pointercancel")
        || event.kind.as_deref() == Some("lostpointercapture")
    {
        return PointerDown {
            first_point: None,
            open_stroke: false,
            commit_first: false,
        };
    }
    let first_point = map_client_to_paper_point(event, surface, rotation);
    PointerDown {
        commit_first: first_point.is_some(),
        open_stroke: true,
        first_point,
    }
}

pub fn map_client_to_paper_point(
    event: &PointerEvent,
    surface: Option<&PaperSurface>,
    rotation: f64,
) -> Option<MappedInkPoint> {
    let surface = surface?;
    if surface.width < 1.0 || surface.height < 1.0 {
        return None;
    }
    let (Some(client_x), Some(client_y)) = (event.client_x, event.client_y) else {
        return None;
    };
    if !client_x.is_finite() || !client_y.is_finite() {
        return None;
    }
    if client_x == 0.0 && client_y == 0.0 {
        let paper_corner_at_origin = surface.left.abs() <= 8.0 && surface.top.abs() <= 8.0;
        let pressure = event.pressure.unwrap_or(0.0);
        if !paper_corner_at_origin || !pressure.is_finite() || pressure <= 0.0 {
            return None;
        }
    }
    let paper_w = surface.offset_width.unwrap_or(surface.width).max(1.0);
    let paper_h = surface.offset_height.unwrap_or(surface.height).max(1.0);
    let hit_room_x = SCROLL_ROOM * (surface.width / paper_w);
    let hit_room_y = SCROLL_ROOM * (surface.height / paper_h);
    let pad_x = hit_room_x.max(48.0);
    let pad_y = hit_room_y.max(48.0);
    if client_x < surface.left - pad_x
        || client_x > surface.left + surface.width + pad_x
        || client_y < surface.top - pad_y
        || client_y > surface.top + surface.height + pad_y
    {
        return None;
    }
    let visual_x = (client_x - surface.left) / surface.width;
    let visual_y = (client_y - surface.top) / surface.height;
    if !visual_x.is_finite() || !visual_y.is_finite() {
        return None;
    }
    let edge_slop_x = (pad_x / surface.width.max(1.0)).max(0.04);
    let edge_slop_y = (pad_y / surface.height.max(1.0)).max(0.04);
    if visual_x < -edge_slop_x
        || visual_x > 1.0 + edge_slop_x
        || visual_y < -edge_slop_y
        || visual_y > 1.0 + edge_slop_y
    {
        return None;
    }
    let (paper_local_x, paper_local_y) = if rotation.abs() > 0.01 {
        let rad = (-rotation * std::f64::consts::PI) / 180.0;
        let (sin, cos) = rad.sin_cos();
        let dx = (visual_x - 0.5) * paper_w;
        let dy = (visual_y - 0.5) * paper_h;
        (
            dx * cos - dy * sin + paper_w / 2.0,
            dx * sin + dy * cos + paper_h / 2.0,
        )
    } else {
        (visual_x * paper_w, visual_y * paper_h)
    };
    let x = paper_local_x / paper_w;
    let y = paper_local_y / paper_h;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let raw_pressure = if event.pressure.unwrap_or(0.0) > 0.0 {
        event.pressure.unwrap_or(0.0)
    } else if event.pointer_type.as_deref() == Some("mouse") {
        0.55
    } else {
        0.35
    };
    Some(MappedInkPoint {
        x,
        y,
        t: ((event.time_stamp.unwrap_or(0.0) * 100.0).round()) / 100.0,
        pressure: (raw_pressure.clamp(0.0, 1.0) * 1_000.0).round() / 1_000.0,
        tilt_x: event.tilt_x.unwrap_or(0.0),
        tilt_y: event.tilt_y.unwrap_or(0.0),
        pointer_type: event.pointer_type.clone().unwrap_or_else(|| "mouse".into()),
    })
}

pub fn append_accepted_ink_point(
    points: &mut Vec<MappedInkPoint>,
    event: &PointerEvent,
    surface: Option<&PaperSurface>,
    _source_width: f64,
    _source_height: f64,
    rotation: f64,
) -> JumpAction {
    if event.predicted || !usable(event) {
        return JumpAction::Skip;
    }
    let Some(mapped) = map_client_to_paper_point(event, surface, rotation) else {
        return JumpAction::Skip;
    };
    resolve_ink_jump_append(points, mapped)
}

fn usable(event: &PointerEvent) -> bool {
    if event.kind.as_deref() == Some("pointercancel")
        || event.kind.as_deref() == Some("lostpointercapture")
    {
        return false;
    }
    matches!((event.client_x, event.client_y), (Some(x), Some(y)) if x.is_finite() && y.is_finite())
}
