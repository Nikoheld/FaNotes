//! `drawInkStroke` on tiny-skia.
//!
//! Ported branch by branch from `fanotes/src/lib/inkStrokePaint.ts`. Points
//! are mapped to the paint space exactly like the TypeScript painter
//! (`x * width`, `y * height`) and offset by `origin`, the device position of
//! the target inside that paint space. A small canvas-like context keeps the
//! save/restore, global alpha, composite and shadow semantics the port relies on.

use std::f64::consts::PI;

use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, IntRect, LineCap, LineJoin,
    LinearGradient, Paint, Path, PathBuilder, Pixmap, PixmapMut, PixmapPaint, Point,
    PremultipliedColorU8, Shader, SpreadMode, Stroke, Transform,
};

use crate::blur::{blur_alpha, blur_reach};
use crate::stroke::{
    brush_passes, clamp, ink_brush_of, ink_opacity_of, ink_stroke_bitmap_width,
    ink_stroke_is_translucent, ink_stroke_paint_margin, ink_stroke_paint_scale, js_round,
    opaque_pass, seeded_unit, Brush, Effect, InkStroke, Pass,
};

/// Circle and ellipse quadrants as cubic Béziers.
const KAPPA: f64 = 0.552_284_749_830_793_4;

#[derive(Clone, Copy, Debug)]
struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Affine {
    fn translate(tx: f64, ty: f64) -> Self {
        Self {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: tx,
            f: ty,
        }
    }

    fn map(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }

    fn pre_translate(&self, tx: f64, ty: f64) -> Self {
        Self {
            e: self.a * tx + self.c * ty + self.e,
            f: self.b * tx + self.d * ty + self.f,
            ..*self
        }
    }

    fn pre_rotate(&self, radians: f64) -> Self {
        let (sin, cos) = radians.sin_cos();
        Self {
            a: self.a * cos + self.c * sin,
            b: self.b * cos + self.d * sin,
            c: -self.a * sin + self.c * cos,
            d: -self.b * sin + self.d * cos,
            ..*self
        }
    }

    fn pre_scale(&self, sx: f64, sy: f64) -> Self {
        Self {
            a: self.a * sx,
            b: self.b * sx,
            c: self.c * sy,
            d: self.d * sy,
            ..*self
        }
    }

    fn scale_factor(&self) -> f64 {
        (self.a * self.d - self.b * self.c).abs().sqrt()
    }

    fn to_transform(self) -> Transform {
        Transform::from_row(
            self.a as f32,
            self.b as f32,
            self.c as f32,
            self.d as f32,
            self.e as f32,
            self.f as f32,
        )
    }
}

#[derive(Clone, Copy, Debug)]
enum Ink {
    Solid(u32),
    /// `createLinearGradient` coordinates, interpreted in the transform at draw time.
    Gradient {
        start: (f64, f64),
        end: (f64, f64),
        stops: &'static [(f32, u32)],
    },
}

#[derive(Clone, Copy, Debug)]
struct State {
    ctm: Affine,
    ink: Ink,
    alpha: f64,
    line_width: f64,
    cap: LineCap,
    join: LineJoin,
    blend: BlendMode,
    shadow: Option<(u32, f64)>,
}

/// The slice of the 2D canvas API that `drawInkStroke` uses.
struct Ctx {
    state: State,
    stack: Vec<State>,
    path: PathBuilder,
}

fn rgb_color(rgb: u32, alpha: f64) -> Color {
    Color::from_rgba(
        ((rgb >> 16) & 0xff) as f32 / 255.0,
        ((rgb >> 8) & 0xff) as f32 / 255.0,
        (rgb & 0xff) as f32 / 255.0,
        clamp(alpha, 0.0, 1.0) as f32,
    )
    .unwrap_or(Color::TRANSPARENT)
}

