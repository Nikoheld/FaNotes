//! Frames and page textures as plain RGBA8.

use std::sync::Arc;

use kurbo::Rect;

/// Straight (not premultiplied) RGBA8, row-major.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl RgbaImage {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0; width as usize * height as usize * 4],
        }
    }

    pub fn from_premultiplied(width: u32, height: u32, mut data: Vec<u8>) -> Self {
        for pixel in data.as_chunks_mut::<4>().0 {
            let a = pixel[3] as u32;
            if a != 0 && a != 255 {
                for channel in &mut pixel[..3] {
                    *channel = ((*channel as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
            if a == 0 {
                pixel[..3].fill(0);
            }
        }
        Self {
            width,
            height,
            data,
        }
    }

    /// Premultiplied copy, what GPU textures and vello images expect.
    pub fn to_premultiplied(&self) -> Vec<u8> {
        let mut out = self.data.clone();
        for pixel in out.as_chunks_mut::<4>().0 {
            let a = pixel[3] as u32;
            if a != 255 {
                for channel in &mut pixel[..3] {
                    *channel = ((*channel as u32 * a + 127) / 255) as u8;
                }
            }
        }
        out
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let index = (y as usize * self.width as usize + x as usize) * 4;
        [
            self.data[index],
            self.data[index + 1],
            self.data[index + 2],
            self.data[index + 3],
        ]
    }

    /// Pixel difference to `other` (same size), composited over white so
    /// colour noise under zero alpha does not count.
    pub fn diff(&self, other: &RgbaImage) -> ImageDiff {
        assert_eq!(
            (self.width, self.height),
            (other.width, other.height),
            "image sizes differ"
        );
        let over_white = |pixel: &[u8]| -> [f64; 3] {
            let a = pixel[3] as f64 / 255.0;
            [
                pixel[0] as f64 * a + 255.0 * (1.0 - a),
                pixel[1] as f64 * a + 255.0 * (1.0 - a),
                pixel[2] as f64 * a + 255.0 * (1.0 - a),
            ]
        };
        let mut max: f64 = 0.0;
        let mut sum = 0.0;
        let mut over = 0usize;
        let mut ink_left = 0.0;
        let mut ink_right = 0.0;
        for (left, right) in self
            .data
            .as_chunks::<4>()
            .0
            .iter()
            .zip(other.data.as_chunks::<4>().0)
        {
            let a = over_white(left);
            let b = over_white(right);
            let d = (0..3).map(|i| (a[i] - b[i]).abs()).fold(0.0, f64::max);
            max = max.max(d);
            sum += d;
            if d > 48.0 {
                over += 1;
            }
            let dark = |c: [f64; 3]| 255.0 - c.iter().copied().fold(255.0, f64::min);
            ink_left += dark(a);
            ink_right += dark(b);
        }
        let pixels = (self.width as usize * self.height as usize).max(1);
        ImageDiff {
            max,
            mean: sum / pixels as f64,
            over_48: over as f64 / pixels as f64,
            ink: (ink_left / 255.0, ink_right / 255.0),
        }
    }
}

/// How far two frames are apart, over white, in 0–255 channel units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageDiff {
    pub max: f64,
    pub mean: f64,
    /// Share of pixels whose worst channel differs by more than 48.
    pub over_48: f64,
    /// Ink mass of each image: the darkest channel's distance from white, summed, in pixels.
    pub ink: (f64, f64),
}

/// A bitmap placed on the paper, e.g. a PDF page raster.
///
/// `id` names the content: a backend uploads a texture once per id and keeps
/// it while the id stays in the scene.
#[derive(Clone, Debug)]
pub struct PageImage {
    pub id: u64,
    /// Where the bitmap lands, in page px.
    pub rect: Rect,
    pub image: Arc<RgbaImage>,
}
