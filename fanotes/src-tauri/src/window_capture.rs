//! The bug-report window image without a toolkit: PNG in, JPEG data URL out.
//!
//! WebView2 hands back a PNG. This applies the same size and quality budget
//! as Electron `encodeWindowCapture` (`electron/window-capture.cjs`) and the
//! WebKitGTK path in `capture.rs`: the longest edge at most 1280 px, JPEG
//! quality 55 down to 25, then smaller images until it fits 180 KiB.

use base64::Engine;

pub const MAX_CAPTURE_BYTES: usize = 180 * 1024;
pub const MAX_CAPTURE_EDGE: u32 = 1280;

const INVALID: &str = "Das Fensterbild ist ungültig.";
const EMPTY: &str = "Das Fensterbild ist leer.";
const TOO_LARGE: &str = "Das Fensterbild ist zu groß für den Fehlerbericht.";

/// Packed 8-bit RGB pixels, row by row.
#[derive(Clone, Debug)]
pub struct RgbImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

pub fn png_to_data_url(png: &[u8]) -> Result<String, String> {
    encode_capture(decode_png(png)?)
}

pub fn decode_png(bytes: &[u8]) -> Result<RgbImage, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|_| INVALID.to_owned())?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let frame = reader
        .next_frame(&mut buffer)
        .map_err(|_| INVALID.to_owned())?;
    let (width, height) = (frame.width, frame.height);
    if width < 1 || height < 1 {
        return Err(EMPTY.to_owned());
    }
    let channels = match frame.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err(INVALID.to_owned()),
    };
    let row = frame.line_size;
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
    for y in 0..height as usize {
        let line = &buffer[y * row..y * row + width as usize * channels];
        for pixel in line.chunks_exact(channels) {
            match channels {
                1 | 2 => pixels.extend_from_slice(&[pixel[0], pixel[0], pixel[0]]),
                // A JPEG has no alpha. Electron's `toJPEG` drops it too.
                _ => pixels.extend_from_slice(&pixel[..3]),
            }
        }
    }
    Ok(RgbImage {
        width,
        height,
        pixels,
    })
}

