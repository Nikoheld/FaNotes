//! Numeric stay-put fixtures from `fanotes/scripts/check-stay-put.mjs`.
//!
//! DOM sealing (CodeMirror scroll locks, ghost-text observers) stays in the
//! TypeScript check. Everything here is the pure reducer those fixtures drive.

use fanotes_paper::{
    apply_stay_put_op, grow_page_from_mark, live_write_stay_put,
    markdown_and_ink_after_min_edge_grow, markdown_glyph_after_camera_and_grow, origin_pad_delta,
    overlay_sample_onto_write_page, paper_camera_after_max_edge_grow,
    paper_layout_after_column_resize, paper_origin_scroll_delta,
    paper_scroll_bounds_from_visual_rect, paper_sheet_layout_shift, paper_text_column_width,
    paper_text_pad_x, reduce_stay_put_ops, stay_put_after_column_resize,
    stay_put_after_extent_grow, stay_put_paper_after_op, stay_put_paper_moved_by_pad_only,
    text_origin_css_px, write_page_stay_extent, CanvasPoint, CanvasSize, GlyphStep, GrownPage,
    LiveWrite, LiveWriteStayPutGrow, Mark, PageExtent, Painted, ScrollerOrigin, SheetShift,
    StayPutOp, StayPutState, VisualRect, PAGE_START_HEIGHT, PAGE_START_WIDTH,
    PAPER_TEXT_COLUMN_WIDTH, PAPER_TEXT_PAD_X, PAPER_TEXT_PAD_Y, SCROLL_ROOM, WRITE_CAP_HEIGHT,
    WRITE_CAP_WIDTH, WRITE_MARGIN_X, WRITE_MARGIN_Y,
};

const GLYPH_X: f64 = 86.0;
const GLYPH_Y: f64 = 78.0;
const START_W: f64 = 2186.0;
const START_H: f64 = 1408.0;

fn near(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{what}: {actual} must stay {expected}"
    );
}

fn step(cam_x: f64, cam_y: f64, width: f64, height: f64, pad_x: f64, pad_y: f64) -> GlyphStep {
    GlyphStep {
        cam_x,
        cam_y,
        width,
        height,
        pad_x,
        pad_y,
        editor_x: 0.0,
        editor_y: 0.0,
    }
}

fn op_of(step: GlyphStep) -> StayPutOp {
    StayPutOp {
        cam_x: Some(step.cam_x),
        cam_y: Some(step.cam_y),
        width: Some(step.width),
        height: Some(step.height),
        pad_x: Some(step.pad_x),
        pad_y: Some(step.pad_y),
        ..StayPutOp::default()
    }
}

fn report_1788366080812() -> Vec<GlyphStep> {
    vec![
        step(560.0, 560.0, 2186.0, 1408.0, 0.0, 0.0),
        step(560.0, 829.0, 2186.0, 1408.0, 0.0, 0.0),
        step(560.0, 1368.0, 2186.0, 1408.0, 0.0, 0.0),
        step(560.0, 1368.0, 2186.0, 1440.0, 0.0, 0.0),
        step(560.0, 1368.0, 2186.0, 1584.0, 0.0, 0.0),
        step(560.0, 1368.0, 3306.0, 2704.0, 0.0, 0.0),
    ]
}

fn report_1788376550462() -> Vec<GlyphStep> {
    vec![
        step(560.0, 645.0, 2186.0, 1408.0, 0.0, 0.0),
        step(668.0, 645.0, 2294.0, 1408.0, 108.0, 0.0),
        step(668.0, 645.0, 3414.0, 2528.0, 108.0, 0.0),
    ]
}

fn report_1788416428895() -> Vec<GlyphStep> {
    vec![
        step(668.0, 640.0, 2294.0, 1552.0, 108.0, 144.0),
        step(632.0, 1978.0, 2294.0, 2016.0, 108.0, 144.0),
        step(632.0, 1978.0, 2294.0, 2160.0, 108.0, 144.0),
        step(632.0, 1978.0, 2294.0, 2304.0, 108.0, 144.0),
        step(632.0, 1978.0, 2294.0, 2448.0, 108.0, 144.0),
    ]
}

fn report_1788433450822() -> Vec<GlyphStep> {
    vec![
        step(560.0, 560.0, 2186.0, 1408.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1408.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1440.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1584.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1728.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1872.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 2016.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 2160.0, 0.0, 0.0),
        step(435.0, 2586.0, 2186.0, 2592.0, 0.0, 0.0),
        step(435.0, 2586.0, 2186.0, 2736.0, 0.0, 0.0),
        step(435.0, 2586.0, 2186.0, 2880.0, 0.0, 0.0),
    ]
}

