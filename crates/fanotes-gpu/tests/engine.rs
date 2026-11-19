//! Width parity with TypeScript, incremental strokes, tile invalidation and ink sync.

use std::collections::HashSet;

use fanotes_gpu::fixtures::{art, handwriting, long_stroke};
use fanotes_gpu::ops::{Op, OpSource};
use fanotes_gpu::tiles::{plan_tiles, TileCache, TileKey};
use fanotes_gpu::{
    build_stroke_ops, pressure_width, Brush, Camera, CpuRenderer, InkPoint, InkStroke, LiveStroke,
    PageScene, PaperStyle, Renderer,
};
use fanotes_ink::{InkDocument, PointerKind, StrokePoint};
use fanotes_raster::{brush_passes, ink_brush_of};
use serde_json::Value;

fn ts_vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/ts_ink_vectors.json")).expect("vectors")
}

#[test]
fn pressure_width_matches_the_typescript_vectors() {
    let vectors = ts_vectors();
    let widths = vectors["widths"].as_array().expect("widths");
    assert!(widths.len() > 50);
    for row in widths {
        let base = row[0].as_f64().unwrap();
        let enabled = row[1].as_bool().unwrap();
        let pressure = row[2].as_f64().unwrap();
        let want = row[3].as_f64().unwrap();
        let got = pressure_width(base, enabled, pressure);
        assert!(
            (got - want).abs() < 1e-12,
            "pressureWidth({base}, {enabled}, {pressure}) = {got}, TS {want}"
        );
    }
}

#[test]
fn every_brush_pass_matches_the_typescript_table() {
    let vectors = ts_vectors();
    let passes = vectors["passes"].as_object().expect("passes");
    let names = [
        ("fineliner", Brush::Fineliner),
        ("pencil", Brush::Pencil),
        ("marker", Brush::Marker),
        ("paintbrush", Brush::Paintbrush),
        ("calligraphy", Brush::Calligraphy),
        ("highlighter", Brush::Highlighter),
        ("watercolor", Brush::Watercolor),
        ("spray", Brush::Spray),
    ];
    assert_eq!(passes.len(), names.len());
    for (name, brush) in names {
        let ts = passes[name].as_array().unwrap();
        let rust = brush_passes(brush);
        assert_eq!(ts.len(), rust.len(), "{name}");
        for (t, r) in ts.iter().zip(rust) {
            assert_eq!(t[0].as_f64().unwrap(), r.width_factor, "{name} width");
            assert_eq!(t[1].as_f64().unwrap(), r.alpha, "{name} alpha");
            assert_eq!(t[2].as_f64(), r.jitter, "{name} jitter");
        }
    }
    // Handwriting is always the fineliner, whatever brush the art palette had.
    let mut pen = InkStroke::pen(Vec::new(), 3.5, 0);
    pen.brush = Some(Brush::Highlighter);
    assert_eq!(ink_brush_of(&pen), Brush::Fineliner);
}

#[test]
fn segment_widths_follow_pressure_at_every_scale() {
    // One straight segment per pressure: the stroked width is pressureWidth × scale.
    for scale in [0.5, 1.0, 2.0, 4.0] {
        for pressure in [0.0, 0.35, 0.5, 1.0] {
            let points = vec![
                InkPoint {
                    x: 10.0,
                    y: 10.0,
                    pressure,
                },
                InkPoint {
                    x: 60.0,
                    y: 10.0,
                    pressure,
                },
            ];
            let ops =
                build_stroke_ops(&InkStroke::pen(points, 3.5, 0), (900.0, 1273.0), scale, 0.5);
            let width = ops
                .ops
                .iter()
                .find_map(|op| match op {
                    Op::Seg { width, .. } => Some(*width as f64),
                    _ => None,
                })
                .expect("segment");
            let want = (pressure_width(3.5, true, pressure) * scale).max(1.0);
            assert!(
                (width - want).abs() < 1e-4,
                "scale {scale} pressure {pressure}: {width} vs {want}"
            );
        }
    }
}

