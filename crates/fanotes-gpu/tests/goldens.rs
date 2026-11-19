//! Golden frames: every backend against the tiny-skia reference.
//!
//! Each fixture is rendered by the reference (`fanotes-raster`'s
//! `draw_ink_stroke`, itself checked against `inkStrokePaint.ts`) and stored
//! as a small PNG in `tests/goldens/`. The reference must still match its PNG
//! (raster drift), and vello_cpu and vello_hybrid must match it within a
//! tolerance, both painting exactly and through the tile cache.
//!
//! `FANOTES_GPU_BLESS=1` rewrites the PNGs. Without a GPU adapter the
//! vello_hybrid half is skipped unless `FANOTES_GPU_REQUIRE=1`.

use std::path::PathBuf;
use std::sync::Arc;

use fanotes_gpu::fixtures::{art, glyph, special, Rng};
use fanotes_gpu::{
    Brush, Camera, CpuRenderer, Effect, InkPoint, InkStroke, PageImage, PageScene, PaperStyle,
    ReferenceRenderer, Renderer, RgbaImage, Symbol,
};
use fanotes_raster::parse_svg_path;

const W: u32 = 320;
const H: u32 = 200;

fn pt(x: f64, y: f64, pressure: f64) -> InkPoint {
    InkPoint { x, y, pressure }
}

fn wave(x0: f64, y0: f64, length: f64, amplitude: f64, samples: usize) -> Vec<InkPoint> {
    (0..samples)
        .map(|i| {
            let t = i as f64 / (samples - 1) as f64;
            pt(
                x0 + t * length,
                y0 + (t * 9.0).sin() * amplitude,
                0.2 + 0.7 * (t * std::f64::consts::PI).sin(),
            )
        })
        .collect()
}

fn zigzag(x0: f64, y0: f64) -> Vec<InkPoint> {
    let mut points = Vec::new();
    for i in 0..=24 {
        let t = i as f64 / 24.0;
        let leg = (t * 4.0).floor() as i32;
        let local = t * 4.0 - leg as f64;
        let y = if leg % 2 == 0 { local } else { 1.0 - local };
        points.push(pt(x0 + t * 240.0, y0 + y * 70.0, 0.6));
    }
    points
}

fn handwriting_line(seed: u64, y: f64) -> Vec<InkStroke> {
    let mut rng = Rng::new(seed);
    (0..18)
        .map(|i| {
            InkStroke::pen(
                glyph(&mut rng, 24.0 + i as f64 * 15.0, y, 12.0, 14),
                2.5,
                0x1a1a1a,
            )
        })
        .collect()
}

struct Fixture {
    name: &'static str,
    scene: PageScene,
    camera: Camera,
    /// Looser bound for effects the vello path approximates (the neon glow).
    approximate: bool,
    /// Allowed ink-mass difference. Spray particles are ~1 px dots: tiny-skia's
    /// 4×4 supersampling covers a 1 px dot ~9% short of its area, vello within 1%.
    /// Millimeter paper is a faint pattern over every pixel, where 1–2 levels of
    /// u8 compositing rounding add up.
    ink_tolerance: f64,
}

fn scene(paper: PaperStyle, strokes: Vec<InkStroke>) -> PageScene {
    let mut scene = PageScene::new(900.0, 1273.0);
    scene.paper = paper;
    scene.smoothing = 0.5;
    for stroke in strokes {
        scene.add_stroke(stroke);
    }
    scene
}

fn fixture(name: &'static str, paper: PaperStyle, strokes: Vec<InkStroke>) -> Fixture {
    Fixture {
        name,
        scene: scene(paper, strokes),
        camera: Camera::new(W, H),
        approximate: false,
        ink_tolerance: match name {
            "spray" => 0.15,
            "ruling_millimeter" => 0.10,
            _ => 0.05,
        },
    }
}