fn report_1788435936618() -> Vec<GlyphStep> {
    vec![
        step(668.0, 382.0, 2294.0, 1408.0, 108.0, 0.0),
        step(668.0, 526.0, 2294.0, 1552.0, 108.0, 144.0),
        step(668.0, 526.0, 2294.0, 1552.0, 108.0, 144.0),
        step(668.0, 1978.0, 2294.0, 1872.0, 108.0, 144.0),
        step(668.0, 1978.0, 2294.0, 2016.0, 108.0, 144.0),
        step(668.0, 1978.0, 2294.0, 2160.0, 108.0, 144.0),
        step(668.0, 1978.0, 2294.0, 2304.0, 108.0, 144.0),
        step(665.0, 181.0, 2294.0, 2304.0, 108.0, 144.0),
    ]
}

fn pan_only() -> Vec<GlyphStep> {
    vec![
        step(560.0, 560.0, 2186.0, 1408.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1408.0, 0.0, 0.0),
        step(665.0, 181.0, 2186.0, 1408.0, 0.0, 0.0),
    ]
}

fn max_edge_down() -> Vec<GlyphStep> {
    vec![
        step(435.0, 1745.0, 2186.0, 1408.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1440.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1584.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1728.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 1872.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 2016.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 2160.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 2592.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 2736.0, 0.0, 0.0),
        step(435.0, 1745.0, 2186.0, 2880.0, 0.0, 0.0),
    ]
}

fn max_edge_width() -> Vec<GlyphStep> {
    vec![
        step(435.0, 1745.0, 2186.0, 1408.0, 0.0, 0.0),
        step(435.0, 1745.0, 2294.0, 1408.0, 0.0, 0.0),
        step(435.0, 1745.0, 2500.0, 1408.0, 0.0, 0.0),
    ]
}

fn min_edge_pad() -> Vec<GlyphStep> {
    vec![
        step(560.0, 560.0, 2186.0, 1408.0, 0.0, 0.0),
        step(668.0, 560.0, 2294.0, 1408.0, 108.0, 0.0),
        step(668.0, 704.0, 2294.0, 1552.0, 108.0, 144.0),
    ]
}

fn overlay_jump() -> Vec<StayPutOp> {
    vec![
        op_of(step(668.0, 645.0, 2294.0, 1408.0, 108.0, 0.0)),
        StayPutOp {
            cam_x: Some(668.0),
            cam_y: Some(645.0),
            width: Some(2294.0),
            height: Some(1408.0),
            pad_x: Some(108.0),
            pad_y: Some(0.0),
            painted_width: Some(2294.0 + 2.0 * 560.0),
            painted_height: Some(1408.0 + 2.0 * 560.0),
            ..StayPutOp::default()
        },
    ]
}

fn nested_lock() -> Vec<StayPutOp> {
    vec![StayPutOp {
        cam_x: Some(560.0),
        cam_y: Some(560.0),
        width: Some(2186.0),
        height: Some(1408.0),
        pad_x: Some(0.0),
        pad_y: Some(0.0),
        lock_editor: true,
        editor_x: Some(8.0),
        editor_y: Some(40.0),
        ..StayPutOp::default()
    }]
}

fn sheet_origin_shift() -> Vec<StayPutOp> {
    vec![StayPutOp {
        cam_x: Some(435.0),
        cam_y: Some(1745.0),
        width: Some(2186.0),
        height: Some(1584.0),
        pad_x: Some(0.0),
        pad_y: Some(0.0),
        sheet_shift: Some(SheetShift {
            x: Some(0.0),
            y: Some(40.0),
        }),
        ..StayPutOp::default()
    }]
}

fn ops_of(steps: &[GlyphStep]) -> Vec<StayPutOp> {
    steps.iter().copied().map(op_of).collect()
}

fn seed(ops: &[StayPutOp]) -> StayPutState {
    StayPutState {
        paper_x: GLYPH_X,
        paper_y: GLYPH_Y,
        cam_x: ops[0].cam_x.expect("fixture camera"),
        cam_y: ops[0].cam_y.expect("fixture camera"),
        width: START_W,
        height: START_H,
        origin_x: 0.0,
        origin_y: 0.0,
        editor_x: 0.0,
        editor_y: 0.0,
    }
}

fn assert_closed(
    name: &str,
    ops: &[StayPutOp],
    seed_state: StayPutState,
) -> fanotes_paper::StayPutReduction {
    let reduced = reduce_stay_put_ops(seed_state, ops);
    let mut previous = seed_state;
    for (index, frame) in reduced.frames.iter().enumerate() {
        assert!(
            stay_put_paper_moved_by_pad_only(previous, *frame),
            "{name} step {index} paper {},{} moved by more than the new origin pad",
            frame.paper_x,
            frame.paper_y
        );
        assert_eq!(
            frame.editor_x, 0.0,
            "{name} step {index} editor X must be 0"
        );
        assert_eq!(
            frame.editor_y, 0.0,
            "{name} step {index} editor Y must be 0"
        );
        previous = *frame;
    }
    reduced
}

