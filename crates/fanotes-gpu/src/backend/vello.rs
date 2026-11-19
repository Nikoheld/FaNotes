//! Op encoding shared by vello_cpu and vello_hybrid.
//!
//! Both renderers expose the same drawing API (`set_paint`, `stroke_path`,
//! `push_layer`, …) on different types from different `vello_common`
//! versions, so a small trait is implemented for each with one macro.

use kurbo::{Affine, BezPath, Cap as KCap, Join, Rect, Stroke};
use peniko::color::{AlphaColor, Srgb};
use peniko::{BlendMode, Compose, Gradient, Mix};

use crate::camera::Camera;
use crate::ops::{ellipse_path, op_path, Cap, Ink, Op, OpSource};
use crate::ruling::{ruling_prims, Prim};
use crate::scene::PageScene;
use crate::stroke::build_stroke_ops;

pub(crate) type Color = AlphaColor<Srgb>;

pub(crate) trait Canvas {
    fn set_transform(&mut self, transform: Affine);
    fn set_color(&mut self, color: Color);
    fn set_gradient(&mut self, gradient: Gradient);
    fn set_stroke(&mut self, stroke: Stroke);
    fn fill(&mut self, path: &BezPath);
    fn fill_rect(&mut self, rect: &Rect);
    fn stroke(&mut self, path: &BezPath);
    fn push_group(&mut self, alpha: f32, blend: BlendMode);
    /// Canvas `shadowBlur` glow around the following draws; false if unsupported.
    fn push_glow(&mut self, color: Color, std_deviation: f32) -> bool;
    fn pop_group(&mut self);
}

macro_rules! impl_canvas {
    ($ty:ty, $filter:path, $primitive:path, $edge:path) => {
        impl crate::backend::vello::Canvas for $ty {
            fn set_transform(&mut self, transform: kurbo::Affine) {
                <$ty>::set_transform(self, transform);
            }
            fn set_color(&mut self, color: crate::backend::vello::Color) {
                self.set_paint(color);
            }
            fn set_gradient(&mut self, gradient: peniko::Gradient) {
                self.set_paint(gradient);
            }
            fn set_stroke(&mut self, stroke: kurbo::Stroke) {
                <$ty>::set_stroke(self, stroke);
            }
            fn fill(&mut self, path: &kurbo::BezPath) {
                self.fill_path(path);
            }
            fn fill_rect(&mut self, rect: &kurbo::Rect) {
                <$ty>::fill_rect(self, rect);
            }
            fn stroke(&mut self, path: &kurbo::BezPath) {
                self.stroke_path(path);
            }
            fn push_group(&mut self, alpha: f32, blend: peniko::BlendMode) {
                self.push_layer(None, Some(blend), Some(alpha), None, None);
            }
            fn push_glow(
                &mut self,
                color: crate::backend::vello::Color,
                std_deviation: f32,
            ) -> bool {
                use $primitive as Primitive;
                let filter = <$filter>::from_primitive(Primitive::DropShadow {
                    dx: 0.0,
                    dy: 0.0,
                    std_deviation,
                    color,
                    edge_mode: $edge,
                });
                self.push_layer(None, None, None, None, Some(filter));
                true
            }
            fn pop_group(&mut self) {
                self.pop_layer();
            }
        }
    };
}
pub(crate) use impl_canvas;

