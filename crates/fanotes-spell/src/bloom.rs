//! The compact Bloom filter of `spelling.ts` (`fanotes-spelling-bloom-v2`).

use crate::text::{normalize_word, Language};

pub const BLOOM_HASHES: u32 = 8;

pub struct Bloom {
    bytes: Vec<u8>,
    bit_count: u64,
    hashes: u32,
}

fn hash_word(word: &str, seed: u32) -> u32 {
    let mut hash = seed;
    for unit in word.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

impl Bloom {
    pub fn new(bytes: Vec<u8>, bit_count: u64, hashes: u32) -> Result<Self, &'static str> {
        if hashes != BLOOM_HASHES {
            return Err("Unbekanntes Rechtschreibformat.");
        }
        if bytes.len() as u64 * 8 != bit_count || bit_count == 0 {
            return Err("Die lokalen Rechtschreibdaten besitzen eine ungültige Länge.");
        }
        Ok(Self {
            bytes,
            bit_count,
            hashes,
        })
    }

    pub fn has(&self, raw_word: &str, language: Language) -> bool {
        let word = normalize_word(raw_word, language);
        if word.is_empty() {
            return false;
        }
        let first = hash_word(&word, 0x811c_9dc5);
        let second = hash_word(&word, 0x9e37_79b1) | 1;
        for index in 0..self.hashes {
            let bit = u64::from(first.wrapping_add(index.wrapping_mul(second))) % self.bit_count;
            let byte = self.bytes.get((bit >> 3) as usize).copied().unwrap_or(0);
            if byte & (1 << (bit & 7)) == 0 {
                return false;
            }
        }
        true
    }
}
