//! The flat stroke format `fanotes/src/lib/viewportRaster.ts` sends across wasm.

use std::sync::Arc;

use crate::stroke::{Brush, Effect, InkPoint, InkStroke, Symbol};

/// Header values per stroke, in order:
/// point count, base width, pressure enabled, 0xRRGGBB, art, brush id (−1 none),
/// effect id, opacity (NaN none), texture seed (NaN none), symbol index (−1 none),
/// symbol rotation in degrees. Points follow as `x, y, pressure` triples.
pub const PACKED_STROKE_FIELDS: usize = 11;
pub const PACKED_POINT_FIELDS: usize = 3;

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn optional(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

/// Rebuilds strokes; a truncated tail ends the list instead of reading past it.
pub fn strokes_from_packed(
    header: &[f64],
    points: &[f64],
    symbols: &[Arc<Symbol>],
) -> Vec<InkStroke> {
    let mut strokes = Vec::with_capacity(header.len() / PACKED_STROKE_FIELDS);
    let mut cursor = 0_usize;
    for fields in header.as_chunks::<PACKED_STROKE_FIELDS>().0 {
        // The count is untrusted (it comes across wasm from the page). `as`
        // saturates a huge float at `usize::MAX`, so the arithmetic is checked:
        // an overflowing or out-of-range count ends the list like a truncated
        // tail. Every allocation below is bounded by the slices' real lengths.
        let count = finite_or(fields[0], 0.0).max(0.0) as usize;
        let Some(end) = count
            .checked_mul(PACKED_POINT_FIELDS)
            .and_then(|len| cursor.checked_add(len))
            .filter(|end| *end <= points.len())
        else {
            break;
        };
        let stroke_points = points[cursor..end]
            .as_chunks::<PACKED_POINT_FIELDS>()
            .0
            .iter()
            .map(|point| InkPoint {
                x: finite_or(point[0], 0.0),
                y: finite_or(point[1], 0.0),
                pressure: finite_or(point[2], 0.5),
            })
            .collect();
        cursor = end;
        let symbol_index = finite_or(fields[9], -1.0);
        strokes.push(InkStroke {
            points: stroke_points,
            base_width: finite_or(fields[1], 4.0),
            pressure_enabled: fields[2] != 0.0,
            color: finite_or(fields[3], 0.0).clamp(0.0, 16_777_215.0) as u32,
            art: fields[4] != 0.0,
            brush: Brush::from_id(finite_or(fields[5], -1.0) as i64),
            effect: Effect::from_id(finite_or(fields[6], 0.0) as i64),
            opacity: optional(fields[7]),
            texture_seed: optional(fields[8]),
            symbol: (symbol_index >= 0.0)
                .then(|| symbols.get(symbol_index as usize).cloned())
                .flatten(),
            symbol_rotation: finite_or(fields[10], 0.0),
        });
    }
    strokes
}

/// The inverse of [`strokes_from_packed`], for tests and native callers.
pub fn pack_strokes(strokes: &[InkStroke], symbols: &[Arc<Symbol>]) -> (Vec<f64>, Vec<f64>) {
    let mut header = Vec::with_capacity(strokes.len() * PACKED_STROKE_FIELDS);
    let mut points = Vec::new();
    for stroke in strokes {
        let symbol = stroke
            .symbol
            .as_ref()
            .and_then(|symbol| symbols.iter().position(|known| Arc::ptr_eq(known, symbol)))
            .map(|index| index as f64)
            .unwrap_or(-1.0);
        header.extend_from_slice(&[
            stroke.points.len() as f64,
            stroke.base_width,
            if stroke.pressure_enabled { 1.0 } else { 0.0 },
            stroke.color as f64,
            if stroke.art { 1.0 } else { 0.0 },
            stroke.brush.map(|brush| brush.id() as f64).unwrap_or(-1.0),
            stroke.effect.id() as f64,
            stroke.opacity.unwrap_or(f64::NAN),
            stroke.texture_seed.unwrap_or(f64::NAN),
            symbol,
            stroke.symbol_rotation,
        ]);
        for point in &stroke.points {
            points.extend_from_slice(&[point.x, point.y, point.pressure]);
        }
    }
    (header, points)
}

#[cfg(test)]
mod tests {
    use super::{strokes_from_packed, PACKED_STROKE_FIELDS};

    fn header(count: f64) -> Vec<f64> {
        let mut fields = vec![0.0; PACKED_STROKE_FIELDS];
        fields[0] = count;
        fields[1] = 4.0;
        fields[7] = f64::NAN;
        fields[8] = f64::NAN;
        fields[9] = -1.0;
        fields
    }

    /// A hostile count used to overflow `count * 3` (a debug-build panic, a
    /// wrapped and possibly in-range `end` in release builds).
    #[test]
    fn a_huge_point_count_ends_the_list_instead_of_overflowing() {
        let points = vec![1.0, 2.0, 0.5, 3.0, 4.0, 0.5];
        for hostile in [
            f64::MAX,
            1e300,
            usize::MAX as f64,
            (usize::MAX / 3 + 1) as f64,
            ((usize::MAX / 3) * 2) as f64,
        ] {
            let mut packed = header(2.0);
            packed.extend(header(hostile));
            packed.extend(header(0.0));
            let strokes = strokes_from_packed(&packed, &points, &[]);
            assert_eq!(strokes.len(), 1, "count {hostile}");
            assert_eq!(strokes[0].points.len(), 2);
        }
        // A count past the end of the points is a truncated tail, too.
        let strokes = strokes_from_packed(&header(3.0), &points, &[]);
        assert!(strokes.is_empty());
        // Infinity is not finite, so it counts as zero points.
        let strokes = strokes_from_packed(&header(f64::INFINITY), &points, &[]);
        assert_eq!(strokes.len(), 1);
        assert!(strokes[0].points.is_empty());
    }
}
