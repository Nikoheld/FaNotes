//! Groups the pen strokes of a page into text lines for the ink recognizer.
//!
//! Large strokes found the lines: each line keeps a straight centre track, so a line that drifts
//! across the page still collects its own words while the descenders of the line above and the
//! capitals of the line below stay out. Dots, accents, crossbars and punctuation then join the
//! line they belong to. Very wide horizontal gaps split one row into separate segments.

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
    fn width(&self) -> f64 {
        self.max_x - self.min_x
    }
    fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
    fn center_x(&self) -> f64 {
        (self.min_x + self.max_x) / 2.0
    }
    fn center_y(&self) -> f64 {
        (self.min_y + self.max_y) / 2.0
    }
}

#[derive(Debug, Clone)]
struct Track {
    items: Vec<Item>,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    /// Centre line `y = slope * x + intercept`.
    slope: f64,
    intercept: f64,
    body: f64,
}

impl Track {
    fn new(item: Item) -> Self {
        let mut track = Self {
            items: vec![item],
            min_x: item.min_x,
            min_y: item.min_y,
            max_x: item.max_x,
            max_y: item.max_y,
            slope: 0.0,
            intercept: item.center_y(),
            body: item.height(),
        };
        track.refit();
        track
    }

    fn push(&mut self, item: Item) {
        self.items.push(item);
        self.min_x = self.min_x.min(item.min_x);
        self.min_y = self.min_y.min(item.min_y);
        self.max_x = self.max_x.max(item.max_x);
        self.max_y = self.max_y.max(item.max_y);
        self.refit();
    }

    fn refit(&mut self) {
        let mut heights: Vec<f64> = self.items.iter().map(Item::height).collect();
        heights.sort_by(f64::total_cmp);
        self.body = heights[heights.len() / 2].max(1.0);
        let weights: Vec<f64> = self
            .items
            .iter()
            .map(|item| item.width().max(1.0))
            .collect();
        let total: f64 = weights.iter().sum();
        let mean_x = self
            .items
            .iter()
            .zip(&weights)
            .map(|(item, w)| item.center_x() * w)
            .sum::<f64>()
            / total;
        let mean_y = self
            .items
            .iter()
            .zip(&weights)
            .map(|(item, w)| item.center_y() * w)
            .sum::<f64>()
            / total;
        let mut sxx = 0.0;
        let mut sxy = 0.0;
        for (item, w) in self.items.iter().zip(&weights) {
            let dx = item.center_x() - mean_x;
            sxx += w * dx * dx;
            sxy += w * dx * (item.center_y() - mean_y);
        }
        let span = self.max_x - self.min_x;
        // A slope needs several words of evidence; a short track stays level.
        self.slope = if self.items.len() >= 3 && span > 4.0 * self.body && sxx > 0.0 {
            (sxy / sxx).clamp(-0.25, 0.25)
        } else {
            0.0
        };
        self.intercept = mean_y - self.slope * mean_x;
    }

