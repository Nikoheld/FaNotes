//! Text measurement for the layout (`layout/measure.ts`). Layout units are CSS
//! pixels at 96 dpi and zoom 1.

use crate::json::{JsValue, ObjectBuilder, ToJs};
use crate::model::types::{FontFamily, StoryLanguage};

pub const MM: f64 = 96.0 / 25.4;
pub const PT: f64 = 96.0 / 72.0;

pub fn mm_to_px(mm: f64) -> f64 {
    mm * MM
}

pub fn pt_to_px(pt: f64) -> f64 {
    pt * PT
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontSpec {
    pub family: FontFamily,
    pub bold: bool,
    pub italic: bool,
    /// CSS pixels.
    pub size: f64,
}

impl ToJs for FontSpec {
    fn to_js(&self) -> JsValue {
        ObjectBuilder::new()
            .set("family", self.family)
            .set("bold", self.bold)
            .set("italic", self.italic)
            .set("size", self.size)
            .build()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontMetrics {
    pub ascent: f64,
    pub descent: f64,
}

/// `TextMeasurer`.
pub trait Measurer {
    fn width(&self, text: &str, font: &FontSpec) -> f64;
    /// Ascent and descent in CSS pixels for the font at its size.
    fn metrics(&self, font: &FontSpec) -> FontMetrics;
}

/// `FixedMeasurer`: every character is 0.5 em (1 em for `m w M W @`, 0.3 em for a space).
#[derive(Clone, Copy, Debug, Default)]
pub struct FixedMeasurer;

impl Measurer for FixedMeasurer {
    fn width(&self, text: &str, font: &FontSpec) -> f64 {
        let mut units = 0.0;
        for c in text.chars() {
            units += match c {
                'm' | 'w' | 'M' | 'W' | '@' => 1.0,
                ' ' => 0.3,
                _ => 0.5,
            };
        }
        units * font.size * if font.bold { 1.05 } else { 1.0 }
    }

    fn metrics(&self, font: &FontSpec) -> FontMetrics {
        FontMetrics {
            ascent: font.size * 0.8,
            descent: font.size * 0.2,
        }
    }
}

/// The bundled font files (`FONT_FILES`).
pub fn font_file(family: FontFamily, bold: bool, italic: bool) -> &'static str {
    let files: [&str; 4] = match family {
        FontFamily::Literata => [
            "Literata-Regular.ttf",
            "Literata-Italic.ttf",
            "Literata-Bold.ttf",
            "Literata-BoldItalic.ttf",
        ],
        FontFamily::Garamond => [
            "EBGaramond-Regular.ttf",
            "EBGaramond-Italic.ttf",
            "EBGaramond-Bold.ttf",
            "EBGaramond-BoldItalic.ttf",
        ],
        FontFamily::Courier => [
            "CourierPrime-Regular.ttf",
            "CourierPrime-Italic.ttf",
            "CourierPrime-Bold.ttf",
            "CourierPrime-BoldItalic.ttf",
        ],
        FontFamily::Atkinson => [
            "AtkinsonHyperlegible-Regular.ttf",
            "AtkinsonHyperlegible-Italic.ttf",
            "AtkinsonHyperlegible-Bold.ttf",
            "AtkinsonHyperlegible-BoldItalic.ttf",
        ],
    };
    files[match (bold, italic) {
        (false, false) => 0,
        (false, true) => 1,
        (true, false) => 2,
        (true, true) => 3,
    }]
}

/// The hyphenation pattern set a language uses (`hyphenModule`).
pub fn hyphen_language(language: StoryLanguage) -> &'static str {
    match language {
        StoryLanguage::EnUs => "en-us",
        StoryLanguage::EnGb => "en-gb",
        StoryLanguage::De | StoryLanguage::DeCh => "de",
    }
}