impl Ctx {
    fn new(origin: (f64, f64), ink: Ink) -> Self {
        Self {
            state: State {
                ctm: Affine::translate(-origin.0, -origin.1),
                ink,
                alpha: 1.0,
                line_width: 1.0,
                cap: LineCap::Round,
                join: LineJoin::Round,
                blend: BlendMode::SourceOver,
                shadow: None,
            },
            stack: Vec::new(),
            path: PathBuilder::new(),
        }
    }

    fn save(&mut self) {
        self.stack.push(self.state);
    }

    fn restore(&mut self) {
        if let Some(state) = self.stack.pop() {
            self.state = state;
        }
    }

    fn begin_path(&mut self) {
        self.path = PathBuilder::new();
    }

    fn device(&self, x: f64, y: f64) -> (f32, f32) {
        let (dx, dy) = self.state.ctm.map(x, y);
        (dx as f32, dy as f32)
    }

    fn move_to(&mut self, x: f64, y: f64) {
        let (dx, dy) = self.device(x, y);
        self.path.move_to(dx, dy);
    }

    fn line_to(&mut self, x: f64, y: f64) {
        let (dx, dy) = self.device(x, y);
        self.path.line_to(dx, dy);
    }

    fn quad_to(&mut self, cx: f64, cy: f64, x: f64, y: f64) {
        let (dcx, dcy) = self.device(cx, cy);
        let (dx, dy) = self.device(x, y);
        self.path.quad_to(dcx, dcy, dx, dy);
    }

    fn close_path(&mut self) {
        self.path.close();
    }

    /// `ellipse(cx, cy, rx, ry, rotation, 0, 2π)`; a circle when rx == ry and rotation == 0.
    fn ellipse(&mut self, cx: f64, cy: f64, rx: f64, ry: f64, rotation: f64) {
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
        let (sx, sy) = local(1.0, 0.0);
        let (dsx, dsy) = self.device(sx, sy);
        self.path.move_to(dsx, dsy);
        for quadrant in quadrants {
            let (c1x, c1y) = local(quadrant[0].0, quadrant[0].1);
            let (c2x, c2y) = local(quadrant[1].0, quadrant[1].1);
            let (px, py) = local(quadrant[2].0, quadrant[2].1);
            let (a, b) = self.device(c1x, c1y);
            let (c, d) = self.device(c2x, c2y);
            let (e, f) = self.device(px, py);
            self.path.cubic_to(a, b, c, d, e, f);
        }
        self.path.close();
    }

    fn arc(&mut self, cx: f64, cy: f64, radius: f64) {
        self.ellipse(cx, cy, radius, radius, 0.0);
    }

    fn translate(&mut self, x: f64, y: f64) {
        self.state.ctm = self.state.ctm.pre_translate(x, y);
    }

    fn rotate(&mut self, radians: f64) {
        self.state.ctm = self.state.ctm.pre_rotate(radians);
    }

    fn scale(&mut self, sx: f64, sy: f64) {
        self.state.ctm = self.state.ctm.pre_scale(sx, sy);
    }