#[test]
fn constants_match_the_typescript_camera() {
    assert_eq!(SCROLL_ROOM * 2.0, 1120.0);
    assert_eq!(WRITE_MARGIN_X, 108.0);
    assert_eq!(WRITE_MARGIN_Y, 144.0);
    assert_eq!(PAGE_START_WIDTH, 900.0);
    assert_eq!(PAGE_START_HEIGHT, 1273.0);
    assert_eq!(WRITE_CAP_WIDTH, 18_000.0);
    assert_eq!(WRITE_CAP_HEIGHT, 50_920.0);
    assert_eq!(PAPER_TEXT_COLUMN_WIDTH, 820.0);
    assert_eq!(PAPER_TEXT_PAD_X, 72.0);
    assert_eq!(PAPER_TEXT_PAD_Y, 78.0);
    assert_eq!(origin_pad_delta(0.0, 108.0), 108.0);
    assert_eq!(origin_pad_delta(108.0, 108.0), 0.0);
    assert_eq!(write_page_stay_extent(2294.0, 3414.0), 2294.0);
    assert_eq!(write_page_stay_extent(1408.0, 2528.0), 1408.0);
}

#[test]
fn report_scroll_holds_paper_pixels() {
    let report = report_1788366080812();
    let scrolled = markdown_glyph_after_camera_and_grow(
        CanvasPoint {
            x: GLYPH_X,
            y: GLYPH_Y,
        },
        CanvasSize {
            width: START_W,
            height: START_H,
        },
        &report,
    );
    assert_eq!(scrolled.origin_paper_x, 86.0);
    assert_eq!(scrolled.origin_paper_y, 78.0);
    assert_eq!(scrolled.frames.len(), report.len());
    for (index, frame) in scrolled.frames.iter().enumerate() {
        near(
            frame.paper_x,
            scrolled.origin_paper_x,
            &format!("scroll step {index} paper X"),
        );
        near(
            frame.paper_y,
            scrolled.origin_paper_y,
            &format!("scroll step {index} paper Y"),
        );
        assert_eq!(frame.editor_y, 0.0);
        assert_eq!(frame.cam_y, report[index].cam_y);
        assert_eq!(frame.width, report[index].width);
        assert_eq!(frame.height, report[index].height);
    }
}

#[test]
fn report_left_pad_then_scroll_room_does_not_reapply_the_pad() {
    let report = report_1788376550462();
    let sequence = markdown_glyph_after_camera_and_grow(
        CanvasPoint {
            x: GLYPH_X,
            y: GLYPH_Y,
        },
        CanvasSize {
            width: START_W,
            height: START_H,
        },
        &report,
    );
    let visual0_x = sequence.frames[0].paper_x - sequence.frames[0].cam_x;
    let visual0_y = sequence.frames[0].paper_y - sequence.frames[0].cam_y;
    for (index, frame) in sequence.frames.iter().enumerate() {
        near(
            frame.paper_x,
            GLYPH_X + report[index].pad_x,
            &format!("step {index} paper X"),
        );
        near(
            frame.paper_y,
            GLYPH_Y + report[index].pad_y,
            &format!("step {index} paper Y"),
        );
        near(
            frame.paper_x - frame.cam_x,
            visual0_x,
            &format!("step {index} visual X"),
        );
        near(
            frame.paper_y - frame.cam_y,
            visual0_y,
            &format!("step {index} visual Y"),
        );
        assert_eq!(frame.editor_y, 0.0);
        assert_eq!(frame.cam_x, report[index].cam_x);
        assert_eq!(frame.cam_y, report[index].cam_y);
    }
    assert_eq!(sequence.frames[1].paper_x, 194.0);
    assert_eq!(
        sequence.frames[2].paper_x, 194.0,
        "2×SCROLL_ROOM jump must not re-apply origin pad 108"
    );
    assert_eq!(sequence.frames[2].width, 3414.0);
    assert_eq!(sequence.frames[2].height, 2528.0);

    let mut pad_then_scroll = vec![
        report[0],
        report[1],
        step(668.0, 829.0, 2294.0, 1408.0, 108.0, 0.0),
    ];
    pad_then_scroll.push(step(668.0, 1368.0, 2294.0, 1408.0, 108.0, 0.0));
    pad_then_scroll.push(report[2]);
    let tracked = markdown_glyph_after_camera_and_grow(
        CanvasPoint {
            x: GLYPH_X,
            y: GLYPH_Y,
        },
        CanvasSize {
            width: START_W,
            height: START_H,
        },
        &pad_then_scroll,
    );
    assert_eq!(tracked.frames[1].paper_x, 194.0);
    assert_eq!(
        tracked.frames[3].paper_x, 194.0,
        "scrolling after a left-edge pad must not re-apply origin pad"
    );
    assert_eq!(tracked.frames[4].paper_x, 194.0);
    assert_eq!(tracked.frames[3].paper_y, 78.0);
    assert_eq!(tracked.frames[3].cam_y, 1368.0);
}

