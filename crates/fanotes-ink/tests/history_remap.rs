//! History remap from `fanotes/scripts/check-ink-history-remap.mjs`.
//!
//! The script's browser case: stroke A at the top, erase it, stroke B grows the
//! sheet from 432 px to 576 px, then two undos. Before the fix A came back near
//! y 350. After it, A is still on paper pixel 262 because the undo frame's
//! points were remapped with the live ink.

use fanotes_ink::{InkDocument, PointerKind, StrokePoint, UNDO_CAP};
use fanotes_paper::{grow_page_from_mark, keep_mark_on_page, Mark, PageExtent, Painted};

fn pen(x: f64, y: f64) -> StrokePoint {
    StrokePoint {
        x,
        y,
        t: 0.0,
        pressure: 0.5,
        tilt_x: 0.0,
        tilt_y: 0.0,
        pointer: PointerKind::Pen,
    }
}

fn paper_y(doc: &InkDocument, id: fanotes_ink::StrokeId) -> f64 {
    doc.stroke_points(id).unwrap()[0].y * doc.page_height()
}

#[test]
fn erased_stroke_keeps_its_paper_pixel_after_the_page_grows() {
    let mut doc = InkDocument::new(900.0, 432.0);
    let y_norm = 262.0 / 432.0;
    let stroke_a = doc
        .commit_stroke(&[pen(0.2, y_norm)], 2.5, true, "#111111")
        .unwrap();
    assert!(doc.erase_stroke(stroke_a));
    assert!(doc.live_ids().is_empty());

    let grown = grow_page_from_mark(
        PageExtent {
            width: doc.page_width(),
            height: doc.page_height(),
            origin_x: doc.origin_x(),
            origin_y: doc.origin_y(),
        },
        Mark {
            x: Some(0.5),
            y: Some(0.95),
        },
        Painted {
            width: Some(doc.page_width()),
            height: Some(doc.page_height()),
        },
    );
    assert!((grown.height - 576.0).abs() < 1e-6, "sheet grows 432 → 576");
    assert_eq!(grown.pad_y, 0.0);
    let prev_w = doc.page_width();
    let prev_h = doc.page_height();
    doc.remap_after_grow(
        prev_w,
        prev_h,
        grown.width,
        grown.height,
        grown.pad_x,
        grown.pad_y,
    );

    let broken_y = y_norm * doc.page_height();
    assert!(
        (broken_y - 349.333).abs() < 0.01,
        "leaving the erased stroke in pre-grow 0–1 space paints it near y 350, not 262"
    );

    let y_on_grown = keep_mark_on_page(0.95, prev_h, grown.height, grown.pad_y);
    doc.commit_stroke(&[pen(0.5, y_on_grown)], 2.5, true, "#111111")
        .unwrap();

    assert!(doc.undo(), "undo stroke B");
    assert!(doc.live_ids().is_empty());
    assert!(doc.undo(), "undo the erase and restore stroke A");
    assert_eq!(doc.live_ids(), &[stroke_a]);
    let restored = paper_y(&doc, stroke_a);
    assert!(
        (restored - 262.0).abs() < 1e-6,
        "restored stroke A paper y {restored} must stay 262 on the grown sheet"
    );
    assert!((doc.page_height() - 576.0).abs() < 1e-6);
}

#[test]
fn grow_and_scale_remap_each_point_once_even_when_undo_also_holds_it() {
    let mut doc = InkDocument::new(900.0, 400.0);
    let stroke = doc
        .commit_stroke(&[pen(0.25, 0.5)], 2.0, true, "#111111")
        .unwrap();
    let section = doc.add_section("band", 0.1, 0.2);
    let before_y = doc.stroke_points(stroke).unwrap()[0].y;
    let before_section = doc.point(section.top).unwrap().y;
    doc.push_undo();
    doc.remap_after_grow(900.0, 400.0, 900.0, 544.0, 0.0, 0.0);
    let once = keep_mark_on_page(before_y, 400.0, 544.0, 0.0);
    let twice = keep_mark_on_page(once, 400.0, 544.0, 0.0);
    assert!((doc.stroke_points(stroke).unwrap()[0].y - once).abs() < 1e-12);
    assert!((doc.stroke_points(stroke).unwrap()[0].y - twice).abs() > 1e-6);
    assert!(
        (doc.point(section.top).unwrap().y - keep_mark_on_page(before_section, 400.0, 544.0, 0.0))
            .abs()
            < 1e-12
    );
    assert_eq!(
        doc.point(section.top).unwrap().pointer,
        PointerKind::Section
    );

    doc.erase_stroke(stroke);
    let erased_y = doc.stroke_points(stroke).unwrap()[0].y;
    doc.scale_normalized(1.0, 0.5);
    assert!((doc.stroke_points(stroke).unwrap()[0].y - erased_y * 0.5).abs() < 1e-12);
    assert!(
        doc.live_ids().is_empty(),
        "the scaled stroke is only in the undo frame"
    );
}

#[test]
fn undo_frames_of_stroke_ids_are_capped_at_80() {
    let mut doc = InkDocument::new(900.0, 1273.0);
    for index in 0..81 {
        let y = (index as f64 + 1.0) / 100.0;
        doc.commit_stroke(&[pen(0.1, y)], 2.0, true, "#111111")
            .unwrap();
    }
    assert_eq!(doc.undo_len(), UNDO_CAP);
    assert_eq!(doc.live_ids().len(), 81);
    for _ in 0..UNDO_CAP {
        assert!(doc.undo());
    }
    assert!(
        !doc.undo(),
        "the frame dropped by the cap cannot be restored"
    );
    assert_eq!(doc.live_ids().len(), 1);
    assert_eq!(doc.redo_len(), UNDO_CAP);
}

#[test]
fn drawing_document_json_roundtrip_keeps_live_strokes_and_extra_fields() {
    let raw = r##"{
      "schemaVersion": 1,
      "title": "Mechanik",
      "paperStyle": "grid",
      "sourceWidth": 900,
      "sourceHeight": 1273,
      "createdAt": "2026-10-10T00:00:00.000Z",
      "updatedAt": "2026-10-10T00:00:00.000Z",
      "searchTranscript": "kraft",
      "strokes": [{
        "points": [{ "x": 0.2, "y": 0.3, "t": 4, "pressure": 0.5, "tiltX": 0, "tiltY": 1, "pointerType": "pen" }],
        "baseWidth": 3.5,
        "pressureEnabled": true,
        "color": "#112233",
        "purpose": "handwriting"
      }]
    }"##;
    let doc = InkDocument::from_json(raw).unwrap();
    assert_eq!(doc.live_ids().len(), 1);
    assert!((doc.stroke_points(doc.live_ids()[0]).unwrap()[0].y - 0.3).abs() < 1e-6);
    let saved = doc.to_json().unwrap();
    let again = InkDocument::from_json(&saved).unwrap();
    assert_eq!(again.page_width(), 900.0);
    assert_eq!(again.page_height(), 1273.0);
    assert_eq!(again.stroke_color(again.live_ids()[0]), Some("#112233"));
    let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["searchTranscript"], "kraft");
    assert_eq!(value["strokes"][0]["purpose"], "handwriting");
    assert_eq!(value["strokes"][0]["points"][0]["pointerType"], "pen");
    assert!(value["title"].as_str().unwrap().trim().len() <= 180);
}