fn wave(samples: usize) -> Vec<InkPoint> {
    (0..samples)
        .map(|i| {
            let t = i as f64 / (samples.max(2) - 1) as f64;
            InkPoint {
                x: 20.0 + t * 400.0,
                y: 80.0 + (t * 11.0).sin() * 35.0,
                pressure: 0.2 + 0.7 * (t * 3.0).sin().abs(),
            }
        })
        .collect()
}

fn styles() -> Vec<(&'static str, InkStroke)> {
    let mut constant = InkStroke::pen(Vec::new(), 3.0, 0x202333);
    constant.pressure_enabled = false;
    let mut flat_highlighter = art(Vec::new(), Brush::Highlighter, 16.0, 0xffd400);
    flat_highlighter.pressure_enabled = false;
    let mut translucent = art(Vec::new(), Brush::Fineliner, 6.0, 0x8e44ad);
    translucent.opacity = Some(0.5);
    let mut constant_pencil = art(Vec::new(), Brush::Pencil, 6.0, 0x555555);
    constant_pencil.pressure_enabled = false;
    let mut out = vec![
        ("pen", InkStroke::pen(Vec::new(), 3.5, 0x202333)),
        ("constant pen", constant),
        ("flat highlighter", flat_highlighter),
        ("translucent", translucent),
        ("constant pencil", constant_pencil),
    ];
    for brush in Brush::ALL {
        out.push((
            match brush {
                Brush::Fineliner => "fineliner",
                Brush::Pencil => "pencil",
                Brush::Marker => "marker",
                Brush::Paintbrush => "paintbrush",
                Brush::Calligraphy => "calligraphy",
                Brush::Highlighter => "highlighter",
                Brush::Watercolor => "watercolor",
                Brush::Spray => "spray",
            },
            art(Vec::new(), brush, 9.0, 0x3a7bd5),
        ));
    }
    out
}

fn collect(source: &dyn OpSource) -> Vec<Op> {
    let mut ops = Vec::new();
    source.visit(&mut |op| {
        if !matches!(op, Op::Cap(_)) {
            ops.push(op.clone());
        }
    });
    ops
}

#[test]
fn the_wet_stroke_builds_the_same_ops_as_a_full_paint() {
    for smoothing in [0.0, 0.5, 1.0] {
        for (name, style) in styles() {
            for samples in [1, 2, 3, 4, 60] {
                let points = wave(samples);
                let mut live = LiveStroke::new(&style, (900.0, 1273.0), 1.5, smoothing);
                for point in &points {
                    live.push(*point);
                }
                let mut whole = style.clone();
                whole.points = points;
                let committed = build_stroke_ops(&whole, (900.0, 1273.0), 1.5, smoothing);
                let committed: Vec<Op> = committed
                    .ops
                    .into_iter()
                    .filter(|op| !matches!(op, Op::Cap(_)))
                    .collect();
                assert_eq!(
                    collect(&live),
                    committed,
                    "{name}, {samples} samples, smoothing {smoothing}"
                );
            }
        }
    }
}

#[test]
fn a_new_sample_adds_constant_work_and_never_rewrites_final_ops() {
    for (name, style) in styles() {
        let mut live = LiveStroke::new(&style, (900.0, 1273.0), 2.0, 0.5);
        let points = long_stroke(4000, (40.0, 300.0));
        let mut previous = 0;
        let mut max_step = 0;
        let mut snapshot: Vec<Op> = Vec::new();
        for (index, point) in points.iter().enumerate() {
            live.push(*point);
            let now = live.final_op_count();
            assert!(now >= previous, "{name}: final ops shrank");
            max_step = max_step.max(now - previous);
            previous = now;
            if index == 1000 {
                snapshot = collect(&live);
            }
        }
        // Spray adds two ops per particle (alpha, dot); everything else a few per pass.
        let bound = if name == "spray" { 2 * 24 } else { 8 };
        assert!(
            max_step <= bound,
            "{name}: one sample added {max_step} final ops"
        );
        let now = collect(&live);
        // Single-pass segment strokes: everything final at sample 1000 is
        // still there, unchanged and in place, at sample 4000.
        let path_kind = matches!(name, "flat highlighter" | "constant pencil" | "marker");
        if !path_kind && brush_passes(ink_brush_of(&style)).len() == 1 {
            let keep = snapshot.len() - 3;
            assert_eq!(&now[..keep], &snapshot[..keep], "{name}: final ops changed");
        }
    }
}

