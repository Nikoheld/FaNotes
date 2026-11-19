//! Backend-neutral draw ops for one stroke.
//!
//! Geometry is in "build px": page px times the build scale (device px per
//! page px the stroke was built for). Every width rule of `inkStrokePaint.ts`
//! that depends on device pixels (the 1 px minimum nib, the 0.2 px segment
//! skip, the lift-hook test) is evaluated at that scale, exactly like the
//! TypeScript and tiny-skia painters. A backend draws the ops through
//! `camera * scale(1 / build_scale)`, so a tile built at its bucket density
//! and the live stroke built at the camera scale use the same code.
//!
//! Ops are compact (a segment is 36 bytes) so a 500k-point page fits.

use kurbo::BezPath;

/// A point in build px. f32 keeps a segment small; 24 bits of mantissa is
/// still 0.01 px at 100k px.
pub type P = [f32; 2];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cap {
    Round,
    Butt,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Global alpha of the following draws.
    Alpha(f32),
    /// Line cap of the following strokes. Joins are always round.
    Cap(Cap),
    /// One stroked segment: from `a`, a quadratic through `c` to `b`, or a line to `b`.
    Seg {
        a: P,
        c: Option<P>,
        b: P,
        width: f32,
    },
    /// A stroked polyline / curve with one width.
    Path {
        path: BezPath,
        width: f32,
    },
    /// A filled circle.
    Dot {
        c: P,
        r: f32,
    },
    /// A filled rotated ellipse (calligraphy tap).
    Ellipse {
        c: P,
        rx: f32,
        ry: f32,
        rotation: f32,
    },
    /// A filled quadrilateral (calligraphy nib sweep).
    Quad([P; 4]),
    /// Composite the following ops as one group with `alpha`, multiplied for the highlighter.
    PushLayer {
        alpha: f32,
        multiply: bool,
    },
    PopLayer,
}

/// Ink of a stroke: a solid 0xRRGGBB or a special-ink gradient laid across the page.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ink {
    Solid(u32),
    /// `createLinearGradient(start, end)` in build px.
    Gradient {
        start: [f64; 2],
        end: [f64; 2],
        stops: &'static [(f32, u32)],
    },
}

/// Neon glow: canvas `shadowColor` / `shadowBlur` (build px).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glow {
    pub color: u32,
    pub blur: f32,
}

/// Anything that can replay stroke ops in paint order.
pub trait OpSource {
    fn build_scale(&self) -> f64;
    fn ink(&self) -> Ink;
    fn glow(&self) -> Option<Glow>;
    fn visit(&self, f: &mut dyn FnMut(&Op));
}

/// Ops of one committed stroke.
#[derive(Clone, Debug, PartialEq)]
pub struct StrokeOps {
    pub scale: f64,
    pub ink: Ink,
    pub glow: Option<Glow>,
    pub ops: Vec<Op>,
}

impl StrokeOps {
    pub fn is_empty(&self) -> bool {
        self.ops.iter().all(|op| {
            matches!(
                op,
                Op::Alpha(_) | Op::Cap(_) | Op::PushLayer { .. } | Op::PopLayer
            )
        })
    }
}

impl OpSource for StrokeOps {
    fn build_scale(&self) -> f64 {
        self.scale
    }

    fn ink(&self) -> Ink {
        self.ink
    }

    fn glow(&self) -> Option<Glow> {
        self.glow
    }

    fn visit(&self, f: &mut dyn FnMut(&Op)) {
        for op in &self.ops {
            f(op);
        }
    }
}

pub(crate) fn p(x: f64, y: f64) -> P {
    [x as f32, y as f32]
}

/// Circle and ellipse quadrants as cubic Béziers, like the tiny-skia port.
pub const KAPPA: f64 = 0.552_284_749_830_793_4;

/// `ellipse(cx, cy, rx, ry, rotation, 0, 2π)` as four cubics.
pub fn ellipse_path(path: &mut BezPath, cx: f64, cy: f64, rx: f64, ry: f64, rotation: f64) {
    let (sin, cos) = rotation.sin_cos();
    let local = |ux: f64, uy: f64| {
        let x = ux * rx;
        let y = uy * ry;
        (cx + x * cos - y * sin, cy + x * sin + y * cos)
    };
    let quadrants: [[(f64, f64); 3]; 4] = [
        [(1.0, KAPPA), (KAPPA, 1.0), (0.0, 1.0)],
        [(-KAPPA, 1.0), (-1.0, KAPPA), (-1.0, 0.0)],
        [(-1.0, -KAPPA), (-KAPPA, -1.0), (0.0, -1.0)],
        [(KAPPA, -1.0), (1.0, -KAPPA), (1.0, 0.0)],
    ];
    path.move_to(local(1.0, 0.0));
    for quadrant in quadrants {
        path.curve_to(
            local(quadrant[0].0, quadrant[0].1),
            local(quadrant[1].0, quadrant[1].1),
            local(quadrant[2].0, quadrant[2].1),
        );
    }
    path.close_path();
}

/// The fill or stroke path of one op, into a reused buffer. `None` for state ops.
pub fn op_path(op: &Op, path: &mut BezPath) -> bool {
    path.truncate(0);
    match op {
        Op::Seg { a, c, b, .. } => {
            path.move_to((a[0] as f64, a[1] as f64));
            match c {
                Some(c) => path.quad_to((c[0] as f64, c[1] as f64), (b[0] as f64, b[1] as f64)),
                None => path.line_to((b[0] as f64, b[1] as f64)),
            }
            true
        }
        Op::Dot { c, r } => {
            ellipse_path(path, c[0] as f64, c[1] as f64, *r as f64, *r as f64, 0.0);
            true
        }
        Op::Ellipse {
            c,
            rx,
            ry,
            rotation,
        } => {
            ellipse_path(
                path,
                c[0] as f64,
                c[1] as f64,
                *rx as f64,
                *ry as f64,
                *rotation as f64,
            );
            true
        }
        Op::Quad(q) => {
            path.move_to((q[0][0] as f64, q[0][1] as f64));
            for corner in &q[1..] {
                path.line_to((corner[0] as f64, corner[1] as f64));
            }
            path.close_path();
            true
        }
        _ => false,
    }
}
