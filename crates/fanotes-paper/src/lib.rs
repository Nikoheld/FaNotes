//! Paper camera and stay-put reducer.
//!
//! Line-for-line port of the pure functions in `fanotes/src/lib/noteCanvas.ts`.
//! A new origin pad is the only write that may move paper coordinates. Pan,
//! max-edge growth, the scroll-room overlay, and nested editor scroll must not.
//! The pad-only predicate uses the same `1e-6` tolerance as the TypeScript check.

mod num;
mod page;

pub use page::*;

/// Extra writable paper past the last mark.
pub const WRITE_MARGIN_X: f64 = 108.0;
/// Extra writable paper past the last mark.
pub const WRITE_MARGIN_Y: f64 = 144.0;

pub const PAGE_START_WIDTH: f64 = 900.0;
pub const PAGE_START_HEIGHT: f64 = 1273.0;

/// Grow in the same chunks as the write margin so the page follows the pen.
pub const GROW_STEP_X: f64 = WRITE_MARGIN_X;
pub const GROW_STEP_Y: f64 = WRITE_MARGIN_Y;

/// Finite extra pan room past the write page. Same paper, not a second surface.
pub const SCROLL_ROOM: f64 = 560.0;

pub const WRITE_CAP_WIDTH: f64 = PAGE_START_WIDTH * 20.0;
pub const WRITE_CAP_HEIGHT: f64 = PAGE_START_HEIGHT * 40.0;

pub const PAGE_BACKGROUND: &str = "#fff";

/// A4 text column in CSS px. A split or a window-width cut must not shrink it.
pub const PAPER_TEXT_COLUMN_WIDTH: f64 = 820.0;
/// Horizontal pad of typed text on the sheet. Paper px, never `vw`.
pub const PAPER_TEXT_PAD_X: f64 = 72.0;
pub const PAPER_TEXT_PAD_Y: f64 = 78.0;

pub const PAPER_SOURCE_WIDTH: f64 = PAGE_START_WIDTH;
pub const PAPER_SOURCE_HEIGHT: f64 = PAGE_START_HEIGHT;
pub const WRITE_SLACK_WIDTH: f64 = WRITE_MARGIN_X;
pub const WRITE_SLACK_HEIGHT: f64 = WRITE_MARGIN_Y;
pub const PAGE_GROW_STEP_WIDTH: f64 = GROW_STEP_X;
pub const PAGE_GROW_STEP_HEIGHT: f64 = GROW_STEP_Y;
pub const WRITE_MEMORY_CAP_WIDTH: f64 = WRITE_CAP_WIDTH;
pub const WRITE_MEMORY_CAP_HEIGHT: f64 = WRITE_CAP_HEIGHT;

/// Tolerance of [`stay_put_paper_moved_by_pad_only`].
pub const STAY_PUT_PAD_EPSILON: f64 = 1e-6;
