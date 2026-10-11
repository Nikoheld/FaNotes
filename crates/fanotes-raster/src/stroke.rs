//! Stroke model and the width rules of `fanotes/src/lib/inkStrokePaint.ts`.

use std::f64::consts::SQRT_2;
use std::sync::Arc;

use tiny_skia::Path;

/// A 3.5 px pen must occupy at least this many backing-store pixels.
pub const INK_MIN_BITMAP_PX: f64 = 1.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Brush {
    Fineliner,
    Pencil,
    Marker,
    Paintbrush,
    Calligraphy,
    Highlighter,
    Watercolor,
    Spray,
}

impl Brush {
    pub const ALL: [Brush; 8] = [
        Brush::Fineliner,
        Brush::Pencil,
        Brush::Marker,
        Brush::Paintbrush,
        Brush::Calligraphy,
        Brush::Highlighter,
        Brush::Watercolor,
        Brush::Spray,
    ];

    pub fn from_id(id: i64) -> Option<Brush> {
        usize::try_from(id)
            .ok()
            .and_then(|index| Brush::ALL.get(index).copied())
    }

    pub fn id(self) -> i64 {
        Brush::ALL
            .iter()
            .position(|brush| *brush == self)
            .unwrap_or(0) as i64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Effect {
    Solid,
    Rainbow,
    Aurora,
    Sunset,
    Ocean,
    Gold,
    Silver,
    Neon,
}

impl Effect {
    pub const ALL: [Effect; 8] = [
        Effect::Solid,
        Effect::Rainbow,
        Effect::Aurora,
        Effect::Sunset,
        Effect::Ocean,
        Effect::Gold,
        Effect::Silver,
        Effect::Neon,
    ];

    pub fn from_id(id: i64) -> Effect {
        usize::try_from(id)
            .ok()
            .and_then(|index| Effect::ALL.get(index).copied())
            .unwrap_or(Effect::Solid)
    }

    pub fn id(self) -> i64 {
        Effect::ALL
            .iter()
            .position(|effect| *effect == self)
            .unwrap_or(0) as i64
    }

    /// Gradient stops of a special ink, or `None` for a solid color.
    pub fn stops(self) -> Option<&'static [(f32, u32)]> {
        match self {
            Effect::Solid => None,
            Effect::Rainbow => Some(&[
                (0.0, 0xff4d6d),
                (0.17, 0xffb13b),
                (0.34, 0xe9e34a),
                (0.51, 0x48ce87),
                (0.68, 0x3aa8ff),
                (0.84, 0x815cff),
                (1.0, 0xe84dba),
            ]),
            Effect::Aurora => Some(&[
                (0.0, 0x68f6ca),
                (0.34, 0x32b9ef),
                (0.68, 0x7968f4),
                (1.0, 0xe85bd2),
            ]),
            Effect::Sunset => Some(&[
                (0.0, 0xffcf59),
                (0.36, 0xff754e),
                (0.68, 0xd84dba),
                (1.0, 0x694ee8),
            ]),
            Effect::Ocean => Some(&[
                (0.0, 0x62ead5),
                (0.36, 0x1eb6db),
                (0.7, 0x2671df),
                (1.0, 0x4036a9),
            ]),
            Effect::Gold => Some(&[
                (0.0, 0x7c5013),
                (0.24, 0xf7d779),
                (0.5, 0xb27620),
                (0.76, 0xfff0a8),
                (1.0, 0x8b5914),
            ]),
            Effect::Silver => Some(&[
                (0.0, 0x59616d),
                (0.24, 0xf5f7fb),
                (0.5, 0x8b929d),
                (0.76, 0xffffff),
                (1.0, 0x626975),
            ]),
            Effect::Neon => Some(&[
                (0.0, 0x45ffe6),
                (0.34, 0x5e8bff),
                (0.68, 0xdb55ff),
                (1.0, 0xff4ba8),
            ]),
        }
    }
}

/// An art stamp: SVG paths in a 24 × 24 box.
#[derive(Clone, Debug)]
pub struct Symbol {
    pub paths: Vec<Path>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
}

/// One stroke as `drawInkStroke` receives it. Points are 0–1 of the page.
#[derive(Clone, Debug)]
pub struct InkStroke {
    pub points: Vec<InkPoint>,
    pub base_width: f64,
    pub pressure_enabled: bool,
    pub color: u32,
    /// `purpose === 'art'`.
    pub art: bool,
    pub brush: Option<Brush>,
    pub effect: Effect,
    pub opacity: Option<f64>,
    pub texture_seed: Option<f64>,
    pub symbol: Option<Arc<Symbol>>,
    pub symbol_rotation: f64,
}

impl InkStroke {
    pub fn pen(points: Vec<InkPoint>, base_width: f64, color: u32) -> Self {
        Self {
            points,
            base_width,
            pressure_enabled: true,
            color,
            art: false,
            brush: None,
            effect: Effect::Solid,
            opacity: None,
            texture_seed: None,
            symbol: None,
            symbol_rotation: 0.0,
        }
    }