fn fixtures() -> Vec<Fixture> {
    let mut out = Vec::new();
    let mut constant = InkStroke::pen(wave(30.0, 150.0, 250.0, 10.0, 40), 3.5, 0x1f4fbf);
    constant.pressure_enabled = false;
    out.push(fixture(
        "pen",
        PaperStyle::Blank,
        vec![
            InkStroke::pen(wave(30.0, 50.0, 260.0, 25.0, 60), 3.5, 0x202333),
            InkStroke::pen(vec![pt(60.0, 110.0, 0.5)], 6.0, 0xc0392b),
            InkStroke::pen(zigzag(40.0, 80.0), 2.0, 0x202333),
            constant,
        ],
    ));
    for (name, brush, width) in [
        ("pencil", Brush::Pencil, 6.0),
        ("marker", Brush::Marker, 10.0),
        ("paintbrush", Brush::Paintbrush, 9.0),
        ("calligraphy", Brush::Calligraphy, 9.0),
        ("watercolor", Brush::Watercolor, 14.0),
        ("spray", Brush::Spray, 18.0),
    ] {
        out.push(fixture(
            name,
            PaperStyle::Blank,
            vec![
                art(wave(30.0, 60.0, 260.0, 30.0, 50), brush, width, 0x3a7bd5),
                art(zigzag(40.0, 100.0), brush, width * 0.7, 0xd35400),
            ],
        ));
    }
    let mut strokes = handwriting_line(3, 60.0);
    let mut flat = art(
        vec![
            pt(20.0, 64.0, 0.5),
            pt(150.0, 66.0, 0.5),
            pt(300.0, 62.0, 0.5),
        ],
        Brush::Highlighter,
        18.0,
        0xffd400,
    );
    flat.pressure_enabled = false;
    strokes.push(flat);
    strokes.push(art(zigzag(30.0, 100.0), Brush::Highlighter, 16.0, 0x2ecc71));
    out.push(fixture("highlighter", PaperStyle::Lines, strokes));
    let mut translucent = art(
        wave(30.0, 70.0, 260.0, 30.0, 50),
        Brush::Fineliner,
        8.0,
        0x8e44ad,
    );
    translucent.opacity = Some(0.45);
    let mut crossing = art(zigzag(40.0, 60.0), Brush::Fineliner, 8.0, 0x8e44ad);
    crossing.opacity = Some(0.45);
    out.push(fixture(
        "translucent",
        PaperStyle::Blank,
        vec![translucent, crossing],
    ));
    out.push(fixture(
        "rainbow",
        PaperStyle::Blank,
        vec![
            special(wave(30.0, 60.0, 260.0, 30.0, 50), Effect::Rainbow, 8.0),
            special(zigzag(40.0, 100.0), Effect::Gold, 6.0),
        ],
    ));
    let symbol = Arc::new(Symbol {
        paths: ["M4 12h16", "M12 4v16", "M5 5L19 19"]
            .iter()
            .filter_map(|d| parse_svg_path(d))
            .collect(),
    });
    let mut stamp = InkStroke::pen(vec![pt(80.0, 100.0, 0.5)], 48.0, 0x202333);
    stamp.symbol = Some(symbol.clone());
    let mut turned = InkStroke::pen(vec![pt(200.0, 100.0, 0.5)], 64.0, 0xc0392b);
    turned.symbol = Some(symbol);
    turned.symbol_rotation = 30.0;
    out.push(fixture("symbol", PaperStyle::Blank, vec![stamp, turned]));

    for (name, paper) in [
        ("ruling_lines", PaperStyle::Lines),
        ("ruling_squares", PaperStyle::Squares(20.0)),
        ("ruling_grid", PaperStyle::Grid(28.0)),
        ("ruling_dots", PaperStyle::Dots),
        ("ruling_millimeter", PaperStyle::Millimeter),
    ] {
        let mut f = fixture(name, paper, handwriting_line(7, 120.0));
        f.camera.origin_x = 13.0;
        f.camera.origin_y = 37.0;
        out.push(f);
    }

    // Camera: zoom between buckets with a fractional scroll, ruling and ink together.
    let mut zoomed = fixture("camera_zoom", PaperStyle::Lines, handwriting_line(11, 60.0));
    zoomed
        .scene
        .add_stroke(art(zigzag(30.0, 20.0), Brush::Highlighter, 14.0, 0xffd400));
    zoomed.camera.zoom = 1.75;
    zoomed.camera.scroll_x = 37.5;
    zoomed.camera.scroll_y = 41.25;
    zoomed.camera.origin_y = 6.0;
    out.push(zoomed);

    // HiDPI: dpr 2 at zoom 1 uses the 2× density bucket, pixel aligned.
    let mut hidpi = fixture("hidpi", PaperStyle::Dots, handwriting_line(5, 40.0));
    hidpi.camera.dpr = 2.0;
    out.push(hidpi);

    // The wet stroke over committed ink.
    let mut live = fixture("live", PaperStyle::Lines, handwriting_line(13, 60.0));
    let style = art(Vec::new(), Brush::Highlighter, 16.0, 0xff7a00);
    live.scene.begin_live(&style, 1.0);
    for point in wave(20.0, 64.0, 280.0, 6.0, 70) {
        live.scene.push_live(point);
    }
    out.push(live);
    let mut wet_pen = fixture("live_pen", PaperStyle::Blank, Vec::new());
    wet_pen
        .scene
        .begin_live(&InkStroke::pen(Vec::new(), 3.5, 0x202333), 1.0);
    for point in wave(30.0, 90.0, 260.0, 40.0, 80) {
        wet_pen.scene.push_live(point);
    }
    out.push(wet_pen);

    // A page texture (what a PDF page raster becomes) under ink.
    let mut image = RgbaImage::new(64, 40);
    for y in 0..40 {
        for x in 0..64 {
            let i = ((y * 64 + x) * 4) as usize;
            let shade = if (x / 8 + y / 8) % 2 == 0 { 230 } else { 160 };
            image.data[i..i + 4].copy_from_slice(&[shade, shade, 255, 255]);
        }
    }
    let mut page = fixture("page_image", PaperStyle::Blank, handwriting_line(17, 100.0));
    page.scene.set_images(vec![PageImage {
        id: 1,
        rect: kurbo::Rect::new(40.0, 30.0, 296.0, 190.0),
        image: Arc::new(image),
    }]);
    out.push(page);

    let mut neon = fixture(
        "neon",
        PaperStyle::Blank,
        vec![
            special(wave(30.0, 60.0, 260.0, 30.0, 50), Effect::Neon, 6.0),
            special(zigzag(40.0, 100.0), Effect::Neon, 4.0),
        ],
    );
    neon.approximate = true;
    out.push(neon);
    out
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens")
}

