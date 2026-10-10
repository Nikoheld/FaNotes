//! SVG path data for art stamps (`Path2D` in the TypeScript painter).

use std::f64::consts::PI;

use tiny_skia::{Path, PathBuilder};

struct Cursor<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl<'a> Cursor<'a> {
    fn skip_separators(&mut self) {
        while self.index < self.bytes.len() {
            let byte = self.bytes[self.index];
            if byte.is_ascii_whitespace() || byte == b',' {
                self.index += 1;
            } else {
                break;
            }
        }
    }

    fn peek_command(&mut self) -> Option<u8> {
        self.skip_separators();
        let byte = *self.bytes.get(self.index)?;
        if byte.is_ascii_alphabetic() && byte != b'e' && byte != b'E' {
            Some(byte)
        } else {
            None
        }
    }

    fn at_number(&mut self) -> bool {
        self.skip_separators();
        matches!(
            self.bytes.get(self.index),
            Some(b'0'..=b'9' | b'.' | b'-' | b'+')
        )
    }

    fn number(&mut self) -> Option<f64> {
        self.skip_separators();
        let start = self.index;
        let mut index = self.index;
        if matches!(self.bytes.get(index), Some(b'-' | b'+')) {
            index += 1;
        }
        let mut digits = false;
        while matches!(self.bytes.get(index), Some(b'0'..=b'9')) {
            index += 1;
            digits = true;
        }
        if self.bytes.get(index) == Some(&b'.') {
            index += 1;
            while matches!(self.bytes.get(index), Some(b'0'..=b'9')) {
                index += 1;
                digits = true;
            }
        }
        if !digits {
            return None;
        }
        if matches!(self.bytes.get(index), Some(b'e' | b'E')) {
            let mut exponent = index + 1;
            if matches!(self.bytes.get(exponent), Some(b'-' | b'+')) {
                exponent += 1;
            }
            if matches!(self.bytes.get(exponent), Some(b'0'..=b'9')) {
                while matches!(self.bytes.get(exponent), Some(b'0'..=b'9')) {
                    exponent += 1;
                }
                index = exponent;
            }
        }
        self.index = index;
        std::str::from_utf8(&self.bytes[start..index])
            .ok()?
            .parse()
            .ok()
    }

    fn flag(&mut self) -> Option<bool> {
        self.skip_separators();
        let byte = *self.bytes.get(self.index)?;
        let value = match byte {
            b'0' => false,
            b'1' => true,
            _ => return None,
        };
        self.index += 1;
        Some(value)
    }
}

