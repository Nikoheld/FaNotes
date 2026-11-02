"""Builds the FaNotes character n-gram language model (`fanotes-charlm-v1`).

Interpolated Witten-Bell estimates over the recognizer alphabet. Each context length has its
own table of 32-bit FNV-1a context hashes; `crates/fanotes-recog/src/charlm.rs` reads it.

Binary layout (little endian):
  b'FNLM', u16 version=1, u8 order, u8 flags (bit 0: case folded), u32 alphabet_bytes, alphabet
  unigram: (alphabet_size + 1) × u8 cost   (symbol 0 is the line start, never predicted)
  for context length k = 1 .. order-1:
     u32 context_count, u32 entry_count
     contexts: context_count × (u32 hash, u32 first_entry, u8 backoff_cost)  sorted by hash
     entries:  entry_count × (u8 symbol, u8 cost)  grouped by context, sorted by symbol
Costs are quantized negative natural logs: probability = exp(-cost / 16).
"""
import argparse
import os
import re
import struct
import sys
import unicodedata

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from compose import _sentences, _wiki  # noqa: E402

FNV_OFFSET = np.uint64(0x811C9DC5)
FNV_PRIME = np.uint64(0x01000193)
MASK32 = np.uint64(0xFFFFFFFF)
Q = 16.0


def vector_hash(columns):
    value = np.full(columns[0].shape, FNV_OFFSET, dtype=np.uint64)
    for column in columns:
        value ^= column.astype(np.uint64)
        value = (value * FNV_PRIME) & MASK32
    return value


def normalize_line(sentence):
    # ß stays a single letter. It is in the recognizer alphabet; expanding it to
    # "ss" trained the language model to treat every ß as impossible.
    sentence = unicodedata.normalize('NFC', sentence)
    sentence = re.sub(r'[„“”«»]', '"', sentence)
    sentence = re.sub(r"[‚‘’´`]", "'", sentence)
    return ' '.join(sentence.split())


def corpus(language, limit, alphabet, extra_lines=()):
    rng = np.random.default_rng(11)
    text_language = {'de': 'deu', 'en': 'eng'}[language]
    pool = _sentences(text_language, limit) + _wiki(text_language, limit) + list(extra_lines)
    index = {c: i + 1 for i, c in enumerate(alphabet)}
    lines = []
    for sentence in pool:
        sentence = normalize_line(sentence).lower()
        if not sentence or any(c not in index for c in sentence):
            continue
        lines.append(sentence)
        words = sentence.split()
        if len(words) > 3:
            start = int(rng.integers(1, len(words) - 1))
            lines.append(' '.join(words[start:start + int(rng.integers(2, 9))]))
    total = sum(len(line) + 1 for line in lines)
    data = np.zeros(total, dtype=np.uint8)
    position = 0
    for line in lines:
        position += 1
        data[position:position + len(line)] = [index[c] for c in line]
        position += len(line)
    return data, len(lines)


def cost(probability):
    return np.clip(np.round(-np.log(np.maximum(probability, 1e-30)) * Q), 0, 255).astype(np.uint8)