fn camera(width: u32, height: u32) -> Camera {
    Camera::new(width, height)
}

fn stroke_at(x: f64, y: f64) -> InkStroke {
    InkStroke::pen(
        (0..12)
            .map(|i| InkPoint {
                x: x + i as f64 * 3.0,
                y: y + (i as f64).sin() * 4.0,
                pressure: 0.5,
            })
            .collect(),
        3.0,
        0x202333,
    )
}

fn keys(cache: &TileCache<u32>) -> HashSet<(i32, i32)> {
    cache.keys().map(|key| (key.col, key.row)).collect()
}

fn filled(scene: &PageScene, camera: &Camera) -> TileCache<u32> {
    let mut cache = TileCache::default();
    cache.sync(scene);
    for key in plan_tiles(camera).expect("bucket").keys {
        cache.insert(key, 0, 1);
    }
    cache
}

#[test]
fn erase_undo_and_section_shift_drop_only_the_tiles_they_touch() {
    let mut scene = PageScene::new(1536.0, 1536.0);
    let a = scene.add_stroke(stroke_at(100.0, 100.0)); // tile (0, 0)
    scene.add_stroke(stroke_at(700.0, 100.0)); // tile (1, 0)
    scene.add_stroke(stroke_at(100.0, 700.0)); // tile (0, 1)
    scene.add_stroke(stroke_at(700.0, 1200.0)); // tile (1, 2)
    let view = camera(1536, 1536);
    let mut cache = filled(&scene, &view);
    assert_eq!(cache.len(), 9);

    // Erase: one tile.
    let erased = scene.remove_stroke(a).expect("erase");
    cache.sync(&scene);
    assert_eq!(keys(&cache).len(), 8);
    assert!(!keys(&cache).contains(&(0, 0)));

    // Undo puts it back: the same one tile repaints.
    let mut cache = filled(&scene, &view);
    scene.add_stroke(erased);
    cache.sync(&scene);
    assert_eq!(keys(&cache).len(), 8);
    assert!(!keys(&cache).contains(&(0, 0)));

    // A section opening at y = 600 pushes everything below down by 200 px:
    // rows 1 and 2 repaint, row 0 stays.
    let mut cache = filled(&scene, &view);
    let moved = scene.shift_section(600.0, 200.0);
    assert_eq!(moved, 2);
    cache.sync(&scene);
    let left = keys(&cache);
    assert_eq!(left, [(0, 0), (1, 0), (2, 0)].into_iter().collect());

    // A stroke on a tile corner drops all four neighbours.
    let mut cache = filled(&scene, &view);
    scene.add_stroke(stroke_at(505.0, 505.0));
    cache.sync(&scene);
    for tile in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        assert!(!keys(&cache).contains(&tile), "{tile:?} kept");
    }
    assert_eq!(cache.len(), 5);
}

