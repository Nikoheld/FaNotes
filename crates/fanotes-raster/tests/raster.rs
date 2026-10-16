use fanotes_raster::{
    ink_stroke_bitmap_width, ink_stroke_paint_margin, ink_stroke_paint_scale, pack_strokes,
    parse_svg_path, pressure_width, rasterize, strokes_from_packed, zoom_bucket, Brush, Effect,
    InkPoint, InkStroke, IntRect, Pixmap, Scene, Symbol, TILE_BUDGET, TILE_PX,
};
use std::sync::Arc;

const INK: u32 = 0x202333;

fn point(x: f64, y: f64) -> InkPoint {
    InkPoint {
        x,
        y,
        pressure: 0.5,
    }
}

fn line(x0: f64, y0: f64, x1: f64, y1: f64, steps: usize) -> Vec<InkPoint> {
    (0..=steps)
        .map(|step| {
            let t = step as f64 / steps as f64;
            point(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
        })
        .collect()
}

fn constant(points: Vec<InkPoint>, width: f64) -> InkStroke {
    let mut stroke = InkStroke::pen(points, width, INK);
    stroke.pressure_enabled = false;
    stroke
}

fn art(points: Vec<InkPoint>, brush: Brush, width: f64) -> InkStroke {
    let mut stroke = InkStroke::pen(points, width, 0x3a7bd5);
    stroke.art = true;
    stroke.brush = Some(brush);
    stroke.texture_seed = Some(17.0);
    stroke
}

fn alpha(pixmap: &Pixmap, x: u32, y: u32) -> u8 {
    pixmap.pixels()[(y * pixmap.width() + x) as usize].alpha()
}

fn opaque_rows_at(pixmap: &Pixmap, x: u32) -> usize {
    (0..pixmap.height())
        .filter(|y| alpha(pixmap, x, *y) >= 24)
        .count()
}

fn opaque_box(pixmap: &Pixmap, min_alpha: u8) -> Option<(u32, u32, u32, u32, usize)> {
    let (mut x0, mut y0, mut x1, mut y1, mut count) = (u32::MAX, u32::MAX, 0, 0, 0);
    for y in 0..pixmap.height() {
        for x in 0..pixmap.width() {
            if alpha(pixmap, x, y) >= min_alpha {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                count += 1;
            }
        }
    }
    (count > 0).then_some((x0, y0, x1, y1, count))
}

fn region(width: u32, height: u32) -> IntRect {
    IntRect::from_xywh(0, 0, width, height).unwrap()
}

#[test]
fn width_rules_match_the_typescript_painter() {
    assert!((pressure_width(3.5, true, 0.5) - 3.36).abs() < 1e-12);
    assert!((pressure_width(3.5, true, 0.0) - 3.5 * (0.4 + 0.08 * 1.12)).abs() < 1e-12);
    assert_eq!(pressure_width(3.5, false, 0.9), 3.5);
    assert_eq!(ink_stroke_paint_scale(900.0, 900.0), 1.0);
    assert_eq!(ink_stroke_paint_scale(1800.0, 900.0), 2.0);
    assert_eq!(ink_stroke_paint_scale(0.0, 900.0), 1.0);
    let pen = constant(vec![point(0.2, 0.2)], 3.5);
    assert_eq!(
        ink_stroke_bitmap_width(&pen, 0.5, 0.2),
        1.0,
        "a pen never collapses below one bitmap px"
    );
    assert!((ink_stroke_paint_margin(&pen, 1.0) - (3.5 * 1.5 / 2.0 + 2.0)).abs() < 1e-12);
}

#[test]
fn a_pen_line_is_its_css_width_at_one_and_two_device_px() {
    let stroke = constant(line(0.1, 0.5, 0.9, 0.5, 16), 3.5);
    let at_one = rasterize(vec![stroke.clone()], 900, 900, 900.0, 0.0).unwrap();
    let rows = opaque_rows_at(&at_one, 450);
    assert!((3..=5).contains(&rows), "3.5 CSS px at 1×, got {rows} rows");
    let at_two = rasterize(vec![stroke], 1800, 1800, 900.0, 0.0).unwrap();
    let rows = opaque_rows_at(&at_two, 900);
    assert!(
        (6..=9).contains(&rows),
        "3.5 CSS px is 7 bitmap px at 2×, got {rows} rows"
    );
}

#[test]
fn zoom_buckets_follow_the_sharpness_band() {
    assert_eq!(zoom_bucket(1.0), Some(1.0));
    assert_eq!(zoom_bucket(1.17), Some(1.0));
    assert_eq!(zoom_bucket(1.2), Some(2.0));
    assert_eq!(zoom_bucket(2.0), Some(2.0));
    assert_eq!(zoom_bucket(2.35), Some(2.0));
    assert_eq!(zoom_bucket(2.4), Some(4.0));
    assert_eq!(zoom_bucket(4.0), Some(4.0));
    assert_eq!(zoom_bucket(4.7), Some(4.0));
    assert_eq!(
        zoom_bucket(5.0),
        None,
        "500 % paints at the exact device scale"
    );
    assert_eq!(zoom_bucket(6.0), None);
    assert_eq!(zoom_bucket(0.5), Some(1.0));
    assert_eq!(zoom_bucket(0.4), None);
    for zoom in [
        0.5, 0.75, 1.0, 1.1, 1.17, 1.18, 1.5, 2.0, 2.3, 2.36, 3.0, 4.0, 4.6,
    ] {
        let bucket = zoom_bucket(zoom).unwrap();
        assert!(
            bucket / zoom >= 0.85 - 1e-9 && bucket / zoom <= 2.0 + 1e-9,
            "zoom {zoom} bucket {bucket}"
        );
    }
}

fn page() -> Vec<InkStroke> {
    vec![
        InkStroke::pen(line(0.05, 0.1, 0.45, 0.32, 24), 3.5, INK),
        InkStroke::pen(line(0.3, 0.6, 0.95, 0.4, 24), 3.5, 0xc0392b),
        constant(line(0.12, 0.85, 0.88, 0.86, 12), 6.0),
        art(line(0.2, 0.7, 0.7, 0.75, 20), Brush::Marker, 14.0),
    ]
}

fn exact(
    strokes: Vec<InkStroke>,
    layout: (f64, f64),
    scale: f64,
    size: (u32, u32),
    origin: (f64, f64),
) -> Pixmap {
    let mut scene = Scene::new();
    scene.set_scene(layout.0, layout.1, 0.5, strokes);
    // A dpr no bucket can serve forces the exact path at the same scale.
    let pixmap = scene
        .paint(scale, scale / 6.0, origin, region(size.0, size.1))
        .unwrap();
    assert_eq!(scene.last_stats().bucket, None);
    pixmap
}

#[test]
fn tiles_at_a_bucket_zoom_copy_the_exact_paint() {
    let layout = (900.0, 1273.0);
    let mut scene = Scene::new();
    scene.set_scene(layout.0, layout.1, 0.5, page());
    let origin = (300.0, 700.0);
    let tiled = scene.paint(2.0, 1.0, origin, region(1000, 900)).unwrap();
    let stats = scene.last_stats();
    assert_eq!(stats.bucket, Some(2.0));
    assert!(
        stats.tiles_used >= 4,
        "the region spans several 512 px tiles, used {}",
        stats.tiles_used
    );
    let direct = exact(page(), layout, 2.0, (1000, 900), origin);
    let mut differing = 0;
    let mut worst = 0_i32;
    for (a, b) in tiled.pixels().iter().zip(direct.pixels()) {
        let delta = (a.alpha() as i32 - b.alpha() as i32).abs();
        worst = worst.max(delta);
        if delta > 2 {
            differing += 1;
        }
    }
    assert!(
        differing * 1000 < tiled.pixels().len(),
        "{differing} pixels differ"
    );
    assert!(worst <= 40, "worst alpha delta {worst}");
}

#[test]
fn resampled_tiles_have_no_seams() {
    let layout = (2000.0, 1600.0);
    // A long diagonal crosses many tile edges at 1.5× (bucket 2, k = 0.75).
    let strokes = vec![constant(line(0.02, 0.05, 0.98, 0.93, 64), 5.0)];
    let mut scene = Scene::new();
    scene.set_scene(layout.0, layout.1, 0.5, strokes.clone());
    let origin = (0.0, 0.0);
    let size = (1500, 1200);
    let tiled = scene
        .paint(1.5, 1.0, origin, region(size.0, size.1))
        .unwrap();
    assert_eq!(scene.last_stats().bucket, Some(2.0));
    let direct = exact(strokes, layout, 1.5, size, origin);
    let mut holes = 0;
    for (a, b) in tiled.pixels().iter().zip(direct.pixels()) {
        if b.alpha() > 200 && a.alpha() < 60 {
            holes += 1;
        }
    }
    assert_eq!(
        holes, 0,
        "a tile edge left a transparent seam through the stroke"
    );
    let covered = |pixmap: &Pixmap| {
        pixmap
            .pixels()
            .iter()
            .filter(|pixel| pixel.alpha() >= 128)
            .count() as f64
    };
    let ratio = covered(&tiled) / covered(&direct);
    assert!(
        (0.9..1.1).contains(&ratio),
        "resampled coverage drifted: {ratio}"
    );
}

#[test]
fn erasing_and_undoing_rerender_only_the_touched_tiles() {
    let layout = (2400.0, 2400.0);
    let near = InkStroke::pen(line(0.02, 0.02, 0.08, 0.05, 8), 3.5, INK);
    let far = InkStroke::pen(line(0.8, 0.85, 0.9, 0.9, 8), 3.5, INK);
    let mut scene = Scene::new();
    scene.set_scene(layout.0, layout.1, 0.5, vec![near.clone(), far.clone()]);
    let full = region(2400, 2400);
    scene.paint(1.0, 1.0, (0.0, 0.0), full).unwrap();
    let first = scene.last_stats();
    assert_eq!(first.bucket, Some(1.0));
    assert_eq!(
        first.tiles_rendered, 25,
        "2400 px at 1× is a 5 × 5 tile grid"
    );
    scene.clear_dirty();

    assert!(
        scene.set_scene(layout.0, layout.1, 0.5, vec![far.clone()]),
        "erase changes the page"
    );
    let dirty = scene
        .dirty_region(1.0, 1.0, (0.0, 0.0), 2400, 2400)
        .expect("erase leaves a dirty region");
    assert!(
        dirty.right() < TILE_PX as i32 && dirty.bottom() < TILE_PX as i32,
        "dirty region stays near the erased stroke: {dirty:?}"
    );
    scene.paint(1.0, 1.0, (0.0, 0.0), full).unwrap();
    assert_eq!(
        scene.last_stats().tiles_rendered,
        1,
        "only the erased stroke's tile repaints"
    );
    scene.clear_dirty();

    assert!(
        scene.set_scene(layout.0, layout.1, 0.5, vec![near.clone(), far.clone()]),
        "undo brings it back"
    );
    scene.paint(1.0, 1.0, (0.0, 0.0), full).unwrap();
    assert_eq!(scene.last_stats().tiles_rendered, 1);
    scene.clear_dirty();

    let appended = InkStroke::pen(line(0.45, 0.45, 0.47, 0.47, 4), 3.5, INK);
    assert!(scene.set_scene(
        layout.0,
        layout.1,
        0.5,
        vec![near.clone(), far.clone(), appended.clone()]
    ));
    let dirty = scene
        .dirty_region(1.0, 1.0, (0.0, 0.0), 2400, 2400)
        .unwrap();
    let after_append = scene.paint(1.0, 1.0, (0.0, 0.0), full).unwrap();
    assert_eq!(
        scene.last_stats().tiles_rendered,
        0,
        "an appended stroke is painted onto the cached tiles"
    );
    assert!(dirty.width() < 200 && dirty.height() < 200, "{dirty:?}");
    let repainted = exact(
        vec![near.clone(), far.clone(), appended],
        layout,
        1.0,
        (2400, 2400),
        (0.0, 0.0),
    );
    let differing = after_append
        .pixels()
        .iter()
        .zip(repainted.pixels())
        .filter(|(a, b)| (a.alpha() as i32 - b.alpha() as i32).abs() > 2)
        .count();
    assert!(
        differing < 20,
        "painting on top must equal a full repaint, {differing} px differ"
    );
    scene.clear_dirty();

    // A section shift moves the far stroke: its old and new place repaint.
    let mut shifted = far.clone();
    for point in &mut shifted.points {
        point.y -= 0.3;
    }
    assert!(scene.set_scene(layout.0, layout.1, 0.5, vec![near, shifted]));
    let dirty = scene
        .dirty_region(1.0, 1.0, (0.0, 0.0), 2400, 2400)
        .unwrap();
    assert!(
        dirty.top() < (0.6 * 2400.0) as i32 && dirty.bottom() > (0.85 * 2400.0) as i32,
        "{dirty:?}"
    );
}

#[test]
fn a_bottom_grow_with_remapped_points_keeps_every_tile() {
    let (width, height) = (900.0, 1273.0);
    let strokes = page();
    let mut scene = Scene::new();
    scene.set_scene(width, height, 0.5, strokes.clone());
    scene
        .paint(1.0, 1.0, (0.0, 0.0), region(900, 1273))
        .unwrap();
    scene.clear_dirty();
    let grown = height + 144.0;
    let remapped: Vec<InkStroke> = strokes
        .into_iter()
        .map(|mut stroke| {
            for point in &mut stroke.points {
                point.y = point.y * height / grown;
            }
            stroke
        })
        .collect();
    assert!(
        !scene.set_scene(width, grown, 0.5, remapped),
        "same paper pixels, nothing to repaint"
    );
    assert_eq!(scene.dirty_region(1.0, 1.0, (0.0, 0.0), 900, 1417), None);
    scene
        .paint(1.0, 1.0, (0.0, 0.0), region(900, 1273))
        .unwrap();
    assert_eq!(scene.last_stats().tiles_rendered, 0);
}

#[test]
fn a_crossing_highlighter_is_composited_once() {
    let mut stroke = art(
        vec![
            point(0.1, 0.5),
            point(0.5, 0.2),
            point(0.5, 0.8),
            point(0.1, 0.5),
            point(0.9, 0.5),
        ],
        Brush::Highlighter,
        22.0,
    );
    stroke.pressure_enabled = false;
    let pixmap = rasterize(vec![stroke], 600, 600, 600.0, 0.4).unwrap();
    let top = pixmap
        .pixels()
        .iter()
        .map(|pixel| pixel.alpha())
        .max()
        .unwrap();
    assert!(top > 70, "the highlighter painted, max alpha {top}");
    assert!(
        top <= (0.36 * 255.0) as u8,
        "overlaps must not darken a translucent stroke, max alpha {top}"
    );
}

#[test]
fn every_brush_paints_inside_its_reach() {
    let mut stroke_cases: Vec<InkStroke> = Brush::ALL
        .iter()
        .map(|brush| art(line(0.2, 0.3, 0.7, 0.62, 14), *brush, 10.0))
        .collect();
    let mut neon = art(line(0.25, 0.25, 0.75, 0.3, 10), Brush::Fineliner, 6.0);
    neon.effect = Effect::Neon;
    stroke_cases.push(neon);
    let mut rainbow = InkStroke::pen(line(0.1, 0.8, 0.9, 0.82, 10), 8.0, INK);
    rainbow.effect = Effect::Rainbow;
    stroke_cases.push(rainbow);
    let star = parse_svg_path(
        "M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z",
    )
    .unwrap();
    let mut stamp = art(vec![point(0.5, 0.5)], Brush::Fineliner, 60.0);
    stamp.symbol = Some(Arc::new(Symbol { paths: vec![star] }));
    stamp.symbol_rotation = 30.0;
    stroke_cases.push(stamp);
    for stroke in stroke_cases {
        let label = format!(
            "{:?}/{:?}/symbol={}",
            stroke.brush,
            stroke.effect,
            stroke.symbol.is_some()
        );
        let pixmap = rasterize(vec![stroke.clone()], 800, 800, 800.0, 0.5).unwrap();
        let (x0, y0, x1, y1, count) =
            opaque_box(&pixmap, 1).unwrap_or_else(|| panic!("{label} painted nothing"));
        assert!(count > 20, "{label} painted only {count} px");
        let margin = ink_stroke_paint_margin(&stroke, 1.0) + 1.0;
        let xs = stroke.points.iter().map(|p| p.x * 800.0);
        let ys = stroke.points.iter().map(|p| p.y * 800.0);
        let (min_x, max_x) = (
            xs.clone().fold(f64::INFINITY, f64::min),
            xs.fold(f64::NEG_INFINITY, f64::max),
        );
        let (min_y, max_y) = (
            ys.clone().fold(f64::INFINITY, f64::min),
            ys.fold(f64::NEG_INFINITY, f64::max),
        );
        assert!(
            x0 as f64 >= min_x - margin - 1.0 && x1 as f64 <= max_x + margin + 1.0,
            "{label} x {x0}..{x1}"
        );
        assert!(
            y0 as f64 >= min_y - margin - 1.0 && y1 as f64 <= max_y + margin + 1.0,
            "{label} y {y0}..{y1}"
        );
    }
}

#[test]
fn a_turn_does_not_hook_along_the_previous_heading() {
    let turn = InkStroke::pen(
        vec![point(0.2, 0.5), point(0.5, 0.5), point(0.5, 0.8)],
        3.5,
        INK,
    );
    let pixmap = rasterize(vec![turn], 400, 400, 400.0, 1.0).unwrap();
    assert!(alpha(&pixmap, 200, 200) >= 24, "the corner the pen reached stays covered");
    assert!(alpha(&pixmap, 120, 200) >= 24, "the incoming leg stays covered");
    assert!(alpha(&pixmap, 200, 280) >= 24, "the outgoing leg stays covered");
    assert!(
        alpha(&pixmap, 216, 220) < 24,
        "the open tip must not flash onward in the previous direction"
    );
    assert!(
        alpha(&pixmap, 214, 200) < 24,
        "the incoming heading stops at the corner"
    );
    let reverse = InkStroke::pen(
        vec![point(0.2, 0.45), point(0.55, 0.45), point(0.2, 0.45)],
        3.5,
        INK,
    );
    let pixmap = rasterize(vec![reverse], 400, 400, 400.0, 1.0).unwrap();
    assert!(alpha(&pixmap, 220, 180) >= 24, "a reversal still covers the turn");
    assert!(
        alpha(&pixmap, 248, 180) < 24,
        "a reversal must not loop past the tip"
    );
}

#[test]
fn seeded_brushes_paint_the_same_pixels_twice() {
    for brush in [Brush::Spray, Brush::Pencil] {
        let stroke = art(line(0.1, 0.2, 0.8, 0.6, 20), brush, 12.0);
        let first = rasterize(vec![stroke.clone()], 500, 500, 500.0, 0.5).unwrap();
        let second = rasterize(vec![stroke], 500, 500, 500.0, 0.5).unwrap();
        assert_eq!(first.data(), second.data(), "{brush:?}");
    }
}

#[test]
fn five_hundred_percent_paints_at_the_exact_device_scale() {
    let layout = (900.0, 1273.0);
    let mut scene = Scene::new();
    scene.set_scene(
        layout.0,
        layout.1,
        0.0,
        vec![constant(line(0.1, 0.5, 0.9, 0.5, 16), 3.5)],
    );
    // 1200 × 800 CSS viewport at 5× zoom and DPR 2: ten device px per layout px.
    let origin = (0.4 * 900.0 * 10.0, 0.5 * 1273.0 * 10.0 - 400.0);
    let pixmap = scene.paint(10.0, 2.0, origin, region(2400, 1600)).unwrap();
    assert_eq!(scene.last_stats().bucket, None);
    assert_eq!(
        scene.tile_count(),
        0,
        "500 % does not populate the tile cache"
    );
    assert_eq!(
        (pixmap.width(), pixmap.height()),
        (2400, 1600),
        "only the viewport is allocated"
    );
    let rows = opaque_rows_at(&pixmap, 1200);
    assert!(
        (33..=37).contains(&rows),
        "3.5 CSS px at 5× DPR 2 is 35 device px, got {rows}"
    );
}

#[test]
fn a_region_needing_more_tiles_than_the_budget_paints_exact() {
    let mut scene = Scene::new();
    scene.set_scene(
        20_000.0,
        20_000.0,
        0.5,
        vec![InkStroke::pen(line(0.1, 0.1, 0.9, 0.9, 40), 3.5, INK)],
    );
    let side = TILE_PX * ((TILE_BUDGET as f64).sqrt() as u32 + 2);
    scene
        .paint(1.0, 1.0, (0.0, 0.0), region(side, side))
        .unwrap();
    assert_eq!(scene.last_stats().bucket, None);
    assert!(scene.tile_count() <= TILE_BUDGET);
}

#[test]
fn packed_strokes_roundtrip() {
    let symbols = vec![Arc::new(Symbol {
        paths: vec![parse_svg_path("M5 12h14").unwrap()],
    })];
    let mut stamp = art(vec![point(0.4, 0.4)], Brush::Fineliner, 30.0);
    stamp.symbol = Some(symbols[0].clone());
    stamp.symbol_rotation = 15.0;
    stamp.opacity = Some(0.6);
    let strokes = vec![stamp, InkStroke::pen(line(0.1, 0.1, 0.2, 0.3, 3), 3.5, INK)];
    let (header, points) = pack_strokes(&strokes, &symbols);
    let back = strokes_from_packed(&header, &points, &symbols);
    assert_eq!(back.len(), 2);
    assert!(Arc::ptr_eq(back[0].symbol.as_ref().unwrap(), &symbols[0]));
    assert_eq!(back[0].opacity, Some(0.6));
    assert_eq!(back[0].symbol_rotation, 15.0);
    assert_eq!(back[1].points, strokes[1].points);
    assert!(back[1].pressure_enabled);
    assert_eq!(
        strokes_from_packed(&header, &points[..points.len() - 3], &symbols).len(),
        1,
        "a truncated tail is dropped"
    );
}
