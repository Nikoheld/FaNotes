//! The model image must match the Python reference that renders the training data.

use fanotes_recog::{group_ink_lines, ink_image, InkOptions, INK_HEIGHT};

fn decode_base64(text: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (index, &byte) in alphabet.iter().enumerate() {
        lookup[byte as usize] = index as u8;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        buffer = (buffer << 6) | u32::from(lookup[byte as usize]);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

fn strokes_of(value: &serde_json::Value) -> Vec<Vec<(f64, f64)>> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|stroke| {
            stroke
                .as_array()
                .unwrap()
                .iter()
                .map(|point| (point[0].as_f64().unwrap(), point[1].as_f64().unwrap()))
                .collect()
        })
        .collect()
}

#[test]
fn ink_image_matches_python_reference() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ink-golden.json")).unwrap();
    assert_eq!(fixture["spec"], "fanotes-ink-line-v1");
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let strokes = strokes_of(&case["strokes"]);
        let options = InkOptions {
            ref_height: case["refHeight"].as_f64().unwrap(),
            ..InkOptions::default()
        };
        let image = ink_image(&strokes, &options).expect(name);
        assert_eq!(
            image.width,
            case["width"].as_u64().unwrap() as u32,
            "{name} width"
        );
        assert_eq!(image.height, INK_HEIGHT, "{name} height");
        let expected = decode_base64(case["ink"].as_str().unwrap());
        assert_eq!(expected.len(), image.values.len(), "{name} size");
        let mut worst = 0i32;
        for (value, &reference) in image.values.iter().zip(&expected) {
            let ours = ((1.0 - value) * 255.0).round() as i32;
            worst = worst.max((ours - i32::from(reference)).abs());
        }
        assert!(worst <= 1, "{name}: pixel difference {worst}");
    }
}

#[test]
fn empty_and_non_finite_strokes_render_nothing() {
    assert!(ink_image(&[], &InkOptions::default()).is_none());
    assert!(ink_image(&[vec![]], &InkOptions::default()).is_none());
    assert!(ink_image(&[vec![(f64::NAN, 1.0)]], &InkOptions::default()).is_none());
}

fn word(left: f64, top: f64, width: f64, height: f64) -> Vec<Vec<(f64, f64)>> {
    let steps = 24;
    let main = (0..=steps)
        .map(|step| {
            let t = step as f64 / steps as f64;
            (
                left + t * width,
                top + height * (0.5 + 0.45 * (t * 18.0).sin()),
            )
        })
        .collect();
    let dot = vec![(left + width * 0.4, top - height * 0.35)];
    vec![main, dot]
}

#[test]
fn line_grouping_keeps_rows_and_dots_together() {
    let mut strokes = Vec::new();
    let mut truth = Vec::new();
    for row in 0..4 {
        let top = 80.0 + row as f64 * 48.0;
        for column in 0..3 {
            // A gentle downward drift across the row, as on unruled paper.
            let left = 60.0 + column as f64 * 120.0;
            for stroke in word(left, top + column as f64 * 3.5, 90.0, 22.0) {
                strokes.push(stroke);
                truth.push(row);
            }
        }
    }
    let lines = group_ink_lines(&strokes);
    assert_eq!(lines.len(), 4, "{lines:?}");
    for (row, line) in lines.iter().enumerate() {
        assert!(
            line.strokes.iter().all(|&index| truth[index] == row),
            "row {row}: {:?}",
            line.strokes
        );
        assert_eq!(line.strokes.len(), 6);
    }
}

#[test]
fn far_apart_blocks_on_one_row_are_separate_segments() {
    let mut strokes = word(40.0, 100.0, 80.0, 20.0);
    strokes.extend(word(700.0, 100.0, 80.0, 20.0));
    let lines = group_ink_lines(&strokes);
    assert_eq!(lines.len(), 2);
    assert!(lines[0].min_x < lines[1].min_x);
}