    fn paint(&self) -> Option<Paint<'static>> {
        if !(self.state.alpha > 0.0) {
            return None;
        }
        let shader = match self.state.ink {
            Ink::Solid(rgb) => Shader::SolidColor(rgb_color(rgb, self.state.alpha)),
            Ink::Gradient { start, end, stops } => {
                let s = self.state.ctm.map(start.0, start.1);
                let e = self.state.ctm.map(end.0, end.1);
                let stops = stops
                    .iter()
                    .map(|(position, rgb)| GradientStop::new(*position, rgb_color(*rgb, 1.0)))
                    .collect();
                let mut shader = LinearGradient::new(
                    Point::from_xy(s.0 as f32, s.1 as f32),
                    Point::from_xy(e.0 as f32, e.1 as f32),
                    stops,
                    SpreadMode::Pad,
                    Transform::identity(),
                )?;
                shader.apply_opacity(clamp(self.state.alpha, 0.0, 1.0) as f32);
                shader
            }
        };
        Some(Paint {
            shader,
            blend_mode: self.state.blend,
            anti_alias: true,
            force_hq_pipeline: false,
        })
    }

    fn line_stroke(&self) -> Stroke {
        Stroke {
            width: (self.state.line_width * self.state.ctm.scale_factor()) as f32,
            miter_limit: 10.0,
            line_cap: self.state.cap,
            line_join: self.state.join,
            dash: None,
        }
    }

    fn fill(&mut self, target: &mut PixmapMut) {
        let Some(path) = self.path.clone().finish() else {
            return;
        };
        let Some(paint) = self.paint() else { return };
        self.cast_shadow(target, &path, None);
        target.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }

    fn stroke(&mut self, target: &mut PixmapMut) {
        let Some(path) = self.path.clone().finish() else {
            return;
        };
        self.stroke_path(target, &path);
    }

    fn stroke_path(&mut self, target: &mut PixmapMut, path: &Path) {
        let Some(paint) = self.paint() else { return };
        let stroke = self.line_stroke();
        self.cast_shadow(target, path, Some(&stroke));
        target.stroke_path(path, &paint, &stroke, Transform::identity(), None);
    }

    /// Canvas shadow of a fill or stroke: the shape's coverage in the shadow
    /// color, blurred with σ = shadowBlur / 2, composited before the shape.
    fn cast_shadow(&self, target: &mut PixmapMut, path: &Path, stroke: Option<&Stroke>) {
        let Some((color, blur)) = self.state.shadow else {
            return;
        };
        if !(blur > 0.0) {
            return;
        }
        let reach = blur_reach(blur) as f32;
        let half = stroke.map(|stroke| stroke.width / 2.0 + 1.0).unwrap_or(1.0);
        let bounds = path.bounds();
        let width = target.width() as f32;
        let height = target.height() as f32;
        let x0 = (bounds.left() - half - reach).max(-2.0 * reach).floor();
        let y0 = (bounds.top() - half - reach).max(-2.0 * reach).floor();
        let x1 = (bounds.right() + half + reach)
            .min(width + 2.0 * reach)
            .ceil();
        let y1 = (bounds.bottom() + half + reach)
            .min(height + 2.0 * reach)
            .ceil();
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let (Some(mut coverage), Some(mut shadow)) = (
            Pixmap::new((x1 - x0) as u32, (y1 - y0) as u32),
            Pixmap::new((x1 - x0) as u32, (y1 - y0) as u32),
        ) else {
            return;
        };
        let mut paint = Paint::default();
        paint.set_color_rgba8(255, 255, 255, 255);
        paint.anti_alias = true;
        let shift = Transform::from_translate(-x0, -y0);
        match stroke {
            Some(stroke) => coverage.stroke_path(path, &paint, stroke, shift, None),
            None => coverage.fill_path(path, &paint, FillRule::Winding, shift, None),
        }
        self.composite_shadow(
            target,
            &coverage,
            &mut shadow,
            x0 as i32,
            y0 as i32,
            color,
            blur,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn composite_shadow(
        &self,
        target: &mut PixmapMut,
        coverage: &Pixmap,
        shadow: &mut Pixmap,
        x: i32,
        y: i32,
        color: u32,
        blur: f64,
    ) {
        let width = coverage.width() as usize;
        let height = coverage.height() as usize;
        let mut alpha: Vec<f32> = coverage
            .pixels()
            .iter()
            .map(|pixel| pixel.alpha() as f32 / 255.0)
            .collect();
        blur_alpha(&mut alpha, width, height, blur);
        let (r, g, b) = (
            ((color >> 16) & 0xff) as f32,
            ((color >> 8) & 0xff) as f32,
            (color & 0xff) as f32,
        );
        for (pixel, value) in shadow.pixels_mut().iter_mut().zip(alpha) {
            let a = value.clamp(0.0, 1.0);
            let alpha8 = (a * 255.0).round() as u8;
            let channel = |c: f32| ((c * a).round() as u8).min(alpha8);
            *pixel = PremultipliedColorU8::from_rgba(channel(r), channel(g), channel(b), alpha8)
                .unwrap_or(PremultipliedColorU8::TRANSPARENT);
        }
        let paint = PixmapPaint {
            opacity: clamp(self.state.alpha, 0.0, 1.0) as f32,
            blend_mode: self.state.blend,
            quality: FilterQuality::Nearest,
        };
        target.draw_pixmap(x, y, shadow.as_ref(), &paint, Transform::identity(), None);
    }

    /// `drawImage(scratch, …)` at a whole device position, shadow included.
    fn draw_image(&self, target: &mut PixmapMut, image: &Pixmap, x: i32, y: i32) {
        if let Some((color, blur)) = self.state.shadow {
            if blur > 0.0 {
                let reach = blur_reach(blur) as i32;
                let width = image.width() as i32 + 2 * reach;
                let height = image.height() as i32 + 2 * reach;
                if let (Some(mut coverage), Some(mut shadow)) = (
                    Pixmap::new(width as u32, height as u32),
                    Pixmap::new(width as u32, height as u32),
                ) {
                    coverage.draw_pixmap(
                        reach,
                        reach,
                        image.as_ref(),
                        &PixmapPaint::default(),
                        Transform::identity(),
                        None,
                    );
                    self.composite_shadow(
                        target,
                        &coverage,
                        &mut shadow,
                        x - reach,
                        y - reach,
                        color,
                        blur,
                    );
                }
            }
        }
        let paint = PixmapPaint {
            opacity: clamp(self.state.alpha, 0.0, 1.0) as f32,
            blend_mode: self.state.blend,
            quality: FilterQuality::Nearest,
        };
        target.draw_pixmap(x, y, image.as_ref(), &paint, Transform::identity(), None);
    }
}

fn stroke_ink(stroke: &InkStroke, width: f64, height: f64) -> Ink {
    match stroke.effect.stops() {
        None => Ink::Solid(stroke.color),
        Some(stops) => Ink::Gradient {
            start: (0.0, height * 0.08),
            end: (width, height * 0.28),
            stops,
        },
    }
}

struct Strokes<'s> {
    stroke: &'s InkStroke,
    width: f64,
    height: f64,
    smoothing: f64,
    blend: f64,
    scale: f64,
    opacity: f64,
    first_segment: usize,
    last_segment: usize,
}

