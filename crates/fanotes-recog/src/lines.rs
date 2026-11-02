//! Groups the pen strokes of a page into text lines for the ink recognizer.
//!
//! Strokes are clustered by their vertical centre: consecutive strokes (sorted top to bottom)
//! stay on one line until a gap larger than roughly one text size opens, which is where the next
//! line begins. Because the gap is measured locally between neighbouring strokes, a baseline that
//! drifts across the page still stays one line, while a dot, a body stroke and a descender of the
//! same line — of very different heights — are kept together. A wide horizontal gap then splits a
//! row into separate segments (two columns, a margin note).

use serde::Serialize;

#[derive(Debug, Clone, Copy)]
struct Item {
    index: usize,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl Item {
    fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
    fn center_y(&self) -> f64 {
        (self.min_y + self.max_y) / 2.0
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InkLine {
    /// Indexes into the input strokes, in input order.
    pub strokes: Vec<usize>,
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    /// Median body height of this line's strokes.
    pub body_height: f64,
}

/// `strokes` are page-space polylines in writing order. Returns lines top to bottom, segments of
/// one row left to right.
pub fn group_ink_lines(strokes: &[Vec<(f64, f64)>]) -> Vec<InkLine> {
    let mut items: Vec<Item> = strokes
        .iter()
        .enumerate()
        .filter_map(|(index, stroke)| {
            let mut item = Item {
                index,
                min_x: f64::INFINITY,
                min_y: f64::INFINITY,
                max_x: f64::NEG_INFINITY,
                max_y: f64::NEG_INFINITY,
            };
            for &(x, y) in stroke {
                if !x.is_finite() || !y.is_finite() {
                    return None;
                }
                item.min_x = item.min_x.min(x);
                item.min_y = item.min_y.min(y);
                item.max_x = item.max_x.max(x);
                item.max_y = item.max_y.max(y);
            }
            (!stroke.is_empty()).then_some(item)
        })
        .collect();
    if items.is_empty() {
        return Vec::new();
    }
    // Text size from the taller strokes, so a page full of dots and crossbars does not shrink it.
    let mut heights: Vec<f64> = items.iter().map(Item::height).collect();
    heights.sort_by(f64::total_cmp);
    let p75 = heights[(heights.len() * 3) / 4];
    let bodies: Vec<f64> = heights
        .iter()
        .copied()
        .filter(|&height| height >= p75 * 0.4)
        .collect();
    let unit = bodies[bodies.len() / 2].max(2.0);
    // A stroke joins the current line while it starts within this much of the line's growing
    // lower edge, so a floating i-dot or an accent above the body still counts as adjacent while
    // the clearly separated next line does not.
    let adjacency = unit * 0.6;

    items.sort_by(|a, b| a.center_y().total_cmp(&b.center_y()));
    let mut rows: Vec<Vec<Item>> = Vec::new();
    let mut row_bottom = f64::NEG_INFINITY;
    for item in items {
        if rows.is_empty() || item.min_y > row_bottom + adjacency {
            rows.push(Vec::new());
            row_bottom = item.max_y;
        }
        row_bottom = row_bottom.max(item.max_y);
        rows.last_mut().unwrap().push(item);
    }

    let mut lines: Vec<InkLine> = rows
        .into_iter()
        .flat_map(|row| split_row(row, unit))
        .collect();
    lines.sort_by(|a, b| {
        let a_center = (a.min_y + a.max_y) / 2.0;
        let b_center = (b.min_y + b.max_y) / 2.0;
        if (a_center - b_center).abs() < a.body_height.min(b.body_height) * 0.5 {
            a.min_x.total_cmp(&b.min_x)
        } else {
            a_center.total_cmp(&b_center)
        }
    });
    lines
}

/// Splits one vertical cluster into left-to-right segments wherever a horizontal gap is wider
/// than several text sizes (columns, a detached margin note).
fn split_row(mut row: Vec<Item>, unit: f64) -> Vec<InkLine> {
    let body = {
        let mut body_heights: Vec<f64> = row.iter().map(Item::height).collect();
        body_heights.sort_by(f64::total_cmp);
        body_heights[body_heights.len() / 2].max(unit)
    };
    row.sort_by(|a, b| a.min_x.total_cmp(&b.min_x));
    let mut groups: Vec<Vec<Item>> = Vec::new();
    let mut right = f64::NEG_INFINITY;
    for item in row {
        if groups.is_empty() || item.min_x - right > body * 4.5 {
            groups.push(Vec::new());
            right = item.max_x;
        }
        right = right.max(item.max_x);
        groups.last_mut().unwrap().push(item);
    }
    groups
        .into_iter()
        .map(|group| {
            let mut strokes: Vec<usize> = group.iter().map(|item| item.index).collect();
            strokes.sort_unstable();
            InkLine {
                strokes,
                min_x: group
                    .iter()
                    .map(|item| item.min_x)
                    .fold(f64::INFINITY, f64::min),
                min_y: group
                    .iter()
                    .map(|item| item.min_y)
                    .fold(f64::INFINITY, f64::min),
                max_x: group
                    .iter()
                    .map(|item| item.max_x)
                    .fold(f64::NEG_INFINITY, f64::max),
                max_y: group
                    .iter()
                    .map(|item| item.max_y)
                    .fold(f64::NEG_INFINITY, f64::max),
                body_height: body,
            }
        })
        .collect()
}