#[test]
fn report_already_padded_page_does_not_reapply_pads() {
    let report = report_1788416428895();
    let padded = markdown_glyph_after_camera_and_grow(
        CanvasPoint {
            x: GLYPH_X,
            y: GLYPH_Y,
        },
        CanvasSize {
            width: 2294.0,
            height: 1552.0,
        },
        &report,
    );
    let padded_paper_x = GLYPH_X + 108.0;
    let padded_paper_y = GLYPH_Y + 144.0;
    assert_eq!(origin_pad_delta(108.0, 108.0), 0.0);
    assert_eq!(origin_pad_delta(144.0, 144.0), 0.0);
    for (index, frame) in padded.frames.iter().enumerate() {
        near(
            frame.paper_x,
            padded_paper_x,
            &format!("padded-scroll step {index} paper X"),
        );
        near(
            frame.paper_y,
            padded_paper_y,
            &format!("padded-scroll step {index} paper Y"),
        );
        assert_eq!(frame.editor_y, 0.0);
        assert_eq!(frame.cam_x, report[index].cam_x);
        assert_eq!(frame.cam_y, report[index].cam_y);
        assert_eq!(frame.height, report[index].height);
        assert_eq!(frame.pad_x, 108.0);
        assert_eq!(frame.pad_y, 144.0);
    }
    assert_eq!(
        padded.frames[1].cam_x, 632.0,
        "camX 668→632 must not slide paper X"
    );
    assert_eq!(padded.frames.last().unwrap().height, 2448.0);
    assert_eq!(
        padded.frames.last().unwrap().paper_x,
        padded.frames[0].paper_x
    );
    assert_eq!(
        padded.frames.last().unwrap().paper_y,
        padded.frames[0].paper_y
    );
}

#[test]
fn report_max_edge_extend_holds_the_glyph() {
    let report = report_1788433450822();
    let extended = markdown_glyph_after_camera_and_grow(
        CanvasPoint {
            x: GLYPH_X,
            y: GLYPH_Y,
        },
        CanvasSize {
            width: START_W,
            height: START_H,
        },
        &report,
    );
    assert_eq!(
        paper_camera_after_max_edge_grow(435.0, 1745.0, 0.0, 0.0, SheetShift::default()).0,
        435.0
    );
    assert_eq!(
        paper_camera_after_max_edge_grow(435.0, 1745.0, 0.0, 0.0, SheetShift::default()).1,
        1745.0
    );
    assert_eq!(
        paper_camera_after_max_edge_grow(560.0, 560.0, 108.0, 0.0, SheetShift::default()).0,
        668.0
    );
    for (index, frame) in extended.frames.iter().enumerate() {
        near(
            frame.paper_x,
            GLYPH_X,
            &format!("extend step {index} paper X"),
        );
        near(
            frame.paper_y,
            GLYPH_Y,
            &format!("extend step {index} paper Y"),
        );
        assert_eq!(frame.editor_y, 0.0);
        assert_eq!(frame.cam_x, report[index].cam_x);
        assert_eq!(frame.cam_y, report[index].cam_y);
        assert_eq!(frame.height, report[index].height);
        assert_eq!(frame.pad_x, 0.0);
    }
    assert_eq!(
        extended.frames[1].cam_x, 435.0,
        "camX 560→435 must not slide paper X"
    );
    assert_eq!(extended.frames.last().unwrap().cam_y, 2586.0);
    assert_eq!(extended.frames.last().unwrap().height, 2880.0);
    assert_eq!(extended.frames.last().unwrap().paper_x, GLYPH_X);
    assert_eq!(extended.frames.last().unwrap().paper_y, GLYPH_Y);
}

