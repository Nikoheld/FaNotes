//! Deterministic synthetic ink for tests, benchmarks and `paper-proto --headless-frames`.

use fanotes_raster::{Brush, Effect, InkPoint, InkStroke};

/// xorshift64*: same numbers on every machine.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
}

/// One handwriting-sized glyph stroke: a wobbly loop about `size` px wide at `(x, y)`.
pub fn glyph(rng: &mut Rng, x: f64, y: f64, size: f64, points: usize) -> Vec<InkPoint> {
    let turns = rng.range(0.6, 1.4);
    let phase = rng.range(0.0, std::f64::consts::TAU);
    let lean = rng.range(-0.25, 0.25);
    let drift = rng.range(0.4, 1.0);
    (0..points.max(1))
        .map(|i| {
            let t = i as f64 / (points.max(2) - 1) as f64;
            let a = phase + t * turns * std::f64::consts::TAU;
            let r = size * 0.5 * (0.55 + 0.45 * (t * 3.1).sin().abs());
            InkPoint {
                x: x + t * size * drift + a.cos() * r * 0.6 + lean * (a.sin() * r),
                y: y + a.sin() * r * 0.8,
                pressure: 0.35 + 0.4 * (t * std::f64::consts::PI).sin(),
            }
        })
        .collect()
}

/// `strokes` glyph strokes of `points` samples each, written in lines across
/// a `page` (page px). When the page is full the next layer starts at the top
/// again, a little offset, so a 500k-stroke page is dense ink everywhere.
pub fn handwriting(strokes: usize, points: usize, page: (f64, f64), seed: u64) -> Vec<InkStroke> {
    let mut rng = Rng::new(seed);
    let margin = 40.0;
    let line = 28.0;
    let advance = 11.0;
    let per_line = ((page.0 - 2.0 * margin) / advance).floor().max(1.0) as usize;
    let lines = ((page.1 - 2.0 * margin) / line).floor().max(1.0) as usize;
    let per_layer = per_line * lines;
    (0..strokes)
        .map(|index| {
            let layer = index / per_layer;
            let slot = index % per_layer;
            let offset = (layer as f64 * 3.7) % line;
            let x = margin + (slot % per_line) as f64 * advance + rng.range(-1.5, 1.5);
            let y = margin + (slot / per_line) as f64 * line + offset + rng.range(-2.0, 2.0);
            let size = rng.range(9.0, 16.0);
            let mut stroke = InkStroke::pen(glyph(&mut rng, x, y, size, points), 2.5, 0x1a1a1a);
            stroke.pressure_enabled = true;
            stroke
        })
        .collect()
}

/// A long sweeping stroke for the wet-stroke benchmarks, `points` samples.
pub fn long_stroke(points: usize, origin: (f64, f64)) -> Vec<InkPoint> {
    (0..points)
        .map(|i| {
            let t = i as f64 * 0.05;
            InkPoint {
                x: origin.0 + t * 6.0 % 600.0,
                y: origin.1 + (t * 0.9).sin() * 40.0 + (t * 6.0 / 600.0).floor() * 90.0,
                pressure: 0.4 + 0.3 * (t * 0.37).sin(),
            }
        })
        .collect()
}

/// An art stroke with every brush field set.
pub fn art(points: Vec<InkPoint>, brush: Brush, width: f64, color: u32) -> InkStroke {
    let mut stroke = InkStroke::pen(points, width, color);
    stroke.art = true;
    stroke.brush = Some(brush);
    stroke.texture_seed = Some(17.0);
    stroke
}

/// An art stroke with a special ink.
pub fn special(points: Vec<InkPoint>, effect: Effect, width: f64) -> InkStroke {
    let mut stroke = art(points, Brush::Fineliner, width, 0x3a7bd5);
    stroke.effect = effect;
    stroke
}