pub fn encode_capture(image: RgbImage) -> Result<String, String> {
    if image.width < 1
        || image.height < 1
        || image.pixels.len() != image.width as usize * image.height as usize * 3
    {
        return Err(EMPTY.to_owned());
    }
    let mut current = image;
    let longest = current.width.max(current.height);
    if longest > MAX_CAPTURE_EDGE {
        let scale = MAX_CAPTURE_EDGE as f64 / longest as f64;
        current = shrink(&current, scale);
    }
    let mut quality = 55u8;
    let mut jpeg = encode_jpeg(&current, quality)?;
    while jpeg.len() > MAX_CAPTURE_BYTES && quality > 25 {
        quality -= 10;
        jpeg = encode_jpeg(&current, quality)?;
    }
    let mut guard = 0;
    while jpeg.len() > MAX_CAPTURE_BYTES && guard < 6 {
        let next = (MAX_CAPTURE_BYTES as f64 / jpeg.len() as f64).sqrt() * 0.85;
        if !(next > 0.0 && next < 1.0) {
            break;
        }
        current = shrink(&current, next);
        jpeg = encode_jpeg(&current, quality.max(25))?;
        guard += 1;
    }
    if jpeg.is_empty() || jpeg.len() > MAX_CAPTURE_BYTES {
        return Err(TOO_LARGE.to_owned());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}

fn encode_jpeg(image: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let width = u16::try_from(image.width).map_err(|_| INVALID.to_owned())?;
    let height = u16::try_from(image.height).map_err(|_| INVALID.to_owned())?;
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(&image.pixels, width, height, jpeg_encoder::ColorType::Rgb)
        .map_err(|_| INVALID.to_owned())?;
    Ok(out)
}

/// Shrink by `scale` (0 < scale < 1) with an area average, like GDK's bilinear
/// scaling does when it reduces an image.
fn shrink(image: &RgbImage, scale: f64) -> RgbImage {
    let width = ((image.width as f64) * scale).round().max(1.0) as u32;
    let height = ((image.height as f64) * scale).round().max(1.0) as u32;
    let columns = axis_weights(image.width, width);
    let rows = axis_weights(image.height, height);
    // Columns first: every source row becomes `width` pixels.
    let mut narrow = vec![0f32; width as usize * image.height as usize * 3];
    for y in 0..image.height as usize {
        let source = &image.pixels[y * image.width as usize * 3..][..image.width as usize * 3];
        for (x, weights) in columns.iter().enumerate() {
            let mut sum = [0f32; 3];
            for &(index, weight) in weights {
                for channel in 0..3 {
                    sum[channel] += source[index * 3 + channel] as f32 * weight;
                }
            }
            narrow[(y * width as usize + x) * 3..][..3].copy_from_slice(&sum);
        }
    }
    let mut pixels = vec![0u8; width as usize * height as usize * 3];
    for (y, weights) in rows.iter().enumerate() {
        for x in 0..width as usize {
            let mut sum = [0f32; 3];
            for &(index, weight) in weights {
                for channel in 0..3 {
                    sum[channel] += narrow[(index * width as usize + x) * 3 + channel] * weight;
                }
            }
            for channel in 0..3 {
                pixels[(y * width as usize + x) * 3 + channel] =
                    sum[channel].round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    RgbImage {
        width,
        height,
        pixels,
    }
}

/// For each target pixel, the source pixels it covers and their share.
fn axis_weights(from: u32, to: u32) -> Vec<Vec<(usize, f32)>> {
    let span = from as f64 / to as f64;
    (0..to)
        .map(|target| {
            let start = target as f64 * span;
            let end = (start + span).min(from as f64);
            let mut weights = Vec::new();
            let mut index = start.floor() as usize;
            while (index as f64) < end && index < from as usize {
                let covered = ((index + 1) as f64).min(end) - (index as f64).max(start);
                if covered > 0.0 {
                    weights.push((index, (covered / (end - start)) as f32));
                }
                index += 1;
            }
            if weights.is_empty() {
                weights.push(((from as usize - 1).min(start as usize), 1.0));
            }
            weights
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32, color: png::ColorType, pixel: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(color);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let data: Vec<u8> = (0..width * height).flat_map(|_| pixel.to_vec()).collect();
            writer.write_image_data(&data).unwrap();
        }
        out
    }

    fn noise(width: u32, height: u32) -> RgbImage {
        let mut state = 0x2545_f491_u32;
        let pixels = (0..width * height * 3)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect();
        RgbImage {
            width,
            height,
            pixels,
        }
    }

    fn jpeg_size(data_url: &str) -> (usize, u16, u16) {
        let encoded = data_url.strip_prefix("data:image/jpeg;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert!(bytes.starts_with(&[0xff, 0xd8]), "not a JPEG");
        // Walk the markers to the frame header for the encoded size.
        let mut at = 2;
        loop {
            assert_eq!(bytes[at], 0xff);
            let marker = bytes[at + 1];
            let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
            if (0xc0..=0xc2).contains(&marker) {
                let height = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]);
                let width = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]);
                return (bytes.len(), width, height);
            }
            at += 2 + length;
        }
    }

    #[test]
    fn a_window_png_becomes_a_small_jpeg_data_url() {
        let png = png_bytes(640, 480, png::ColorType::Rgba, &[0x12, 0x34, 0x56, 0xff]);
        let image = png_to_data_url(&png).unwrap();
        assert!(image.starts_with("data:image/jpeg;base64,/9j/"));
        let (bytes, width, height) = jpeg_size(&image);
        assert!(bytes < MAX_CAPTURE_BYTES);
        assert_eq!((width, height), (640, 480));
    }

    #[test]
    fn the_longest_edge_is_at_most_1280_pixels() {
        let png = png_bytes(2560, 1440, png::ColorType::Rgb, &[200, 200, 200]);
        let (_, width, height) = jpeg_size(&png_to_data_url(&png).unwrap());
        assert_eq!((width, height), (1280, 720));
        let gray = png_bytes(900, 3000, png::ColorType::Grayscale, &[90]);
        let (_, width, height) = jpeg_size(&png_to_data_url(&gray).unwrap());
        assert_eq!((width, height), (384, 1280));
    }

    #[test]
    fn a_busy_window_shrinks_until_it_fits_the_report() {
        let image = encode_capture(noise(1280, 960)).unwrap();
        let (bytes, width, height) = jpeg_size(&image);
        assert!(bytes <= MAX_CAPTURE_BYTES, "{bytes} bytes");
        assert!(width < 1280 && height < 960, "{width}x{height}");
        assert_eq!(
            (width as f64 / height as f64 * 100.0).round(),
            (1280.0f64 / 960.0 * 100.0).round(),
            "the aspect ratio changed"
        );
    }

    #[test]
    fn an_empty_or_broken_image_is_refused() {
        assert_eq!(
            encode_capture(RgbImage {
                width: 0,
                height: 0,
                pixels: Vec::new()
            })
            .unwrap_err(),
            EMPTY
        );
        assert_eq!(png_to_data_url(b"not a png").unwrap_err(), INVALID);
    }

    #[test]
    fn shrinking_averages_the_covered_pixels() {
        let image = RgbImage {
            width: 2,
            height: 1,
            pixels: vec![0, 0, 0, 255, 255, 255],
        };
        let half = shrink(&image, 0.5);
        assert_eq!((half.width, half.height), (1, 1));
        assert_eq!(half.pixels, vec![128, 128, 128]);
        for weights in axis_weights(1000, 333) {
            let total: f32 = weights.iter().map(|(_, weight)| weight).sum();
            assert!((total - 1.0).abs() < 1e-4, "weights sum to {total}");
        }
    }
}