#[test]
fn report_enlarge_with_sheet_shift_moves_only_the_camera() {
    let report = report_1788435936618();
    let enlarge = markdown_glyph_after_camera_and_grow(
        CanvasPoint {
            x: GLYPH_X,
            y: GLYPH_Y,
        },
        CanvasSize {
            width: START_W,
            height: START_H,
        },
        &report,
    );
    let enlarge_paper_x = GLYPH_X + 108.0;
    let enlarge_paper_y = GLYPH_Y + 144.0;
    assert_eq!(enlarge.frames[0].paper_x, enlarge_paper_x);
    assert_eq!(enlarge.frames[0].paper_y, GLYPH_Y);
    assert_eq!(enlarge.frames[1].paper_y, enlarge_paper_y);
    for (index, frame) in enlarge.frames.iter().enumerate() {
        near(
            frame.paper_x,
            enlarge_paper_x,
            &format!("enlarge step {index} paper X"),
        );
        if index >= 1 {
            near(
                frame.paper_y,
                enlarge_paper_y,
                &format!("enlarge step {index} paper Y"),
            );
        }
        assert_eq!(frame.editor_y, 0.0);
        assert_eq!(frame.cam_x, report[index].cam_x);
        assert_eq!(frame.cam_y, report[index].cam_y);
        assert_eq!(frame.height, report[index].height);
        assert_eq!(frame.pad_x, 108.0);
    }
    assert_eq!(enlarge.frames[1].pad_y, 144.0);
    assert_eq!(enlarge.frames[3].cam_y, 1978.0);
    assert_eq!(enlarge.frames[6].height, 2304.0);
    assert_eq!(enlarge.frames[6].paper_x, enlarge.frames[1].paper_x);
    assert_eq!(enlarge.frames[6].paper_y, enlarge.frames[1].paper_y);
    assert_eq!(
        enlarge.frames.last().unwrap().cam_x,
        665.0,
        "camX 668→665 must not slide paper X"
    );
    assert_eq!(enlarge.frames.last().unwrap().cam_y, 181.0);
    assert_eq!(paper_sheet_layout_shift(560.0, 560.0, 560.0, 600.0).1, 40.0);
    assert_eq!(
        paper_camera_after_max_edge_grow(668.0, 1978.0, 0.0, 0.0, SheetShift::default()).1,
        1978.0
    );
    assert_eq!(
        paper_camera_after_max_edge_grow(
            668.0,
            1978.0,
            0.0,
            0.0,
            SheetShift {
                x: None,
                y: Some(40.0)
            }
        )
        .1,
        2018.0
    );
    let scroller = ScrollerOrigin {
        left: 0.0,
        top: 0.0,
        scroll_left: 668.0,
        scroll_top: 1978.0,
    };
    let sheet_before = paper_scroll_bounds_from_visual_rect(
        VisualRect {
            left: 100.0,
            top: 80.0,
            right: 400.0,
            bottom: 500.0,
        },
        scroller,
    );
    let sheet_after = paper_scroll_bounds_from_visual_rect(
        VisualRect {
            left: 100.0,
            top: 120.0,
            right: 400.0,
            bottom: 640.0,
        },
        scroller,
    );
    let enlarge_shift = paper_sheet_layout_shift(
        sheet_before.min_x,
        sheet_before.min_y,
        sheet_after.min_x,
        sheet_after.min_y,
    );
    assert_eq!(enlarge_shift.1, 40.0);
    let pinned = paper_camera_after_max_edge_grow(
        668.0,
        1978.0,
        0.0,
        0.0,
        SheetShift {
            x: Some(enlarge_shift.0),
            y: Some(enlarge_shift.1),
        },
    );
    assert_eq!(pinned.1, 2018.0);
}

