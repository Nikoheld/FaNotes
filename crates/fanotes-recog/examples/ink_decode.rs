//! Batch decoder for recognizer evaluation and decoder tuning.
//!
//! ```text
//! cargo run --release -p fanotes-recog --example ink_decode -- \
//!     logits.f32 index.json [--lm de.fnlm] [--words words.txt] [--lm-weight 0.55] ...
//! ```
//! `index.json` is `{"alphabet": "...", "lines": [{"offset": 0, "frames": 120}, ...]}` with
//! offsets in floats into `logits.f32`. Prints one JSON object per line.

use std::collections::HashSet;
use std::env;
use std::fs;

use fanotes_recog::{beam_decode, BeamOptions, CharLm, Lexicon};

struct Words(HashSet<String>);

impl Lexicon for Words {
    fn contains(&self, word: &str) -> bool {
        self.0.contains(word)
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let logits_bytes = fs::read(&args[1]).expect("logits");
    let logits: Vec<f32> = logits_bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    let index: serde_json::Value =
        serde_json::from_slice(&fs::read(&args[2]).expect("index")).expect("json");
    let alphabet: Vec<char> = index["alphabet"]
        .as_str()
        .expect("alphabet")
        .chars()
        .collect();
    let mut options = BeamOptions::default();
    let mut lm = None;
    let mut words = Words(HashSet::new());
    let mut position = 3;
    while position + 1 < args.len() {
        let value = &args[position + 1];
        match args[position].as_str() {
            "--lm" => lm = Some(CharLm::parse(&fs::read(value).expect("lm")).expect("lm format")),
            "--words" => {
                for file in value.split(',') {
                    let text = fs::read_to_string(file).expect("words");
                    words.0.extend(
                        text.lines()
                            .map(|line| line.trim().to_lowercase())
                            .filter(|w| !w.is_empty()),
                    );
                }
            }
            "--lm-weight" => options.lm_weight = value.parse().unwrap(),
            "--word-bonus" => options.word_bonus = value.parse().unwrap(),
            "--unknown-word-penalty" => options.unknown_word_penalty = value.parse().unwrap(),
            "--insertion-bonus" => options.insertion_bonus = value.parse().unwrap(),
            "--beam-width" => options.beam_width = value.parse().unwrap(),
            other => panic!("unknown option {other}"),
        }
        position += 2;
    }
    let classes = alphabet.len() + 1;
    for line in index["lines"].as_array().expect("lines") {
        let offset = line["offset"].as_u64().unwrap() as usize;
        let frames = line["frames"].as_u64().unwrap() as usize;
        let slice = &logits[offset..offset + frames * classes];
        let decoded = beam_decode(
            slice,
            classes,
            &alphabet,
            lm.as_ref(),
            &words,
            None,
            &options,
        )
        .expect("decode");
        println!("{}", serde_json::to_string(&decoded).unwrap());
    }
}
