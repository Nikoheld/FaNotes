//! Ids (`model/ids.ts`): 14 random base-36 characters for projects, scenes,
//! paragraphs and notes. Randomness comes from an [`IdSource`], so tests and
//! the parity fixtures can use a seeded sequence.

const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// Fills byte buffers like `crypto.getRandomValues`.
pub trait IdSource {
    fn fill(&mut self, bytes: &mut [u8]);
}

/// `newId(length)`: one random byte per character, `byte % 36`.
pub fn new_id(source: &mut dyn IdSource, length: usize) -> String {
    let mut bytes = vec![0u8; length];
    source.fill(&mut bytes);
    bytes
        .iter()
        .map(|byte| ALPHABET[(*byte % 36) as usize] as char)
        .collect()
}

/// `isId`: `/^[0-9a-z]{6,40}$/`.
pub fn is_id(value: &str) -> bool {
    (6..=40).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
}

/// The operating system's random generator.
#[cfg(feature = "os-random")]
#[derive(Clone, Copy, Debug, Default)]
pub struct OsIds;

#[cfg(feature = "os-random")]
impl IdSource for OsIds {
    fn fill(&mut self, bytes: &mut [u8]) {
        if getrandom::getrandom(bytes).is_err() {
            // No OS randomness (never expected on desktop): fall back to a hashed clock.
            let mut fallback = SeededIds::new(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u32)
                    .unwrap_or(1),
            );
            fallback.fill(bytes);
        }
    }
}

/// A deterministic byte sequence, the same one the fixture generator puts in
/// place of `crypto.getRandomValues`: a 31-bit linear congruential generator
/// (`state = (state * 1103515245 + 12345) mod 2^31`, byte = `state >> 16 & 255`).
#[derive(Clone, Debug)]
pub struct SeededIds {
    state: u32,
}

impl SeededIds {
    pub fn new(seed: u32) -> SeededIds {
        SeededIds {
            state: seed & 0x7fff_ffff,
        }
    }
}

impl IdSource for SeededIds {
    fn fill(&mut self, bytes: &mut [u8]) {
        for byte in bytes {
            self.state = ((self.state as u64 * 1_103_515_245 + 12_345) % 2_147_483_648) as u32;
            *byte = ((self.state >> 16) & 255) as u8;
        }
    }
}

impl<F: FnMut(&mut [u8])> IdSource for F {
    fn fill(&mut self, bytes: &mut [u8]) {
        self(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(is_id("abc123"));
        assert!(!is_id("abc12"));
        assert!(!is_id("ABC123"));
        let mut source = SeededIds::new(1);
        let id = new_id(&mut source, 14);
        assert_eq!(id.len(), 14);
        assert!(is_id(&id));
    }
}