def build(language, order, limit, min_counts, out_path, alphabet):
    data, line_count = corpus(language, limit, alphabet)
    size = len(alphabet) + 1
    print(language, 'lines', line_count, 'symbols', len(data), flush=True)
    line_id = np.cumsum(data == 0).astype(np.int32)
    counts = np.bincount(data[data != 0], minlength=size).astype(np.float64)
    unigram = (counts + 0.5) / (counts.sum() + 0.5 * (size - 1))
    unigram[0] = 1e-12
    previous = None  # (sorted keys, probabilities) of context length k-1
    tables = []
    for k in range(1, order):
        n = len(data) - k
        symbol = data[k:]
        valid = (symbol != 0) & (line_id[k:] == line_id[:n])
        hashes = vector_hash([data[j:j + n][valid] for j in range(k)])
        keys = (hashes << np.uint64(8)) | symbol[valid].astype(np.uint64)
        if k > 1:
            short = (vector_hash([data[j:j + n][valid] for j in range(1, k)]) << np.uint64(8)) | symbol[valid].astype(np.uint64)
        del hashes
        sort = np.argsort(keys, kind='stable')
        keys = keys[sort]
        boundary = np.flatnonzero(np.diff(keys)) + 1
        first = np.concatenate([[0], boundary])
        unique = keys[first]
        ngram_counts = np.diff(np.concatenate([first, [len(keys)]]))
        if k > 1:
            short_unique = short[sort][first]
            del short
        del keys, sort
        sym = (unique & np.uint64(0xFF)).astype(np.int64)
        ctx = unique >> np.uint64(8)
        ctx_first = np.concatenate([[0], np.flatnonzero(np.diff(ctx)) + 1])
        ctx_hash = ctx[ctx_first]
        ctx_distinct = np.diff(np.concatenate([ctx_first, [len(ctx)]]))
        ctx_total = np.add.reduceat(ngram_counts, ctx_first)
        group = np.repeat(np.arange(len(ctx_hash)), ctx_distinct)
        if k == 1:
            lower = unigram[sym]
        else:
            prev_keys, prev_p = previous
            position = np.clip(np.searchsorted(prev_keys, short_unique), 0, len(prev_keys) - 1)
            found = prev_keys[position] == short_unique
            lower = np.where(found, prev_p[position], unigram[sym])
        probability = (ngram_counts + ctx_distinct[group] * lower) / (ctx_total[group] + ctx_distinct[group])
        backoff = ctx_distinct / (ctx_total + ctx_distinct)
        keep = ngram_counts >= min_counts[k - 1]
        keep_ctx = np.zeros(len(ctx_hash), dtype=bool)
        keep_ctx[group[keep]] = True
        tables.append((ctx_hash, backoff, keep_ctx, group, sym, probability, keep))
        previous = (unique, probability)
        print(f'  context {k}: {len(unique)} ngrams, kept {keep.sum()} in {keep_ctx.sum()} contexts', flush=True)
    write(out_path, alphabet, order, unigram, tables)


def write(path, alphabet, order, unigram, tables):
    alphabet_bytes = alphabet.encode('utf-8')
    with open(path, 'wb') as handle:
        handle.write(b'FNLM')
        handle.write(struct.pack('<HBBI', 1, order, 1, len(alphabet_bytes)))
        handle.write(alphabet_bytes)
        handle.write(cost(unigram).tobytes())
        for ctx_hash, backoff, keep_ctx, group, sym, probability, keep in tables:
            kept_ctx = np.flatnonzero(keep_ctx)
            entry_mask = keep & keep_ctx[group]
            remap = np.full(len(keep_ctx), -1, dtype=np.int64)
            remap[kept_ctx] = np.arange(len(kept_ctx))
            entry_group = remap[group[entry_mask]]
            first_entry = np.searchsorted(entry_group, np.arange(len(kept_ctx))).astype(np.uint32)
            contexts = np.zeros(len(kept_ctx), dtype=[('h', '<u4'), ('e', '<u4'), ('b', 'u1')])
            contexts['h'] = ctx_hash[kept_ctx].astype(np.uint32)
            contexts['e'] = first_entry
            contexts['b'] = cost(backoff[kept_ctx])
            entries = np.zeros(int(entry_mask.sum()), dtype=[('s', 'u1'), ('p', 'u1')])
            entries['s'] = sym[entry_mask].astype(np.uint8)
            entries['p'] = cost(probability[entry_mask])
            handle.write(struct.pack('<II', len(contexts), len(entries)))
            handle.write(contexts.tobytes())
            handle.write(entries.tobytes())
    print('wrote', path, os.path.getsize(path) // 1024, 'KiB', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--language', default='de')
    parser.add_argument('--order', type=int, default=6)
    parser.add_argument('--limit', type=int, default=300_000)
    parser.add_argument('--min-counts', default='1,2,2,3,3,3,3')
    parser.add_argument('--out', default='')
    args = parser.parse_args()
    from inknet import base_alphabet
    alphabet = base_alphabet()
    from inkpaths import LM
    out = args.out or os.path.join(LM, f'{args.language}-{args.order}.fnlm')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    build(args.language, args.order, args.limit, [int(v) for v in args.min_counts.split(',')], out, alphabet)
