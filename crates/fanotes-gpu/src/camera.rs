//! One camera per frame.
//!
//! The camera is the only thing that maps paper to screen. Ink, ruling, PDF
//! pages, the live stroke and the tile grid all read the same value, so they
//! cannot drift apart the way two CSS-zoomed canvases did.
//!
//! Units follow `fanotes-paper` / `noteCanvas.ts`:
//! - page px: unzoomed paper CSS px. Ink points are `normalized * page size`.
//! - scroll: the zoomed (visual) CSS px offset of the sheet, like DOM `scrollLeft`.
//!   `scroll_for_zoomed_origin_pad` adds `pad * zoom` to it.
//! - device px: visual px times the device pixel ratio.

use fanotes_paper::{scroll_for_zoomed_origin_pad, SheetShift, StayPutState};
use kurbo::{Affine, Point, Rect};

pub const MIN_ZOOM: f64 = 0.1;
pub const MAX_ZOOM: f64 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    /// Paper zoom (CSS `zoom` of the sheet plane in the web app).
    pub zoom: f64,
    /// Visual scroll offset in zoomed CSS px.
    pub scroll_x: f64,
    pub scroll_y: f64,
    /// Origin pad in page px: where the text column and the ruling start.
    pub origin_x: f64,
    pub origin_y: f64,
    /// Device pixels per CSS px.
    pub dpr: f64,
    /// Viewport in device px.
    pub width: u32,
    pub height: u32,
}

impl Camera {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            zoom: 1.0,
            scroll_x: 0.0,
            scroll_y: 0.0,
            origin_x: 0.0,
            origin_y: 0.0,
            dpr: 1.0,
            width,
            height,
        }
    }

    /// Camera of a stay-put state: `cam_*` is the visual scroll, `origin_*` the pad.
    pub fn from_stay_put(
        state: &StayPutState,
        zoom: f64,
        dpr: f64,
        width: u32,
        height: u32,
    ) -> Self {
        Self {
            zoom: sane(zoom, 1.0),
            scroll_x: state.cam_x,
            scroll_y: state.cam_y,
            origin_x: state.origin_x,
            origin_y: state.origin_y,
            dpr: sane(dpr, 1.0),
            width,
            height,
        }
    }

    /// Device px per page px.
    pub fn device_scale(&self) -> f64 {
        sane(self.zoom, 1.0) * sane(self.dpr, 1.0)
    }

    /// Page px → device px.
    pub fn page_to_device(&self) -> Affine {
        let s = self.device_scale();
        let dpr = sane(self.dpr, 1.0);
        Affine::new([s, 0.0, 0.0, s, -self.scroll_x * dpr, -self.scroll_y * dpr])
    }

    pub fn device_to_page(&self, x: f64, y: f64) -> Point {
        self.page_to_device().inverse() * Point::new(x, y)
    }

    pub fn page_to_device_point(&self, x: f64, y: f64) -> Point {
        self.page_to_device() * Point::new(x, y)
    }

    /// Page rect the viewport shows.
    pub fn visible_page_rect(&self) -> Rect {
        let inverse = self.page_to_device().inverse();
        inverse.transform_rect_bbox(Rect::new(0.0, 0.0, self.width as f64, self.height as f64))
    }

    /// Zoom around a device pixel; the page point under it stays put.
    pub fn zoom_at(&mut self, device_x: f64, device_y: f64, factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let anchor = self.device_to_page(device_x, device_y);
        self.zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        let dpr = sane(self.dpr, 1.0);
        self.scroll_x = anchor.x * self.zoom - device_x / dpr;
        self.scroll_y = anchor.y * self.zoom - device_y / dpr;
    }

    /// Pan by device px (positive moves the paper right/down).
    pub fn pan_device(&mut self, dx: f64, dy: f64) {
        let dpr = sane(self.dpr, 1.0);
        self.scroll_x -= dx / dpr;
        self.scroll_y -= dy / dpr;
    }

    /// A new min-edge origin pad: paper grew left/up by `pad` page px. The scroll
    /// follows by `pad * zoom` (plus any sheet layout shift) so nothing on screen moves.
    pub fn apply_origin_pad(&mut self, pad_x: f64, pad_y: f64, shift: SheetShift) {
        let (x, y) = scroll_for_zoomed_origin_pad(
            self.scroll_x,
            self.scroll_y,
            pad_x,
            pad_y,
            shift,
            self.zoom,
        );
        self.scroll_x = x;
        self.scroll_y = y;
        self.origin_x += pad_x.max(0.0);
        self.origin_y += pad_y.max(0.0);
    }

    /// Integral device translation and scale exactly `density`: tiles can be
    /// sampled with nearest filtering and stay pixel-identical.
    pub fn is_pixel_aligned(&self, density: f64) -> bool {
        let dpr = sane(self.dpr, 1.0);
        (self.device_scale() - density).abs() < 1e-9
            && (self.scroll_x * dpr).fract().abs() < 1e-9
            && (self.scroll_y * dpr).fract().abs() < 1e-9
    }
}

fn sane(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_keeps_the_page_point_under_the_cursor() {
        let mut camera = Camera::new(800, 600);
        camera.dpr = 2.0;
        camera.scroll_x = 30.0;
        let before = camera.device_to_page(300.0, 200.0);
        camera.zoom_at(300.0, 200.0, 2.5);
        let after = camera.device_to_page(300.0, 200.0);
        assert!((before.x - after.x).abs() < 1e-9 && (before.y - after.y).abs() < 1e-9);
        assert!((camera.zoom - 2.5).abs() < 1e-12);
    }

    #[test]
    fn an_origin_pad_keeps_old_paper_on_the_same_device_pixel() {
        let mut camera = Camera::new(800, 600);
        camera.zoom = 1.5;
        camera.scroll_x = 40.0;
        let ink = Point::new(100.0, 80.0);
        let before = camera.page_to_device() * ink;
        // The grow moves every paper point by the pad.
        camera.apply_origin_pad(108.0, 0.0, SheetShift::default());
        let after = camera.page_to_device() * Point::new(ink.x + 108.0, ink.y);
        assert!((before.x - after.x).abs() < 1e-9 && (before.y - after.y).abs() < 1e-9);
        assert_eq!(camera.origin_x, 108.0);
    }

    #[test]
    fn stay_put_state_drives_scroll_and_origin() {
        let state = StayPutState {
            paper_x: 0.0,
            paper_y: 0.0,
            cam_x: 12.0,
            cam_y: 340.0,
            width: 900.0,
            height: 1273.0,
            origin_x: 108.0,
            origin_y: 144.0,
            editor_x: 0.0,
            editor_y: 0.0,
        };
        let camera = Camera::from_stay_put(&state, 2.0, 1.0, 640, 480);
        let p = camera.page_to_device_point(108.0, 144.0);
        assert!((p.x - (108.0 * 2.0 - 12.0)).abs() < 1e-9);
        assert!((p.y - (144.0 * 2.0 - 340.0)).abs() < 1e-9);
        let visible = camera.visible_page_rect();
        assert!((visible.x0 - 6.0).abs() < 1e-9 && (visible.width() - 320.0).abs() < 1e-9);
    }
}