impl Strokes<'_> {
    fn px(&self, index: usize) -> f64 {
        self.stroke.points[index].x * self.width
    }

    fn py(&self, index: usize) -> f64 {
        self.stroke.points[index].y * self.height
    }

    fn pressure(&self, index: usize) -> f64 {
        self.stroke.points[index].pressure
    }

    /// Curve of segment `index` (points index-1 → index), as the TypeScript `segment` paints it.
    fn segment_curve(
        &self,
        ctx: &mut Ctx,
        index: usize,
        ox: f64,
        oy: f64,
        connected: bool,
        point_count: usize,
    ) {
        let previous_x = self.px(index - 1);
        let previous_y = self.py(index - 1);
        let point_x = self.px(index);
        let point_y = self.py(index);
        if !connected {
            ctx.move_to(previous_x + ox, previous_y + oy);
        }
        if self.smoothing > 0.0 && index + 1 < point_count {
            let next = &self.stroke.points[index + 1];
            let mid_x = point_x * (1.0 - self.blend * 0.35)
                + ((point_x + next.x * self.width) / 2.0) * self.blend * 0.35;
            let mid_y = point_y * (1.0 - self.blend * 0.35)
                + ((point_y + next.y * self.height) / 2.0) * self.blend * 0.35;
            ctx.quad_to(point_x + ox, point_y + oy, mid_x + ox, mid_y + oy);
        } else if self.smoothing > 0.0 && index >= 2 {
            let previous = &self.stroke.points[index - 1];
            let before = &self.stroke.points[index - 2];
            let control_x = previous_x + (previous.x - before.x) * self.width * self.blend * 0.4;
            let control_y = previous_y + (previous.y - before.y) * self.height * self.blend * 0.4;
            ctx.quad_to(control_x + ox, control_y + oy, point_x + ox, point_y + oy);
        } else {
            ctx.line_to(point_x + ox, point_y + oy);
        }
    }

    fn segment_width(&self, index: usize, width_factor: f64) -> f64 {
        ink_stroke_bitmap_width(
            self.stroke,
            (self.pressure(index - 1) + self.pressure(index)) / 2.0,
            self.scale,
        ) * width_factor
    }

    fn pass_offset(&self, pass: &Pass, pass_index: usize, index: usize) -> (f64, f64) {
        let Some(jitter) = pass.jitter else {
            return (0.0, 0.0);
        };
        let seed = self.stroke.texture_seed.unwrap_or(1.0)
            + index as f64 * 53.0
            + (pass_index as f64 - 1.0) * 2.0;
        (
            (seeded_unit(seed) - 0.5) * self.scale * jitter,
            (seeded_unit(seed + 1.0) - 0.5) * self.scale * jitter,
        )
    }

    /// Direct paint, one stroke per segment.
    fn paint_pass_segments(
        &self,
        ctx: &mut Ctx,
        target: &mut PixmapMut,
        pass: &Pass,
        pass_index: usize,
        alpha: f64,
    ) {
        for index in self.first_segment..self.last_segment {
            let (ox, oy) = self.pass_offset(pass, pass_index, index);
            ctx.state.alpha = alpha;
            ctx.begin_path();
            self.segment_curve(ctx, index, ox, oy, false, self.stroke.points.len());
            ctx.state.line_width = self.segment_width(index, pass.width_factor);
            ctx.stroke(target);
        }
    }

    /// Constant width: the whole range is one path, so bends are joins, not seams.
    fn paint_pass_path(&self, ctx: &mut Ctx, target: &mut PixmapMut, pass: &Pass, alpha: f64) {
        ctx.state.alpha = alpha;
        let line_width = self.segment_width(self.first_segment, pass.width_factor);
        ctx.state.line_width = line_width;
        let count = self.stroke.points.len();
        let mut end = self.last_segment;
        if end == count && end - 1 > self.first_segment {
            let stub = ((self.px(end - 1) - self.px(end - 2)).powi(2)
                + (self.py(end - 1) - self.py(end - 2)).powi(2))
            .sqrt();
            if stub < line_width * 0.3 {
                end -= 1;
            }
        }
        ctx.begin_path();
        for index in self.first_segment..end {
            self.segment_curve(ctx, index, 0.0, 0.0, index > self.first_segment, end);
        }
        ctx.stroke(target);
    }

    /// Marker centerline with a quadratic fillet inside each corner.
    fn paint_marker_stroke(&self, ctx: &mut Ctx, target: &mut PixmapMut, alpha: f64) {
        let count = self.stroke.points.len();
        ctx.state.alpha = alpha;
        ctx.state.join = LineJoin::Round;
        ctx.state.cap = LineCap::Round;
        ctx.state.line_width = self.segment_width(self.first_segment.min(count - 1), 1.0);
        let from = self.first_segment.saturating_sub(1);
        let to = from.max(self.last_segment.saturating_sub(1));
        ctx.begin_path();
        ctx.move_to(self.px(from), self.py(from));
        if to == from {
            ctx.stroke(target);
            return;
        }
        let radius = ctx.state.line_width / 2.0;
        let smooth = clamp(self.smoothing, 0.0, 1.0);
        if smooth <= 0.0 || to - from < 2 {
            for index in from + 1..=to {
                ctx.line_to(self.px(index), self.py(index));
            }
            ctx.stroke(target);
            return;
        }
        let mut cursor = (self.px(from), self.py(from));
        for index in from + 1..to {
            let (ax, ay) = (self.px(index - 1), self.py(index - 1));
            let (bx, by) = (self.px(index), self.py(index));
            let (cx, cy) = (self.px(index + 1), self.py(index + 1));
            let (in_x, in_y) = (bx - ax, by - ay);
            let (out_x, out_y) = (cx - bx, cy - by);
            let in_len = in_x.hypot(in_y);
            let out_len = out_x.hypot(out_y);
            if in_len < 0.01 || out_len < 0.01 {
                ctx.line_to(bx, by);
                cursor = (bx, by);
                continue;
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
                ctx.line_to(bx, by);
                cursor = (bx, by);
                continue;
            }
            let start = (bx - (in_x / in_len) * trim, by - (in_y / in_len) * trim);
            let end = (bx + (out_x / out_len) * trim, by + (out_y / out_len) * trim);
            if (start.0 - cursor.0).hypot(start.1 - cursor.1) > 0.4 {
                ctx.line_to(start.0, start.1);
            }
            ctx.quad_to(bx, by, end.0, end.1);
            cursor = end;
        }
        ctx.line_to(self.px(to), self.py(to));
        ctx.stroke(target);
    }

    fn spray_segment(
        &self,
        ctx: &mut Ctx,
        target: &mut PixmapMut,
        previous: usize,
        point: usize,
        index: usize,
    ) {
        let previous_x = self.px(previous);
        let previous_y = self.py(previous);
        let point_x = self.px(point);
        let point_y = self.py(point);
        let radius = ink_stroke_bitmap_width(
            self.stroke,
            (self.pressure(previous) + self.pressure(point)) / 2.0,
            self.scale,
        ) / 2.0;
        let particles = js_round(clamp(self.stroke.base_width * 0.68, 6.0, 24.0)) as usize;
        let seed = self.stroke.texture_seed.unwrap_or(1.0);
        for particle in 0..particles {
            let key = seed + index as f64 * 1_009.0 + particle as f64 * 37.0;
            let progress = seeded_unit(key + 1.0);
            let angle = seeded_unit(key + 2.0) * PI * 2.0;
            let spread = seeded_unit(key + 3.0).sqrt() * radius;
            let x = previous_x + (point_x - previous_x) * progress + angle.cos() * spread;
            let y = previous_y + (point_y - previous_y) * progress + angle.sin() * spread;
            let particle_radius = 0.35_f64.max(self.scale * (0.28 + seeded_unit(key + 4.0) * 0.62));
            ctx.state.alpha = self.opacity * (0.2 + seeded_unit(key + 5.0) * 0.5);
            ctx.begin_path();
            ctx.arc(x, y, particle_radius);
            ctx.fill(target);
        }
    }

    fn calligraphy_nib(
        &self,
        ctx: &mut Ctx,
        target: &mut PixmapMut,
        previous: usize,
        point: usize,
    ) {
        let previous_x = self.px(previous);
        let previous_y = self.py(previous);
        let point_x = self.px(point);
        let point_y = self.py(point);
        let nib_width = ink_stroke_bitmap_width(
            self.stroke,
            (self.pressure(previous) + self.pressure(point)) / 2.0,
            self.scale,
        );
        let nib_x = (-PI * 0.22).cos() * nib_width / 2.0;
        let nib_y = (-PI * 0.22).sin() * nib_width / 2.0;
        ctx.begin_path();
        ctx.move_to(previous_x + nib_x, previous_y + nib_y);
        ctx.line_to(point_x + nib_x, point_y + nib_y);
        ctx.line_to(point_x - nib_x, point_y - nib_y);
        ctx.line_to(previous_x - nib_x, previous_y - nib_y);
        ctx.close_path();
        ctx.fill(target);
    }
}