    pub(crate) fn has_symbol(&self) -> bool {
        self.symbol
            .as_ref()
            .is_some_and(|symbol| !symbol.paths.is_empty())
    }
}

pub(crate) fn clamp(value: f64, min: f64, max: f64) -> f64 {
    min.max(max.min(value))
}

pub fn pressure_width(base_width: f64, pressure_enabled: bool, pressure: f64) -> f64 {
    if !pressure_enabled {
        return base_width;
    }
    base_width * (0.4 + pressure.max(0.08) * 1.12)
}

/// Bitmap px per layout px: `inkStrokePaintScale`.
pub fn ink_stroke_paint_scale(bitmap_width: f64, layout_width: f64) -> f64 {
    let layout = if layout_width > 1.0 {
        layout_width
    } else {
        bitmap_width
    };
    if !(bitmap_width > 0.0) || !(layout > 0.0) {
        return 1.0;
    }
    bitmap_width / layout
}

/// Bitmap px for a CSS pen so a normal stroke cannot collapse to a hairline.
pub fn ink_stroke_bitmap_width(stroke: &InkStroke, pressure: f64, scale: f64) -> f64 {
    INK_MIN_BITMAP_PX
        .max(pressure_width(stroke.base_width, stroke.pressure_enabled, pressure) * scale)
}

/// How far, in bitmap px, any paint of this stroke can reach from its points.
pub fn ink_stroke_paint_margin(stroke: &InkStroke, scale: f64) -> f64 {
    if stroke.has_symbol() {
        return stroke.base_width * scale * SQRT_2 + 2.0;
    }
    let widest = ink_stroke_bitmap_width(stroke, 1.0, scale) * 1.5;
    let glow = if stroke.effect == Effect::Neon {
        (stroke.base_width * scale * 0.85).max(4.0) * 2.0
    } else {
        0.0
    };
    widest / 2.0 + glow + 2.0
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Pass {
    pub width_factor: f64,
    pub alpha: f64,
    /// Pencil grain: per-segment offset in bitmap px per unit scale.
    pub jitter: Option<f64>,
}

const OPAQUE_PASS: [Pass; 1] = [Pass {
    width_factor: 1.0,
    alpha: 1.0,
    jitter: None,
}];
const PENCIL: [Pass; 3] = [
    Pass {
        width_factor: 0.72,
        alpha: 0.58,
        jitter: None,
    },
    Pass {
        width_factor: 0.22,
        alpha: 0.2,
        jitter: Some(1.4),
    },
    Pass {
        width_factor: 0.18,
        alpha: 0.14,
        jitter: Some(1.8),
    },
];
const PAINTBRUSH: [Pass; 2] = [
    Pass {
        width_factor: 1.4,
        alpha: 0.16,
        jitter: None,
    },
    Pass {
        width_factor: 0.92,
        alpha: 0.82,
        jitter: None,
    },
];
const HIGHLIGHTER: [Pass; 1] = [Pass {
    width_factor: 1.0,
    alpha: 0.34,
    jitter: None,
}];
const WATERCOLOR: [Pass; 3] = [
    Pass {
        width_factor: 1.48,
        alpha: 0.11,
        jitter: None,
    },
    Pass {
        width_factor: 1.14,
        alpha: 0.17,
        jitter: None,
    },
    Pass {
        width_factor: 0.78,
        alpha: 0.27,
        jitter: None,
    },
];
const MARKER: [Pass; 1] = [Pass {
    width_factor: 1.0,
    alpha: 0.9,
    jitter: None,
}];

/// Stroked passes of a brush, widest first.
pub(crate) fn brush_passes(brush: Brush) -> &'static [Pass] {
    match brush {
        Brush::Pencil => &PENCIL,
        Brush::Paintbrush => &PAINTBRUSH,
        Brush::Highlighter => &HIGHLIGHTER,
        Brush::Watercolor => &WATERCOLOR,
        Brush::Marker => &MARKER,
        _ => &OPAQUE_PASS,
    }
}

pub(crate) fn opaque_pass() -> &'static [Pass] {
    &OPAQUE_PASS
}

pub(crate) fn ink_brush_of(stroke: &InkStroke) -> Brush {
    if stroke.art {
        stroke.brush.unwrap_or(Brush::Fineliner)
    } else {
        Brush::Fineliner
    }
}

pub(crate) fn ink_opacity_of(stroke: &InkStroke) -> f64 {
    if stroke.art {
        clamp(stroke.opacity.unwrap_or(1.0), 0.08, 1.0)
    } else {
        1.0
    }
}

/// A stroke whose paint is see-through. It is painted opaque on a scratch
/// layer and composited once, so overlapping segments cannot band.
pub fn ink_stroke_is_translucent(stroke: &InkStroke) -> bool {
    if !stroke.art || stroke.has_symbol() {
        return false;
    }
    let brush = ink_brush_of(stroke);
    if brush == Brush::Spray {
        return false;
    }
    if ink_opacity_of(stroke) < 0.999 {
        return true;
    }
    brush_passes(brush).iter().any(|pass| pass.alpha < 0.999)
}

pub(crate) fn seeded_unit(seed: f64) -> f64 {
    let value = (seed * 12.9898 + 78.233).sin() * 43_758.545_3;
    value - value.floor()
}

/// `Math.round`: halves round toward +∞.
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}
