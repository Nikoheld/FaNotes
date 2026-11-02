//! CTC beam decoding, alignment and personal classifier adaptation.

use std::collections::HashSet;

use fanotes_recog::{
    adapt_head, beam_decode, ctc_loss_and_gradient, AdaptOptions, AdaptSample, BeamOptions, Lexicon,
};

const ALPHABET: [char; 5] = ['a', 'b', 'c', 'n', ' '];

struct Words(HashSet<&'static str>);

impl Lexicon for Words {
    fn contains(&self, word: &str) -> bool {
        self.0.contains(word)
    }
}

/// Logits that put `strength` on the given class per frame (`0` blank).
fn logits(path: &[usize], strength: f32) -> Vec<f32> {
    let classes = ALPHABET.len() + 1;
    let mut out = vec![0f32; path.len() * classes];
    for (frame, &class) in path.iter().enumerate() {
        out[frame * classes + class] = strength;
    }
    out
}

#[test]
fn clear_path_decodes_with_spans() {
    // b a n (blank) a n a
    let path = [0, 2, 2, 0, 1, 0, 4, 4, 0, 1, 0, 4, 0, 1, 1, 0];
    let decoded = beam_decode(
        &logits(&path, 9.0),
        ALPHABET.len() + 1,
        &ALPHABET,
        None,
        &(),
        None,
        &BeamOptions::default(),
    )
    .unwrap();
    assert_eq!(decoded.text, "banana");
    assert_eq!(decoded.greedy_text, "banana");
    assert_eq!(decoded.characters.len(), 6);
    assert_eq!(decoded.characters[0].start_frame, 1);
    assert_eq!(decoded.characters[0].end_frame, 3);
    assert!(decoded.characters.iter().all(|c| c.confidence > 0.9));
    assert_eq!(decoded.readings[0].text, "banana");
}

#[test]
fn lexicon_breaks_a_visual_tie_towards_a_known_word() {
    let classes = ALPHABET.len() + 1;
    // "c?b": the middle frame is torn between `a` and `n`, with `n` slightly ahead.
    let mut values = logits(&[0, 3, 0, 4, 0, 2, 0], 8.0);
    values[3 * classes + 1] = 7.6;
    values[3 * classes + 4] = 7.8;
    let words = Words(["cab"].into_iter().collect());
    let plain = beam_decode(
        &values,
        classes,
        &ALPHABET,
        None,
        &(),
        None,
        &BeamOptions::default(),
    )
    .unwrap();
    assert_eq!(plain.text, "cnb");
    let guided = beam_decode(
        &values,
        classes,
        &ALPHABET,
        None,
        &words,
        None,
        &BeamOptions::default(),
    )
    .unwrap();
    assert_eq!(guided.text, "cab");
    assert!(guided.readings.iter().any(|reading| reading.text == "cnb"));
    let middle = &guided.characters[1];
    assert_eq!(middle.char, "a");
    assert!(middle
        .alternatives
        .iter()
        .any(|alternative| alternative.char == "n"));
}

#[test]
fn ctc_gradient_matches_finite_differences() {
    let classes = 4;
    let frames = 6;
    let labels = [1u32, 2, 2];
    let mut values: Vec<f32> = (0..frames * classes)
        .map(|i| ((i * 37 % 11) as f32 - 5.0) * 0.3)
        .collect();
    let (loss, gradient) = ctc_loss_and_gradient(&values, classes, &labels).unwrap();
    assert!(loss.is_finite() && loss > 0.0);
    for index in [0, 3, 5, 9, 14, 22] {
        let original = values[index];
        values[index] = original + 1e-3;
        let (up, _) = ctc_loss_and_gradient(&values, classes, &labels).unwrap();
        values[index] = original - 1e-3;
        let (down, _) = ctc_loss_and_gradient(&values, classes, &labels).unwrap();
        values[index] = original;
        let numeric = (up - down) / 2e-3;
        assert!(
            (numeric - f64::from(gradient[index])).abs() < 2e-3,
            "{index}: {numeric} vs {}",
            gradient[index]
        );
    }
    // A line shorter than its labels has no valid alignment.
    assert!(ctc_loss_and_gradient(&values[..classes * 2], classes, &labels).is_none());
}

#[test]
fn adaptation_learns_a_writer_specific_shape() {
    // Feature 0 marks this writer's `a`, which the shipped classifier reads as `b`.
    let classes = 3;
    let dim = 4;
    let weight = vec![
        0.0, 0.0, 0.0, 2.0, // blank listens to feature 3
        0.0, 0.0, 0.0, 0.0, // a
        3.0, 0.0, 0.0, 0.0, // b
    ];
    let bias = vec![0.0; classes];
    let frame = |kind: usize| -> [f32; 4] {
        let mut h = [0.0; 4];
        h[kind] = 1.0;
        h
    };
    let mut features = Vec::new();
    for kind in [3, 0, 3, 0, 3] {
        features.extend_from_slice(&frame(kind));
    }
    let labels = vec![1u32, 1];
    let samples: Vec<AdaptSample<'_>> = (0..4)
        .map(|_| AdaptSample {
            features: &features,
            labels: &labels,
        })
        .collect();
    let update = adapt_head(
        &samples,
        &weight,
        &bias,
        classes,
        dim,
        &AdaptOptions {
            iterations: 150,
            ..AdaptOptions::default()
        },
    )
    .unwrap();
    assert!(
        update.loss_after < update.loss_before * 0.5,
        "{} -> {}",
        update.loss_before,
        update.loss_after
    );
    let mut logits = vec![0f32; 5 * classes];
    for (index, h) in features.chunks(dim).enumerate() {
        for class in 0..classes {
            logits[index * classes + class] = (0..dim)
                .map(|d| weight[class * dim + d] * h[d])
                .sum::<f32>();
        }
    }
    update.apply(&features, &mut logits);
    let second_frame = &logits[classes..2 * classes];
    assert!(second_frame[1] > second_frame[2], "{second_frame:?}");
}