fn write_png(path: &PathBuf, image: &RgbaImage) {
    let file = std::fs::File::create(path).expect("png file");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), image.width, image.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::High);
    encoder
        .write_header()
        .expect("png header")
        .write_image_data(&image.data)
        .expect("png data");
}

fn read_png(path: &PathBuf) -> RgbaImage {
    let decoder = png::Decoder::new(std::io::BufReader::new(
        std::fs::File::open(path).unwrap_or_else(|_| {
            panic!(
                "missing golden {} (run with FANOTES_GPU_BLESS=1)",
                path.display()
            )
        }),
    ));
    let mut reader = decoder.read_info().expect("png info");
    let mut data = vec![0; reader.output_buffer_size().expect("png size")];
    let info = reader.next_frame(&mut data).expect("png frame");
    data.truncate(info.buffer_size());
    assert_eq!(info.color_type, png::ColorType::Rgba);
    RgbaImage {
        width: info.width,
        height: info.height,
        data,
    }
}

/// Mean |Δ| over white, share of pixels off by more than 48, inked-pixel balance.
fn assert_close(label: &str, golden: &RgbaImage, frame: &RgbaImage, fixture: &Fixture) {
    if let Ok(dir) = std::env::var("FANOTES_GPU_DUMP") {
        write_png(
            &PathBuf::from(dir).join(format!("{}.png", label.replace(' ', "_"))),
            frame,
        );
    }
    let diff = golden.diff(frame);
    let (ink_golden, ink_frame) = diff.ink;
    let balance = (ink_frame - ink_golden).abs() / ink_golden.max(1.0);
    eprintln!(
        "{label:40} mean {:6.3} max {:5.1} >48 {:6.3}% ink {ink_golden:.0}/{ink_frame:.0} ({:+.1}%)",
        diff.mean,
        diff.max,
        diff.over_48 * 100.0,
        (ink_frame - ink_golden) / ink_golden.max(1.0) * 100.0
    );
    let (mean, over, ink) = if fixture.approximate {
        (4.0, 0.06, 0.25)
    } else {
        (1.2, 0.012, fixture.ink_tolerance)
    };
    assert!(
        diff.mean <= mean,
        "{label}: mean diff {} > {mean}",
        diff.mean
    );
    assert!(
        diff.over_48 <= over,
        "{label}: {}% of pixels off by >48",
        diff.over_48 * 100.0
    );
    assert!(
        balance <= ink,
        "{label}: ink mass {ink_frame:.0} vs golden {ink_golden:.0}"
    );
}

