//! `drawInkStroke` as draw ops, committed and incremental.
//!
//! [`build_stroke_ops`] is a branch-by-branch port of `draw_ink_stroke` in
//! `fanotes-raster` (itself the port of `inkStrokePaint.ts`), emitting ops
//! instead of painting. Widths come from `fanotes_raster::pressure_width` and
//! the brush pass table from `fanotes_raster::brush_passes`, so the three
//! painters share one width rule.
//!
//! [`LiveStroke`] builds the same ops one sample at a time. A segment's curve
//! depends on the samples around it (the smoothing pull looks one sample
//! ahead), so appending sample `n` finalizes segment `n - 1` and leaves only
//! segment `n` provisional: O(1) work per sample, whatever the stroke length.
//!
//! Points are page px. Geometry is emitted in build px (`page px * scale`).

use std::f64::consts::{PI, SQRT_2};

use fanotes_raster::{
    brush_passes, ink_brush_of, ink_opacity_of, ink_quick_turn_keep, ink_stroke_bitmap_width,
    ink_stroke_is_translucent, seeded_unit, Brush, Effect, InkPoint, InkStroke, Pass,
};
use kurbo::{Affine, BezPath, PathEl, Point};
use tiny_skia::PathSegment;

use crate::ops::{p, Cap, Glow, Ink, Op, OpSource, StrokeOps, P};

const OPAQUE: [Pass; 1] = [Pass {
    width_factor: 1.0,
    alpha: 1.0,
    jitter: None,
}];

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    min.max(max.min(value))
}

/// `Math.round`: halves round toward +∞.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `inkInteriorPull` in `inkStrokePaint.ts`.
fn interior_pull(smoothing: f64, leg_px: f64, nib_px: f64) -> f64 {
    let wanted = clamp(smoothing, 0.0, 1.0) * 0.85;
    if leg_px <= 0.01 || nib_px <= 0.0 {
        return wanted;
    }
    wanted.min((nib_px * 0.35) / leg_px)
}

pub(crate) fn has_symbol(stroke: &InkStroke) -> bool {
    stroke
        .symbol
        .as_ref()
        .is_some_and(|symbol| !symbol.paths.is_empty())
}

/// Ink of a stroke at `scale` on a `page` (page px) sheet.
pub fn stroke_ink(stroke: &InkStroke, page: (f64, f64), scale: f64) -> Ink {
    match stroke.effect.stops() {
        None => Ink::Solid(stroke.color),
        Some(stops) => Ink::Gradient {
            start: [0.0, page.1 * scale * 0.08],
            end: [page.0 * scale, page.1 * scale * 0.28],
            stops,
        },
    }
}

fn stroke_glow(stroke: &InkStroke, scale: f64) -> Option<Glow> {
    (stroke.effect == Effect::Neon).then(|| Glow {
        color: stroke.color,
        blur: (stroke.base_width * scale * 0.85).max(4.0) as f32,
    })
}

/// The point/width/offset helpers of the tiny-skia `Strokes` painter.
struct Geo<'a> {
    style: &'a InkStroke,
    points: &'a [InkPoint],
    scale: f64,
    smoothing: f64,
}

/// A segment curve: start (used when not connected), optional control, end.
struct Curve {
    start: (f64, f64),
    ctrl: Option<(f64, f64)>,
    end: (f64, f64),
}

