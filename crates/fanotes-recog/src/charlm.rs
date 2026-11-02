//! Character n-gram language model (`fanotes-charlm-v1`), built by
//! `fanotes/scripts/ink-model/build_charlm.py`.
//!
//! Interpolated Witten-Bell probabilities are stored per context length with 32-bit FNV-1a
//! context hashes. Symbols are the recognizer alphabet indexes (`1..=n`); `0` marks the start of
//! a line and is only ever context.

const MAGIC: &[u8; 4] = b"FNLM";
const COST_SCALE: f32 = 16.0;
const FNV_OFFSET: u32 = 0x811C_9DC5;
const FNV_PRIME: u32 = 0x0100_0193;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharLmError(pub &'static str);

impl std::fmt::Display for CharLmError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.0)
    }
}

#[derive(Debug, Clone, Default)]
struct Table {
    hashes: Vec<u32>,
    first: Vec<u32>,
    backoff: Vec<u8>,
    symbols: Vec<u8>,
    costs: Vec<u8>,
}

impl Table {
    fn context(&self, hash: u32) -> Option<usize> {
        self.hashes.binary_search(&hash).ok()
    }

    fn entry(&self, context: usize, symbol: u8) -> Option<u8> {
        let start = self.first[context] as usize;
        let end = self
            .first
            .get(context + 1)
            .map_or(self.symbols.len(), |&next| next as usize);
        self.symbols[start..end]
            .binary_search(&symbol)
            .ok()
            .map(|offset| self.costs[start + offset])
    }
}

#[derive(Debug, Clone)]
pub struct CharLm {
    order: usize,
    alphabet: Vec<char>,
    unigram: Vec<u8>,
    tables: Vec<Table>,
    /// Symbol → the symbol the model was trained on. A case-folded model leaves capitalization
    /// to the visual evidence, so `POLITICAL` scores like `political`.
    fold: Vec<u8>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], CharLmError> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|&end| end <= self.bytes.len())
            .ok_or(CharLmError("Das Sprachmodell ist unvollständig."))?;
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, CharLmError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, CharLmError> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> Result<u32, CharLmError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

pub fn context_hash(symbols: &[u8]) -> u32 {
    symbols.iter().fold(FNV_OFFSET, |hash, &symbol| {
        (hash ^ u32::from(symbol)).wrapping_mul(FNV_PRIME)
    })
}

impl CharLm {
    pub fn parse(bytes: &[u8]) -> Result<Self, CharLmError> {
        let mut reader = Reader { bytes, offset: 0 };
        if reader.take(4)? != MAGIC {
            return Err(CharLmError("Unbekanntes Sprachmodell."));
        }
        if reader.u16()? != 1 {
            return Err(CharLmError("Nicht unterstützte Sprachmodellversion."));
        }
        let order = usize::from(reader.u8()?);
        let flags = reader.u8()?;
        let alphabet_bytes = reader.u32()? as usize;
        let alphabet: Vec<char> = std::str::from_utf8(reader.take(alphabet_bytes)?)
            .map_err(|_| CharLmError("Das Sprachmodell-Alphabet ist ungültig."))?
            .chars()
            .collect();
        if !(2..=8).contains(&order) || alphabet.is_empty() || alphabet.len() > 254 {
            return Err(CharLmError("Das Sprachmodell ist ungültig."));
        }
        let unigram = reader.take(alphabet.len() + 1)?.to_vec();
        let mut tables = Vec::with_capacity(order - 1);
        for _ in 1..order {
            let contexts = reader.u32()? as usize;
            let entries = reader.u32()? as usize;
            let mut table = Table {
                hashes: Vec::with_capacity(contexts),
                first: Vec::with_capacity(contexts),
                backoff: Vec::with_capacity(contexts),
                symbols: Vec::with_capacity(entries),
                costs: Vec::with_capacity(entries),
            };
            let raw = reader.take(
                contexts
                    .checked_mul(9)
                    .ok_or(CharLmError("Das Sprachmodell ist ungültig."))?,
            )?;
            for record in raw.as_chunks::<9>().0 {
                table.hashes.push(u32::from_le_bytes([
                    record[0], record[1], record[2], record[3],
                ]));
                table.first.push(u32::from_le_bytes([
                    record[4], record[5], record[6], record[7],
                ]));
                table.backoff.push(record[8]);
            }
            let raw = reader.take(
                entries
                    .checked_mul(2)
                    .ok_or(CharLmError("Das Sprachmodell ist ungültig."))?,
            )?;
            for entry in raw.as_chunks::<2>().0 {
                table.symbols.push(entry[0]);
                table.costs.push(entry[1]);
            }
            let sorted = table.hashes.windows(2).all(|pair| pair[0] < pair[1]);
            let ordered = table.first.windows(2).all(|pair| pair[0] <= pair[1])
                && table
                    .first
                    .last()
                    .is_none_or(|&last| last as usize <= entries);
            if !sorted || !ordered {
                return Err(CharLmError("Das Sprachmodell ist beschädigt."));
            }
            tables.push(table);
        }
        if reader.offset != bytes.len() {
            return Err(CharLmError("Das Sprachmodell hat unerwartete Zusatzdaten."));
        }
        let mut fold: Vec<u8> = (0..=alphabet.len() as u8).collect();
        if flags & 1 != 0 {
            for (index, character) in alphabet.iter().enumerate() {
                let mut lower = character.to_lowercase();
                if let (Some(single), None) = (lower.next(), lower.next()) {
                    if let Some(target) = alphabet.iter().position(|&candidate| candidate == single)
                    {
                        fold[index + 1] = (target + 1) as u8;
                    }
                }
            }
        }
        Ok(Self {
            order,
            alphabet,
            unigram,
            tables,
            fold,
        })
    }

    pub fn order(&self) -> usize {
        self.order
    }

    pub fn alphabet(&self) -> &[char] {
        &self.alphabet
    }

    /// `-ln P(symbol | history)`; `history` runs oldest to newest and may begin with `0`.
    pub fn cost(&self, history: &[u8], symbol: u8) -> f32 {
        if symbol == 0 || usize::from(symbol) >= self.unigram.len() {
            return 12.0;
        }
        let symbol = self.fold[usize::from(symbol)];
        let longest = history.len().min(self.order - 1);
        let folded: Vec<u8> = history[history.len() - longest..]
            .iter()
            .map(|&value| self.fold.get(usize::from(value)).copied().unwrap_or(value))
            .collect();
        let mut backoff = 0u32;
        for length in (1..=longest).rev() {
            let context = &folded[folded.len() - length..];
            let table = &self.tables[length - 1];
            if let Some(index) = table.context(context_hash(context)) {
                if let Some(cost) = table.entry(index, symbol) {
                    return (backoff + u32::from(cost)) as f32 / COST_SCALE;
                }
                backoff += u32::from(table.backoff[index]);
            }
        }
        (backoff + u32::from(self.unigram[usize::from(symbol)])) as f32 / COST_SCALE
    }
}
