//! Page-engine benchmark: `cargo bench -p fanotes-gpu --bench page_engine`.
//!
//! Synthetic handwriting (8 samples per stroke) at 20k / 100k / 500k strokes,
//! all on one A4 sheet seen whole in a 1920 × 1080 viewport. Per backend:
//! - exact: full redraw without tiles (every visible stroke built and encoded);
//! - tiles cold: full redraw that renders every visible tile;
//! - still: a frame from warm tiles;
//! - wet +1: append one pen sample to a 200-sample wet stroke and render;
//! - pan: 60 frames scrolling 13 px at zoom 2 (tiles fill in as they appear);
//! - zoom: 60 frames zooming 3% per frame from 0.85 to 5 (bucket changes, then exact).
//!
//! Env: `FANOTES_BENCH_SIZES=20000,100000`, `FANOTES_BENCH_BACKENDS=gpu,cpu,ref`,
//! `FANOTES_GPU_ADAPTER=3070`. Prints a Markdown table.

use std::time::Instant;

use fanotes_gpu::fixtures::{handwriting, long_stroke};
use fanotes_gpu::{
    Camera, CpuRenderer, InkStroke, LiveStroke, PageScene, PaperStyle, ReferenceRenderer, Renderer,
};

const PAGE: (f64, f64) = (900.0, 1273.0);
const VIEW: (u32, u32) = (1920, 1080);
const POINTS_PER_STROKE: usize = 8;

fn rss_mib() -> (f64, f64) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|kb| kb.parse::<f64>().ok())
            .map_or(f64::NAN, |kb| kb / 1024.0)
    };
    (field("VmRSS:"), field("VmHWM:"))
}

fn page_camera() -> Camera {
    let mut camera = Camera::new(VIEW.0, VIEW.1);
    camera.zoom = 0.85;
    camera.scroll_x = -((VIEW.0 as f64 - PAGE.0 * 0.85) / 2.0).round();
    camera
}

#[derive(Default, Clone)]
struct Times(Vec<f64>);

impl Times {
    fn push(&mut self, ms: f64) {
        self.0.push(ms);
    }
    fn mean(&self) -> f64 {
        self.0.iter().sum::<f64>() / self.0.len().max(1) as f64
    }
    fn p95(&self) -> f64 {
        let mut sorted = self.0.clone();
        sorted.sort_by(f64::total_cmp);
        sorted
            .get(((sorted.len() as f64 * 0.95).ceil() as usize).saturating_sub(1))
            .copied()
            .unwrap_or(f64::NAN)
    }
    fn max(&self) -> f64 {
        self.0.iter().copied().fold(f64::NAN, f64::max)
    }
}

fn frame(renderer: &mut dyn Renderer, scene: &PageScene, camera: &Camera) -> f64 {
    let start = Instant::now();
    renderer.render(scene, camera).expect("render");
    start.elapsed().as_secs_f64() * 1000.0
}

struct Row {
    backend: String,
    strokes: usize,
    exact: f64,
    cold: f64,
    still: f64,
    wet: f64,
    pan: Times,
    zoom: Times,
    tile_mib: f64,
    rss: (f64, f64),
}

