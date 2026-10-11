//! Stay-put reducer, page grow, and the write-page camera.
//!
//! Ported from `fanotes/src/lib/noteCanvas.ts`. Field names match that file.

use crate::num::{finite_origin_px, finite_positive, js_max, js_min, js_not_gt, js_round};
use crate::{
    GROW_STEP_X, GROW_STEP_Y, PAGE_START_WIDTH, PAPER_TEXT_COLUMN_WIDTH, PAPER_TEXT_PAD_X,
    SCROLL_ROOM, STAY_PUT_PAD_EPSILON, WRITE_CAP_HEIGHT, WRITE_CAP_WIDTH, WRITE_MARGIN_X,
    WRITE_MARGIN_Y,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasViewport {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageExtent {
    pub width: f64,
    pub height: f64,
    pub origin_x: f64,
    pub origin_y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mark {
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Painted {
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrownPage {
    pub width: f64,
    pub height: f64,
    pub pad_x: f64,
    pub pad_y: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SheetShift {
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StayPutState {
    pub paper_x: f64,
    pub paper_y: f64,
    pub cam_x: f64,
    pub cam_y: f64,
    pub width: f64,
    pub height: f64,
    pub origin_x: f64,
    pub origin_y: f64,
    pub editor_x: f64,
    pub editor_y: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StayPutOp {
    pub cam_x: Option<f64>,
    pub cam_y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub pad_x: Option<f64>,
    pub pad_y: Option<f64>,
    pub editor_x: Option<f64>,
    pub editor_y: Option<f64>,
    pub sheet_shift: Option<SheetShift>,
    pub painted_width: Option<f64>,
    pub painted_height: Option<f64>,
    pub lock_editor: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveWriteStayPutGrow {
    pub width: f64,
    pub height: f64,
    pub pad_x: f64,
    pub pad_y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveWrite {
    pub grown: LiveWriteStayPutGrow,
    pub painted_width: Option<f64>,
    pub painted_height: Option<f64>,
    pub sheet_shift: Option<SheetShift>,
    pub cam_x: Option<f64>,
    pub cam_y: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StayPutReduction {
    pub start: StayPutState,
    pub frames: Vec<StayPutState>,
    pub end: StayPutState,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextOriginCss {
    pub x: String,
    pub y: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MinEdgeStay {
    pub ink_x: f64,
    pub ink_y: f64,
    pub text_x: f64,
    pub text_y: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub visual_ink_x: f64,
    pub visual_ink_y: f64,
    pub visual_text_x: f64,
    pub visual_text_y: f64,
    pub prev_ink_x: f64,
    pub prev_ink_y: f64,
    pub prev_text_x: f64,
    pub prev_text_y: f64,
    pub origin_x_px: f64,
    pub origin_y_px: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MinEdgeStayPut {
    pub origin: TextOriginCss,
    pub stay: MinEdgeStay,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrowSequenceStep {
    pub pad_x: f64,
    pub pad_y: f64,
    pub origin_x: f64,
    pub origin_y: f64,
    pub width: f64,
    pub height: f64,
    pub paint_w: f64,
    pub paint_h: f64,
    pub paper_text_x: f64,
    pub paper_text_y: f64,
    pub paper_ink_x: f64,
    pub paper_ink_y: f64,
    pub visual_ink_x: f64,
    pub visual_ink_y: f64,
    pub visual_text_x: f64,
    pub visual_text_y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GrowSequence {
    pub origin_ink_x: f64,
    pub origin_ink_y: f64,
    pub origin_text_x: f64,
    pub origin_text_y: f64,
    pub camera_x: f64,
    pub camera_y: f64,
    pub origin_x: f64,
    pub origin_y: f64,
    pub steps: Vec<GrowSequenceStep>,
}

/// One step of [`markdown_glyph_after_camera_and_grow`].
///
/// `width` / `height` on the returned frame are these step fields, matching
/// the TypeScript helper. The reducer itself may refuse a scroll-room painted
/// box; that clamped size lives on [`StayPutState`], not on this frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphStep {
    pub cam_x: f64,
    pub cam_y: f64,
    pub width: f64,
    pub height: f64,
    pub pad_x: f64,
    pub pad_y: f64,
    pub editor_x: f64,
    pub editor_y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphFrame {
    pub paper_x: f64,
    pub paper_y: f64,
    pub visual_x: f64,
    pub visual_y: f64,
    pub cam_x: f64,
    pub cam_y: f64,
    pub editor_x: f64,
    pub editor_y: f64,
    pub width: f64,
    pub height: f64,
    pub pad_x: f64,
    pub pad_y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GlyphTrack {
    pub origin_paper_x: f64,
    pub origin_paper_y: f64,
    pub frames: Vec<GlyphFrame>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColumnLayout {
    pub column_width: f64,
    pub pad_x: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageCanvasLayout {
    pub pad: f64,
    pub page_x: f64,
    pub page_y: f64,
    pub page_width: f64,
    pub page_height: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub scroll_width: f64,
    pub scroll_height: f64,
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

fn option_finite(value: Option<f64>) -> Option<f64> {
    value.filter(|item| item.is_finite())
}

/// Painted paper box is the 0–1 space. Ignore a 0×0 first layout.
pub fn painted_stay_extent(source: f64, painted: f64) -> f64 {
    let live = if painted.is_finite() && painted > 1.0 {
        painted
    } else {
        0.0
    };
    let base = if source.is_finite() && source > 0.0 {
        source
    } else {
        0.0
    };
    js_max(base, live)
}

/// Page size a document is saved with. Strokes stay in the painted sheet's space.
pub fn saved_ink_page(source: CanvasSize, painted_w: f64, painted_h: f64) -> CanvasSize {
    CanvasSize {
        width: js_round(painted_stay_extent(source.width, painted_w)),
        height: js_round(painted_stay_extent(source.height, painted_h)),
    }
}

/// A painted box that is exactly the page plus `2 * SCROLL_ROOM` is pan paper.
pub fn is_painted_scroll_room_jump(source: f64, painted: f64) -> bool {
    let src = finite_positive(source);
    let paint = if painted.is_finite() && painted > 1.0 {
        painted
    } else {
        0.0
    };
    if js_not_gt(src, 1.0) || js_not_gt(paint, src + 1.0) {
        return false;
    }
    (paint - src - 2.0 * SCROLL_ROOM).abs() <= 1.0
}

/// 0–1 write-page extent. Camera-room overlays do not enlarge the page.
pub fn write_page_stay_extent(source: f64, painted: f64) -> f64 {
    if is_painted_scroll_room_jump(source, painted) {
        finite_positive(source)
    } else {
        painted_stay_extent(source, painted)
    }
}

/// Lift a 0–1 sample from a page+2·SCROLL_ROOM overlay onto the write page.
pub fn overlay_sample_onto_write_page(
    sample: CanvasPoint,
    page: CanvasSize,
    painted: Painted,
) -> CanvasPoint {
    let page_w = finite_positive(page.width);
    let page_h = finite_positive(page.height);
    let paint_w = painted
        .width
        .filter(|value| value.is_finite() && *value > 1.0)
        .unwrap_or(0.0);
    let paint_h = painted
        .height
        .filter(|value| value.is_finite() && *value > 1.0)
        .unwrap_or(0.0);
    let lift_x = is_painted_scroll_room_jump(page_w, paint_w) && page_w > 0.0;
    let lift_y = is_painted_scroll_room_jump(page_h, paint_h) && page_h > 0.0;
    if !lift_x && !lift_y {
        return sample;
    }
    CanvasPoint {
        x: if lift_x {
            sample.x * paint_w / page_w
        } else {
            sample.x
        },
        y: if lift_y {
            sample.y * paint_h / page_h
        } else {
            sample.y
        },
    }
}

/// Grow the max edge so a 0–1 mark plus write margin still fits.
pub fn grow_write_extent(normalized: Option<f64>, current: f64, margin: f64, step: f64) -> f64 {
    let Some(normalized) = normalized.filter(|value| value.is_finite()) else {
        return current;
    };
    if !current.is_finite() || current < 1.0 {
        return current;
    }
    if !margin.is_finite() || !step.is_finite() || step < 1.0 {
        return current;
    }
    let needed = normalized * current + margin;
    if js_not_gt(needed, current) {
        return current;
    }
    js_max(current, (needed / step).ceil() * step)
}

/// Extra origin pad when writing near or past the min edge.
pub fn grow_write_origin(normalized: Option<f64>, current: f64, margin: f64, step: f64) -> f64 {
    let Some(normalized) = normalized.filter(|value| value.is_finite()) else {
        return 0.0;
    };
    if !current.is_finite() || current < 1.0 {
        return 0.0;
    }
    if !margin.is_finite() || !step.is_finite() || step < 1.0 {
        return 0.0;
    }
    let pixel = normalized * current;
    if pixel >= margin {
        return 0.0;
    }
    ((margin - pixel) / step).ceil() * step
}

pub fn paper_min_edge_grows(normalized: Option<f64>, current: f64, margin: f64, step: f64) -> bool {
    grow_write_origin(normalized, current, margin, step) > 0.0
}

/// Grow the write page around a mark. `origin_x` / `origin_y` are pads already applied.
pub fn grow_page_from_mark(extent: PageExtent, mark: Mark, painted: Painted) -> GrownPage {
    let have_x = js_max(
        0.0,
        if extent.origin_x.is_finite() {
            extent.origin_x
        } else {
            0.0
        },
    );
    let have_y = js_max(
        0.0,
        if extent.origin_y.is_finite() {
            extent.origin_y
        } else {
            0.0
        },
    );
    let live_w = write_page_stay_extent(extent.width, painted.width.unwrap_or(0.0));
    let live_h = write_page_stay_extent(extent.height, painted.height.unwrap_or(0.0));
    let want_x = grow_write_origin(mark.x, live_w, WRITE_MARGIN_X, GROW_STEP_X);
    let want_y = grow_write_origin(mark.y, live_h, WRITE_MARGIN_Y, GROW_STEP_Y);
    let pad_x = js_max(0.0, want_x - have_x);
    let pad_y = js_max(0.0, want_y - have_y);
    let width = js_max(
        grow_write_extent(mark.x, live_w, WRITE_MARGIN_X, GROW_STEP_X),
        js_max(live_w + pad_x, extent.width + pad_x),
    );
    let height = js_max(
        grow_write_extent(mark.y, live_h, WRITE_MARGIN_Y, GROW_STEP_Y),
        js_max(live_h + pad_y, extent.height + pad_y),
    );
    GrownPage {
        width: js_min(WRITE_CAP_WIDTH, js_max(extent.width, width)),
        height: js_min(WRITE_CAP_HEIGHT, js_max(extent.height, height)),
        pad_x,
        pad_y,
    }
}

fn at_least_one(value: f64) -> f64 {
    // `finitePositive(value) || 1`, then `Math.max(1, …)`.
    let positive = finite_positive(value);
    js_max(1.0, if positive > 0.0 { positive } else { 1.0 })
}

pub fn write_page_layout_size(source: CanvasSize, viewport: CanvasSize) -> CanvasSize {
    CanvasSize {
        width: js_max(at_least_one(viewport.width), at_least_one(source.width)),
        height: js_max(at_least_one(viewport.height), at_least_one(source.height)),
    }
}

/// Keep a 0–1 mark at the same page-pixel position after the page grows.
pub fn keep_mark_on_page(value: f64, prev_extent: f64, next_extent: f64, min_pad: f64) -> f64 {
    if !value.is_finite() || js_not_gt(prev_extent, 0.0) || js_not_gt(next_extent, 0.0) {
        return value;
    }
    let pad = js_max(0.0, if min_pad.is_finite() { min_pad } else { 0.0 });
    if (next_extent - prev_extent).abs() < STAY_PUT_PAD_EPSILON && pad == 0.0 {
        return value;
    }
    (value * prev_extent + pad) / next_extent
}

/// New min-edge pad this step. A bug-report `padX` is the cumulative origin.
pub fn origin_pad_delta(have: f64, next: f64) -> f64 {
    js_max(0.0, finite_origin_px(next) - finite_origin_px(have))
}

/// Markdown column offset after a min-edge grow. Values are CSS `px` strings.
pub fn text_origin_css_px(origin_x: f64, origin_y: f64) -> TextOriginCss {
    TextOriginCss {
        x: format!("{}px", js_round(finite_origin_px(origin_x)) as i64),
        y: format!("{}px", js_round(finite_origin_px(origin_y)) as i64),
    }
}

/// Camera delta that keeps pre-grow paper pixels in view after a min-edge pad.
pub fn paper_origin_scroll_delta(pad: f64) -> f64 {
    finite_origin_px(pad)
}

/// Visual scroll after a min-edge pad. `pad` is unzoomed CSS px. DOM scroll adds `pad * zoom`.
pub fn scroll_for_zoomed_origin_pad(
    scroll_x: f64,
    scroll_y: f64,
    pad_x: f64,
    pad_y: f64,
    shift: SheetShift,
    zoom: f64,
) -> (f64, f64) {
    let used = if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    };
    let shift_x = shift.x.filter(|value| value.is_finite()).unwrap_or(0.0);
    let shift_y = shift.y.filter(|value| value.is_finite()).unwrap_or(0.0);
    let scroll_x = if scroll_x.is_finite() { scroll_x } else { 0.0 };
    let scroll_y = if scroll_y.is_finite() { scroll_y } else { 0.0 };
    (
        scroll_x + shift_x + finite_origin_px(pad_x) * used,
        scroll_y + shift_y + finite_origin_px(pad_y) * used,
    )
}

pub fn paper_sheet_layout_shift(
    before_x: f64,
    before_y: f64,
    after_x: f64,
    after_y: f64,
) -> (f64, f64) {
    (
        finite_or(after_x, 0.0) - finite_or(before_x, 0.0),
        finite_or(after_y, 0.0) - finite_or(before_y, 0.0),
    )
}

/// Camera after a write-page extent change. Max-edge grow with no new pad does not pan.
pub fn paper_camera_after_max_edge_grow(
    cam_x: f64,
    cam_y: f64,
    pad_x: f64,
    pad_y: f64,
    sheet_shift: SheetShift,
) -> (f64, f64) {
    let shift_x = sheet_shift
        .x
        .filter(|value| value.is_finite())
        .unwrap_or(0.0);
    let shift_y = sheet_shift
        .y
        .filter(|value| value.is_finite())
        .unwrap_or(0.0);
    (
        finite_or(cam_x, 0.0) + paper_origin_scroll_delta(pad_x) + shift_x,
        finite_or(cam_y, 0.0) + paper_origin_scroll_delta(pad_y) + shift_y,
    )
}

/// Paper coords after one write op. The only legal change is a new origin pad.
pub fn stay_put_paper_after_op(
    paper_x: f64,
    paper_y: f64,
    have_pad_x: f64,
    have_pad_y: f64,
    next_pad_x: f64,
    next_pad_y: f64,
) -> (f64, f64) {
    (
        paper_x + origin_pad_delta(have_pad_x, next_pad_x),
        paper_y + origin_pad_delta(have_pad_y, next_pad_y),
    )
}

pub fn stay_put_after_extent_grow(
    cam_x: f64,
    cam_y: f64,
    pad_x: f64,
    pad_y: f64,
    sheet_shift: SheetShift,
) -> (f64, f64) {
    paper_camera_after_max_edge_grow(cam_x, cam_y, pad_x, pad_y, sheet_shift)
}

/// True only when paper X/Y changed by the new origin pad and nothing else.
pub fn stay_put_paper_moved_by_pad_only(previous: StayPutState, next: StayPutState) -> bool {
    let add_x = origin_pad_delta(previous.origin_x, next.origin_x);
    let add_y = origin_pad_delta(previous.origin_y, next.origin_y);
    (next.paper_x - previous.paper_x - add_x).abs() < STAY_PUT_PAD_EPSILON
        && (next.paper_y - previous.paper_y - add_y).abs() < STAY_PUT_PAD_EPSILON
}

/// Nested CodeMirror scroll is not a paper-coordinate channel. Any assigned offset maps to 0.
pub fn nested_editor_offset_on_write_page(_scroll_left: f64, _scroll_top: f64) -> (f64, f64) {
    (0.0, 0.0)
}

/// One closed write/scroll/grow step.
///
/// A user camera is taken as-is when provided. Live grow without a new camera
/// holds the current camera and adds only the new pad plus a sheet shift.
/// Overlay painted boxes do not become write-page extent. Nested editor X/Y
/// is always 0. `lock_editor` is accepted and cannot leave a non-zero offset.
pub fn apply_stay_put_op(state: StayPutState, op: StayPutOp) -> StayPutState {
    let next_pad_x = js_max(0.0, op.pad_x.unwrap_or(state.origin_x));
    let next_pad_y = js_max(0.0, op.pad_y.unwrap_or(state.origin_y));
    let add_x = origin_pad_delta(state.origin_x, next_pad_x);
    let add_y = origin_pad_delta(state.origin_y, next_pad_y);
    let (paper_x, paper_y) = stay_put_paper_after_op(
        state.paper_x,
        state.paper_y,
        state.origin_x,
        state.origin_y,
        next_pad_x,
        next_pad_y,
    );
    let width = write_page_stay_extent(
        write_page_stay_extent(state.width, op.width.unwrap_or(state.width)),
        op.painted_width.unwrap_or(0.0),
    );
    let height = write_page_stay_extent(
        write_page_stay_extent(state.height, op.height.unwrap_or(state.height)),
        op.painted_height.unwrap_or(0.0),
    );
    let has_user_camera = option_finite(op.cam_x).is_some() || option_finite(op.cam_y).is_some();
    let from_x = option_finite(op.cam_x).unwrap_or(state.cam_x);
    let from_y = option_finite(op.cam_y).unwrap_or(state.cam_y);
    let (cam_x, cam_y) = stay_put_after_extent_grow(
        from_x,
        from_y,
        if has_user_camera { 0.0 } else { add_x },
        if has_user_camera { 0.0 } else { add_y },
        op.sheet_shift.unwrap_or_default(),
    );
    let (editor_x, editor_y) =
        nested_editor_offset_on_write_page(op.editor_x.unwrap_or(0.0), op.editor_y.unwrap_or(0.0));
    StayPutState {
        paper_x,
        paper_y,
        cam_x,
        cam_y,
        width,
        height,
        origin_x: next_pad_x,
        origin_y: next_pad_y,
        editor_x,
        editor_y,
    }
}

/// Live write/grow path. `grown.pad_x` / `pad_y` are the new pads this step.
pub fn live_write_stay_put(state: StayPutState, live: LiveWrite) -> StayPutState {
    apply_stay_put_op(
        state,
        StayPutOp {
            width: Some(live.grown.width),
            height: Some(live.grown.height),
            pad_x: Some(state.origin_x + js_max(0.0, live.grown.pad_x)),
            pad_y: Some(state.origin_y + js_max(0.0, live.grown.pad_y)),
            painted_width: live.painted_width,
            painted_height: live.painted_height,
            sheet_shift: live.sheet_shift,
            cam_x: live.cam_x,
            cam_y: live.cam_y,
            lock_editor: true,
            ..StayPutOp::default()
        },
    )
}

pub fn paper_text_column_width(_pane_width: f64) -> f64 {
    PAPER_TEXT_COLUMN_WIDTH
}

pub fn paper_text_pad_x(_pane_width: f64) -> f64 {
    PAPER_TEXT_PAD_X
}

pub fn paper_layout_after_column_resize(column_width: f64) -> ColumnLayout {
    ColumnLayout {
        column_width: paper_text_column_width(column_width),
        pad_x: paper_text_pad_x(column_width),
    }
}

/// Column or window resize. The write page does not shrink with the pane.
pub fn stay_put_after_column_resize(state: StayPutState, next_column_width: f64) -> StayPutState {
    let _layout = paper_layout_after_column_resize(next_column_width);
    apply_stay_put_op(
        state,
        StayPutOp {
            cam_x: Some(state.cam_x),
            cam_y: Some(state.cam_y),
            width: Some(state.width),
            height: Some(state.height),
            pad_x: Some(state.origin_x),
            pad_y: Some(state.origin_y),
            painted_width: Some(0.0),
            painted_height: Some(0.0),
            lock_editor: true,
            ..StayPutOp::default()
        },
    )
}

pub fn reduce_stay_put_ops(start: StayPutState, ops: &[StayPutOp]) -> StayPutReduction {
    let mut frames = Vec::with_capacity(ops.len());
    let mut state = start;
    for op in ops {
        state = apply_stay_put_op(state, *op);
        frames.push(state);
    }
    StayPutReduction {
        start,
        end: state,
        frames,
    }
}

pub fn markdown_and_ink_after_min_edge_grow(
    mark: CanvasPoint,
    text: CanvasPoint,
    prev: CanvasSize,
    next: GrownPage,
    layout: CanvasSize,
    prev_layout: CanvasSize,
) -> MinEdgeStayPut {
    let pad_x = finite_origin_px(next.pad_x);
    let pad_y = finite_origin_px(next.pad_y);
    let prev_w = write_page_stay_extent(prev.width, prev_layout.width);
    let prev_h = write_page_stay_extent(prev.height, prev_layout.height);
    let next_w = write_page_stay_extent(prev_w, painted_stay_extent(next.width, layout.width));
    let next_h = write_page_stay_extent(prev_h, painted_stay_extent(next.height, layout.height));
    let ink_x = keep_mark_on_page(mark.x, prev_w, next_w, pad_x) * next_w;
    let ink_y = keep_mark_on_page(mark.y, prev_h, next_h, pad_y) * next_h;
    let text_x = text.x + pad_x;
    let text_y = text.y + pad_y;
    let scroll_x = paper_origin_scroll_delta(pad_x);
    let scroll_y = paper_origin_scroll_delta(pad_y);
    MinEdgeStayPut {
        origin: text_origin_css_px(pad_x, pad_y),
        stay: MinEdgeStay {
            ink_x,
            ink_y,
            text_x,
            text_y,
            scroll_x,
            scroll_y,
            visual_ink_x: ink_x - scroll_x,
            visual_ink_y: ink_y - scroll_y,
            visual_text_x: text_x - scroll_x,
            visual_text_y: text_y - scroll_y,
            prev_ink_x: mark.x * prev.width,
            prev_ink_y: mark.y * prev.height,
            prev_text_x: text.x,
            prev_text_y: text.y,
            origin_x_px: pad_x,
            origin_y_px: pad_y,
        },
    }
}

pub fn markdown_and_ink_after_grow_sequence(
    mark: CanvasPoint,
    text: CanvasPoint,
    start: CanvasSize,
    samples: &[CanvasPoint],
    painted: CanvasSize,
) -> GrowSequence {
    let mut page = PageExtent {
        width: start.width,
        height: start.height,
        origin_x: 0.0,
        origin_y: 0.0,
    };
    let mut paint_w = write_page_stay_extent(start.width, painted.width);
    let mut paint_h = write_page_stay_extent(start.height, painted.height);
    let mut ink = mark;
    let mut glyph = text;
    let mut camera_x = 0.0;
    let mut camera_y = 0.0;
    let steps = samples
        .iter()
        .map(|sample| {
            let prev_paint = CanvasSize {
                width: paint_w,
                height: paint_h,
            };
            let grown = grow_page_from_mark(
                page,
                Mark {
                    x: Some(sample.x),
                    y: Some(sample.y),
                },
                Painted {
                    width: Some(prev_paint.width),
                    height: Some(prev_paint.height),
                },
            );
            let next_paint = CanvasSize {
                width: write_page_stay_extent(paint_w, grown.width),
                height: write_page_stay_extent(paint_h, grown.height),
            };
            let stay = markdown_and_ink_after_min_edge_grow(
                ink,
                glyph,
                prev_paint,
                GrownPage {
                    width: next_paint.width,
                    height: next_paint.height,
                    pad_x: grown.pad_x,
                    pad_y: grown.pad_y,
                },
                next_paint,
                prev_paint,
            );
            camera_x += stay.stay.scroll_x;
            camera_y += stay.stay.scroll_y;
            ink = CanvasPoint {
                x: if next_paint.width > 0.0 {
                    stay.stay.ink_x / next_paint.width
                } else {
                    ink.x
                },
                y: if next_paint.height > 0.0 {
                    stay.stay.ink_y / next_paint.height
                } else {
                    ink.y
                },
            };
            glyph = CanvasPoint {
                x: stay.stay.text_x,
                y: stay.stay.text_y,
            };
            page = PageExtent {
                width: grown.width,
                height: grown.height,
                origin_x: page.origin_x + grown.pad_x,
                origin_y: page.origin_y + grown.pad_y,
            };
            paint_w = next_paint.width;
            paint_h = next_paint.height;
            GrowSequenceStep {
                pad_x: grown.pad_x,
                pad_y: grown.pad_y,
                origin_x: page.origin_x,
                origin_y: page.origin_y,
                width: grown.width,
                height: grown.height,
                paint_w,
                paint_h,
                paper_text_x: stay.stay.text_x,
                paper_text_y: stay.stay.text_y,
                paper_ink_x: stay.stay.ink_x,
                paper_ink_y: stay.stay.ink_y,
                visual_ink_x: stay.stay.ink_x - camera_x,
                visual_ink_y: stay.stay.ink_y - camera_y,
                visual_text_x: stay.stay.text_x - camera_x,
                visual_text_y: stay.stay.text_y - camera_y,
            }
        })
        .collect();
    GrowSequence {
        origin_ink_x: mark.x * write_page_stay_extent(start.width, painted.width),
        origin_ink_y: mark.y * write_page_stay_extent(start.height, painted.height),
        origin_text_x: text.x,
        origin_text_y: text.y,
        camera_x,
        camera_y,
        origin_x: page.origin_x,
        origin_y: page.origin_y,
        steps,
    }
}

pub fn markdown_glyph_after_camera_and_grow(
    glyph: CanvasPoint,
    start: CanvasSize,
    steps: &[GlyphStep],
) -> GlyphTrack {
    let mut state = StayPutState {
        paper_x: glyph.x,
        paper_y: glyph.y,
        cam_x: steps.first().map(|step| step.cam_x).unwrap_or(0.0),
        cam_y: steps.first().map(|step| step.cam_y).unwrap_or(0.0),
        width: start.width,
        height: start.height,
        origin_x: 0.0,
        origin_y: 0.0,
        editor_x: 0.0,
        editor_y: 0.0,
    };
    let frames = steps
        .iter()
        .map(|step| {
            state = apply_stay_put_op(
                state,
                StayPutOp {
                    cam_x: Some(step.cam_x),
                    cam_y: Some(step.cam_y),
                    width: Some(step.width),
                    height: Some(step.height),
                    pad_x: Some(step.pad_x),
                    pad_y: Some(step.pad_y),
                    editor_x: Some(step.editor_x),
                    editor_y: Some(step.editor_y),
                    ..StayPutOp::default()
                },
            );
            GlyphFrame {
                paper_x: state.paper_x,
                paper_y: state.paper_y,
                visual_x: state.paper_x - state.cam_x - state.editor_x,
                visual_y: state.paper_y - state.cam_y - state.editor_y,
                cam_x: state.cam_x,
                cam_y: state.cam_y,
                editor_x: state.editor_x,
                editor_y: state.editor_y,
                width: step.width,
                height: step.height,
                pad_x: state.origin_x,
                pad_y: state.origin_y,
            }
        })
        .collect();
    GlyphTrack {
        origin_paper_x: glyph.x,
        origin_paper_y: glyph.y,
        frames,
    }
}

pub fn mark_page_position(normalized: f64, extent: f64) -> f64 {
    if normalized.is_finite() && extent.is_finite() {
        normalized * extent
    } else {
        0.0
    }
}

pub fn canvas_scroll_bounds(content: CanvasBox, room: f64) -> CanvasBox {
    let extra = js_max(0.0, if room.is_finite() { room } else { 0.0 });
    CanvasBox {
        min_x: finite_or(content.min_x, 0.0) - extra,
        min_y: finite_or(content.min_y, 0.0) - extra,
        max_x: finite_or(content.max_x, 0.0) + extra,
        max_y: finite_or(content.max_y, 0.0) + extra,
    }
}

pub fn paper_scroll_pad(bounds: CanvasBox) -> (f64, f64) {
    (
        js_max(0.0, -finite_or(bounds.min_x, 0.0)),
        js_max(0.0, -finite_or(bounds.min_y, 0.0)),
    )
}

pub fn clamp_canvas_scroll(
    offset_x: f64,
    offset_y: f64,
    bounds: CanvasBox,
    viewport: CanvasViewport,
) -> (f64, f64) {
    let view_w = js_max(0.0, viewport.width);
    let view_h = js_max(0.0, viewport.height);
    let max_scroll_x = js_max(0.0, bounds.max_x - view_w);
    let max_scroll_y = js_max(0.0, bounds.max_y - view_h);
    let x = if offset_x.is_finite() { offset_x } else { 0.0 };
    let y = if offset_y.is_finite() { offset_y } else { 0.0 };
    (
        js_min(max_scroll_x, js_max(0.0, x)),
        js_min(max_scroll_y, js_max(0.0, y)),
    )
}

pub fn write_extent_from_content(content: CanvasBox) -> CanvasSize {
    let max_x = js_max(0.0, finite_or(content.max_x, 0.0)) + WRITE_MARGIN_X;
    let max_y = js_max(0.0, finite_or(content.max_y, 0.0)) + WRITE_MARGIN_Y;
    CanvasSize {
        width: js_min(WRITE_CAP_WIDTH, js_max(PAGE_START_WIDTH, max_x)),
        height: js_min(WRITE_CAP_HEIGHT, js_max(WRITE_MARGIN_Y, max_y)),
    }
}

pub fn page_canvas_layout(page: CanvasSize, room: f64) -> PageCanvasLayout {
    let pad = js_max(0.0, if room.is_finite() { room } else { 0.0 });
    let width = js_max(
        1.0,
        if finite_positive(page.width) > 0.0 {
            finite_positive(page.width)
        } else {
            1.0
        },
    );
    let height = js_max(
        1.0,
        if finite_positive(page.height) > 0.0 {
            finite_positive(page.height)
        } else {
            1.0
        },
    );
    PageCanvasLayout {
        pad,
        page_x: 0.0,
        page_y: 0.0,
        page_width: width,
        page_height: height,
        scroll_x: -pad,
        scroll_y: -pad,
        scroll_width: width + pad * 2.0,
        scroll_height: height + pad * 2.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisualRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollerOrigin {
    pub left: f64,
    pub top: f64,
    pub scroll_left: f64,
    pub scroll_top: f64,
}

pub fn paper_scroll_bounds_from_visual_rect(
    paper: VisualRect,
    scroller: ScrollerOrigin,
) -> CanvasBox {
    let min_x = paper.left - scroller.left + scroller.scroll_left;
    let min_y = paper.top - scroller.top + scroller.scroll_top;
    let max_x = paper.right - scroller.left + scroller.scroll_left;
    let max_y = paper.bottom - scroller.top + scroller.scroll_top;
    CanvasBox {
        min_x: if min_x.is_finite() { min_x } else { 0.0 },
        min_y: if min_y.is_finite() { min_y } else { 0.0 },
        max_x: if max_x.is_finite() { max_x } else { 0.0 },
        max_y: if max_y.is_finite() { max_y } else { 0.0 },
    }
}

/// `neededWriteExtent` alias.
pub fn needed_write_extent(normalized: Option<f64>, current: f64, margin: f64, step: f64) -> f64 {
    grow_write_extent(normalized, current, margin, step)
}

/// `neededWriteMinPad` alias.
pub fn needed_write_min_pad(normalized: Option<f64>, current: f64, margin: f64, step: f64) -> f64 {
    grow_write_origin(normalized, current, margin, step)
}

/// `remapNormalizedAfterExtent` alias.
pub fn remap_normalized_after_extent(
    value: f64,
    prev_extent: f64,
    next_extent: f64,
    min_pad: f64,
) -> f64 {
    keep_mark_on_page(value, prev_extent, next_extent, min_pad)
}