impl Geo<'_> {
    fn px(&self, index: usize) -> f64 {
        self.points[index].x * self.scale
    }

    fn py(&self, index: usize) -> f64 {
        self.points[index].y * self.scale
    }

    fn pressure(&self, index: usize) -> f64 {
        self.points[index].pressure
    }

    fn bitmap_width(&self, pressure: f64) -> f64 {
        ink_stroke_bitmap_width(self.style, pressure, self.scale)
    }

    fn nib_between(&self, left: usize, right: usize) -> f64 {
        self.bitmap_width((self.pressure(left) + self.pressure(right)) / 2.0)
    }

    /// `segmentEnd`: where the segment that arrives at `sample` ends.
    fn segment_end(&self, sample: usize, point_count: usize) -> (f64, f64) {
        let sx = self.px(sample);
        let sy = self.py(sample);
        if self.smoothing <= 0.0 || sample + 1 >= point_count {
            return (sx, sy);
        }
        let nx = self.px(sample + 1);
        let ny = self.py(sample + 1);
        let before = if sample > 0 { sample - 1 } else { sample };
        let pull = interior_pull(
            self.smoothing,
            (nx - sx).hypot(ny - sy),
            self.nib_between(before, sample)
                .min(self.nib_between(sample, sample + 1)),
        );
        (sx + (nx - sx) * pull * 0.5, sy + (ny - sy) * pull * 0.5)
    }

    /// Curve of segment `index` (points `index - 1` → `index`). The open tip is the chord.
    fn segment_curve(&self, index: usize, ox: f64, oy: f64, point_count: usize) -> Curve {
        let point = (self.px(index) + ox, self.py(index) + oy);
        let (sx, sy) = if index <= 1 {
            (self.px(0), self.py(0))
        } else {
            self.segment_end(index - 1, point_count)
        };
        let start = (sx + ox, sy + oy);
        if self.smoothing > 0.0 && index + 1 < point_count {
            let (ex, ey) = self.segment_end(index, point_count);
            if (ex + ox - point.0).hypot(ey + oy - point.1) > 0.15 {
                return Curve {
                    start,
                    ctrl: Some(point),
                    end: (ex + ox, ey + oy),
                };
            }
        }
        Curve {
            start,
            ctrl: None,
            end: point,
        }
    }

    fn segment_width(&self, index: usize, width_factor: f64) -> f64 {
        self.nib_between(index - 1, index) * width_factor
    }

    fn pass_offset(&self, pass: &Pass, pass_index: usize, index: usize) -> (f64, f64) {
        let Some(jitter) = pass.jitter else {
            return (0.0, 0.0);
        };
        let seed = self.style.texture_seed.unwrap_or(1.0)
            + index as f64 * 53.0
            + (pass_index as f64 - 1.0) * 2.0;
        (
            (seeded_unit(seed) - 0.5) * self.scale * jitter,
            (seeded_unit(seed + 1.0) - 0.5) * self.scale * jitter,
        )
    }

    fn short(&self, index: usize) -> bool {
        (self.px(index) - self.px(index - 1)).hypot(self.py(index) - self.py(index - 1)) < 0.2
    }

    /// `paintPassSegments`, one segment.
    fn pass_segment(
        &self,
        out: &mut Vec<Op>,
        pass: &Pass,
        pass_index: usize,
        index: usize,
        count: usize,
    ) {
        if self.short(index) {
            return;
        }
        let (ox, oy) = self.pass_offset(pass, pass_index, index);
        let curve = self.segment_curve(index, ox, oy, count);
        out.push(Op::Seg {
            a: p(curve.start.0, curve.start.1),
            c: curve.ctrl.map(|c| p(c.0, c.1)),
            b: p(curve.end.0, curve.end.1),
            width: self.segment_width(index, pass.width_factor) as f32,
        });
    }

    /// One element run of the constant-width path for segment `index`.
    fn path_segment(&self, path: &mut BezPath, index: usize, connected: bool, point_count: usize) {
        let curve = self.segment_curve(index, 0.0, 0.0, point_count);
        if !connected {
            path.move_to(curve.start);
        }
        match curve.ctrl {
            Some(ctrl) => path.quad_to(ctrl, curve.end),
            None => path.line_to(curve.end),
        }
    }

    fn marker_radius(&self) -> f64 {
        self.segment_width(1, 1.0) / 2.0
    }

    /// Marker fillet at corner `index` (needs `index + 1`). Moves `cursor`.
    fn marker_corner(&self, path: &mut BezPath, index: usize, cursor: &mut (f64, f64)) {
        let radius = self.marker_radius();
        let smooth = clamp(self.smoothing, 0.0, 1.0);
        let (ax, ay) = (self.px(index - 1), self.py(index - 1));
        let (bx, by) = (self.px(index), self.py(index));
        let (cx, cy) = (self.px(index + 1), self.py(index + 1));
        let (in_x, in_y) = (bx - ax, by - ay);
        let (out_x, out_y) = (cx - bx, cy - by);
        let in_len = in_x.hypot(in_y);
        let out_len = out_x.hypot(out_y);
        if in_len < 0.01 || out_len < 0.01 {
            path.line_to((bx, by));
            *cursor = (bx, by);
            return;
        }
        let dot = clamp(
            (in_x * out_x + in_y * out_y) / (in_len * out_len),
            -1.0,
            1.0,
        );
        let turn = dot.acos();
        let sin_half = (turn / 2.0).sin();
        let mut trim = 0.0;
        if sin_half > 0.02 {
            let max_by_nib = (1.7 * radius) / sin_half;
            let max_by_leg = 0.45 * in_len.min(out_len);
            trim = max_by_nib.min(max_by_leg) * smooth;
        }
        if trim < 0.75 {
            path.line_to((bx, by));
            *cursor = (bx, by);
            return;
        }
        let start = (bx - (in_x / in_len) * trim, by - (in_y / in_len) * trim);
        let end = (bx + (out_x / out_len) * trim, by + (out_y / out_len) * trim);
        if (start.0 - cursor.0).hypot(start.1 - cursor.1) > 0.4 {
            path.line_to(start);
        }
        path.quad_to((bx, by), end);
        *cursor = end;
    }

    fn spray_segment(
        &self,
        out: &mut Vec<Op>,
        previous: usize,
        point: usize,
        index: usize,
        opacity: f64,
    ) {
        let (x0, y0) = (self.px(previous), self.py(previous));
        let (x1, y1) = (self.px(point), self.py(point));
        let radius = self.nib_between(previous, point) / 2.0;
        let particles = js_round(clamp(self.style.base_width * 0.68, 6.0, 24.0)) as usize;
        let seed = self.style.texture_seed.unwrap_or(1.0);
        for particle in 0..particles {
            let key = seed + index as f64 * 1_009.0 + particle as f64 * 37.0;
            let progress = seeded_unit(key + 1.0);
            let angle = seeded_unit(key + 2.0) * PI * 2.0;
            let spread = seeded_unit(key + 3.0).sqrt() * radius;
            let x = x0 + (x1 - x0) * progress + angle.cos() * spread;
            let y = y0 + (y1 - y0) * progress + angle.sin() * spread;
            let r = 0.35_f64.max(self.scale * (0.28 + seeded_unit(key + 4.0) * 0.62));
            out.push(Op::Alpha(
                (opacity * (0.2 + seeded_unit(key + 5.0) * 0.5)) as f32,
            ));
            out.push(Op::Dot {
                c: p(x, y),
                r: r as f32,
            });
        }
    }

    fn calligraphy_nib(&self, out: &mut Vec<Op>, previous: usize, point: usize) {
        let (x0, y0) = (self.px(previous), self.py(previous));
        let (x1, y1) = (self.px(point), self.py(point));
        let nib = self.nib_between(previous, point);
        let nx = (-PI * 0.22).cos() * nib / 2.0;
        let ny = (-PI * 0.22).sin() * nib / 2.0;
        out.push(Op::Quad([
            p(x0 + nx, y0 + ny),
            p(x1 + nx, y1 + ny),
            p(x1 - nx, y1 - ny),
            p(x0 - nx, y0 - ny),
        ]));
    }

    /// The single-sample tap of each brush.
    fn tap(&self, out: &mut Vec<Op>, brush: Brush, opacity: f64) {
        let first = self.points[0];
        let (x, y) = (first.x * self.scale, first.y * self.scale);
        match brush {
            Brush::Spray => self.spray_segment(out, 0, 0, 0, opacity),
            Brush::Calligraphy => {
                let nib = self.bitmap_width(first.pressure);
                out.push(Op::Alpha(opacity as f32));
                out.push(Op::Ellipse {
                    c: p(x, y),
                    rx: (nib / 2.0) as f32,
                    ry: 0.5_f64.max(nib * 0.16) as f32,
                    rotation: (-PI * 0.22) as f32,
                });
            }
            Brush::Highlighter => {
                // The highlighter multiplies even its tap.
                out.push(Op::PushLayer {
                    alpha: 1.0,
                    multiply: true,
                });
                out.push(Op::Alpha((opacity * 0.32) as f32));
                out.push(Op::Dot {
                    c: p(x, y),
                    r: (self.bitmap_width(first.pressure) / 2.0) as f32,
                });
                out.push(Op::PopLayer);
            }
            _ => {
                out.push(Op::Alpha(opacity as f32));
                out.push(Op::Dot {
                    c: p(x, y),
                    r: (self.bitmap_width(first.pressure) / 2.0) as f32,
                });
            }
        }
    }
}