#[test]
fn closed_fixture_sets_move_paper_by_the_new_pad_only() {
    let glyph = CanvasPoint {
        x: GLYPH_X,
        y: GLYPH_Y,
    };
    let closed_latest = assert_closed(
        "latest-enlarge",
        &ops_of(&report_1788435936618()),
        seed(&ops_of(&report_1788435936618())),
    );
    assert_eq!(closed_latest.end.paper_x, glyph.x + 108.0);
    assert_eq!(closed_latest.end.paper_y, glyph.y + 144.0);
    assert_eq!(closed_latest.end.cam_y, 181.0);
    assert_eq!(closed_latest.end.height, 2304.0);

    let closed_pan = assert_closed("pan-only", &ops_of(&pan_only()), seed(&ops_of(&pan_only())));
    assert_eq!(closed_pan.end.paper_x, glyph.x);
    assert_eq!(closed_pan.end.paper_y, glyph.y);
    assert_eq!(closed_pan.end.cam_x, 665.0);
    assert_eq!(closed_pan.end.cam_y, 181.0);

    let closed_down = assert_closed(
        "max-edge-down",
        &ops_of(&max_edge_down()),
        seed(&ops_of(&max_edge_down())),
    );
    assert_eq!(closed_down.end.paper_y, glyph.y);
    assert_eq!(closed_down.end.height, 2880.0);
    assert_eq!(closed_down.end.cam_y, 1745.0);

    let closed_width = assert_closed(
        "max-edge-width",
        &ops_of(&max_edge_width()),
        seed(&ops_of(&max_edge_width())),
    );
    assert_eq!(closed_width.end.paper_x, glyph.x);
    assert_eq!(closed_width.end.width, 2500.0);

    let pad_ops = ops_of(&min_edge_pad());
    let closed_pad = assert_closed("min-edge-pad", &pad_ops, seed(&pad_ops));
    assert_eq!(closed_pad.frames[1].paper_x, glyph.x + 108.0);
    assert_eq!(closed_pad.frames[2].paper_y, glyph.y + 144.0);
    assert_eq!(
        closed_pad.frames[1].paper_x - closed_pad.frames[1].cam_x,
        glyph.x - 560.0
    );
    assert_eq!(
        closed_pad.frames[2].paper_y - closed_pad.frames[2].cam_y,
        glyph.y - 560.0
    );

    let live_pad = apply_stay_put_op(
        seed(&pad_ops),
        StayPutOp {
            pad_x: Some(108.0),
            width: Some(2294.0),
            height: Some(1408.0),
            ..StayPutOp::default()
        },
    );
    assert_eq!(live_pad.paper_x, glyph.x + 108.0);
    assert_eq!(
        live_pad.cam_x,
        stay_put_after_extent_grow(560.0, 560.0, 108.0, 0.0, SheetShift::default()).0
    );
    assert_eq!(live_pad.paper_x - live_pad.cam_x, glyph.x - 560.0);
    assert_eq!(
        stay_put_paper_after_op(glyph.x, glyph.y, 0.0, 0.0, 108.0, 0.0).0,
        glyph.x + 108.0
    );

    let closed_overlay = assert_closed("overlay-jump", &overlay_jump(), seed(&overlay_jump()));
    assert_eq!(closed_overlay.end.width, 2294.0);
    assert_eq!(closed_overlay.end.height, 1408.0);
    assert_eq!(closed_overlay.end.paper_x, glyph.x + 108.0);

    let shifted = apply_stay_put_op(
        seed(&ops_of(&max_edge_down())),
        StayPutOp {
            cam_x: Some(435.0),
            cam_y: Some(1745.0),
            width: Some(2186.0),
            height: Some(1584.0),
            pad_x: Some(0.0),
            pad_y: Some(0.0),
            sheet_shift: Some(SheetShift {
                x: Some(0.0),
                y: Some(40.0),
            }),
            ..StayPutOp::default()
        },
    );
    assert_eq!(shifted.paper_x, glyph.x);
    assert_eq!(shifted.paper_y, glyph.y);
    assert_eq!(
        shifted.cam_y,
        stay_put_after_extent_grow(
            435.0,
            1745.0,
            0.0,
            0.0,
            SheetShift {
                x: None,
                y: Some(40.0)
            }
        )
        .1
    );

    let mut nested_seed = seed(&ops_of(&pan_only()));
    nested_seed.editor_x = 8.0;
    nested_seed.editor_y = 40.0;
    let nested = apply_stay_put_op(nested_seed, nested_lock()[0]);
    assert_eq!(nested.editor_x, 0.0);
    assert_eq!(nested.editor_y, 0.0);
    assert_eq!(nested.paper_x, glyph.x);
    assert_eq!(nested.cam_y, 560.0);

    assert_closed(
        "report-1788366080812",
        &ops_of(&report_1788366080812()),
        seed(&ops_of(&report_1788366080812())),
    );
    assert_closed(
        "report-1788376550462",
        &ops_of(&report_1788376550462()),
        seed(&ops_of(&report_1788376550462())),
    );
    assert_closed(
        "report-1788416428895",
        &ops_of(&report_1788416428895()),
        seed(&ops_of(&report_1788416428895())),
    );
    assert_closed(
        "report-1788433450822",
        &ops_of(&report_1788433450822()),
        seed(&ops_of(&report_1788433450822())),
    );
    assert_closed(
        "report-1788435936618",
        &ops_of(&report_1788435936618()),
        seed(&ops_of(&report_1788435936618())),
    );

    let mut nested_start = seed(&nested_lock());
    nested_start.editor_x = 8.0;
    nested_start.editor_y = 40.0;
    let closed_nested = assert_closed("nested-lock-editor", &nested_lock(), nested_start);
    assert_eq!(closed_nested.end.editor_x, 0.0);
    assert_eq!(closed_nested.end.editor_y, 0.0);
    assert_eq!(closed_nested.end.paper_x, glyph.x);

    let closed_shift = assert_closed(
        "sheet-origin-shift",
        &sheet_origin_shift(),
        seed(&ops_of(&max_edge_down())),
    );
    assert_eq!(closed_shift.end.paper_x, glyph.x);
    assert_eq!(closed_shift.end.paper_y, glyph.y);
    assert_eq!(
        closed_shift.end.cam_y,
        stay_put_after_extent_grow(
            435.0,
            1745.0,
            0.0,
            0.0,
            SheetShift {
                x: None,
                y: Some(40.0)
            }
        )
        .1
    );

    let kept_nested = apply_stay_put_op(
        seed(&ops_of(&pan_only())),
        StayPutOp {
            cam_x: Some(560.0),
            cam_y: Some(560.0),
            width: Some(2186.0),
            height: Some(1408.0),
            editor_x: Some(8.0),
            editor_y: Some(40.0),
            ..StayPutOp::default()
        },
    );
    assert_eq!(kept_nested.editor_x, 0.0);
    assert_eq!(kept_nested.editor_y, 0.0);
    assert_eq!(kept_nested.paper_x, glyph.x);
    assert_eq!(kept_nested.paper_y, glyph.y);
}

