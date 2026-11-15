//! A [`Measurer`] from the bundled TTF fonts (`fanotes/public/writing/fonts`),
//! shaped with rustybuzz (HarfBuzz port, default features, kerning on, like
//! canvas `measureText` with `fontKerning = 'normal'`).
//!
//! How close it gets to Chromium's canvas widths is checked by
//! `tests/fonts.rs` against `tests/fixtures/canvas-widths.json`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

use super::measure::{font_file, FontMetrics, FontSpec, Measurer};
use crate::model::types::FontFamily;

/// Chromium (Skia/FreeType on Linux) shapes at the font size floored to 1/64 px
/// (26.6 fixed point); widths scale with that size, not the requested one.
fn quantized(size: f64) -> f64 {
    (size * 64.0).floor() / 64.0
}

/// Face (family, bold, italic) and text.
type WidthKey = (FontFamily, bool, bool, String);

struct Face {
    face: rustybuzz::Face<'static>,
    units_per_em: f64,
    ascender: f64,
    descender: f64,
}

/// Text widths from the font files. Faces that are missing measure 0.5 em per character.
pub struct FontMeasurer {
    faces: HashMap<(FontFamily, bool, bool), Face>,
    widths: RefCell<HashMap<WidthKey, f64>>,
}

impl FontMeasurer {
    /// Loads the 16 faces from a directory. The font bytes live as long as the
    /// process (they are loaded once per app).
    pub fn from_dir(dir: &Path) -> std::io::Result<FontMeasurer> {
        let mut faces = HashMap::new();
        for &family in FontFamily::ALL {
            for (bold, italic) in [(false, false), (false, true), (true, false), (true, true)] {
                let bytes: &'static [u8] = Box::leak(
                    std::fs::read(dir.join(font_file(family, bold, italic)))?.into_boxed_slice(),
                );
                let Some(face) = rustybuzz::Face::from_slice(bytes, 0) else {
                    continue;
                };
                let units_per_em = face.units_per_em() as f64;
                let (ascender, descender) = (face.ascender() as f64, face.descender() as f64);
                faces.insert(
                    (family, bold, italic),
                    Face {
                        face,
                        units_per_em,
                        ascender,
                        descender,
                    },
                );
            }
        }
        Ok(FontMeasurer {
            faces,
            widths: RefCell::new(HashMap::new()),
        })
    }

    fn face(&self, font: &FontSpec) -> Option<&Face> {
        self.faces.get(&(font.family, font.bold, font.italic))
    }

    /// The shaped advance in font units.
    fn advance(face: &Face, text: &str) -> f64 {
        let mut buffer = rustybuzz::UnicodeBuffer::new();
        buffer.push_str(text);
        buffer.guess_segment_properties();
        let glyphs = rustybuzz::shape(&face.face, &[], buffer);
        glyphs
            .glyph_positions()
            .iter()
            .map(|position| position.x_advance as f64)
            .sum()
    }
}

impl Measurer for FontMeasurer {
    fn width(&self, text: &str, font: &FontSpec) -> f64 {
        if text.is_empty() {
            return 0.0;
        }
        let Some(face) = self.face(font) else {
            return text.chars().count() as f64 * font.size * 0.5;
        };
        // Widths scale linearly with the size: cache per face and text in font units.
        let key = (font.family, font.bold, font.italic, text.to_string());
        let units = self.widths.borrow().get(&key).copied();
        let units = units.unwrap_or_else(|| {
            let units = Self::advance(face, text);
            let mut cache = self.widths.borrow_mut();
            if cache.len() > 200_000 {
                cache.clear();
            }
            cache.insert(key, units);
            units
        });
        units * quantized(font.size) / face.units_per_em
    }

    fn metrics(&self, font: &FontSpec) -> FontMetrics {
        match self.face(font) {
            Some(face) => FontMetrics {
                ascent: face.ascender * font.size / face.units_per_em,
                descent: -face.descender * font.size / face.units_per_em,
            },
            None => FontMetrics {
                ascent: font.size * 0.8,
                descent: font.size * 0.25,
            },
        }
    }
}