fn symbol_ops(stroke: &InkStroke, scale: f64, opacity: f64, ink: Ink) -> (Vec<Op>, Ink) {
    let mut ops = Vec::new();
    let Some(symbol) = stroke.symbol.as_ref() else {
        return (ops, ink);
    };
    let first = stroke.points[0];
    let symbol_scale = stroke.base_width * scale / 24.0;
    let transform = Affine::translate((first.x * scale, first.y * scale))
        * Affine::rotate(stroke.symbol_rotation * PI / 180.0)
        * Affine::scale(symbol_scale)
        * Affine::translate((-12.0, -12.0));
    ops.push(Op::Alpha(opacity as f32));
    ops.push(Op::Cap(Cap::Round));
    for path in &symbol.paths {
        let mut out = BezPath::new();
        for segment in path.segments() {
            let map = |pt: tiny_skia::Point| transform * Point::new(pt.x as f64, pt.y as f64);
            match segment {
                PathSegment::MoveTo(a) => out.move_to(map(a)),
                PathSegment::LineTo(a) => out.line_to(map(a)),
                PathSegment::QuadTo(a, b) => out.quad_to(map(a), map(b)),
                PathSegment::CubicTo(a, b, c) => out.curve_to(map(a), map(b), map(c)),
                PathSegment::Close => out.close_path(),
            }
        }
        ops.push(Op::Path {
            path: out,
            width: (1.75 * symbol_scale) as f32,
        });
    }
    // Canvas maps gradient coordinates through the transform current at draw time.
    let ink = match ink {
        Ink::Gradient { start, end, stops } => {
            let s = transform * Point::new(start[0], start[1]);
            let e = transform * Point::new(end[0], end[1]);
            Ink::Gradient {
                start: [s.x, s.y],
                end: [e.x, e.y],
                stops,
            }
        }
        solid => solid,
    };
    (ops, ink)
}