#[test]
fn a_renderer_repaints_only_invalidated_tiles_and_matches_a_fresh_frame() {
    let mut scene = PageScene::new(900.0, 1273.0);
    scene.paper = PaperStyle::Lines;
    let keys: Vec<_> = handwriting(1500, 10, (900.0, 1273.0), 4)
        .into_iter()
        .map(|stroke| scene.add_stroke(stroke))
        .collect();
    let mut view = camera(900, 1100);
    view.zoom = 1.0;
    let mut renderer = CpuRenderer::new(None);
    let first = renderer.render(&scene, &view).expect("frame");
    assert_eq!(first.tiles_rendered, first.tiles_used);
    let warm = renderer.render(&scene, &view).expect("frame");
    assert_eq!(warm.tiles_rendered, 0, "a still frame renders no tile");

    scene.remove_stroke(keys[0]).expect("erase");
    let after = renderer.render(&scene, &view).expect("frame");
    assert!(
        after.tiles_rendered >= 1 && after.tiles_rendered <= 4,
        "{after:?}"
    );
    let incremental = renderer.read_rgba().expect("frame");
    let mut fresh = CpuRenderer::new(None);
    fresh.render(&scene, &view).expect("frame");
    assert_eq!(
        incremental,
        fresh.read_rgba().expect("frame"),
        "invalidated frame differs from a fresh one"
    );

    // Pan by whole pixels: no stroke is re-encoded for tiles already cached.
    view.scroll_y = 40.0;
    let pan = renderer.render(&scene, &view).expect("frame");
    assert!(pan.tiles_rendered <= 2, "{pan:?}");
}

#[test]
fn tiles_and_exact_paint_agree_across_zoom() {
    let mut scene = PageScene::new(900.0, 1273.0);
    scene.paper = PaperStyle::Blank;
    for stroke in handwriting(300, 12, (900.0, 1273.0), 9) {
        scene.add_stroke(stroke);
    }
    let mut tiled = CpuRenderer::new(None);
    let mut exact = CpuRenderer::new(None);
    exact.set_tiling(false);
    for zoom in [0.3, 0.6, 1.0, 1.4, 2.0, 3.0] {
        let mut view = camera(400, 300);
        view.zoom = zoom;
        view.scroll_x = 13.0 * zoom;
        view.scroll_y = 21.0 * zoom;
        tiled.render(&scene, &view).expect("tiled");
        exact.render(&scene, &view).expect("exact");
        let diff = exact.read_rgba().unwrap().diff(&tiled.read_rgba().unwrap());
        eprintln!("zoom {zoom}: {diff:?}");
        // A bucket within 0.85–2× of the screen, sampled bilinearly. Far out
        // (zoom 0.3 → bucket 0.5) the device-pixel rules of drawInkStroke (1 px
        // minimum nib, lift hooks and 0.2 px segments measured in px) see a
        // different scale, so only the overall picture is compared there.
        let balance = (diff.ink.0 - diff.ink.1).abs() / diff.ink.0;
        assert!(diff.mean < 3.0, "zoom {zoom}: {diff:?}");
        assert!(zoom < 0.5 || balance < 0.08, "zoom {zoom}: {diff:?}");
    }
}