#[test]
fn live_write_matches_apply_for_min_edge_and_max_edge_samples() {
    let page = PageExtent {
        width: START_W,
        height: START_H,
        origin_x: 0.0,
        origin_y: 0.0,
    };
    let painted = Painted {
        width: Some(START_W),
        height: Some(START_H),
    };
    let grown_min = grow_page_from_mark(
        page,
        Mark {
            x: Some(0.0489),
            y: Some(0.22),
        },
        painted,
    );
    assert_eq!(grown_min.pad_x, 108.0);
    assert_eq!(grown_min.width, 2294.0);
    let pad_ops = ops_of(&min_edge_pad());
    let reduced_min = apply_stay_put_op(
        seed(&pad_ops),
        StayPutOp {
            width: Some(grown_min.width),
            height: Some(grown_min.height),
            pad_x: Some(grown_min.pad_x),
            pad_y: Some(grown_min.pad_y),
            ..StayPutOp::default()
        },
    );
    let via_live = live_write_stay_put(
        seed(&pad_ops),
        LiveWrite {
            grown: LiveWriteStayPutGrow {
                width: grown_min.width,
                height: grown_min.height,
                pad_x: grown_min.pad_x,
                pad_y: grown_min.pad_y,
            },
            painted_width: Some(START_W),
            painted_height: Some(START_H),
            sheet_shift: None,
            cam_x: None,
            cam_y: None,
        },
    );
    assert_eq!(reduced_min.paper_x, via_live.paper_x);
    assert_eq!(reduced_min.paper_y, via_live.paper_y);
    assert_eq!(reduced_min.cam_x, via_live.cam_x);
    assert!(stay_put_paper_moved_by_pad_only(seed(&pad_ops), via_live));
    assert_eq!(via_live.editor_x, 0.0);
    assert_eq!(via_live.editor_y, 0.0);

    let grown_max = grow_page_from_mark(
        page,
        Mark {
            x: Some(0.5),
            y: Some(0.99),
        },
        painted,
    );
    let down = ops_of(&max_edge_down());
    let down_seed = seed(&down);
    let reduced_max = apply_stay_put_op(
        down_seed,
        StayPutOp {
            width: Some(grown_max.width),
            height: Some(grown_max.height),
            pad_x: Some(down_seed.origin_x + grown_max.pad_x),
            pad_y: Some(down_seed.origin_y + grown_max.pad_y),
            ..StayPutOp::default()
        },
    );
    let via_max = live_write_stay_put(
        down_seed,
        LiveWrite {
            grown: LiveWriteStayPutGrow {
                width: grown_max.width,
                height: grown_max.height,
                pad_x: grown_max.pad_x,
                pad_y: grown_max.pad_y,
            },
            painted_width: Some(START_W),
            painted_height: Some(START_H),
            sheet_shift: None,
            cam_x: None,
            cam_y: None,
        },
    );
    assert_eq!(reduced_max.paper_x, via_max.paper_x);
    assert_eq!(reduced_max.paper_y, via_max.paper_y);
    assert!(stay_put_paper_moved_by_pad_only(down_seed, via_max));
    assert_eq!(via_max.editor_y, 0.0);
}

#[test]
fn min_edge_pad_then_overlay_jump_keeps_ink_and_text_pixels() {
    let ink = CanvasPoint { x: 0.22, y: 0.31 };
    let glyph = CanvasPoint {
        x: GLYPH_X,
        y: GLYPH_Y,
    };
    let start = CanvasSize {
        width: START_W,
        height: START_H,
    };
    let after_pad = markdown_and_ink_after_min_edge_grow(
        ink,
        glyph,
        start,
        GrownPage {
            width: 2294.0,
            height: 1408.0,
            pad_x: 108.0,
            pad_y: 0.0,
        },
        CanvasSize {
            width: 2294.0,
            height: 1408.0,
        },
        start,
    );
    assert_eq!(after_pad.origin.x, text_origin_css_px(108.0, 0.0).x);
    assert_eq!(after_pad.stay.scroll_x, paper_origin_scroll_delta(108.0));
    near(after_pad.stay.visual_text_x, glyph.x, "visual text X");
    near(after_pad.stay.visual_text_y, glyph.y, "visual text Y");
    near(after_pad.stay.visual_ink_x, ink.x * 2186.0, "visual ink X");

    let ink_after_pad = CanvasPoint {
        x: after_pad.stay.ink_x / 2294.0,
        y: after_pad.stay.ink_y / 1408.0,
    };
    let glyph_after_pad = CanvasPoint {
        x: after_pad.stay.text_x,
        y: after_pad.stay.text_y,
    };
    let prev = CanvasSize {
        width: 2294.0,
        height: 1408.0,
    };
    let after_jump = markdown_and_ink_after_min_edge_grow(
        ink_after_pad,
        glyph_after_pad,
        prev,
        GrownPage {
            width: 3414.0,
            height: 2528.0,
            pad_x: origin_pad_delta(108.0, 108.0),
            pad_y: 0.0,
        },
        CanvasSize {
            width: 3414.0,
            height: 2528.0,
        },
        prev,
    );
    assert_eq!(after_jump.stay.scroll_x, 0.0);
    assert_eq!(after_jump.stay.text_x, glyph_after_pad.x);
    assert_eq!(after_jump.stay.text_y, glyph_after_pad.y);
    near(
        after_jump.stay.ink_x,
        after_pad.stay.ink_x,
        "ink X across overlay",
    );
    near(
        after_jump.stay.ink_y,
        after_pad.stay.ink_y,
        "ink Y across overlay",
    );
}