/// Committed ops of a whole stroke: `drawInkStroke(…, 1, …, points.length)`.
///
/// `stroke.points` are page px; `page` is the sheet size in page px (only the
/// special-ink gradient reads it); `scale` is device px per page px.
pub fn build_stroke_ops(
    stroke: &InkStroke,
    page: (f64, f64),
    scale: f64,
    smoothing: f64,
) -> StrokeOps {
    let ink = stroke_ink(stroke, page, scale);
    let mut out = StrokeOps {
        scale,
        ink,
        glow: stroke_glow(stroke, scale),
        ops: Vec::new(),
    };
    let count = stroke.points.len();
    if count == 0 || !(scale > 0.0) {
        return out;
    }
    let brush = ink_brush_of(stroke);
    let opacity = ink_opacity_of(stroke);
    if has_symbol(stroke) {
        let (ops, ink) = symbol_ops(stroke, scale, opacity, ink);
        out.ops = ops;
        out.ink = ink;
        return out;
    }
    // A paint through the stroke's end drops a lift hook inside the nib.
    let mut points = &stroke.points[..];
    if count > 1 {
        let nib = ink_stroke_bitmap_width(stroke, stroke.points[count - 1].pressure, scale);
        let keep = ink_quick_turn_keep(&stroke.points, scale, scale, nib);
        if keep + 1 < count {
            points = &stroke.points[..keep + 1];
        }
    }
    let count = points.len();
    let geo = Geo {
        style: stroke,
        points,
        scale,
        smoothing,
    };
    let ops = &mut out.ops;
    if count == 1 {
        geo.tap(ops, brush, opacity);
        return out;
    }
    if brush == Brush::Spray {
        for index in 1..count {
            geo.spray_segment(ops, index - 1, index, index, opacity);
        }
        return out;
    }
    let passes: &[Pass] = if brush == Brush::Calligraphy {
        &OPAQUE
    } else {
        brush_passes(brush)
    };
    let constant_width = !stroke.pressure_enabled;
    let translucent = ink_stroke_is_translucent(stroke);
    let multiply = brush == Brush::Highlighter;
    // Direct paint keeps canvas state across passes, like the context does.
    let mut direct_cap = Cap::Round;
    for (pass_index, pass) in passes.iter().enumerate() {
        let alpha = opacity * pass.alpha;
        if translucent && alpha < 0.999 {
            ops.push(Op::PushLayer {
                alpha: alpha as f32,
                multiply,
            });
            ops.push(Op::Alpha(1.0));
            ops.push(Op::Cap(if multiply && constant_width {
                Cap::Butt
            } else {
                Cap::Round
            }));
            if brush == Brush::Calligraphy {
                for index in 1..count {
                    geo.calligraphy_nib(ops, index - 1, index);
                }
            } else if brush == Brush::Marker {
                marker_path(&geo, ops);
            } else if constant_width {
                constant_path(&geo, ops, pass);
            } else {
                for index in 1..count {
                    geo.pass_segment(ops, pass, pass_index, index, count);
                }
            }
            ops.push(Op::PopLayer);
            continue;
        }
        if brush == Brush::Calligraphy {
            ops.push(Op::Alpha(opacity as f32));
            for index in 1..count {
                geo.calligraphy_nib(ops, index - 1, index);
            }
            continue;
        }
        if brush == Brush::Marker {
            direct_cap = Cap::Round;
            ops.push(Op::Alpha(alpha as f32));
            ops.push(Op::Cap(direct_cap));
            marker_path(&geo, ops);
            continue;
        }
        if multiply {
            direct_cap = Cap::Butt;
        }
        ops.push(Op::Alpha(alpha as f32));
        ops.push(Op::Cap(direct_cap));
        if multiply {
            ops.push(Op::PushLayer {
                alpha: 1.0,
                multiply: true,
            });
        }
        for index in 1..count {
            geo.pass_segment(ops, pass, pass_index, index, count);
        }
        if multiply {
            ops.push(Op::PopLayer);
        }
    }
    out
}