fn sample(x: f64, y: f64) -> StrokePoint {
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

fn frame(scene: &PageScene, view: &Camera) -> fanotes_gpu::RgbaImage {
    let mut renderer = CpuRenderer::new(None);
    renderer.render(scene, view).expect("frame");
    renderer.read_rgba().expect("frame")
}

#[test]
fn an_ink_document_drives_erase_undo_redo_live_and_grow() {
    let json = r##"{
        "schemaVersion": 1, "title": "t", "paperStyle": "lines",
        "createdAt": "2026-10-10T00:00:00.000Z", "updatedAt": "2026-10-10T00:00:00.000Z",
        "sourceWidth": 900, "sourceHeight": 1273,
        "strokes": [
            { "points": [{"x":0.1,"y":0.1,"t":0,"pressure":0.5},{"x":0.3,"y":0.12,"t":1,"pressure":0.6}],
              "baseWidth": 3.5, "pressureEnabled": true, "color": "#202333" },
            { "points": [{"x":0.1,"y":0.2,"t":0,"pressure":0.5},{"x":0.4,"y":0.2,"t":1,"pressure":0.5}],
              "baseWidth": 16, "pressureEnabled": false, "color": "#ffd400",
              "purpose": "art", "brush": "highlighter", "opacity": 0.8, "textureSeed": 3 }
        ]
    }"##;
    let mut doc = InkDocument::from_json(json).expect("doc");
    let mut scene = PageScene::new(900.0, 1273.0);
    scene.sync_ink(&doc, 1.0);
    assert_eq!(scene.stroke_count(), 2);
    let highlighter = scene
        .strokes_in(kurbo::Rect::new(0.0, 0.0, 900.0, 1273.0))
        .into_iter()
        .map(|(_, stroke)| stroke.stroke.clone())
        .find(|stroke| stroke.art)
        .expect("art stroke");
    assert_eq!(highlighter.brush, Some(Brush::Highlighter));
    assert_eq!(highlighter.opacity, Some(0.8));
    assert!(!highlighter.pressure_enabled);
    assert!((highlighter.points[1].x - 360.0).abs() < 1e-9, "page px");

    let view = camera(500, 400);
    let both = frame(&scene, &view);
    doc.erase_last();
    scene.sync_ink(&doc, 1.0);
    assert_eq!(scene.stroke_count(), 1);
    let erased = frame(&scene, &view);
    assert_ne!(both, erased);
    doc.undo();
    scene.sync_ink(&doc, 1.0);
    assert_eq!(frame(&scene, &view), both, "undo restores the frame");
    doc.redo();
    scene.sync_ink(&doc, 1.0);
    assert_eq!(frame(&scene, &view), erased, "redo erases again");
    doc.undo();
    scene.sync_ink(&doc, 1.0);

    // The active stroke is the wet stroke, appended sample by sample.
    doc.begin_stroke(2.5, true, "#1a1a1a");
    doc.push_point(sample(0.2, 0.3));
    scene.sync_ink(&doc, 1.0);
    doc.push_point(sample(0.25, 0.32));
    doc.push_point(sample(0.3, 0.3));
    scene.sync_ink(&doc, 1.0);
    assert_eq!(scene.live().map(|live| live.points().len()), Some(3));
    doc.end_stroke();
    scene.sync_ink(&doc, 1.0);
    assert!(scene.live().is_none());
    assert_eq!(scene.stroke_count(), 3);

    // A grow with an origin pad moves all paper: everything repaints, ink moves by the pad.
    let before = scene.revision();
    doc.remap_after_grow(900.0, 1273.0, 1008.0, 1273.0, 108.0, 0.0);
    scene.sync_ink(&doc, 1.0);
    assert!(scene.revision() > before);
    assert!(matches!(
        scene.dirty_since(before),
        fanotes_gpu::scene::Dirty::All
    ));
    let moved = scene
        .strokes_in(kurbo::Rect::new(0.0, 0.0, 1008.0, 1273.0))
        .into_iter()
        .map(|(_, stroke)| stroke.stroke.points[0].x)
        .fold(f64::INFINITY, f64::min);
    assert!(
        (moved - (90.0 + 108.0)).abs() < 1e-6,
        "first point x {moved}"
    );

    // A max-edge grow (no pad) keeps every tile.
    let before = scene.revision();
    doc.remap_after_grow(1008.0, 1273.0, 1008.0, 1417.0, 0.0, 0.0);
    scene.sync_ink(&doc, 1.0);
    assert_eq!(scene.revision(), before);
}

#[test]
fn tile_keys_cover_the_viewport_once() {
    let mut view = camera(1920, 1080);
    view.zoom = 0.85;
    view.scroll_x = 3.0;
    let plan = plan_tiles(&view).expect("bucket");
    assert_eq!(plan.density, 1.0);
    let visible = view.visible_page_rect();
    let mut covered = 0.0;
    for key in &plan.keys {
        covered += key.page_rect().intersect(visible).area();
    }
    assert!((covered - visible.area()).abs() < 1e-6);
    let unique: HashSet<TileKey> = plan.keys.iter().copied().collect();
    assert_eq!(unique.len(), plan.keys.len());
}