fn render(renderer: &mut dyn Renderer, fixture: &Fixture) -> RgbaImage {
    renderer.clear_cache();
    renderer
        .render(&fixture.scene, &fixture.camera)
        .expect("render");
    renderer.read_rgba().expect("read back")
}

fn goldens() -> Vec<(Fixture, RgbaImage)> {
    let bless = std::env::var("FANOTES_GPU_BLESS").is_ok_and(|value| value == "1");
    let dir = golden_dir();
    std::fs::create_dir_all(&dir).expect("golden dir");
    let mut reference = ReferenceRenderer::new();
    fixtures()
        .into_iter()
        .map(|fixture| {
            let frame = render(&mut reference, &fixture);
            let path = dir.join(format!("{}.png", fixture.name));
            if bless {
                write_png(&path, &frame);
            }
            let golden = read_png(&path);
            let diff = golden.diff(&frame);
            assert!(
                diff.max <= 2.0,
                "{}: the tiny-skia reference drifted from its golden (max {})",
                fixture.name,
                diff.max
            );
            (fixture, golden)
        })
        .collect()
}

#[test]
fn vello_cpu_matches_the_reference_exact_and_tiled() {
    let mut multi = CpuRenderer::new(None);
    let mut single = CpuRenderer::new(Some(0));
    for (fixture, golden) in goldens() {
        // Neon glow is a filter, which vello_cpu only runs single-threaded.
        let renderer: &mut dyn Renderer = if fixture.name == "neon" {
            &mut single
        } else {
            &mut multi
        };
        renderer.set_tiling(false);
        let exact = render(renderer, &fixture);
        assert_close(
            &format!("vello_cpu exact {}", fixture.name),
            &golden,
            &exact,
            &fixture,
        );
        renderer.set_tiling(true);
        let tiled = render(renderer, &fixture);
        assert_close(
            &format!("vello_cpu tiled {}", fixture.name),
            &golden,
            &tiled,
            &fixture,
        );
    }
}

#[cfg(feature = "gpu")]
#[test]
fn vello_hybrid_matches_the_reference_exact_and_tiled() {
    let mut gpu = match fanotes_gpu::HybridRenderer::headless() {
        Ok(gpu) => gpu,
        Err(error) => {
            assert!(
                std::env::var("FANOTES_GPU_REQUIRE").is_err(),
                "FANOTES_GPU_REQUIRE is set but no GPU: {error}"
            );
            eprintln!("skipping vello_hybrid goldens: {error}");
            return;
        }
    };
    eprintln!("vello_hybrid on {}", gpu.adapter_name());
    for (fixture, golden) in goldens() {
        gpu.set_tiling(false);
        let exact = render(&mut gpu, &fixture);
        assert_close(
            &format!("vello_hybrid exact {}", fixture.name),
            &golden,
            &exact,
            &fixture,
        );
        gpu.set_tiling(true);
        let tiled = render(&mut gpu, &fixture);
        assert_close(
            &format!("vello_hybrid tiled {}", fixture.name),
            &golden,
            &tiled,
            &fixture,
        );
    }
}

#[test]
fn goldens_are_small() {
    for (fixture, _) in goldens() {
        let bytes = std::fs::metadata(golden_dir().join(format!("{}.png", fixture.name)))
            .expect("golden")
            .len();
        assert!(
            bytes < 64 * 1024,
            "{} golden is {bytes} bytes",
            fixture.name
        );
    }
}