/// Parses SVG path data. Unknown or malformed input ends the path where it stops.
pub fn parse_svg_path(data: &str) -> Option<Path> {
    let mut cursor = Cursor {
        bytes: data.as_bytes(),
        index: 0,
    };
    let mut builder = PathBuilder::new();
    let (mut x, mut y) = (0.0_f64, 0.0_f64);
    let (mut start_x, mut start_y) = (0.0_f64, 0.0_f64);
    let mut last_cubic: Option<(f64, f64)> = None;
    let mut last_quad: Option<(f64, f64)> = None;
    let mut command = 0_u8;
    loop {
        if let Some(next) = cursor.peek_command() {
            command = next;
            cursor.index += 1;
        } else if !cursor.at_number() || command == 0 {
            break;
        }
        let relative = command.is_ascii_lowercase();
        let (base_x, base_y) = if relative { (x, y) } else { (0.0, 0.0) };
        match command.to_ascii_uppercase() {
            b'M' => {
                let (Some(nx), Some(ny)) = (cursor.number(), cursor.number()) else {
                    break;
                };
                x = base_x + nx;
                y = base_y + ny;
                start_x = x;
                start_y = y;
                builder.move_to(x as f32, y as f32);
                command = if relative { b'l' } else { b'L' };
                last_cubic = None;
                last_quad = None;
                continue;
            }
            b'L' => {
                let (Some(nx), Some(ny)) = (cursor.number(), cursor.number()) else {
                    break;
                };
                x = base_x + nx;
                y = base_y + ny;
                builder.line_to(x as f32, y as f32);
                last_cubic = None;
                last_quad = None;
            }
            b'H' => {
                let Some(nx) = cursor.number() else { break };
                x = base_x + nx;
                builder.line_to(x as f32, y as f32);
                last_cubic = None;
                last_quad = None;
            }
            b'V' => {
                let Some(ny) = cursor.number() else { break };
                y = if relative { y + ny } else { ny };
                builder.line_to(x as f32, y as f32);
                last_cubic = None;
                last_quad = None;
            }
            b'C' => {
                let mut values = [0.0; 6];
                for value in &mut values {
                    let Some(number) = cursor.number() else {
                        return builder.finish();
                    };
                    *value = number;
                }
                let (x1, y1) = (base_x + values[0], base_y + values[1]);
                let (x2, y2) = (base_x + values[2], base_y + values[3]);
                x = base_x + values[4];
                y = base_y + values[5];
                builder.cubic_to(
                    x1 as f32, y1 as f32, x2 as f32, y2 as f32, x as f32, y as f32,
                );
                last_cubic = Some((x2, y2));
                last_quad = None;
            }
            b'S' => {
                let mut values = [0.0; 4];
                for value in &mut values {
                    let Some(number) = cursor.number() else {
                        return builder.finish();
                    };
                    *value = number;
                }
                let (x1, y1) = match last_cubic {
                    Some((cx, cy)) => (2.0 * x - cx, 2.0 * y - cy),
                    None => (x, y),
                };
                let (x2, y2) = (base_x + values[0], base_y + values[1]);
                x = base_x + values[2];
                y = base_y + values[3];
                builder.cubic_to(
                    x1 as f32, y1 as f32, x2 as f32, y2 as f32, x as f32, y as f32,
                );
                last_cubic = Some((x2, y2));
                last_quad = None;
            }
            b'Q' => {
                let mut values = [0.0; 4];
                for value in &mut values {
                    let Some(number) = cursor.number() else {
                        return builder.finish();
                    };
                    *value = number;
                }
                let (x1, y1) = (base_x + values[0], base_y + values[1]);
                x = base_x + values[2];
                y = base_y + values[3];
                builder.quad_to(x1 as f32, y1 as f32, x as f32, y as f32);
                last_quad = Some((x1, y1));
                last_cubic = None;
            }
            b'T' => {
                let (Some(nx), Some(ny)) = (cursor.number(), cursor.number()) else {
                    break;
                };
                let (x1, y1) = match last_quad {
                    Some((cx, cy)) => (2.0 * x - cx, 2.0 * y - cy),
                    None => (x, y),
                };
                x = base_x + nx;
                y = base_y + ny;
                builder.quad_to(x1 as f32, y1 as f32, x as f32, y as f32);
                last_quad = Some((x1, y1));
                last_cubic = None;
            }
            b'A' => {
                let (Some(rx), Some(ry), Some(rotation)) =
                    (cursor.number(), cursor.number(), cursor.number())
                else {
                    break;
                };
                let (Some(large), Some(sweep)) = (cursor.flag(), cursor.flag()) else {
                    break;
                };
                let (Some(nx), Some(ny)) = (cursor.number(), cursor.number()) else {
                    break;
                };
                let (end_x, end_y) = (base_x + nx, base_y + ny);
                arc_to(
                    &mut builder,
                    (x, y),
                    (end_x, end_y),
                    rx,
                    ry,
                    rotation,
                    large,
                    sweep,
                );
                x = end_x;
                y = end_y;
                last_cubic = None;
                last_quad = None;
            }
            b'Z' => {
                builder.close();
                x = start_x;
                y = start_y;
                last_cubic = None;
                last_quad = None;
                command = 0;
                continue;
            }
            _ => break,
        }
    }
    builder.finish()
}

