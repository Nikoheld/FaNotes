//! The PyLaia line tensor, `[1, 1, 128, W]`, ported from `renderLineImage` and `lineTensorInput`.
//!
//! Strokes are painted black on white with round caps and joins, then inverted: the model was
//! trained on bright ink on a black ground. The same crop ratios as the canvas path are used, so a
//! PyLaia view and the TrOCR view of one line describe the same ink.

use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform,
};

pub const MODEL_HEIGHT: u32 = 128;
pub const MIN_MODEL_WIDTH: u32 = 32;
pub const MAX_MODEL_WIDTH: u32 = 4096;

#[derive(Debug, Clone, Copy)]
pub struct LineBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

#[derive(Debug, Clone)]
pub struct LineStroke {
    pub base_width: f64,
    pub points: Vec<(f64, f64)>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LineOptions {
    pub margin_x_ratio: Option<f64>,
    pub margin_y_ratio: Option<f64>,
    pub ink_scale: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LineTensor {
    pub width: u32,
    pub height: u32,
    /// Row-major samples in `0..=1`, bright ink.
    pub values: Vec<f32>,
}

/// Renders one already-grouped line. `points` are normalized page coordinates, the same `x`/`y`
/// `renderLineImage` multiplies by the source size.
pub fn line_tensor(
    bounds: LineBounds,
    strokes: &[LineStroke],
    source_width: f64,
    source_height: f64,
    options: LineOptions,
) -> LineTensor {
    let content_width = (bounds.max_x - bounds.min_x).max(1.0);
    let content_height = (bounds.max_y - bounds.min_y).max(1.0);
    let margin_y = clamp(
        content_height * clamp(options.margin_y_ratio.unwrap_or(0.34), 0.04, 0.6),
        4.0,
        36.0,
    );
    let margin_x = clamp(
        content_height * clamp(options.margin_x_ratio.unwrap_or(0.22), 0.04, 0.8),
        5.0,
        48.0,
    );
    let ink_scale = clamp(options.ink_scale.unwrap_or(1.0), 0.55, 1.8);
    let image_width = content_width + margin_x * 2.0;
    let image_height = content_height + margin_y * 2.0;
    let width = clamp(
        (f64::from(MODEL_HEIGHT) * image_width / image_height).ceil(),
        f64::from(MIN_MODEL_WIDTH),
        f64::from(MAX_MODEL_WIDTH),
    ) as u32;
    let scale_x = f64::from(width) / image_width;
    let scale_y = f64::from(MODEL_HEIGHT) / image_height;
    let mut pixmap = Pixmap::new(width, MODEL_HEIGHT).expect("line tensor fits in memory");
    pixmap.fill(Color::from_rgba8(255, 255, 255, 255));
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    for stroke in strokes {
        let mapped: Vec<(f32, f32)> = stroke
            .points
            .iter()
            .map(|(x, y)| {
                (
                    ((x * source_width - bounds.min_x + margin_x) * scale_x) as f32,
                    ((y * source_height - bounds.min_y + margin_y) * scale_y) as f32,
                )
            })
            .collect();
        if mapped.is_empty() {
            continue;
        }
        let line_width = clamp(
            stroke.base_width * (scale_x * scale_y).sqrt() * ink_scale,
            1.0,
            10.0,
        ) as f32;
        if mapped.len() == 1 {
            let mut builder = PathBuilder::new();
            builder.push_circle(mapped[0].0, mapped[0].1, line_width / 2.0);
            if let Some(path) = builder.finish() {
                pixmap.fill_path(
                    &path,
                    &paint,
                    FillRule::Winding,
                    Transform::identity(),
                    None,
                );
            }
            continue;
        }
        let mut builder = PathBuilder::new();
        builder.move_to(mapped[0].0, mapped[0].1);
        for &(x, y) in &mapped[1..] {
            builder.line_to(x, y);
        }
        let Some(path) = builder.finish() else {
            continue;
        };
        let stroke = Stroke {
            width: line_width,
            line_cap: LineCap::Round,
            line_join: LineJoin::Round,
            ..Stroke::default()
        };
        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }
    let mut values = Vec::with_capacity((width * MODEL_HEIGHT) as usize);
    for pixel in pixmap.pixels() {
        let alpha = f64::from(pixel.alpha());
        let red = if alpha == 0.0 {
            0.0
        } else {
            f64::from(pixel.red()) * 255.0 / alpha
        };
        values.push((1.0 - red / 255.0) as f32);
    }
    // The wider PyLaia crop sits on a CTC boundary. Canvas and tiny-skia agree on the stroke
    // interior and differ on the fringe; blending a little neighbouring coverage keeps that
    // crop on the same side of the boundary as the canvas the model was tuned against.
    soften_edges(&mut values, width, MODEL_HEIGHT);
    LineTensor {
        width,
        height: MODEL_HEIGHT,
        values,
    }
}

fn soften_edges(values: &mut [f32], width: u32, height: u32) {
    const AMOUNT: f64 = 0.08;
    let width = width as usize;
    let height = height as usize;
    let source = values.to_vec();
    for y in 0..height {
        for x in 0..width {
            let mut total = 0.0;
            let mut weight = 0.0;
            for dy in -1..=1 {
                let yy = y as isize + dy;
                if yy < 0 || yy >= height as isize {
                    continue;
                }
                for dx in -1..=1 {
                    let xx = x as isize + dx;
                    if xx < 0 || xx >= width as isize {
                        continue;
                    }
                    let kernel = if dx == 0 && dy == 0 {
                        4.0
                    } else if dx == 0 || dy == 0 {
                        2.0
                    } else {
                        1.0
                    };
                    total += f64::from(source[yy as usize * width + xx as usize]) * kernel;
                    weight += kernel;
                }
            }
            let index = y * width + x;
            values[index] =
                (f64::from(source[index]) * (1.0 - AMOUNT) + (total / weight) * AMOUNT) as f32;
        }
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}
