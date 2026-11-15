//! How far the Rust font measurer's widths are from Chromium's canvas
//! `measureText` on the same bundled fonts (`canvas-widths.json`, written by
//! `node scripts/gen-story-fixtures.mjs --chromium`). Prints the numbers.
#![cfg(feature = "fonts")]

use std::path::Path;

use fanotes_story::json::{self, JsValue};
use fanotes_story::layout::fonts::FontMeasurer;
use fanotes_story::model::types::FontFamily;
use fanotes_story::{FontSpec, Measurer};

#[test]
fn font_widths_against_chromium_canvas() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let data = json::parse(
        &std::fs::read_to_string(root.join("tests/fixtures/canvas-widths.json")).unwrap(),
    )
    .unwrap();
    let measurer = FontMeasurer::from_dir(&root.join("../../fanotes/public/writing/fonts"))
        .expect("bundled fonts");
    let mut relative: Vec<f64> = Vec::new();
    let mut absolute: Vec<f64> = Vec::new();
    let mut exact = 0;
    let mut worst = (0.0, String::new());
    let mut ratios: Vec<(String, f64, f64)> = Vec::new();
    let mut per_family: Vec<(FontFamily, f64, usize)> = FontFamily::ALL
        .iter()
        .map(|&family| (family, 0.0, 0))
        .collect();
    for entry in data.get("widths").unwrap().as_array().unwrap() {
        let e = entry.as_array().unwrap();
        let font = FontSpec {
            family: FontFamily::from_js(Some(&e[0])).unwrap(),
            bold: e[1].is_true(),
            italic: e[2].is_true(),
            size: e[3].as_f64().unwrap(),
        };
        let text = e[4].as_str().unwrap();
        let canvas = e[5].as_f64().unwrap();
        let rust = measurer.width(text, &font);
        let difference = (rust - canvas).abs();
        if difference < 1e-9 {
            exact += 1;
        }
        absolute.push(difference);
        if canvas > 0.0 {
            relative.push(difference / canvas);
        }
        if difference > worst.0 {
            worst = (
                difference,
                format!(
                    "{:?} {} {}px {text:?}: rust {rust} canvas {canvas}",
                    font.family,
                    if font.bold { "bold" } else { "" },
                    font.size
                ),
            );
        }
        if canvas > 1.0 {
            let ratio = canvas / rust;
            let key = format!(
                "{:?}{}{} {:.2}",
                font.family,
                if font.bold { "B" } else { "" },
                if font.italic { "I" } else { "" },
                font.size
            );
            match ratios.iter_mut().find(|(k, _, _)| *k == key) {
                Some(slot) => {
                    slot.1 = slot.1.min(ratio);
                    slot.2 = slot.2.max(ratio);
                }
                None => ratios.push((key, ratio, ratio)),
            }
        }
        let slot = per_family
            .iter_mut()
            .find(|(family, _, _)| *family == font.family)
            .unwrap();
        slot.1 = slot.1.max(difference);
        slot.2 += 1;
    }
    let sorted = |list: &mut Vec<f64>| list.sort_by(|a, b| a.partial_cmp(b).unwrap());
    sorted(&mut relative);
    sorted(&mut absolute);
    let pick = |list: &Vec<f64>, q: f64| list[((list.len() - 1) as f64 * q) as usize];
    println!(
        "FONTS {} samples ({}), exact {exact}",
        absolute.len(),
        data.get("chromium")
            .and_then(JsValue::as_str)
            .unwrap_or("?")
    );
    println!("FONTS abs px: median {:.4} p95 {:.4} max {:.4}; relative: median {:.5}% p95 {:.4}% max {:.4}%", pick(&absolute, 0.5), pick(&absolute, 0.95), pick(&absolute, 1.0), pick(&relative, 0.5) * 100.0, pick(&relative, 0.95) * 100.0, pick(&relative, 1.0) * 100.0);
    for (family, max, count) in &per_family {
        println!("FONTS {family:?}: {count} samples, max abs {max:.4} px");
    }
    for (key, low, high) in ratios
        .iter()
        .filter(|(k, _, _)| k.starts_with("Courier ") || k.starts_with("Literata "))
    {
        println!("FONTS ratio canvas/rust {key}: {low:.6} … {high:.6}");
    }
    println!("FONTS worst: {}", worst.1);
    let mut metric_max: f64 = 0.0;
    for entry in data.get("metrics").unwrap().as_array().unwrap() {
        let e = entry.as_array().unwrap();
        let font = FontSpec {
            family: FontFamily::from_js(Some(&e[0])).unwrap(),
            bold: e[1].is_true(),
            italic: e[2].is_true(),
            size: e[3].as_f64().unwrap(),
        };
        let metrics = measurer.metrics(&font);
        metric_max = metric_max
            .max((metrics.ascent - e[4].as_f64().unwrap()).abs())
            .max((metrics.descent - e[5].as_f64().unwrap()).abs());
    }
    println!("FONTS ascent/descent max abs difference {metric_max:.4} px");
    // A broken font load would be off by tens of percent.
    assert!(
        pick(&relative, 0.5) < 0.01,
        "median relative difference {}",
        pick(&relative, 0.5)
    );
}
