//! Paper ruling, as the live sheet draws it.
//!
//! These are the `.paper-ruling` backgrounds of `fanotes/src/styles.css`
//! (`background-position: var(--text-origin-x) var(--text-origin-y)`), not the
//! export painter: the pattern repeats from the origin pad in both directions,
//! so a min-edge grow moves the ruling with the text and the ink.
//! Only the cells the viewport shows are emitted.

use kurbo::{Point, Rect};

/// Straight (not premultiplied) RGBA.
pub type Rgba = [u8; 4];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PaperStyle {
    Blank,
    /// 28 px pitch, a 1 px line at the bottom of each row.
    Lines,
    /// Häuschen: 1 px lines every `square` px (default 20).
    Squares(f64),
    /// Kariert: 1 px lines every `square` px (default 28).
    Grid(f64),
    /// 28 px pitch, a 0.8 px dot in the middle of each cell.
    Dots,
    /// 20 px cell with 4 px minor lines.
    Millimeter,
}

impl PaperStyle {
    /// `paperStyle` of a drawing or note. Unknown values fall back to dots like `normalizePaperStyle`.
    pub fn from_name(name: &str) -> Self {
        match name {
            "blank" => Self::Blank,
            "lines" => Self::Lines,
            "squares" => Self::Squares(20.0),
            "grid" => Self::Grid(28.0),
            "millimeter" => Self::Millimeter,
            _ => Self::Dots,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Prim {
    Rect { rect: Rect, rgba: Rgba },
    Circle { c: Point, r: f64, rgba: Rgba },
}

const fn rgba(r: u8, g: u8, b: u8, a: f64) -> Rgba {
    [r, g, b, (a * 255.0 + 0.5) as u8]
}

const LINES: Rgba = rgba(82, 91, 116, 0.13);
const SQUARES: Rgba = rgba(82, 118, 168, 0.16);
const GRID: Rgba = rgba(82, 91, 116, 0.105);
const DOTS: Rgba = rgba(82, 91, 116, 0.19);
const MM_MINOR: Rgba = rgba(92, 118, 168, 0.08);
const MM_MAJOR: Rgba = rgba(72, 98, 148, 0.18);

/// Below this many device px per cell a pattern is a haze; it is not drawn.
const MIN_PITCH_DEVICE_PX: f64 = 3.0;

fn cells(from: f64, to: f64, origin: f64, pitch: f64) -> std::ops::RangeInclusive<i64> {
    let first = ((from - origin) / pitch).floor() as i64 - 1;
    let last = ((to - origin) / pitch).ceil() as i64;
    first..=last
}

/// Ruling primitives covering `visible` (page px). `scale` is device px per page px.
pub fn ruling_prims(
    style: PaperStyle,
    origin: (f64, f64),
    visible: Rect,
    scale: f64,
    out: &mut Vec<Prim>,
) {
    let (ox, oy) = origin;
    let pitch_ok = |pitch: f64| pitch > 0.0 && pitch * scale >= MIN_PITCH_DEVICE_PX;
    let columns = |out: &mut Vec<Prim>, pitch: f64, offset: f64, width: f64, color: Rgba| {
        for k in cells(visible.x0, visible.x1, ox, pitch) {
            let x = ox + k as f64 * pitch + offset;
            out.push(Prim::Rect {
                rect: Rect::new(x, visible.y0, x + width, visible.y1),
                rgba: color,
            });
        }
    };
    let rows = |out: &mut Vec<Prim>, pitch: f64, offset: f64, height: f64, color: Rgba| {
        for k in cells(visible.y0, visible.y1, oy, pitch) {
            let y = oy + k as f64 * pitch + offset;
            out.push(Prim::Rect {
                rect: Rect::new(visible.x0, y, visible.x1, y + height),
                rgba: color,
            });
        }
    };
    match style {
        PaperStyle::Blank => {}
        PaperStyle::Lines => {
            if pitch_ok(28.0) {
                rows(out, 28.0, 27.0, 1.0, LINES);
            }
        }
        PaperStyle::Squares(size) | PaperStyle::Grid(size) => {
            let color = if matches!(style, PaperStyle::Squares(_)) {
                SQUARES
            } else {
                GRID
            };
            if pitch_ok(size) {
                columns(out, size, 0.0, 1.0, color);
                rows(out, size, 0.0, 1.0, color);
            }
        }
        PaperStyle::Dots => {
            if pitch_ok(28.0) {
                for j in cells(visible.y0, visible.y1, oy, 28.0) {
                    for i in cells(visible.x0, visible.x1, ox, 28.0) {
                        out.push(Prim::Circle {
                            c: Point::new(ox + i as f64 * 28.0 + 14.0, oy + j as f64 * 28.0 + 14.0),
                            r: 0.8,
                            rgba: DOTS,
                        });
                    }
                }
            }
        }
        PaperStyle::Millimeter => {
            if pitch_ok(4.0) {
                for offset in [3.5, 7.5, 11.5, 15.5] {
                    columns(out, 20.0, offset, 1.0, MM_MINOR);
                    rows(out, 20.0, offset, 1.0, MM_MINOR);
                }
            }
            if pitch_ok(20.0) {
                // `M20 0H0V20` at stroke-width 1: the half inside each 20 px cell.
                columns(out, 20.0, 0.0, 0.5, MM_MAJOR);
                rows(out, 20.0, 0.0, 0.5, MM_MAJOR);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_follow_the_origin_pad() {
        let mut prims = Vec::new();
        let view = Rect::new(0.0, 0.0, 200.0, 120.0);
        ruling_prims(PaperStyle::Lines, (0.0, 0.0), view, 1.0, &mut prims);
        let tops: Vec<f64> = prims
            .iter()
            .filter_map(|prim| match prim {
                Prim::Rect { rect, .. } if rect.y0 >= 0.0 && rect.y0 < 120.0 => Some(rect.y0),
                _ => None,
            })
            .collect();
        assert_eq!(tops, vec![27.0, 55.0, 83.0, 111.0]);
        prims.clear();
        ruling_prims(PaperStyle::Lines, (0.0, 144.0), view, 1.0, &mut prims);
        let first = prims
            .iter()
            .filter_map(|prim| match prim {
                Prim::Rect { rect, .. } if rect.y0 >= 0.0 => Some(rect.y0),
                _ => None,
            })
            .next();
        // The pattern is anchored at the pad: 144 - 6 * 28 + 27 = 3.
        assert_eq!(first, Some(144.0 - 28.0 * 6.0 + 27.0));
    }

    #[test]
    fn a_far_zoomed_out_dot_haze_is_skipped() {
        let mut prims = Vec::new();
        ruling_prims(
            PaperStyle::Dots,
            (0.0, 0.0),
            Rect::new(0.0, 0.0, 20_000.0, 20_000.0),
            0.05,
            &mut prims,
        );
        assert!(prims.is_empty());
        ruling_prims(
            PaperStyle::Dots,
            (0.0, 0.0),
            Rect::new(0.0, 0.0, 56.0, 56.0),
            1.0,
            &mut prims,
        );
        assert!(prims
            .iter()
            .any(|prim| matches!(prim, Prim::Circle { c, .. } if c.x == 14.0 && c.y == 14.0)));
    }
}
