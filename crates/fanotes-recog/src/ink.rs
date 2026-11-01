//! The `fanotes-ink-line-v1` model image: pen strokes of one text line, levelled, deslanted,
//! scaled to a fixed body height and drawn with one uniform anti-aliased pen.
//!
//! Training data for the ink recognizer is rendered by the same procedure
//! (`fanotes/scripts/ink-model/inkline.py`), and the Android client ports it as well, so all
//! three must stay identical. `tests/ink.rs` checks this file against golden images produced by
//! the Python reference.

pub const INK_HEIGHT: u32 = 64;
pub const INK_MARGIN_Y: f64 = 6.0;
pub const INK_MARGIN_X: f64 = 8.0;
pub const INK_PEN_WIDTH: f64 = 2.6;
pub const INK_MAX_WIDTH: u32 = 2048;
pub const INK_MIN_WIDTH: u32 = 16;
/// Width reduction of the recognizer: one output frame per four image columns.
pub const INK_FRAME_STRIDE: u32 = 4;
const MIN_CONTENT_HEIGHT: f64 = 6.0;
const MAX_SKEW: f64 = 0.2;
const MAX_SLANT: f64 = 0.6;

#[derive(Debug, Clone, Copy)]
pub struct InkOptions {
    /// Typical line height on the page in the same units as the points. A line much shorter than
    /// this (a dash, a lone `a`) is not blown up to the full model height. `0` disables it.
    pub ref_height: f64,
    pub pen_width: f64,
    pub extra_rotation: f64,
    pub extra_shear: f64,
    pub scale_jitter: f64,
}

impl Default for InkOptions {
    fn default() -> Self {
        Self {
            ref_height: 0.0,
            pen_width: INK_PEN_WIDTH,
            extra_rotation: 0.0,
            extra_shear: 0.0,
            scale_jitter: 1.0,
        }
    }
}

/// Maps page points into model image pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InkTransform {
    center_x: f64,
    center_y: f64,
    cos: f64,
    sin: f64,
    shear: f64,
    shear_center_y: f64,
    min_x: f64,
    middle_y: f64,
    scale: f64,
}