    fn center_at(&self, x: f64) -> f64 {
        let clamped = x.clamp(self.min_x, self.max_x);
        self.slope * clamped + self.intercept + self.slope * (x - clamped)
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
    /// Median body height of this line's large strokes.
    pub body_height: f64,
}

/// `strokes` are page-space polylines in writing order. Returns lines top to bottom, segments of
/// one row left to right.
pub fn group_ink_lines(strokes: &[Vec<(f64, f64)>]) -> Vec<InkLine> {
    let items: Vec<Item> = strokes
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
    let mut sizes: Vec<f64> = items
        .iter()
        .map(|item| item.height().max(item.width() * 0.5))
        .collect();
    sizes.sort_by(f64::total_cmp);
    let typical = sizes[(sizes.len() * 3) / 4].max(2.0);
    let (mut major, minor): (Vec<Item>, Vec<Item>) = items
        .iter()
        .copied()
        .partition(|item| item.height() >= typical * 0.42 || item.width() >= typical * 1.1);
    major.sort_by(|a, b| {
        b.width()
            .max(b.height())
            .total_cmp(&a.width().max(a.height()))
    });

    let mut tracks: Vec<Track> = Vec::new();
    for item in major {
        let best = tracks
            .iter()
            .enumerate()
            .filter_map(|(index, track)| {
                let predicted = track.center_at(item.center_x());
                let half = track.body.max(item.height()) * 0.5;
                let distance = (item.center_y() - predicted).abs();
                let overlap = item.max_y.min(predicted + half) - item.min_y.max(predicted - half);
                let fits = distance <= track.body.min(item.height()).max(track.body * 0.45) * 0.62
                    && overlap >= item.height().min(track.body) * 0.35;
                fits.then_some((index, distance / track.body))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1));
        match best {
            Some((index, _)) => tracks[index].push(item),
            None => tracks.push(Track::new(item)),
        }
    }
    merge_tracks(&mut tracks);

    for item in minor {
        let best = tracks
            .iter()
            .enumerate()
            .filter_map(|(index, track)| {
                let body = track.body;
                let center = track.center_at(item.center_x());
                let top = center - body * 0.5;
                let bottom = center + body * 0.5;
                let horizontal = (track.min_x - item.max_x)
                    .max(item.min_x - track.max_x)
                    .max(0.0);
                if horizontal > body * 1.6 {
                    return None;
                }
                let y = item.center_y();
                // Dots and accents usually sit above the body they belong to; commas and periods
                // sit on its baseline. The asymmetric distance favours the line below a dot.
                let vertical = if y < top {
                    (top - y) * 0.8
                } else if y > bottom {
                    (y - bottom) * 1.35
                } else {
                    0.0
                };
                if vertical > body * 1.25 {
                    return None;
                }
                Some((index, vertical + horizontal * 0.35))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1));
        match best {
            Some((index, _)) => tracks[index].items.push(item),
            None => tracks.push(Track::new(item)),
        }
    }

    let mut lines: Vec<InkLine> = tracks.into_iter().flat_map(split_track).collect();
    lines.sort_by(|a, b| {
        let a_center = (a.min_y + a.max_y) / 2.0;
        let b_center = (b.min_y + b.max_y) / 2.0;
        let same_row = (a_center - b_center).abs() < a.body_height.min(b.body_height) * 0.5;
        if same_row {
            a.min_x.total_cmp(&b.min_x)
        } else {
            a_center.total_cmp(&b_center)
        }
    });
    lines
}

fn merge_tracks(tracks: &mut Vec<Track>) {
    loop {
        let mut merged = false;
        'outer: for first in 0..tracks.len() {
            for second in first + 1..tracks.len() {
                let (a, b) = (&tracks[first], &tracks[second]);
                let x = (a.min_x.max(b.min_x) + a.max_x.min(b.max_x)) / 2.0;
                let distance = (a.center_at(x) - b.center_at(x)).abs();
                let body = a.body.max(b.body);
                let horizontal_gap = (a.min_x - b.max_x).max(b.min_x - a.max_x);
                if distance <= body * 0.42 && horizontal_gap < body * 8.0 {
                    let items = std::mem::take(&mut tracks[second].items);
                    for item in items {
                        tracks[first].push(item);
                    }
                    tracks.remove(second);
                    merged = true;
                    break 'outer;
                }
            }
        }
        if !merged {
            return;
        }
    }
}

fn split_track(track: Track) -> Vec<InkLine> {
    let mut items = track.items.clone();
    items.sort_by(|a, b| a.min_x.total_cmp(&b.min_x));
    let mut groups: Vec<Vec<Item>> = Vec::new();
    let mut right = f64::NEG_INFINITY;
    for item in items {
        if groups.is_empty() || item.min_x - right > track.body * 4.5 {
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
                body_height: track.body,
            }
        })
        .collect()
}
