//! Headless paper session. The window in `main.rs` feeds it pointer samples.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fanotes_ink::{InkDocument, InkError, PointerKind, StrokeId, StrokePoint};
use fanotes_paper::{
    grow_page_from_mark, keep_mark_on_page, Mark, PageExtent, Painted, PAGE_START_HEIGHT,
    PAGE_START_WIDTH,
};

const MIN_ZOOM: f64 = 0.25;
const MAX_ZOOM: f64 = 5.0;

pub struct Session {
    doc: InkDocument,
    zoom: f64,
    scroll_x: f64,
    scroll_y: f64,
    drawing: bool,
    path: Option<PathBuf>,
}

impl Session {
    pub fn new() -> Self {
        Self {
            doc: InkDocument::new(PAGE_START_WIDTH, PAGE_START_HEIGHT),
            zoom: 1.0,
            scroll_x: 0.0,
            scroll_y: 0.0,
            drawing: false,
            path: None,
        }
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, InkError> {
        let path = path.as_ref();
        let text = fs::read_to_string(path)?;
        Ok(Self {
            doc: InkDocument::from_json(&text)?,
            zoom: 1.0,
            scroll_x: 0.0,
            scroll_y: 0.0,
            drawing: false,
            path: Some(path.to_path_buf()),
        })
    }

    pub fn set_path(&mut self, path: PathBuf) {
        self.path = Some(path);
    }

    pub fn zoom(&self) -> f64 {
        self.zoom
    }

    pub fn page_height(&self) -> f64 {
        self.doc.page_height()
    }

    pub fn live_ids(&self) -> &[StrokeId] {
        self.doc.live_ids()
    }

    pub fn stroke_points(&self, id: StrokeId) -> Option<&[StrokePoint]> {
        self.doc.stroke_points(id)
    }

    pub fn stroke_color(&self, id: StrokeId) -> Option<&str> {
        self.doc.stroke_color(id)
    }

    pub fn active_points(&self) -> Option<&[StrokePoint]> {
        self.doc.active_points()
    }

    pub fn screen_to_page(&self, screen_x: f64, screen_y: f64) -> (f64, f64) {
        let page_x = screen_x / self.zoom + self.scroll_x;
        let page_y = screen_y / self.zoom + self.scroll_y;
        (
            page_x / self.doc.page_width(),
            page_y / self.doc.page_height(),
        )
    }

    pub fn page_to_screen(&self, x: f64, y: f64) -> (f64, f64) {
        let page_x = x * self.doc.page_width();
        let page_y = y * self.doc.page_height();
        (
            (page_x - self.scroll_x) * self.zoom,
            (page_y - self.scroll_y) * self.zoom,
        )
    }

    /// Zoom around a screen pixel. The page point under that pixel stays put.
    pub fn zoom_at(&mut self, screen_x: f64, screen_y: f64, factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let page_x = screen_x / self.zoom + self.scroll_x;
        let page_y = screen_y / self.zoom + self.scroll_y;
        self.zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        self.scroll_x = page_x - screen_x / self.zoom;
        self.scroll_y = page_y - screen_y / self.zoom;
    }

    pub fn pan_screen(&mut self, dx: f64, dy: f64) {
        self.scroll_x -= dx / self.zoom;
        self.scroll_y -= dy / self.zoom;
    }

    pub fn pen_down_page(&mut self, x: f64, y: f64) {
        self.doc.cancel_active();
        self.doc.begin_stroke(2.5, true, "#1a1a1a");
        self.drawing = true;
        self.ingest(x, y);
    }

    pub fn pen_move_page(&mut self, x: f64, y: f64) {
        if self.drawing {
            self.ingest(x, y);
        }
    }

    pub fn pen_up(&mut self) -> Option<StrokeId> {
        if !self.drawing {
            return None;
        }
        self.drawing = false;
        self.doc.end_stroke()
    }

    pub fn erase_last(&mut self) -> bool {
        self.doc.cancel_active();
        self.drawing = false;
        self.doc.erase_last()
    }

    pub fn undo(&mut self) -> bool {
        self.drawing = false;
        self.doc.undo()
    }

    pub fn redo(&mut self) -> bool {
        self.drawing = false;
        self.doc.redo()
    }

    pub fn save(&mut self) -> Result<(), InkError> {
        let path = self
            .path
            .clone()
            .unwrap_or_else(|| PathBuf::from("paper-proto.json"));
        self.save_as(path)
    }

    pub fn save_as(&mut self, path: impl AsRef<Path>) -> Result<(), InkError> {
        self.doc.touch_updated_at(&iso_now());
        let text = self.doc.to_json_pretty()?;
        fs::write(path.as_ref(), text)?;
        self.path = Some(path.as_ref().to_path_buf());
        Ok(())
    }

    /// Map a page-normalized sample, grow the sheet when the pen is in the margin, then append.
    fn ingest(&mut self, x_norm: f64, y_norm: f64) {
        let prev_w = self.doc.page_width();
        let prev_h = self.doc.page_height();
        let grown = grow_page_from_mark(
            PageExtent {
                width: prev_w,
                height: prev_h,
                origin_x: self.doc.origin_x(),
                origin_y: self.doc.origin_y(),
            },
            Mark {
                x: Some(x_norm),
                y: Some(y_norm),
            },
            Painted {
                width: Some(prev_w),
                height: Some(prev_h),
            },
        );
        let grew =
            grown.width > prev_w || grown.height > prev_h || grown.pad_x > 0.0 || grown.pad_y > 0.0;
        let (x, y) = if grew {
            self.doc.remap_after_grow(
                prev_w,
                prev_h,
                grown.width,
                grown.height,
                grown.pad_x,
                grown.pad_y,
            );
            self.scroll_x += grown.pad_x;
            self.scroll_y += grown.pad_y;
            (
                keep_mark_on_page(x_norm, prev_w, grown.width, grown.pad_x),
                keep_mark_on_page(y_norm, prev_h, grown.height, grown.pad_y),
            )
        } else {
            (x_norm, y_norm)
        };
        self.doc.push_point(StrokePoint {
            x,
            y,
            t: 0.0,
            pressure: 0.5,
            tilt_x: 0.0,
            tilt_y: 0.0,
            pointer: PointerKind::Mouse,
        });
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format_unix(secs)
}

fn format_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

/// Howard Hinnant's `civil_from_days`, days since Unix epoch.
fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fanotes_ink::PointerKind;

    #[test]
    fn zoom_keeps_the_page_point_under_the_cursor() {
        let mut session = Session::new();
        let before = session.screen_to_page(180.0, 90.0);
        session.zoom_at(180.0, 90.0, 2.0);
        let after = session.screen_to_page(180.0, 90.0);
        assert!((before.0 - after.0).abs() < 1e-9);
        assert!((before.1 - after.1).abs() < 1e-9);
        assert!((session.zoom() - 2.0).abs() < 1e-9);
    }

    #[test]
    fn undo_through_a_grow_restores_the_erased_stroke_on_its_paper_pixel() {
        let mut session = Session::new();
        session.doc = InkDocument::new(900.0, 432.0);
        let y = 262.0 / 432.0;
        session.pen_down_page(0.2, y);
        session.pen_up();
        let stroke_a = session.live_ids()[0];
        assert!(session.erase_last());
        session.pen_down_page(0.5, 0.95);
        session.pen_up();
        assert!((session.page_height() - 576.0).abs() < 1e-6);
        let kept = session.stroke_points(stroke_a).unwrap()[0].clone();
        let screen_before = session.page_to_screen(kept.x, kept.y);
        assert!(session.undo());
        assert!(session.undo());
        assert_eq!(session.live_ids(), &[stroke_a]);
        let restored_point = session.stroke_points(stroke_a).unwrap()[0].clone();
        let restored = restored_point.y * session.page_height();
        assert!((restored - 262.0).abs() < 1e-6);
        let screen_after = session.page_to_screen(restored_point.x, restored_point.y);
        assert!((screen_before.0 - screen_after.0).abs() < 1e-6);
        assert!((screen_before.1 - screen_after.1).abs() < 1e-6);
        assert_eq!(restored_point.pointer, PointerKind::Mouse);
    }

    #[test]
    fn save_and_load_drawing_document_json() {
        let mut session = Session::new();
        session.pen_down_page(0.4, 0.4);
        session.pen_move_page(0.45, 0.5);
        session.pen_up();
        let path =
            std::env::temp_dir().join(format!("fanotes-paper-proto-{}.json", std::process::id()));
        session.save_as(&path).unwrap();
        let loaded = Session::open(&path).unwrap();
        assert_eq!(loaded.live_ids().len(), 1);
        assert_eq!(loaded.stroke_points(loaded.live_ids()[0]).unwrap().len(), 2);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"schemaVersion\": 1"));
        assert!(text.contains("\"title\": \"Untitled\""));
        assert!(text.contains("\"strokes\""));
        let _ = std::fs::remove_file(path);
    }
}
