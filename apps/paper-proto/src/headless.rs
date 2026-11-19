//! `--headless-frames N`: a scripted pen session rendered offscreen.
//!
//! Each frame feeds one pen sample (strokes of 48 samples, written left to
//! right in lines), pans a little every 16 frames and zooms every 64, then
//! renders through the page engine exactly like a window frame would.

use std::io::BufWriter;
use std::time::Instant;

use fanotes_gpu::{CpuRenderer, HybridRenderer, Renderer, RgbaImage};

use crate::session::Session;
use crate::{new_scene, Mode, Options};

pub struct Report {
    pub frames: usize,
    pub strokes: usize,
    pub ink_pixels: usize,
}

const SAMPLES_PER_STROKE: usize = 48;

pub fn run(mut session: Session, frames: usize, options: &Options) -> Result<Report, String> {
    let (width, height) = options.size;
    let mut renderer: Box<dyn Renderer> = match options.mode {
        Mode::Gpu => match HybridRenderer::headless() {
            Ok(gpu) => {
                eprintln!("headless: vello_hybrid on {}", gpu.adapter_name());
                Box::new(gpu)
            }
            Err(error) => {
                eprintln!("headless: no GPU ({error}); using vello_cpu");
                Box::new(CpuRenderer::new(None))
            }
        },
        Mode::Cpu | Mode::Softbuffer => Box::new(CpuRenderer::new(None)),
    };
    let mut scene = new_scene(&session);
    let mut times = Vec::with_capacity(frames);
    for frame in 0..frames {
        let stroke = frame / SAMPLES_PER_STROKE;
        let step = frame % SAMPLES_PER_STROKE;
        let row = (stroke / 6) as f64;
        let column = (stroke % 6) as f64;
        let t = step as f64 / (SAMPLES_PER_STROKE - 1) as f64;
        let screen = (
            60.0 + column * 150.0 + t * 120.0,
            80.0 + row * 60.0 + (t * 9.0).sin() * 14.0,
        );
        let (x, y) = session.screen_to_page(screen.0, screen.1);
        match step {
            0 => session.pen_down_page(x, y),
            s if s == SAMPLES_PER_STROKE - 1 => {
                session.pen_move_page(x, y);
                session.pen_up();
            }
            _ => session.pen_move_page(x, y),
        }
        if frame % 16 == 15 {
            session.pan_screen(0.0, -3.0);
        }
        if frame % 64 == 63 {
            session.zoom_at(width as f64 / 2.0, height as f64 / 2.0, 1.1);
        }
        let camera = session.camera(width, height);
        let start = Instant::now();
        scene.sync_ink(session.doc(), camera.device_scale());
        renderer
            .render(&scene, &camera)
            .map_err(|error| error.to_string())?;
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let last = renderer.read_rgba().map_err(|error| error.to_string())?;
    let ink_pixels = last
        .data
        .as_chunks::<4>()
        .0
        .iter()
        .filter(|pixel| pixel[0] < 128 && pixel[1] < 128 && pixel[2] < 128)
        .count();
    let mut sorted = times.clone();
    sorted.sort_by(f64::total_cmp);
    let mean = times.iter().sum::<f64>() / times.len().max(1) as f64;
    let p95 = sorted
        .get(((sorted.len() as f64 * 0.95).ceil() as usize).saturating_sub(1))
        .copied()
        .unwrap_or(0.0);
    let memory = renderer.memory();
    println!(
        "{} frames on {}: mean {mean:.2} ms, p95 {p95:.2} ms, max {:.2} ms; {} strokes; {} tiles ({:.1} MiB)",
        times.len(),
        renderer.kind().name(),
        sorted.last().copied().unwrap_or(0.0),
        scene.stroke_count(),
        memory.tiles,
        memory.tile_bytes as f64 / (1024.0 * 1024.0)
    );
    if let Some(path) = &options.out {
        write_png(path, &last).map_err(|error| format!("{}: {error}", path.display()))?;
        println!("wrote {}", path.display());
    }
    Ok(Report {
        frames: times.len(),
        strokes: scene.stroke_count(),
        ink_pixels,
    })
}

fn write_png(path: &std::path::Path, image: &RgbaImage) -> Result<(), Box<dyn std::error::Error>> {
    let file = std::fs::File::create(path)?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), image.width, image.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(&image.data)?;
    Ok(())
}