/// SVG endpoint arc as cubic Béziers (SVG 1.1 implementation notes, F.6.5).
#[allow(clippy::too_many_arguments)]
fn arc_to(
    builder: &mut PathBuilder,
    from: (f64, f64),
    to: (f64, f64),
    rx: f64,
    ry: f64,
    rotation_deg: f64,
    large_arc: bool,
    sweep: bool,
) {
    if (from.0 - to.0).abs() < 1e-12 && (from.1 - to.1).abs() < 1e-12 {
        return;
    }
    let mut rx = rx.abs();
    let mut ry = ry.abs();
    if rx < 1e-12 || ry < 1e-12 {
        builder.line_to(to.0 as f32, to.1 as f32);
        return;
    }
    let phi = rotation_deg.to_radians();
    let (sin_phi, cos_phi) = phi.sin_cos();
    let dx = (from.0 - to.0) / 2.0;
    let dy = (from.1 - to.1) / 2.0;
    let x1p = cos_phi * dx + sin_phi * dy;
    let y1p = -sin_phi * dx + cos_phi * dy;
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lambda > 1.0 {
        let grow = lambda.sqrt();
        rx *= grow;
        ry *= grow;
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut coefficient = if denominator > 0.0 {
        (numerator / denominator).max(0.0).sqrt()
    } else {
        0.0
    };
    if large_arc == sweep {
        coefficient = -coefficient;
    }
    let cxp = coefficient * rx * y1p / ry;
    let cyp = -coefficient * ry * x1p / rx;
    let cx = cos_phi * cxp - sin_phi * cyp + (from.0 + to.0) / 2.0;
    let cy = sin_phi * cxp + cos_phi * cyp + (from.1 + to.1) / 2.0;
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| {
        let dot = ux * vx + uy * vy;
        let len = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
        let mut value = (dot / len).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 {
            value = -value;
        }
        value
    };
    let ux = (x1p - cxp) / rx;
    let uy = (y1p - cyp) / ry;
    let vx = (-x1p - cxp) / rx;
    let vy = (-y1p - cyp) / ry;
    let theta1 = angle(1.0, 0.0, ux, uy);
    let mut delta = angle(ux, uy, vx, vy);
    if !sweep && delta > 0.0 {
        delta -= 2.0 * PI;
    } else if sweep && delta < 0.0 {
        delta += 2.0 * PI;
    }
    let segments = (delta.abs() / (PI / 2.0)).ceil().max(1.0) as usize;
    let step = delta / segments as f64;
    let handle = 4.0 / 3.0 * (step / 4.0).tan();
    let map = |ex: f64, ey: f64| {
        let px = ex * rx;
        let py = ey * ry;
        (
            cos_phi * px - sin_phi * py + cx,
            sin_phi * px + cos_phi * py + cy,
        )
    };
    let mut start = theta1;
    for _ in 0..segments {
        let end = start + step;
        let (sin_a, cos_a) = start.sin_cos();
        let (sin_b, cos_b) = end.sin_cos();
        let c1 = map(cos_a - handle * sin_a, sin_a + handle * cos_a);
        let c2 = map(cos_b + handle * sin_b, sin_b - handle * cos_b);
        let p = map(cos_b, sin_b);
        builder.cubic_to(
            c1.0 as f32,
            c1.1 as f32,
            c2.0 as f32,
            c2.1 as f32,
            p.0 as f32,
            p.1 as f32,
        );
        start = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(data: &str) -> (f32, f32, f32, f32) {
        let path = parse_svg_path(data).expect("path");
        let rect = path.compute_tight_bounds().expect("bounds");
        (rect.left(), rect.top(), rect.right(), rect.bottom())
    }

    #[test]
    fn circle_from_two_arcs_spans_its_diameter() {
        let (left, top, right, bottom) = bounds("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z");
        assert!(
            (left - 2.0).abs() < 0.05 && (right - 22.0).abs() < 0.05,
            "{left} {right}"
        );
        assert!(
            (top - 2.0).abs() < 0.05 && (bottom - 22.0).abs() < 0.05,
            "{top} {bottom}"
        );
    }

    #[test]
    fn relative_lines_smooth_cubics_and_implicit_commands_parse() {
        let (left, top, right, bottom) = bounds("m13 6 6 6-6 6");
        assert_eq!((left, top, right, bottom), (13.0, 6.0, 19.0, 18.0));
        let (_, _, right, _) = bounds("M4 20l4.2-1 11-11a2.1 2.1 0 0 0-3-3l-11 11Z");
        assert!(right > 19.0 && right < 21.0, "{right}");
        let (left, _, right, _) =
            bounds("M19.1 4.9c2.8 2.8-1.1 11.1-6.2 16.2S1.5 18.3 4.9 14.9 16.3 1.5 19.1 4.9Z");
        assert!(left > 0.0 && right < 24.0, "{left} {right}");
        let (left, top, right, bottom) = bounds("M5 22V3 M5 4h12l-2 4 2 4H5");
        assert_eq!((left, top, right, bottom), (5.0, 3.0, 17.0, 22.0));
    }

    #[test]
    fn dot_paths_like_lucide_survive() {
        let path = parse_svg_path("M8 14h.01M12 14h.01").expect("path");
        assert_eq!(path.len(), 4);
    }
}