/// `paintPassPath`: constant width, one path, a trailing stub inside the nib dropped.
fn constant_path(geo: &Geo, ops: &mut Vec<Op>, pass: &Pass) {
    let count = geo.points.len();
    let width = geo.segment_width(1, pass.width_factor);
    let mut end = count;
    if end - 1 > 1 {
        let stub = (geo.px(end - 1) - geo.px(end - 2)).hypot(geo.py(end - 1) - geo.py(end - 2));
        if stub < width * 0.3 {
            end -= 1;
        }
    }
    let mut path = BezPath::new();
    for index in 1..end {
        geo.path_segment(&mut path, index, index > 1, end);
    }
    ops.push(Op::Path {
        path,
        width: width as f32,
    });
}

/// `paintMarkerStroke`: centerline with a quadratic fillet inside each corner.
fn marker_path(geo: &Geo, ops: &mut Vec<Op>) {
    let count = geo.points.len();
    let width = geo.segment_width(1, 1.0);
    let mut path = BezPath::new();
    path.move_to((geo.px(0), geo.py(0)));
    let to = count - 1;
    let smooth = clamp(geo.smoothing, 0.0, 1.0);
    if smooth <= 0.0 || to < 2 {
        for index in 1..=to {
            path.line_to((geo.px(index), geo.py(index)));
        }
    } else {
        let mut cursor = (geo.px(0), geo.py(0));
        for index in 1..to {
            geo.marker_corner(&mut path, index, &mut cursor);
        }
        path.line_to((geo.px(to), geo.py(to)));
    }
    ops.push(Op::Path {
        path,
        width: width as f32,
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Symbol,
    Spray,
    Calligraphy,
    Marker,
    Path,
    Segments,
}

#[derive(Clone, Debug)]
struct PassPlan {
    pass: Pass,
    index: usize,
    layer: Option<(f32, bool)>,
    alpha: f32,
    cap: Cap,
}

/// The wet stroke, built one sample at a time.
///
/// Each [`push`](Self::push) appends the segments that just became final and
/// nothing else. The provisional tip (the newest segment, whose curve still
/// depends on the next sample) is derived on the fly when the ops are visited.
/// A highlighter or other translucent pass stays one composited group, so
/// overlapping segments of the wet stroke never band.
#[derive(Clone, Debug)]
pub struct LiveStroke {
    stroke: InkStroke,
    page: (f64, f64),
    scale: f64,
    smoothing: f64,
    kind: Kind,
    brush: Brush,
    opacity: f64,
    plans: Vec<PassPlan>,
    finals: Vec<Vec<Op>>,
    paths: Vec<BezPath>,
    marker_cursor: (f64, f64),
    /// Segments `1..=finalized` are final.
    finalized: usize,
    symbol: Option<(Vec<Op>, Ink)>,
}

impl LiveStroke {
    /// `style` gives brush, width and color; its points are ignored.
    pub fn new(style: &InkStroke, page: (f64, f64), scale: f64, smoothing: f64) -> Self {
        let mut stroke = style.clone();
        stroke.points.clear();
        let brush = ink_brush_of(&stroke);
        let opacity = ink_opacity_of(&stroke);
        let kind = if has_symbol(&stroke) {
            Kind::Symbol
        } else if brush == Brush::Spray {
            Kind::Spray
        } else if brush == Brush::Calligraphy {
            Kind::Calligraphy
        } else if brush == Brush::Marker {
            Kind::Marker
        } else {
            Kind::Segments
        };
        let translucent = ink_stroke_is_translucent(&stroke);
        let multiply = brush == Brush::Highlighter;
        let constant = !stroke.pressure_enabled;
        let passes: &[Pass] = match kind {
            Kind::Symbol | Kind::Spray | Kind::Calligraphy => &OPAQUE,
            _ => brush_passes(brush),
        };
        let mut kind = kind;
        let mut plans = Vec::new();
        let mut direct_cap = Cap::Round;
        for (index, pass) in passes.iter().enumerate() {
            let alpha = opacity * pass.alpha;
            let layered = translucent && alpha < 0.999;
            let cap = if layered {
                if multiply && constant {
                    Cap::Butt
                } else {
                    Cap::Round
                }
            } else {
                if kind == Kind::Marker {
                    direct_cap = Cap::Round;
                } else if multiply {
                    direct_cap = Cap::Butt;
                }
                direct_cap
            };
            if layered && constant && kind == Kind::Segments {
                kind = Kind::Path;
            }
            plans.push(PassPlan {
                pass: *pass,
                index,
                layer: if layered {
                    Some((alpha as f32, multiply))
                } else if multiply {
                    Some((1.0, true))
                } else {
                    None
                },
                alpha: if layered {
                    1.0
                } else if kind == Kind::Calligraphy {
                    opacity as f32
                } else {
                    alpha as f32
                },
                cap,
            });
        }
        let pass_count = plans.len();
        Self {
            stroke,
            page,
            scale,
            smoothing,
            kind,
            brush,
            opacity,
            plans,
            finals: vec![Vec::new(); pass_count],
            paths: vec![BezPath::new(); pass_count],
            marker_cursor: (0.0, 0.0),
            finalized: 0,
            symbol: None,
        }
    }

    pub fn points(&self) -> &[InkPoint] {
        &self.stroke.points
    }

    pub fn style(&self) -> &InkStroke {
        &self.stroke
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }

    /// Final ops held so far (for the O(1) checks).
    pub fn final_op_count(&self) -> usize {
        self.finals.iter().map(Vec::len).sum::<usize>()
            + self
                .paths
                .iter()
                .map(|path| path.elements().len())
                .sum::<usize>()
    }

    /// The committed stroke this wet stroke becomes on pen up.
    pub fn to_stroke(&self) -> InkStroke {
        self.stroke.clone()
    }

    fn geo(&self) -> Geo<'_> {
        Geo {
            style: &self.stroke,
            points: &self.stroke.points,
            scale: self.scale,
            smoothing: self.smoothing,
        }
    }

    /// Append one sample (page px). O(1): only the segment it completes is built.
    pub fn push(&mut self, point: InkPoint) {
        self.stroke.points.push(point);
        let count = self.stroke.points.len();
        if self.kind == Kind::Symbol {
            if count == 1 {
                let ink = stroke_ink(&self.stroke, self.page, self.scale);
                self.symbol = Some(symbol_ops(&self.stroke, self.scale, self.opacity, ink));
            }
            return;
        }
        // Spray and calligraphy segments do not look ahead; the others need the next sample.
        let last_final = match self.kind {
            Kind::Spray | Kind::Calligraphy => count - 1,
            _ => count.saturating_sub(2),
        };
        while self.finalized < last_final {
            self.finalized += 1;
            let index = self.finalized;
            self.finalize(index, count);
        }
    }

    fn finalize(&mut self, index: usize, count: usize) {
        let geo = Geo {
            style: &self.stroke,
            points: &self.stroke.points,
            scale: self.scale,
            smoothing: self.smoothing,
        };
        match self.kind {
            Kind::Spray => {
                geo.spray_segment(&mut self.finals[0], index - 1, index, index, self.opacity)
            }
            Kind::Calligraphy => geo.calligraphy_nib(&mut self.finals[0], index - 1, index),
            Kind::Segments => {
                for (slot, plan) in self.plans.iter().enumerate() {
                    geo.pass_segment(&mut self.finals[slot], &plan.pass, plan.index, index, count);
                }
            }
            Kind::Path => {
                for path in &mut self.paths {
                    geo.path_segment(path, index, index > 1, count);
                }
            }
            Kind::Marker => {
                // Corner `index` needs sample `index + 1`, which exists now.
                let smooth = clamp(self.smoothing, 0.0, 1.0);
                if index == 1 {
                    self.marker_cursor = (geo.px(0), geo.py(0));
                }
                let mut cursor = self.marker_cursor;
                for path in &mut self.paths {
                    if path.elements().is_empty() {
                        path.move_to((geo.px(0), geo.py(0)));
                    }
                    let mut local = self.marker_cursor;
                    if smooth <= 0.0 {
                        path.line_to((geo.px(index), geo.py(index)));
                    } else {
                        geo.marker_corner(path, index, &mut local);
                    }
                    cursor = local;
                }
                self.marker_cursor = cursor;
            }
            Kind::Symbol => {}
        }
    }
}

impl OpSource for LiveStroke {
    fn build_scale(&self) -> f64 {
        self.scale
    }

    fn ink(&self) -> Ink {
        match &self.symbol {
            Some((_, ink)) => *ink,
            None => stroke_ink(&self.stroke, self.page, self.scale),
        }
    }

    fn glow(&self) -> Option<Glow> {
        stroke_glow(&self.stroke, self.scale)
    }

    fn visit(&self, f: &mut dyn FnMut(&Op)) {
        let count = self.stroke.points.len();
        if count == 0 {
            return;
        }
        if let Some((ops, _)) = &self.symbol {
            ops.iter().for_each(&mut *f);
            return;
        }
        let geo = self.geo();
        if count == 1 {
            let mut tap = Vec::new();
            geo.tap(&mut tap, self.brush, self.opacity);
            tap.iter().for_each(&mut *f);
            return;
        }
        let mut tail = Vec::new();
        for (slot, plan) in self.plans.iter().enumerate() {
            if let Some((alpha, multiply)) = plan.layer {
                f(&Op::PushLayer { alpha, multiply });
            }
            if self.kind != Kind::Spray {
                f(&Op::Alpha(plan.alpha));
                f(&Op::Cap(plan.cap));
            }
            self.finals[slot].iter().for_each(&mut *f);
            tail.clear();
            match self.kind {
                Kind::Segments => {
                    for index in self.finalized + 1..count {
                        geo.pass_segment(&mut tail, &plan.pass, plan.index, index, count);
                    }
                }
                Kind::Path | Kind::Marker => {
                    let mut path = self.paths[slot].clone();
                    if self.kind == Kind::Path {
                        for index in self.finalized + 1..count {
                            geo.path_segment(&mut path, index, index > 1, count);
                        }
                    } else {
                        if path.elements().is_empty() {
                            path.move_to((geo.px(0), geo.py(0)));
                        }
                        path.line_to((geo.px(count - 1), geo.py(count - 1)));
                    }
                    let factor = if self.kind == Kind::Marker {
                        1.0
                    } else {
                        plan.pass.width_factor
                    };
                    tail.push(Op::Path {
                        path,
                        width: geo.segment_width(1, factor) as f32,
                    });
                }
                Kind::Spray | Kind::Calligraphy | Kind::Symbol => {}
            }
            tail.iter().for_each(&mut *f);
            if plan.layer.is_some() {
                f(&Op::PopLayer);
            }
        }
    }
}

/// How far, in page px, any paint of `stroke` reaches past its points at `scale`.
pub fn reach_page_px(stroke: &InkStroke, scale: f64) -> f64 {
    let margin = if has_symbol(stroke) {
        stroke.base_width * scale * SQRT_2 + 2.0
    } else {
        fanotes_raster::ink_stroke_paint_margin(stroke, scale)
    };
    // Pencil grain and spray particles reach up to ~0.9 px past the pass width.
    margin / scale + 1.0
}

/// Every op point, for bounds checks in tests.
pub fn op_points(op: &Op) -> Vec<P> {
    match op {
        Op::Seg { a, c, b, .. } => {
            let mut points = vec![*a, *b];
            points.extend(c.iter().copied());
            points
        }
        Op::Path { path, .. } => path
            .elements()
            .iter()
            .flat_map(|element| match element {
                PathEl::MoveTo(a) | PathEl::LineTo(a) => vec![*a],
                PathEl::QuadTo(a, b) => vec![*a, *b],
                PathEl::CurveTo(a, b, c) => vec![*a, *b, *c],
                PathEl::ClosePath => vec![],
            })
            .map(|point| p(point.x, point.y))
            .collect(),
        Op::Dot { c, .. } | Op::Ellipse { c, .. } => vec![*c],
        Op::Quad(q) => q.to_vec(),
        _ => Vec::new(),
    }
}
