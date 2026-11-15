//! PDFium against a committed reference raster.
//!
//! `tests/fixtures/worksheet-2x.png` is this fixture page painted by the pinned
//! PDFium build (chromium/8066) at 2× and checked by eye against pdf.js.
//! It guards the native path against a PDFium bump, a byte-order or crop
//! mistake, or a wrong scale: those move far more than the tolerance below.
//! Re-bless only on purpose: `FANOTES_PDF_BLESS=1 cargo test -p fanotes-pdf --test reference_raster`.

mod common;

use std::path::PathBuf;

use fanotes_pdf::{render_pdf_page, RenderRequest};

const WIDTH: u32 = 600;
const HEIGHT: u32 = 400;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/worksheet-2x.png")
}

fn request() -> RenderRequest {
    RenderRequest {
        page_index: 0,
        pixel_width: WIDTH as i32,
        pixel_height: HEIGHT as i32,
        page_pixel_width: WIDTH as i32,
        page_pixel_height: HEIGHT as i32,
        origin_x: 0,
        origin_y: 0,
        rotation: 0,
        password: String::new(),
    }
}

fn read_png(path: &PathBuf) -> Vec<u8> {
    let decoder = png::Decoder::new(std::fs::File::open(path).expect("reference raster"));
    let mut reader = decoder.read_info().unwrap();
    let mut rgba = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut rgba).unwrap();
    assert_eq!((info.width, info.height), (WIDTH, HEIGHT));
    assert_eq!(info.color_type, png::ColorType::Rgba);
    rgba.truncate(info.buffer_size());
    rgba
}

fn write_png(path: &PathBuf, rgba: &[u8]) {
    let file = std::fs::File::create(path).unwrap();
    let mut encoder = png::Encoder::new(file, WIDTH, HEIGHT);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Best);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(rgba)
        .unwrap();
}

#[test]
fn a_worksheet_page_matches_the_reference_raster() {
    let pdf = common::pdf_with_pages(300, 200, &[common::worksheet_stream(1)]);
    let bitmap = render_pdf_page(&pdf, &request()).expect("render the fixture");
    assert_eq!((bitmap.width, bitmap.height), (WIDTH, HEIGHT));
    if std::env::var_os("FANOTES_PDF_BLESS").is_some() {
        write_png(&fixture(), &bitmap.rgba);
        return;
    }
    let reference = read_png(&fixture());
    let pixels = (WIDTH * HEIGHT) as usize;
    let mut sum = 0u64;
    let mut far = 0usize;
    let mut ink = 0usize;
    for (got, want) in bitmap.rgba.chunks_exact(4).zip(reference.chunks_exact(4)) {
        let diff = (0..3).map(|c| got[c].abs_diff(want[c])).max().unwrap();
        sum += (0..3)
            .map(|c| u64::from(got[c].abs_diff(want[c])))
            .sum::<u64>();
        if diff > 48 {
            far += 1;
        }
        if want[0] < 128 && want[1] < 128 {
            ink += 1;
        }
        assert_eq!(got[3], 255, "the window is opaque");
    }
    let mean = sum as f64 / (pixels * 3) as f64;
    // Text, rules, and the circle: a blank or misplaced page has far less.
    assert!(
        ink > 4_000,
        "the reference shows the page content ({ink} ink pixels)"
    );
    assert!(mean < 1.0, "mean channel difference {mean:.3} ≥ 1.0");
    assert!(
        (far as f64) < pixels as f64 * 0.002,
        "{far} pixels differ by more than 48 levels"
    );
}

#[test]
fn a_window_of_the_reference_is_the_same_crop() {
    let pdf = common::pdf_with_pages(300, 200, &[common::worksheet_stream(1)]);
    let reference = read_png(&fixture());
    let mut job = request();
    job.pixel_width = 160;
    job.pixel_height = 120;
    job.origin_x = 360;
    job.origin_y = 120;
    let window = render_pdf_page(&pdf, &job).expect("render a tile");
    let mut sum = 0u64;
    for row in 0..120u32 {
        for column in 0..160u32 {
            let from = (((120 + row) * WIDTH + 360 + column) * 4) as usize;
            let to = ((row * 160 + column) * 4) as usize;
            for channel in 0..3 {
                sum += u64::from(window.rgba[to + channel].abs_diff(reference[from + channel]));
            }
        }
    }
    let mean = sum as f64 / (160.0 * 120.0 * 3.0);
    assert!(
        mean < 1.0,
        "tile at 360,120 drifts from the page: mean {mean:.3}"
    );
}