#[test]
fn camera_room_overlay_does_not_become_write_page_extent() {
    let page = PageExtent {
        width: 2294.0,
        height: 1408.0,
        origin_x: 108.0,
        origin_y: 0.0,
    };
    let overlay = Painted {
        width: Some(3414.0),
        height: Some(2528.0),
    };
    let jump = CanvasPoint {
        x: 0.0618,
        y: 0.1299,
    };
    let lifted = overlay_sample_onto_write_page(
        jump,
        CanvasSize {
            width: page.width,
            height: page.height,
        },
        overlay,
    );
    assert_ne!(lifted.x, jump.x);
    let grown = grow_page_from_mark(
        page,
        Mark {
            x: Some(jump.x),
            y: Some(jump.y),
        },
        overlay,
    );
    assert_eq!(grown.width, 2294.0);
    assert_eq!(grown.height, 1408.0);
    assert_eq!(grown.pad_x, 0.0);
    assert_eq!(
        write_page_stay_extent(page.width, overlay.width.unwrap()),
        2294.0
    );
}

#[test]
fn column_resize_does_not_move_paper_or_shrink_the_text_column() {
    let single = 1400.0;
    let split = 640.0;
    assert_eq!(paper_text_column_width(single), PAPER_TEXT_COLUMN_WIDTH);
    assert_eq!(
        paper_text_column_width(split),
        paper_text_column_width(single)
    );
    assert_eq!(paper_text_pad_x(single), PAPER_TEXT_PAD_X);
    assert_eq!(paper_text_pad_x(split), paper_text_pad_x(single));
    let single_layout = paper_layout_after_column_resize(single);
    let split_layout = paper_layout_after_column_resize(split);
    assert_eq!(single_layout.column_width, split_layout.column_width);
    assert_eq!(single_layout.pad_x, split_layout.pad_x);
    let split_start = seed(&ops_of(&pan_only()));
    let after_split = stay_put_after_column_resize(split_start, split);
    assert!(stay_put_paper_moved_by_pad_only(split_start, after_split));
    assert_eq!(after_split.paper_x, split_start.paper_x);
    assert_eq!(after_split.paper_y, split_start.paper_y);
    assert_eq!(after_split.cam_x, split_start.cam_x);
    assert_eq!(after_split.cam_y, split_start.cam_y);
    assert_eq!(after_split.editor_x, 0.0);
    assert_eq!(after_split.editor_y, 0.0);
}

#[test]
fn fixture_shapes_match_the_check_script() {
    assert_eq!(report_1788366080812()[2].cam_y, 1368.0);
    assert_eq!(report_1788376550462()[0].cam_y, 645.0);
    assert_eq!(report_1788376550462()[2].width, 2294.0 + 2.0 * SCROLL_ROOM);
    assert_eq!(report_1788416428895()[1].cam_y, 1978.0);
    assert_eq!(report_1788416428895().last().unwrap().height, 2448.0);
    assert_eq!(report_1788433450822()[1].cam_x, 435.0);
    assert_eq!(report_1788433450822()[1].cam_y, 1745.0);
    assert_eq!(report_1788433450822().last().unwrap().height, 2880.0);
    assert_eq!(report_1788435936618()[0].cam_y, 382.0);
    assert_eq!(report_1788435936618()[1].pad_y, 144.0);
    assert_eq!(report_1788435936618()[6].height, 2304.0);
    assert_eq!(report_1788435936618().last().unwrap().cam_y, 181.0);
    assert_ne!(report_1788366080812().len(), report_1788435936618().len());
    assert_ne!(report_1788376550462().len(), report_1788435936618().len());
    assert_ne!(report_1788416428895().len(), report_1788435936618().len());
    assert_ne!(report_1788433450822().len(), report_1788435936618().len());
}