fn run(renderer: &mut dyn Renderer, scene: &mut PageScene, strokes: usize, repeat: usize) -> Row {
    let camera = page_camera();
    // Exact full redraw.
    renderer.set_tiling(false);
    frame(renderer, scene, &camera);
    let exact = (0..repeat)
        .map(|_| frame(renderer, scene, &camera))
        .sum::<f64>()
        / repeat as f64;
    // Tiles, cold then warm.
    renderer.set_tiling(true);
    let mut cold = 0.0;
    for _ in 0..repeat {
        renderer.clear_cache();
        cold += frame(renderer, scene, &camera);
    }
    cold /= repeat as f64;
    let still = (0..20)
        .map(|_| frame(renderer, scene, &camera))
        .sum::<f64>()
        / 20.0;
    // Wet stroke: 200 samples down, then one sample per frame.
    let samples = long_stroke(400, (120.0, 500.0));
    scene.begin_live(
        &InkStroke::pen(Vec::new(), 2.5, 0x1a1a1a),
        camera.device_scale(),
    );
    for point in &samples[..200] {
        scene.push_live(*point);
    }
    frame(renderer, scene, &camera);
    let mut wet = Times::default();
    for point in &samples[200..] {
        let start = Instant::now();
        scene.push_live(*point);
        renderer.render(scene, &camera).expect("render");
        wet.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    scene.cancel_live();
    // Pan at zoom 2.
    let mut pan_camera = camera;
    pan_camera.zoom = 2.0;
    pan_camera.scroll_x = 300.0;
    pan_camera.scroll_y = 200.0;
    frame(renderer, scene, &pan_camera);
    let mut pan = Times::default();
    for _ in 0..60 {
        pan_camera.scroll_y += 13.0;
        pan.push(frame(renderer, scene, &pan_camera));
    }
    // Zoom sweep around the viewport centre.
    let mut zoom_camera = camera;
    frame(renderer, scene, &zoom_camera);
    let mut zoom = Times::default();
    for _ in 0..60 {
        zoom_camera.zoom_at(VIEW.0 as f64 / 2.0, VIEW.1 as f64 / 2.0, 1.03);
        zoom.push(frame(renderer, scene, &zoom_camera));
    }
    let memory = renderer.memory();
    Row {
        backend: format!("{:?}", renderer.kind()),
        strokes,
        exact,
        cold,
        still,
        wet: wet.mean(),
        pan,
        zoom,
        tile_mib: (memory.tile_bytes + memory.other_bytes) as f64 / (1024.0 * 1024.0),
        rss: rss_mib(),
    }
}

/// Cost of `LiveStroke::push` alone at a given stroke length.
fn append_cost(length: usize) -> f64 {
    let points = long_stroke(length + 1000, (40.0, 40.0));
    let mut live = LiveStroke::new(&InkStroke::pen(Vec::new(), 2.5, 0), PAGE, 1.0, 0.5);
    for point in &points[..length] {
        live.push(*point);
    }
    let start = Instant::now();
    for point in &points[length..] {
        live.push(*point);
    }
    start.elapsed().as_secs_f64() * 1e6 / 1000.0
}

fn main() {
    if std::env::args().any(|arg| arg == "--list") {
        return;
    }
    let sizes: Vec<usize> = std::env::var("FANOTES_BENCH_SIZES")
        .unwrap_or_else(|_| "20000,100000,500000".into())
        .split(',')
        .filter_map(|size| size.trim().parse().ok())
        .collect();
    let backends = std::env::var("FANOTES_BENCH_BACKENDS").unwrap_or_else(|_| "gpu,cpu,ref".into());
    eprintln!(
        "wet-stroke push: {:.3} µs/sample at 100 samples, {:.3} µs/sample at 10k, {:.3} µs/sample at 100k",
        append_cost(100),
        append_cost(10_000),
        append_cost(100_000)
    );
    let mut rows = Vec::new();
    for &strokes in &sizes {
        let build = Instant::now();
        let mut scene = PageScene::new(PAGE.0, PAGE.1);
        scene.paper = PaperStyle::Lines;
        for stroke in handwriting(strokes, POINTS_PER_STROKE, PAGE, 42) {
            scene.add_stroke(stroke);
        }
        eprintln!(
            "{strokes} strokes / {} points: scene built in {:.0} ms, RSS {:.0} MiB",
            scene.point_count(),
            build.elapsed().as_secs_f64() * 1000.0,
            rss_mib().0
        );
        let repeat = if strokes >= 500_000 { 2 } else { 3 };
        #[cfg(feature = "gpu")]
        if backends.contains("gpu") {
            match fanotes_gpu::HybridRenderer::headless() {
                Ok(mut gpu) => {
                    eprintln!("  vello_hybrid on {}", gpu.adapter_name());
                    let row = run(&mut gpu, &mut scene, strokes, repeat);
                    eprintln!("  done {}", row.backend);
                    rows.push(row);
                }
                Err(error) => eprintln!("  no GPU: {error}"),
            }
        }
        if backends.contains("cpu") {
            let row = run(&mut CpuRenderer::new(None), &mut scene, strokes, repeat);
            eprintln!("  done {}", row.backend);
            rows.push(row);
        }
        if backends.contains("ref") && strokes <= 100_000 {
            // The reference has no tiles: every frame is an exact paint.
            let mut reference = ReferenceRenderer::new();
            let camera = page_camera();
            frame(&mut reference, &scene, &camera);
            let exact = (0..repeat)
                .map(|_| frame(&mut reference, &scene, &camera))
                .sum::<f64>()
                / repeat as f64;
            println!("tiny-skia reference, {strokes} strokes: exact full redraw {exact:.1} ms");
        }
    }
    println!(
        "| backend | strokes (points) | full redraw exact | tiles cold | still (warm tiles) | wet +1 sample | pan mean / p95 / max | zoom mean / p95 / max | tiles+targets | RSS / peak |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|");
    for row in &rows {
        println!(
            "| {} | {}k ({}k) | {:.1} ms | {:.1} ms | {:.2} ms | {:.2} ms | {:.1} / {:.1} / {:.0} ms | {:.1} / {:.1} / {:.0} ms | {:.0} MiB | {:.0} / {:.0} MiB |",
            row.backend,
            row.strokes / 1000,
            row.strokes * POINTS_PER_STROKE / 1000,
            row.exact,
            row.cold,
            row.still,
            row.wet,
            row.pan.mean(),
            row.pan.p95(),
            row.pan.max(),
            row.zoom.mean(),
            row.zoom.p95(),
            row.zoom.max(),
            row.tile_mib,
            row.rss.0,
            row.rss.1,
        );
    }
}
