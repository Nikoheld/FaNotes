//! In-memory inverted index: a port of `fanotes/src/lib/docSearch/docIndex.ts`.
//!
//! Ranking, candidate rules, duplicate folding and snippets follow the TS code
//! operation by operation, so scores are bit-identical (see `jsmath`) and the
//! order is the same. Where the TS order depends on JavaScript `Map`/`Set`
//! insertion order (float summation order, stable-sort ties), this index keeps
//! the same order: units get monotonically growing slots, postings are kept
//! in slot order, and vocabulary buckets remember when a token (re)appeared.
//!
//! Tie rule (identical in both engines): score descending, then title in
//! German collation (`localeCompare(…, 'de')`), then page ascending, then
//! insertion order of the candidate (postings order of the first expanded
//! token that hit the unit, i.e. the order units were added). A fresh build
//! adds documents in UTF-16 path order and a document's units in extraction
//! order; the parity harness builds the TS index the same way.

use std::cmp::Ordering;
use std::collections::HashMap as StdHashMap;
use std::hash::{BuildHasherDefault, Hasher};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::collate::german_compare;
use crate::jsmath::js_log;
use crate::text::{
    fold_plain_units, from_utf16, hash_text, ink_line_y, make_snippet, parse_doc_query,
    strip_transcript_positions, tokenize, utf16, Snippet,
};

pub const MAX_RESULTS: usize = 40;