/// One paint path for committed ink, a range of segments of one stroke.
///
/// `width` × `height` is the whole page in target pixels; `origin` is the
/// target's top-left inside that space. Segments `start_segment` up to
/// (excluding) `end_segment` are painted, exactly like the TypeScript painter.
#[allow(clippy::too_many_arguments)]
pub fn draw_ink_stroke(
    target: &mut PixmapMut,
    stroke: &InkStroke,
    width: f64,
    height: f64,
    smoothing: f64,
    start_segment: usize,
    source_width: f64,
    layout_width: f64,
    end_segment: usize,
    origin: (f64, f64),
) {
    let count = stroke.points.len();
    if count == 0 || !(width > 0.0) || !(height > 0.0) {
        return;
    }
    let last_segment = end_segment.min(count);
    if count > 1 && last_segment <= start_segment.max(1) {
        return;
    }
    if count == 1 && start_segment > 1 {
        return;
    }
    let layout = if layout_width > 1.0 {
        layout_width
    } else {
        width
    };
    let scale = ink_stroke_paint_scale(width, if layout > 1.0 { layout } else { source_width });
    let brush = ink_brush_of(stroke);
    let opacity = ink_opacity_of(stroke);
    let mut ctx = Ctx::new(origin, stroke_ink(stroke, width, height));
    ctx.save();
    if brush == Brush::Highlighter {
        ctx.state.blend = BlendMode::Multiply;
    }
    if stroke.effect == Effect::Neon {
        ctx.state.shadow = Some((stroke.color, (stroke.base_width * scale * 0.85).max(4.0)));
    }
    let first = stroke.points[0];

    if let Some(symbol) = stroke
        .symbol
        .as_ref()
        .filter(|symbol| !symbol.paths.is_empty())
    {
        let symbol_scale = stroke.base_width * scale / 24.0;
        ctx.state.alpha = opacity;
        ctx.translate(first.x * width, first.y * height);
        ctx.rotate(stroke.symbol_rotation * PI / 180.0);
        ctx.scale(symbol_scale, symbol_scale);
        ctx.translate(-12.0, -12.0);
        ctx.state.line_width = 1.75;
        let to_device = ctx.state.ctm.to_transform();
        for path in &symbol.paths {
            if let Some(device) = path.clone().transform(to_device) {
                ctx.stroke_path(target, &device);
            }
        }
        ctx.restore();
        return;
    }

    let strokes = Strokes {
        stroke,
        width,
        height,
        smoothing,
        blend: clamp(smoothing, 0.0, 0.92),
        scale,
        opacity,
        first_segment: start_segment.max(1),
        last_segment,
    };

    if count == 1 {
        match brush {
            Brush::Spray => strokes.spray_segment(&mut ctx, target, 0, 0, 0),
            Brush::Calligraphy => {
                let nib_width = ink_stroke_bitmap_width(stroke, first.pressure, scale);
                ctx.state.alpha = opacity;
                ctx.begin_path();
                ctx.ellipse(
                    first.x * width,
                    first.y * height,
                    nib_width / 2.0,
                    0.5_f64.max(nib_width * 0.16),
                    -PI * 0.22,
                );
                ctx.fill(target);
            }
            _ => {
                ctx.state.alpha = if brush == Brush::Highlighter {
                    opacity * 0.32
                } else {
                    opacity
                };
                ctx.begin_path();
                ctx.arc(
                    first.x * width,
                    first.y * height,
                    ink_stroke_bitmap_width(stroke, first.pressure, scale) / 2.0,
                );
                ctx.fill(target);
            }
        }
        ctx.restore();
        return;
    }

    if brush == Brush::Spray {
        for index in strokes.first_segment..strokes.last_segment {
            strokes.spray_segment(&mut ctx, target, index - 1, index, index);
        }
        ctx.restore();
        return;
    }

    let passes = if brush == Brush::Calligraphy {
        opaque_pass()
    } else {
        brush_passes(brush)
    };
    let constant_width = !stroke.pressure_enabled;
    let mut composite_box: Option<IntRect> = None;
    if ink_stroke_is_translucent(stroke) {
        let margin = ink_stroke_paint_margin(stroke, scale);
        let last = count - 1;
        let (mut x0, mut y0, mut x1, mut y1) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        let mut include = |px: f64, py: f64| {
            x0 = x0.min(px);
            y0 = y0.min(py);
            x1 = x1.max(px);
            y1 = y1.max(py);
        };
        for index in strokes.first_segment.saturating_sub(2)..=last.min(last_segment) {
            include(strokes.px(index), strokes.py(index));
        }
        if last_segment >= last && last >= 2 {
            let previous = &stroke.points[last - 1];
            let before = &stroke.points[last - 2];
            include(
                (previous.x + (previous.x - before.x) * 0.4) * width,
                (previous.y + (previous.y - before.y) * 0.4) * height,
            );
        }
        let (ex, ey) = (-origin.0, -origin.1);
        let dx0 = 0.0_f64.max((x0 - margin + ex).floor());
        let dy0 = 0.0_f64.max((y0 - margin + ey).floor());
        let dx1 = (target.width() as f64).min((x1 + margin + ex).ceil());
        let dy1 = (target.height() as f64).min((y1 + margin + ey).ceil());
        if dx1 <= dx0 || dy1 <= dy0 {
            ctx.restore();
            return;
        }
        composite_box = IntRect::from_xywh(
            dx0 as i32,
            dy0 as i32,
            (dx1 - dx0) as u32,
            (dy1 - dy0) as u32,
        );
    }

    for (pass_index, pass) in passes.iter().enumerate() {
        let alpha = opacity * pass.alpha;
        if let Some(rect) = composite_box.filter(|_| alpha < 0.999) {
            let Some(mut scratch) = Pixmap::new(rect.width(), rect.height()) else {
                continue;
            };
            {
                let mut scratch_target = scratch.as_mut();
                let mut inner = Ctx::new(
                    (origin.0 + rect.x() as f64, origin.1 + rect.y() as f64),
                    stroke_ink(stroke, width, height),
                );
                inner.state.cap = if brush == Brush::Highlighter && constant_width {
                    LineCap::Butt
                } else {
                    LineCap::Round
                };
                if brush == Brush::Calligraphy {
                    inner.state.alpha = 1.0;
                    for index in strokes.first_segment..strokes.last_segment {
                        strokes.calligraphy_nib(&mut inner, &mut scratch_target, index - 1, index);
                    }
                } else if brush == Brush::Marker {
                    strokes.paint_marker_stroke(&mut inner, &mut scratch_target, 1.0);
                } else if constant_width {
                    strokes.paint_pass_path(&mut inner, &mut scratch_target, pass, 1.0);
                } else {
                    strokes.paint_pass_segments(
                        &mut inner,
                        &mut scratch_target,
                        pass,
                        pass_index,
                        1.0,
                    );
                }
            }
            ctx.state.alpha = alpha;
            ctx.draw_image(target, &scratch, rect.x(), rect.y());
            continue;
        }
        if brush == Brush::Calligraphy {
            for index in strokes.first_segment..strokes.last_segment {
                ctx.state.alpha = opacity;
                strokes.calligraphy_nib(&mut ctx, target, index - 1, index);
            }
            continue;
        }
        if brush == Brush::Marker {
            strokes.paint_marker_stroke(&mut ctx, target, alpha);
            continue;
        }
        if brush == Brush::Highlighter {
            ctx.state.cap = LineCap::Butt;
        }
        strokes.paint_pass_segments(&mut ctx, target, pass, pass_index, alpha);
    }
    ctx.restore();
}
