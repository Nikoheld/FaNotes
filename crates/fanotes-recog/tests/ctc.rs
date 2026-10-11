use std::collections::HashSet;
use std::fs;

use fanotes_recog::{decode_ctc, line_tensor, Language, LineBounds, LineOptions, LineStroke};
use serde_json::Value;

#[test]
fn the_decoder_matches_the_typescript_decoder() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/ctc-golden.json")).unwrap();
    let default_characters: Vec<String> = fixture["characters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    for case in fixture["cases"].as_array().unwrap() {
        let characters = case["characters"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().unwrap().to_owned())
                    .collect()
            })
            .unwrap_or_else(|| default_characters.clone());
        let probabilities: Vec<f32> = case["probabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_f64().unwrap() as f32)
            .collect();
        let words: HashSet<String> = case["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect();
        let language = Language::parse(case["language"].as_str().unwrap()).unwrap();
        let decoded = decode_ctc(
            &probabilities,
            case["steps"].as_u64().unwrap() as usize,
            characters.len() + 1,
            &characters,
            language,
            &words,
        )
        .unwrap();
        let expected = &case["decoded"];
        let name = case["name"].as_str().unwrap();
        assert_eq!(
            decoded.raw_text,
            expected["rawText"].as_str().unwrap(),
            "{name} raw"
        );
        assert_eq!(
            decoded.raw_beam_text,
            expected["rawBeamText"].as_str().unwrap(),
            "{name} beam"
        );
        assert_eq!(
            decoded.ctc_greedy_text,
            expected["ctcGreedyText"].as_str().unwrap(),
            "{name} ctc greedy"
        );
        assert_eq!(
            decoded.confidence,
            expected["confidence"].as_i64().unwrap() as i32,
            "{name} confidence"
        );
        let runs = expected["characters"].as_array().unwrap();
        assert_eq!(decoded.characters.len(), runs.len(), "{name} runs");
        for (actual, expected) in decoded.characters.iter().zip(runs) {
            assert_eq!(actual.char, expected["char"].as_str().unwrap(), "{name}");
            assert_eq!(
                actual.confidence,
                expected["confidence"].as_i64().unwrap() as i32,
                "{name}"
            );
            assert!(
                (actual.start - expected["start"].as_f64().unwrap()).abs() < 1e-12,
                "{name}"
            );
            assert!(
                (actual.end - expected["end"].as_f64().unwrap()).abs() < 1e-12,
                "{name}"
            );
        }
    }
}

#[test]
fn a_bad_tensor_is_refused() {
    let characters = vec!["a".to_owned()];
    assert!(decode_ctc(
        &[1.0, 0.0],
        1,
        3,
        &characters,
        Language::En,
        &HashSet::new()
    )
    .is_err());
}

#[test]
fn the_line_tensor_is_bright_ink_on_black_at_the_model_height() {
    let bounds = LineBounds {
        min_x: 10.0,
        min_y: 20.0,
        max_x: 210.0,
        max_y: 80.0,
    };
    let stroke = LineStroke {
        base_width: 4.0,
        points: vec![(0.05, 0.1), (0.2, 0.12), (0.35, 0.1)],
    };
    let tensor = line_tensor(bounds, &[stroke], 900.0, 560.0, LineOptions::default());
    assert_eq!(tensor.height, 128);
    assert!(tensor.width >= 32 && tensor.width <= 4096);
    assert_eq!(tensor.values.len(), tensor.width as usize * 128);
    assert!(
        tensor.values.iter().any(|value| *value > 0.5),
        "the stroke is ink"
    );
    assert!(
        tensor.values.iter().any(|value| *value < 0.05),
        "the margin stays dark"
    );
    let wider = line_tensor(
        bounds,
        &[LineStroke {
            base_width: 4.0,
            points: stroke_points(),
        }],
        900.0,
        560.0,
        LineOptions {
            margin_y_ratio: Some(0.40),
            margin_x_ratio: None,
            ink_scale: Some(0.92),
        },
    );
    assert_ne!(wider.width, tensor.width);
}

fn stroke_points() -> Vec<(f64, f64)> {
    vec![(0.05, 0.1), (0.2, 0.12), (0.35, 0.1)]
}

#[test]
fn the_fixture_file_is_the_captured_one() {
    assert!(
        fs::metadata(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/ctc-golden.json"
        ))
        .unwrap()
        .len()
            > 1000
    );
}