/// FxHash: the index hashes short keys in hot loops; DoS resistance is not needed here.
#[derive(Default, Clone, Copy)]
pub struct FxHasher(u64);

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word))
                .wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    fn write_u16(&mut self, value: u16) {
        self.0 = (self.0.rotate_left(5) ^ value as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_u32(&mut self, value: u32) {
        self.0 = (self.0.rotate_left(5) ^ value as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_u64(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_usize(&mut self, value: usize) {
        self.write_u64(value as u64);
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

type Fx = BuildHasherDefault<FxHasher>;
type HashMap<K, V> = StdHashMap<K, V, Fx>;

const K1: f64 = 1.2;
const B: f64 = 0.75;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnitKind {
    Note,
    Ink,
    PdfPage,
    Worksheet,
    Annotations,
    Scene,
    Bible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnitSource {
    Text,
    TextLayer,
    Ocr,
    Transcript,
}

/// One searchable unit: a note chunk, a transcript chunk, a PDF page, a worksheet, a scene chunk.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexUnit {
    /// `${path}#${kind}:${n}`, unique per document.
    pub id: String,
    pub path: String,
    pub kind: UnitKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worksheet_id: Option<String>,
    /// Story scene the unit is (part of).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    pub source: UnitSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    pub text: String,
}

/// `SearchResult` of the TS index, field for field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub unit_id: String,
    pub kind: UnitKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worksheet_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    pub source: UnitSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    pub score: f64,
    pub matches: u32,
    pub snippet: Snippet,
    pub also_in: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ink_y: Option<f64>,
    pub title_only: bool,
}

/// A unit folded and counted, ready to insert. Built in parallel, inserted in order.
#[derive(Clone, Debug)]
pub struct PreparedUnit {
    pub unit: IndexUnit,
    /// Distinct tokens in order of first occurrence, with counts.
    tf: Vec<(Vec<u16>, u32)>,
    length: u32,
    text_key: (u32, u32),
}

impl PreparedUnit {
    pub fn new(unit: IndexUnit) -> Self {
        let folded = fold_plain_units(&utf16(&unit.text));
        let mut positions: HashMap<&[u16], usize> = HashMap::default();
        let mut tf: Vec<(Vec<u16>, u32)> = Vec::new();
        let mut length = 0u32;
        for token in tokenize(&folded) {
            length += 1;
            match positions.get(token) {
                Some(&at) => tf[at].1 += 1,
                None => {
                    positions.insert(token, tf.len());
                    tf.push((token.to_vec(), 1));
                }
            }
        }
        drop(positions);
        let text_key = hash_text(&folded);
        Self {
            unit,
            tf,
            length,
            text_key,
        }
    }
}

struct StoredUnit {
    unit: IndexUnit,
    length: u32,
    tf: Vec<(u32, u32)>,
    text_key: (u32, u32),
}

struct Token {
    text: Vec<u16>,
    /// `(slot, count)` in insertion order; slots of removed units are skipped.
    postings: Vec<(u32, u32)>,
    live: u32,
    /// When the token (re)entered its bucket: JavaScript `Set` order.
    seq: u64,
    bucket: u32,
}

struct Bucket {
    seq: u32,
    tokens: Vec<u32>,
}

struct DocEntry {
    title: String,
    title_tokens: Vec<Vec<u16>>,
}

/// The first two UTF-16 units of a token (`token.slice(0, 2)`).
fn bucket_key(token: &[u16]) -> u32 {
    ((token[0] as u32) << 16) | token.get(1).copied().unwrap_or(0) as u32
}

fn title_tokens(title: &str, path: &str) -> Vec<Vec<u16>> {
    // `path.replace(/[/._-]+/gu, ' ')`
    let mut spaced = String::with_capacity(path.len());
    let mut in_run = false;
    for c in path.chars() {
        if matches!(c, '/' | '.' | '_' | '-') {
            if !in_run {
                spaced.push(' ');
            }
            in_run = true;
        } else {
            spaced.push(c);
            in_run = false;
        }
    }
    let folded = fold_plain_units(&utf16(&format!("{title} {spaced}")));
    let mut out: Vec<Vec<u16>> = Vec::new();
    for token in tokenize(&folded) {
        if !out.iter().any(|known| known == token) {
            out.push(token.to_vec());
        }
    }
    out
}

fn source_weight(unit: &IndexUnit) -> f64 {
    match unit.source {
        UnitSource::Ocr => 0.55 + 0.45 * unit.confidence.unwrap_or(0.6),
        UnitSource::Transcript => 0.85,
        _ => 1.0,
    }
}

/// `Map<unitId, tf>` in insertion order, with a dense slot table.
struct Hits {
    order: Vec<(u32, f64)>,
    position: Vec<u32>,
}

impl Hits {
    fn new(slots: usize) -> Self {
        Self {
            order: Vec::new(),
            position: vec![u32::MAX; slots],
        }
    }

    fn add(&mut self, slot: u32, value: f64) {
        let at = self.position[slot as usize];
        if at == u32::MAX {
            self.position[slot as usize] = self.order.len() as u32;
            self.order.push((slot, value));
        } else {
            self.order[at as usize].1 += value;
        }
    }

    fn get(&self, slot: u32) -> Option<f64> {
        let at = self.position[slot as usize];
        (at != u32::MAX).then(|| self.order[at as usize].1)
    }

    fn has(&self, slot: u32) -> bool {
        self.position[slot as usize] != u32::MAX
    }
}

struct Scored<'a> {
    title: &'a str,
    page: i64,
    slot: u32,
    score: f64,
    matches: u32,
    title_only: bool,
    also_in: u32,
}

#[derive(Default)]
pub struct DocIndex {
    units: Vec<Option<StoredUnit>>,
    unit_slots: HashMap<String, u32>,
    live_units: usize,
    doc_units: HashMap<String, Vec<u32>>,
    docs: IndexMap<String, DocEntry>,
    tokens: Vec<Option<Token>>,
    free_tokens: Vec<u32>,
    token_ids: HashMap<Vec<u16>, u32>,
    buckets: HashMap<u32, Bucket>,
    next_bucket_seq: u32,
    next_token_seq: u64,
    total_length: u64,
}

impl DocIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn document_count(&self) -> usize {
        self.docs.len()
    }

    pub fn unit_count(&self) -> usize {
        self.live_units
    }

    pub fn vocabulary_size(&self) -> usize {
        self.token_ids.len()
    }

    pub fn has_doc(&self, path: &str) -> bool {
        self.docs.contains_key(path)
    }

    pub fn doc_paths(&self) -> impl Iterator<Item = &str> {
        self.docs.keys().map(String::as_str)
    }

    pub fn title_of(&self, path: &str) -> Option<&str> {
        self.docs.get(path).map(|doc| doc.title.as_str())
    }

    /// `setDoc`: a known path keeps its place in the document order.
    pub fn set_doc(&mut self, path: &str, title: &str) {
        let entry = DocEntry {
            title: title.to_owned(),
            title_tokens: title_tokens(title, path),
        };
        self.docs.insert(path.to_owned(), entry);
    }

    pub fn units_of(&self, path: &str) -> Vec<&IndexUnit> {
        self.doc_units
            .get(path)
            .map(|slots| {
                slots
                    .iter()
                    .filter_map(|&slot| {
                        self.units[slot as usize]
                            .as_ref()
                            .map(|stored| &stored.unit)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every unit in insertion order (the cache keeps this order).
    pub fn units_in_order(&self) -> impl Iterator<Item = &IndexUnit> {
        self.units
            .iter()
            .filter_map(|stored| stored.as_ref().map(|stored| &stored.unit))
    }

    /// Every document `(path, title)` in document order.
    pub fn docs_in_order(&self) -> impl Iterator<Item = (&str, &str)> {
        self.docs
            .iter()
            .map(|(path, doc)| (path.as_str(), doc.title.as_str()))
    }

    pub fn add_unit(&mut self, unit: IndexUnit) {
        self.add_prepared(PreparedUnit::new(unit));
    }

    pub fn add_prepared(&mut self, prepared: PreparedUnit) {
        if let Some(&slot) = self.unit_slots.get(&prepared.unit.id) {
            self.remove_slot(slot);
        }
        let slot = self.units.len() as u32;
        let mut tf = Vec::with_capacity(prepared.tf.len());
        for (text, count) in prepared.tf {
            let token = match self.token_ids.get(&text) {
                Some(&id) => id,
                None => self.new_token(text),
            };
            let entry = self.tokens[token as usize].as_mut().expect("live token");
            entry.postings.push((slot, count));
            entry.live += 1;
            tf.push((token, count));
        }
        self.unit_slots.insert(prepared.unit.id.clone(), slot);
        self.doc_units
            .entry(prepared.unit.path.clone())
            .or_default()
            .push(slot);
        self.total_length += prepared.length as u64;
        self.live_units += 1;
        self.units.push(Some(StoredUnit {
            unit: prepared.unit,
            length: prepared.length,
            tf,
            text_key: prepared.text_key,
        }));
    }

    fn new_token(&mut self, text: Vec<u16>) -> u32 {
        let key = bucket_key(&text);
        let next_bucket_seq = &mut self.next_bucket_seq;
        let bucket = self.buckets.entry(key).or_insert_with(|| {
            let seq = *next_bucket_seq;
            *next_bucket_seq += 1;
            Bucket {
                seq,
                tokens: Vec::new(),
            }
        });
        let seq = self.next_token_seq;
        self.next_token_seq += 1;
        let token = Token {
            text: text.clone(),
            postings: Vec::new(),
            live: 0,
            seq,
            bucket: key,
        };
        let id = match self.free_tokens.pop() {
            Some(id) => {
                self.tokens[id as usize] = Some(token);
                id
            }
            None => {
                self.tokens.push(Some(token));
                (self.tokens.len() - 1) as u32
            }
        };
        bucket.tokens.push(id);
        self.token_ids.insert(text, id);
        id
    }

    fn remove_slot(&mut self, slot: u32) {
        let Some(stored) = self.units[slot as usize].take() else {
            return;
        };
        for &(token, _) in &stored.tf {
            let entry = self.tokens[token as usize].as_mut().expect("live token");
            entry.live -= 1;
            if entry.live == 0 {
                let entry = self.tokens[token as usize].take().expect("live token");
                if let Some(bucket) = self.buckets.get_mut(&entry.bucket) {
                    bucket.tokens.retain(|&id| id != token);
                }
                self.token_ids.remove(&entry.text);
                self.free_tokens.push(token);
            } else if entry.postings.len() > 2 * entry.live as usize + 16 {
                let units = &self.units;
                entry
                    .postings
                    .retain(|&(posting, _)| units[posting as usize].is_some());
            }
        }
        self.total_length -= stored.length as u64;
        self.live_units -= 1;
        self.unit_slots.remove(&stored.unit.id);
        if let Some(slots) = self.doc_units.get_mut(&stored.unit.path) {
            slots.retain(|&known| known != slot);
        }
    }

    /// `removeDoc`: drops a document's units, and its record unless `keep_record`.
    pub fn remove_doc(&mut self, path: &str, keep_record: bool) {
        if let Some(slots) = self.doc_units.get(path).cloned() {
            for slot in slots {
                self.remove_slot(slot);
            }
        }
        self.doc_units.remove(path);
        if !keep_record {
            self.docs.shift_remove(path);
        }
        self.maybe_compact();
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// Renumbers slots once most of them are dead. Monotonic, so every order is kept.
    fn maybe_compact(&mut self) {
        let dead = self.units.len() - self.live_units;
        if dead < 4096 || dead < self.live_units {
            return;
        }
        let mut remap = vec![u32::MAX; self.units.len()];
        let mut units = Vec::with_capacity(self.live_units);
        for (old, stored) in std::mem::take(&mut self.units).into_iter().enumerate() {
            if let Some(stored) = stored {
                remap[old] = units.len() as u32;
                units.push(Some(stored));
            }
        }
        self.units = units;
        for token in self.tokens.iter_mut().flatten() {
            token
                .postings
                .retain(|&(slot, _)| remap[slot as usize] != u32::MAX);
            for posting in &mut token.postings {
                posting.0 = remap[posting.0 as usize];
            }
        }
        for slot in self.unit_slots.values_mut() {
            *slot = remap[*slot as usize];
        }
        for slots in self.doc_units.values_mut() {
            for slot in slots.iter_mut() {
                *slot = remap[*slot as usize];
            }
        }
    }

    /// `expand(term)`: tokens with `term` as prefix, in JavaScript bucket order, with weights.
    fn expand(&self, term: &[u16]) -> Vec<(u32, f64)> {
        let mut found: Vec<(u32, u64, u32)> = Vec::new();
        let mut collect = |bucket: &Bucket| {
            for &id in &bucket.tokens {
                let token = self.tokens[id as usize].as_ref().expect("live token");
                if token.text.starts_with(term) {
                    found.push((bucket.seq, token.seq, id));
                }
            }
        };
        if term.len() >= 2 {
            if let Some(bucket) = self.buckets.get(&bucket_key(term)) {
                collect(bucket);
            }
        } else {
            for (&key, bucket) in &self.buckets {
                if (key >> 16) as u16 == term[0] {
                    collect(bucket);
                }
            }
        }
        found.sort_unstable_by_key(|&(bucket, seq, _)| (bucket, seq));
        found
            .into_iter()
            .map(|(_, _, id)| {
                let weight = if self.tokens[id as usize].as_ref().expect("live token").text == term
                {
                    1.0
                } else {
                    0.6
                };
                (id, weight)
            })
            .collect()
    }

    fn stored(&self, slot: u32) -> &StoredUnit {
        self.units[slot as usize].as_ref().expect("live unit")
    }

    /// `search(raw, limit)`.
    pub fn search(&self, raw: &str, limit: usize) -> Vec<SearchResult> {
        let terms = parse_doc_query(raw);
        if terms.is_empty() || self.live_units == 0 {
            return Vec::new();
        }
        let unit_count = self.live_units as f64;
        let mut avg = self.total_length as f64 / (self.live_units.max(1) as f64);
        if avg == 0.0 || avg.is_nan() {
            avg = 1.0;
        }
        let mut per_term: Vec<Hits> = Vec::with_capacity(terms.len());
        let mut idf: Vec<f64> = Vec::with_capacity(terms.len());
        for term in &terms {
            let mut hits = Hits::new(self.units.len());
            for (token, weight) in self.expand(term) {
                let entry = self.tokens[token as usize].as_ref().expect("live token");
                for &(slot, count) in &entry.postings {
                    if self.units[slot as usize].is_some() {
                        hits.add(slot, count as f64 * weight);
                    }
                }
            }
            let size = hits.order.len() as f64;
            idf.push(js_log(1.0 + (unit_count - size + 0.5) / (size + 0.5)));
            per_term.push(hits);
        }
        let mut candidates: Vec<u32> = Vec::new();
        let mut seen = vec![false; self.units.len()];
        for hits in &per_term {
            for &(slot, _) in &hits.order {
                if !seen[slot as usize] {
                    seen[slot as usize] = true;
                    candidates.push(slot);
                }
            }
        }
        // `titleMatch(path, term)` for every document once per query.
        let title_hits: Vec<Vec<bool>> = terms
            .iter()
            .map(|term| {
                self.docs
                    .values()
                    .map(|doc| doc.title_tokens.iter().any(|token| token.starts_with(term)))
                    .collect()
            })
            .collect();
        let title_match = |doc: usize, term: usize| title_hits[term][doc];
        let title_only_docs: Vec<usize> = (0..self.docs.len())
            .filter(|&doc| (0..terms.len()).all(|term| title_match(doc, term)))
            .collect();

        let consider = |slot: u32, title_only: bool| -> Option<Scored> {
            let stored = self.stored(slot);
            let (doc, _, entry) = self.docs.get_full(&stored.unit.path)?;
            let mut score = 0.0f64;
            let mut matches = 0u32;
            for (index, term) in terms.iter().enumerate() {
                let tf = per_term[index].get(slot).unwrap_or(0.0);
                if tf > 0.0 {
                    score += idf[index] * (tf * (K1 + 1.0))
                        / (tf + K1 * (1.0 - B + B * stored.length as f64 / avg));
                    matches = matches.saturating_add(tf.round() as u32);
                }
                let _ = term;
                if title_match(doc, index) {
                    score += 0.8 * idf[index];
                }
            }
            score *= source_weight(&stored.unit);
            if title_only {
                score *= 0.5;
            }
            Some(Scored {
                title: entry.title.as_str(),
                page: stored.unit.page.unwrap_or(0) as i64,
                slot,
                score,
                matches: if title_only { 0 } else { matches },
                title_only,
                also_in: 0,
            })
        };

        let mut scored: Vec<Scored> = Vec::new();
        let mut scored_docs = vec![false; self.docs.len()];
        for &slot in &candidates {
            let stored = self.stored(slot);
            let Some(doc) = self.docs.get_index_of(&stored.unit.path) else {
                continue;
            };
            let text_all = per_term.iter().all(|hits| hits.has(slot));
            let with_title = text_all
                || per_term
                    .iter()
                    .enumerate()
                    .all(|(index, hits)| hits.has(slot) || title_match(doc, index));
            if !with_title {
                continue;
            }
            if let Some(result) = consider(slot, false) {
                scored_docs[doc] = true;
                scored.push(result);
            }
        }
        // Documents found only by their title: one result at their first unit.
        for doc in title_only_docs {
            if scored_docs[doc] {
                continue;
            }
            let path = self
                .docs
                .get_index(doc)
                .map(|(path, _)| path.as_str())
                .unwrap_or("");
            let mut slots: Vec<u32> = self.doc_units.get(path).cloned().unwrap_or_default();
            slots.sort_by_key(|&slot| self.stored(slot).unit.page.unwrap_or(0));
            if let Some(&first) = slots.first() {
                if let Some(result) = consider(first, true) {
                    scored_docs[doc] = true;
                    scored.push(result);
                }
            }
        }
        scored.sort_by(|left, right| {
            let difference = right.score - left.score;
            if difference != 0.0 {
                return if difference > 0.0 {
                    Ordering::Greater
                } else {
                    Ordering::Less
                };
            }
            german_compare(left.title, right.title).then_with(|| left.page.cmp(&right.page))
        });

        // Identical page text in several files shows once; pages inside one file stay separate.
        #[derive(PartialEq, Eq, Hash)]
        enum TextKey {
            Text(u32, u32),
            Unit(u32),
        }
        let mut by_text: HashMap<TextKey, usize> = HashMap::default();
        let mut out: Vec<Scored> = Vec::new();
        for result in scored {
            let stored = self.stored(result.slot);
            let key = if stored.length >= 3 {
                TextKey::Text(stored.text_key.0, stored.text_key.1)
            } else {
                TextKey::Unit(result.slot)
            };
            match by_text.get(&key) {
                Some(&first) => {
                    if self.stored(out[first].slot).unit.path != stored.unit.path {
                        out[first].also_in += 1;
                        continue;
                    }
                }
                None => {
                    by_text.insert(key, out.len());
                }
            }
            out.push(result);
            if out.len() >= limit {
                break;
            }
        }

        out.into_iter()
            .map(|result| {
                let stored = self.stored(result.slot);
                let unit = &stored.unit;
                let raw = utf16(&unit.text);
                let readable = if unit.kind == UnitKind::Ink {
                    strip_transcript_positions(&raw)
                } else {
                    raw.clone()
                };
                let snippet = make_snippet(&readable, &terms, 160);
                let matches = if result.title_only {
                    result.matches
                } else {
                    result.matches.max(snippet.matched)
                };
                let ink_y = if unit.kind == UnitKind::Ink {
                    ink_line_y(&raw, &terms)
                } else {
                    None
                };
                SearchResult {
                    path: unit.path.clone(),
                    title: self.docs[&unit.path].title.clone(),
                    unit_id: unit.id.clone(),
                    kind: unit.kind,
                    page: unit.page,
                    worksheet_id: unit.worksheet_id.clone().filter(|id| !id.is_empty()),
                    scene_id: unit.scene_id.clone().filter(|id| !id.is_empty()),
                    source: unit.source,
                    confidence: unit.confidence,
                    score: result.score,
                    matches,
                    snippet,
                    also_in: result.also_in,
                    ink_y,
                    title_only: result.title_only,
                }
            })
            .collect()
    }

    /// Debug aid: the folded vocabulary (sorted).
    pub fn vocabulary(&self) -> Vec<String> {
        let mut words: Vec<String> = self
            .token_ids
            .keys()
            .map(|token| from_utf16(token))
            .collect();
        words.sort();
        words
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(
        path: &str,
        kind: UnitKind,
        n: u32,
        text: &str,
        page: Option<u32>,
        source: UnitSource,
        confidence: Option<f64>,
    ) -> IndexUnit {
        let kind_name = serde_json::to_value(kind).unwrap();
        IndexUnit {
            id: format!("{path}#{}:{n}", kind_name.as_str().unwrap()),
            path: path.to_owned(),
            kind,
            page,
            worksheet_id: None,
            scene_id: None,
            source,
            confidence,
            text: text.to_owned(),
        }
    }

    fn marked(result: &SearchResult) -> Vec<String> {
        let text = utf16(&result.snippet.text);
        result
            .snippet
            .highlights
            .iter()
            .map(|&[a, b]| from_utf16(&text[a as usize..b as usize]))
            .collect()
    }

    #[test]
    fn and_of_terms_prefixes_case_and_umlauts() {
        let mut index = DocIndex::new();
        index.set_doc("Physik/Energie.pdf", "Energie");
        index.add_unit(unit(
            "Physik/Energie.pdf",
            UnitKind::PdfPage,
            1,
            "Kapitel 1. Die Lageenergie hängt von der Höhe ab.",
            Some(1),
            UnitSource::TextLayer,
            None,
        ));
        index.add_unit(unit(
            "Physik/Energie.pdf",
            UnitKind::PdfPage,
            2,
            "Kapitel 2. Bewegungsenergie und Geschwindigkeit.",
            Some(2),
            UnitSource::TextLayer,
            None,
        ));
        index.set_doc("Deutsch/Aufsatz.md", "Aufsatz");
        index.add_unit(unit(
            "Deutsch/Aufsatz.md",
            UnitKind::Note,
            1,
            "Über die Straße gehen wir zur Übung.",
            None,
            UnitSource::Text,
            None,
        ));
        let hits = index.search("hoehe lageenergie", 40);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].page, Some(1));
        let hits = index.search("BEWEGUNG", 40);
        assert_eq!(hits[0].page, Some(2));
        assert_eq!(marked(&hits[0]), ["Bewegungsenergie"]);
        let hits = index.search("strasse uebung", 40);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, UnitKind::Note);
        assert!(index
            .search("energie geschwindigkeit nichtda", 40)
            .is_empty());
        assert!(index.search("ergie", 40).is_empty());
    }

    #[test]
    fn ranking_title_boost_and_exact_above_prefix() {
        let mut index = DocIndex::new();
        index.set_doc("a.pdf", "Notizen A");
        index.add_unit(unit(
            "a.pdf",
            UnitKind::PdfPage,
            1,
            "Zelle Zellmembran Zellkern",
            Some(1),
            UnitSource::TextLayer,
            None,
        ));
        index.add_unit(unit(
            "a.pdf",
            UnitKind::PdfPage,
            2,
            "Zellenteilung und Mitose",
            Some(2),
            UnitSource::TextLayer,
            None,
        ));
        index.set_doc("b.pdf", "Scan B");
        index.add_unit(unit(
            "b.pdf",
            UnitKind::PdfPage,
            1,
            "Zelle Zellmembran Zellkern",
            Some(1),
            UnitSource::Ocr,
            Some(0.3),
        ));
        index.set_doc("Biologie/Zelle.md", "Zelle");
        index.add_unit(unit(
            "Biologie/Zelle.md",
            UnitKind::Note,
            1,
            "Eine Übersicht über die Zelle und Organellen.",
            None,
            UnitSource::Text,
            None,
        ));
        let hits = index.search("zelle", 40);
        assert_eq!(hits[0].path, "Biologie/Zelle.md");
        let order: Vec<String> = hits
            .iter()
            .map(|hit| format!("{}:{}", hit.path, hit.page.unwrap_or(0)))
            .collect();
        let a1 = order.iter().position(|value| value == "a.pdf:1").unwrap();
        let a2 = order.iter().position(|value| value == "a.pdf:2").unwrap();
        assert!(a1 < a2);
    }

    #[test]
    fn duplicates_and_title_only() {
        let mut index = DocIndex::new();
        for name in ["Kopie 1.pdf", "Kopie 2.pdf", "Kopie 3.pdf"] {
            index.set_doc(name, name);
            index.add_unit(unit(
                name,
                UnitKind::PdfPage,
                1,
                "Arbeitsblatt Photosynthese mit Chlorophyll und Licht",
                Some(1),
                UnitSource::Text,
                None,
            ));
        }
        index.set_doc("Buch.pdf", "Buch");
        index.add_unit(unit(
            "Buch.pdf",
            UnitKind::PdfPage,
            4,
            "Wiederholung Photosynthese",
            Some(4),
            UnitSource::Text,
            None,
        ));
        index.add_unit(unit(
            "Buch.pdf",
            UnitKind::PdfPage,
            5,
            "Wiederholung Photosynthese",
            Some(5),
            UnitSource::Text,
            None,
        ));
        let hits = index.search("photosynthese", 40);
        let copies: Vec<&SearchResult> = hits
            .iter()
            .filter(|hit| hit.path.starts_with("Kopie"))
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].also_in, 2);
        assert_eq!(hits.iter().filter(|hit| hit.path == "Buch.pdf").count(), 2);

        let mut index = DocIndex::new();
        index.set_doc("Mathe/Integralrechnung.pdf", "Integralrechnung");
        index.add_unit(unit(
            "Mathe/Integralrechnung.pdf",
            UnitKind::PdfPage,
            1,
            "Seite eins",
            Some(1),
            UnitSource::Text,
            None,
        ));
        index.add_unit(unit(
            "Mathe/Integralrechnung.pdf",
            UnitKind::PdfPage,
            2,
            "Seite zwei",
            Some(2),
            UnitSource::Text,
            None,
        ));
        let hits = index.search("integral", 40);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].title_only);
        assert_eq!(hits[0].page, Some(1));
    }

    #[test]
    fn transcript_positions_and_updates() {
        let mut index = DocIndex::new();
        index.set_doc("Bio.md", "Bio");
        index.add_unit(unit(
            "Bio.md",
            UnitKind::Ink,
            1,
            "0.1000\tPhotosynthese\n0.6200\tChlorophyll ist grün",
            None,
            UnitSource::Transcript,
            None,
        ));
        let hits = index.search("chlorophyll", 40);
        assert_eq!(hits[0].ink_y, Some(0.62));
        assert!(!hits[0].snippet.text.contains("0.62"));
        index.remove_doc("Bio.md", true);
        assert!(index.search("chlorophyll", 40).is_empty());
        assert_eq!(index.vocabulary_size(), 0);
        index.add_unit(unit(
            "Bio.md",
            UnitKind::Note,
            1,
            "Mitochondrien",
            None,
            UnitSource::Text,
            None,
        ));
        assert_eq!(index.search("mito", 40).len(), 1);
    }
}