pub(crate) fn rgb(color: u32, alpha: f32) -> Color {
    Color::from_rgba8(
        ((color >> 16) & 0xff) as u8,
        ((color >> 8) & 0xff) as u8,
        (color & 0xff) as u8,
        (alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
    )
}

fn rgba(color: [u8; 4]) -> Color {
    Color::from_rgba8(color[0], color[1], color[2], color[3])
}

fn gradient(ink: Ink) -> Option<Gradient> {
    let Ink::Gradient { start, end, stops } = ink else {
        return None;
    };
    let stops: Vec<(f32, Color)> = stops
        .iter()
        .map(|(at, color)| (*at, rgb(*color, 1.0)))
        .collect();
    Some(Gradient::new_linear((start[0], start[1]), (end[0], end[1])).with_stops(stops.as_slice()))
}

/// A circle or ellipse as a polygon within 0.02 device px of the curve.
///
/// vello flattens curves to 0.25 px with vertices on the curve, which takes
/// about a third of the area off a one-pixel dot (spray particles, ruling
/// dots, a pen tap). Lines are not flattened again, so this is exact enough.
fn fine_ellipse(
    path: &mut BezPath,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    rotation: f64,
    device_scale: f64,
) {
    path.truncate(0);
    let r = rx.max(ry) * device_scale;
    if !(r > 0.0) {
        return;
    }
    if r > 24.0 {
        ellipse_path(path, cx, cy, rx, ry, rotation);
        return;
    }
    let n = (std::f64::consts::PI / (1.0 - 0.02 / r).max(-1.0).acos())
        .ceil()
        .clamp(8.0, 128.0) as usize;
    // Vertices on a slightly larger polygon so its area equals the curve's.
    let step = std::f64::consts::TAU / n as f64;
    let grow = (step / step.sin()).sqrt();
    let (sin, cos) = rotation.sin_cos();
    for i in 0..n {
        let (s, c) = (i as f64 * step).sin_cos();
        let (x, y) = (c * rx * grow, s * ry * grow);
        let point = (cx + x * cos - y * sin, cy + x * sin + y * cos);
        if i == 0 {
            path.move_to(point);
        } else {
            path.line_to(point);
        }
    }
    path.close_path();
}

const MULTIPLY: BlendMode = BlendMode::new(Mix::Multiply, Compose::SrcOver);
const NORMAL: BlendMode = BlendMode::new(Mix::Normal, Compose::SrcOver);

/// Draw one stroke's ops through `to_device` (build px → device px).
pub(crate) fn encode_stroke<C: Canvas>(
    canvas: &mut C,
    source: &dyn OpSource,
    to_device: Affine,
    glow_ok: bool,
    scratch: &mut BezPath,
) {
    canvas.set_transform(to_device);
    let device_scale = to_device.determinant().abs().sqrt();
    let ink = source.ink();
    let gradient = gradient(ink);
    let glow = source
        .glow()
        .filter(|_| glow_ok)
        .map(|glow| canvas.push_glow(rgb(glow.color, 1.0), glow.blur / 2.0))
        .unwrap_or(false);
    let mut alpha = 1.0_f32;
    let mut paint_alpha = f32::NAN;
    let mut cap = Cap::Round;
    let paint = |canvas: &mut C, alpha: f32, paint_alpha: &mut f32| {
        if *paint_alpha == alpha {
            return;
        }
        *paint_alpha = alpha;
        match (&gradient, ink) {
            (Some(gradient), _) => canvas.set_gradient(gradient.clone().multiply_alpha(alpha)),
            (None, Ink::Solid(color)) => canvas.set_color(rgb(color, alpha)),
            (None, Ink::Gradient { .. }) => {}
        }
    };
    let style = |width: f32, cap: Cap| {
        Stroke::new(width as f64)
            .with_join(Join::Round)
            .with_caps(match cap {
                Cap::Round => KCap::Round,
                Cap::Butt => KCap::Butt,
            })
    };
    source.visit(&mut |op| match op {
        Op::Alpha(value) => alpha = *value,
        Op::Cap(value) => cap = *value,
        Op::Seg { width, .. } => {
            paint(canvas, alpha, &mut paint_alpha);
            canvas.set_stroke(style(*width, cap));
            op_path(op, scratch);
            canvas.stroke(scratch);
        }
        Op::Path { path, width } => {
            paint(canvas, alpha, &mut paint_alpha);
            canvas.set_stroke(style(*width, cap));
            canvas.stroke(path);
        }
        Op::Dot { c, r } => {
            paint(canvas, alpha, &mut paint_alpha);
            fine_ellipse(
                scratch,
                c[0] as f64,
                c[1] as f64,
                *r as f64,
                *r as f64,
                0.0,
                device_scale,
            );
            canvas.fill(scratch);
        }
        Op::Ellipse {
            c,
            rx,
            ry,
            rotation,
        } => {
            paint(canvas, alpha, &mut paint_alpha);
            fine_ellipse(
                scratch,
                c[0] as f64,
                c[1] as f64,
                *rx as f64,
                *ry as f64,
                *rotation as f64,
                device_scale,
            );
            canvas.fill(scratch);
        }
        Op::Quad(_) => {
            paint(canvas, alpha, &mut paint_alpha);
            op_path(op, scratch);
            canvas.fill(scratch);
        }
        Op::PushLayer {
            alpha: group,
            multiply,
        } => {
            canvas.push_group(*group, if *multiply { MULTIPLY } else { NORMAL });
        }
        Op::PopLayer => canvas.pop_group(),
    });
    if glow {
        canvas.pop_group();
    }
}

/// Sheet color and ruling for the viewport.
pub(crate) fn encode_paper<C: Canvas>(
    canvas: &mut C,
    scene: &PageScene,
    camera: &Camera,
    prims: &mut Vec<Prim>,
    scratch: &mut BezPath,
) {
    canvas.set_transform(Affine::IDENTITY);
    canvas.set_color(rgb(scene.background, 1.0));
    canvas.fill_rect(&Rect::new(
        0.0,
        0.0,
        camera.width as f64,
        camera.height as f64,
    ));
    prims.clear();
    ruling_prims(
        scene.paper,
        (camera.origin_x, camera.origin_y),
        camera.visible_page_rect(),
        camera.device_scale(),
        prims,
    );
    canvas.set_transform(camera.page_to_device());
    for prim in prims.iter() {
        match prim {
            Prim::Rect { rect, rgba: color } => {
                canvas.set_color(rgba(*color));
                canvas.fill_rect(rect);
            }
            Prim::Circle { c, r, rgba: color } => {
                canvas.set_color(rgba(*color));
                fine_ellipse(scratch, c.x, c.y, *r, *r, 0.0, camera.device_scale());
                canvas.fill(scratch);
            }
        }
    }
}

/// Committed ink painted at the camera's exact scale, as one isolated layer.
pub(crate) fn encode_exact_ink<C: Canvas>(
    canvas: &mut C,
    scene: &PageScene,
    camera: &Camera,
    glow_ok: bool,
    scratch: &mut BezPath,
) -> usize {
    let scale = camera.device_scale();
    let margin = super::exact_query_margin(scale);
    let strokes = scene.strokes_in(camera.visible_page_rect().inflate(margin, margin));
    let to_device = camera.page_to_device() * Affine::scale(1.0 / scale);
    canvas.push_group(1.0, NORMAL);
    for (_, stroke) in &strokes {
        let ops = build_stroke_ops(&stroke.stroke, scene.page_size(), scale, scene.smoothing);
        encode_stroke(canvas, &ops, to_device, glow_ok, scratch);
    }
    canvas.pop_group();
    strokes.len()
}

/// Committed ink of one tile, in texels.
pub(crate) fn encode_tile_ink<C: Canvas>(
    canvas: &mut C,
    scene: &PageScene,
    key: &crate::tiles::TileKey,
    glow_ok: bool,
    scratch: &mut BezPath,
) -> usize {
    let density = key.density();
    let strokes = scene.strokes_in(key.texture_page_rect());
    let to_texel = key.render_transform();
    for (_, stroke) in &strokes {
        let ops = build_stroke_ops(&stroke.stroke, scene.page_size(), density, scene.smoothing);
        encode_stroke(canvas, &ops, to_texel, glow_ok, scratch);
    }
    strokes.len()
}

/// The wet stroke, isolated like the live canvas above committed ink.
pub(crate) fn encode_live<C: Canvas>(
    canvas: &mut C,
    scene: &PageScene,
    camera: &Camera,
    glow_ok: bool,
    scratch: &mut BezPath,
) {
    let Some(live) = scene.live() else {
        return;
    };
    if live.points().is_empty() {
        return;
    }
    let to_device = camera.page_to_device() * Affine::scale(1.0 / live.scale());
    canvas.push_group(1.0, NORMAL);
    encode_stroke(canvas, live, to_device, glow_ok, scratch);
    canvas.pop_group();
}