impl InkTransform {
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let (dx, dy) = (x - self.center_x, y - self.center_y);
        let rx = dx * self.cos - dy * self.sin + self.center_x;
        let ry = dx * self.sin + dy * self.cos + self.center_y;
        let sx = rx - (ry - self.shear_center_y) * self.shear;
        (
            (sx - self.min_x) * self.scale + INK_MARGIN_X,
            (ry - self.middle_y) * self.scale + f64::from(INK_HEIGHT) / 2.0,
        )
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct InkImage {
    pub width: u32,
    pub height: u32,
    /// Row-major, `1.0` is paper and `0.0` is ink.
    pub values: Vec<f32>,
    pub transform: InkTransform,
}

fn skew_angle(points: &[(f64, f64)]) -> f64 {
    let count = points.len() as f64;
    let mean_x = points.iter().map(|p| p.0).sum::<f64>() / count;
    let mean_y = points.iter().map(|p| p.1).sum::<f64>() / count;
    let mut denominator = 0.0;
    let mut numerator = 0.0;
    for &(x, y) in points {
        let vx = x - mean_x;
        denominator += vx * vx;
        numerator += vx * (y - mean_y);
    }
    if denominator <= 1e-9 {
        return 0.0;
    }
    (numerator / denominator).atan().clamp(-MAX_SKEW, MAX_SKEW)
}

fn slant_angle(strokes: &[Vec<(f64, f64)>]) -> f64 {
    let mut sum_dx = 0.0;
    let mut sum_dy = 0.0;
    for stroke in strokes {
        for pair in stroke.windows(2) {
            let mut dx = pair[1].0 - pair[0].0;
            let mut dy = pair[1].1 - pair[0].1;
            if dy < 0.0 {
                dx = -dx;
                dy = -dy;
            }
            if dy > 0.0 && dx.abs() <= dy && dx * dx + dy * dy >= 0.25 {
                sum_dx += dy * dx;
                sum_dy += dy * dy;
            }
        }
    }
    if sum_dy <= 1e-9 {
        return 0.0;
    }
    sum_dx.atan2(sum_dy).clamp(-MAX_SLANT, MAX_SLANT)
}

fn bounds(strokes: &[Vec<(f64, f64)>]) -> (f64, f64, f64, f64) {
    let mut out = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for &(x, y) in strokes.iter().flatten() {
        out.0 = out.0.min(x);
        out.1 = out.1.min(y);
        out.2 = out.2.max(x);
        out.3 = out.3.max(y);
    }
    out
}

/// Computes the page → image transform and the image width, or `None` without points.
pub fn ink_transform(
    strokes: &[Vec<(f64, f64)>],
    options: &InkOptions,
) -> Option<(InkTransform, u32)> {
    let mut working: Vec<Vec<(f64, f64)>> = strokes
        .iter()
        .filter(|stroke| !stroke.is_empty())
        .cloned()
        .collect();
    let points: Vec<(f64, f64)> = working.iter().flatten().copied().collect();
    if points.is_empty() || points.iter().any(|p| !p.0.is_finite() || !p.1.is_finite()) {
        return None;
    }
    let (min_x, min_y, max_x, max_y) = bounds(&working);
    let wide = max_x - min_x > 2.5 * (max_y - min_y).max(1e-6);
    let skew = if wide && points.len() >= 3 {
        skew_angle(&points)
    } else {
        0.0
    };
    let angle = -skew + options.extra_rotation;
    let count = points.len() as f64;
    let center_x = points.iter().map(|p| p.0).sum::<f64>() / count;
    let center_y = points.iter().map(|p| p.1).sum::<f64>() / count;
    let (sin, cos) = if angle != 0.0 {
        angle.sin_cos()
    } else {
        (0.0, 1.0)
    };
    if angle != 0.0 {
        for point in working.iter_mut().flatten() {
            let (dx, dy) = (point.0 - center_x, point.1 - center_y);
            *point = (
                dx * cos - dy * sin + center_x,
                dx * sin + dy * cos + center_y,
            );
        }
    }
    let shear = slant_angle(&working).tan() - options.extra_shear;
    let (_, rotated_min_y, _, rotated_max_y) = bounds(&working);
    let shear_center_y = (rotated_min_y + rotated_max_y) / 2.0;
    if shear != 0.0 {
        for point in working.iter_mut().flatten() {
            point.0 -= (point.1 - shear_center_y) * shear;
        }
    }
    let (min_x, min_y, max_x, max_y) = bounds(&working);
    let content = (max_y - min_y)
        .max(0.8 * options.ref_height)
        .max(MIN_CONTENT_HEIGHT);
    let mut scale = (f64::from(INK_HEIGHT) - 2.0 * INK_MARGIN_Y) / content * options.scale_jitter;
    let max_width = f64::from(INK_MAX_WIDTH);
    let mut width_needed = (max_x - min_x) * scale + 2.0 * INK_MARGIN_X;
    if width_needed > max_width {
        scale *= (max_width - 2.0 * INK_MARGIN_X) / ((max_x - min_x) * scale).max(1e-6);
        width_needed = max_width;
    }
    let width = ((width_needed.max(f64::from(INK_MIN_WIDTH)) / 4.0).ceil() * 4.0) as u32;
    Some((
        InkTransform {
            center_x,
            center_y,
            cos,
            sin,
            shear,
            shear_center_y,
            min_x,
            middle_y: (min_y + max_y) / 2.0,
            scale,
        },
        width.min(INK_MAX_WIDTH),
    ))
}

/// Page-space boxes `[min_x, min_y, max_x, max_y]` of the ink under each frame span.
/// A span with no ink of its own (a space, or punctuation the pen skipped) is placed
/// between the neighbouring ink boxes so it still has a position on the page.
pub fn ink_span_boxes(
    strokes: &[Vec<(f64, f64)>],
    options: &InkOptions,
    spans: &[[u32; 2]],
) -> Vec<[f64; 4]> {
    let mut boxes = vec![[f64::NAN; 4]; spans.len()];
    let Some((transform, _)) = ink_transform(strokes, options) else {
        return boxes;
    };
    let points: Vec<(f64, f64)> = strokes.iter().flatten().copied().collect();
    let stride = f64::from(INK_FRAME_STRIDE);
    for &(x, y) in &points {
        let frame = transform.apply(x, y).0 / stride;
        for (index, span) in spans.iter().enumerate() {
            if frame >= f64::from(span[0]) && frame < f64::from(span[1]) {
                let target = &mut boxes[index];
                if target[0].is_nan() {
                    *target = [x, y, x, y];
                } else {
                    target[0] = target[0].min(x);
                    target[1] = target[1].min(y);
                    target[2] = target[2].max(x);
                    target[3] = target[3].max(y);
                }
            }
        }
    }
    fill_empty_spans(
        &mut boxes,
        spans,
        &points,
        stride / transform.scale().max(1e-6),
    );
    boxes
}

fn fill_empty_spans(
    boxes: &mut [[f64; 4]],
    spans: &[[u32; 2]],
    points: &[(f64, f64)],
    page_per_frame: f64,
) {
    if points.is_empty() {
        return;
    }
    let finite: Vec<usize> = boxes
        .iter()
        .enumerate()
        .filter(|(_, region)| region[0].is_finite())
        .map(|(index, _)| index)
        .collect();
    let (min_x, min_y, max_x, max_y) = bounds(&[points.to_vec()]);
    for index in 0..boxes.len() {
        if boxes[index][0].is_finite() {
            continue;
        }
        let previous = finite.iter().copied().rev().find(|&other| other < index);
        let next = finite.iter().copied().find(|&other| other > index);
        let frames = f64::from(spans[index][1].saturating_sub(spans[index][0]).max(1));
        let width = (frames * page_per_frame).max(page_per_frame);
        let (mut x0, mut x1, mut y0, mut y1) = match (previous, next) {
            (Some(previous), Some(next)) => {
                let left = boxes[previous][2];
                let right = boxes[next][0];
                let from = f64::from(spans[previous][1]);
                let to = f64::from(spans[next][0]).max(from + 1.0);
                let start = f64::from(spans[index][0]);
                let end = f64::from(spans[index][1].max(spans[index][0] + 1));
                let x0 = left + (right - left) * ((start - from) / (to - from));
                let x1 = left + (right - left) * ((end - from) / (to - from));
                let y0 = boxes[previous][1].min(boxes[next][1]);
                let y1 = boxes[previous][3].max(boxes[next][3]);
                (x0.min(x1), x0.max(x1), y0, y1)
            }
            (Some(previous), None) => {
                let x0 = boxes[previous][2];
                (x0, x0 + width, boxes[previous][1], boxes[previous][3])
            }
            (None, Some(next)) => {
                let x1 = boxes[next][0];
                (x1 - width, x1, boxes[next][1], boxes[next][3])
            }
            (None, None) => {
                let count = boxes.len().max(1) as f64;
                let x0 = min_x + (max_x - min_x) * (index as f64 / count);
                let x1 = min_x + (max_x - min_x) * ((index as f64 + 1.0) / count);
                (x0, x1, min_y, max_y)
            }
        };
        if !x0.is_finite() || !x1.is_finite() {
            x0 = min_x;
            x1 = max_x;
            y0 = min_y;
            y1 = max_y;
        }
        if x1 < x0 {
            std::mem::swap(&mut x0, &mut x1);
        }
        boxes[index] = [x0, y0.min(y1), x1, y0.max(y1)];
    }
}

/// Draws `strokes` (page units) into the model image.
pub fn ink_image(strokes: &[Vec<(f64, f64)>], options: &InkOptions) -> Option<InkImage> {
    let (transform, width) = ink_transform(strokes, options)?;
    let height = INK_HEIGHT;
    let mut ink = vec![0f32; (width * height) as usize];
    let radius = options.pen_width / 2.0 + 0.5;
    for stroke in strokes.iter().filter(|stroke| !stroke.is_empty()) {
        let mapped: Vec<(f64, f64)> = stroke.iter().map(|&(x, y)| transform.apply(x, y)).collect();
        if mapped.len() == 1 {
            draw_segment(&mut ink, width, height, mapped[0], mapped[0], radius);
        } else {
            for pair in mapped.windows(2) {
                draw_segment(&mut ink, width, height, pair[0], pair[1], radius);
            }
        }
    }
    Some(InkImage {
        width,
        height,
        values: ink.into_iter().map(|value| 1.0 - value).collect(),
        transform,
    })
}

fn draw_segment(
    ink: &mut [f32],
    width: u32,
    height: u32,
    from: (f64, f64),
    to: (f64, f64),
    radius: f64,
) {
    let (x0, y0) = from;
    let (x1, y1) = to;
    let left = ((x0.min(x1) - radius).floor() as i64).max(0);
    let right = ((x0.max(x1) + radius).ceil() as i64).min(i64::from(width) - 1);
    let top = ((y0.min(y1) - radius).floor() as i64).max(0);
    let bottom = ((y0.max(y1) + radius).ceil() as i64).min(i64::from(height) - 1);
    let dx = x1 - x0;
    let dy = y1 - y0;
    let length2 = dx * dx + dy * dy;
    for py in top..=bottom {
        let cy = py as f64 + 0.5;
        for px in left..=right {
            let cx = px as f64 + 0.5;
            let t = if length2 > 1e-12 {
                (((cx - x0) * dx + (cy - y0) * dy) / length2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let ex = cx - (x0 + t * dx);
            let ey = cy - (y0 + t * dy);
            let coverage = (radius - (ex * ex + ey * ey).sqrt()).min(1.0);
            let index = (py as u32 * width + px as u32) as usize;
            if coverage > f64::from(ink[index]) {
                ink[index] = coverage as f32;
            }
        }
    }
}
