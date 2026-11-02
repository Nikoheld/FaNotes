"""Evaluates an ink recognizer checkpoint on writer-disjoint test sets (greedy and LM beam)."""
import argparse
import json
import os
import pickle
import random
import re
import subprocess
import sys
import tempfile
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brushdata import load_all, strokes_of  # noqa: E402
from common import edit_distance  # noqa: E402
from inkline import render  # noqa: E402
from inknet import base_alphabet, load_base  # noqa: E402
from train import decode, encode  # noqa: E402

DECODER = os.path.join(REPO, '..', 'target', 'release', 'examples', 'ink_decode')
from inkpaths import LM as LM, DATA
LM = LM


def loose(value):
    return re.sub(r'[^a-zäöü ]', '', value.lower().replace('ß', 'ss')).strip()


def test_sets(limit=None):
    rows = load_all()
    sets = {}
    brush = [r for r in rows if r['split'] == 'test' and encode(r['text'])]
    random.Random(5).shuffle(brush)
    sets['brush-en'] = [(r['text'], strokes_of(r['drawing']), 'en') for r in brush[:limit or 800]]
    scans_path = os.path.join(DATA, 'scan-strokes.pkl')
    if os.path.exists(scans_path):
        scans = pickle.load(open(scans_path, 'rb'))
        for source, language in (('scads', 'de'), ('iam', 'en')):
            chosen = [r for r in scans if r['source'] == source and r['split'] == 'test' and len(r['strokes'][1]) and encode(r['text'])]
            random.Random(5).shuffle(chosen)
            from scans import detokenize, unpack
            sets[f'{source}-{language}'] = [(detokenize(r['text']) if source == 'iam' else r['text'], unpack(r['strokes']), language) for r in chosen[:limit or 500]]
    from compose import ComposedSource
    composed = ComposedSource([r for r in rows if r['split'] == 'test'])
    rng = np.random.default_rng(99)
    for language, key in (('deu', 'composed-de'), ('eng', 'composed-en')):
        items = []
        while len(items) < (limit or 300):
            for _ in range(20):
                writer = composed.writers[rng.integers(len(composed.writers))]
                text = composed.pool.line(rng, language)
                if writer.supports(text) and encode(text):
                    items.append((text, writer.compose(text, rng), language[:2]))
                    break
        sets[key] = items
    return sets


def logits_for(model, items):
    out = []
    started = time.time()
    with torch.no_grad():
        for text, strokes, language in items:
            image = render(strokes)
            logits = model(torch.from_numpy(image)[None, None])[:, 0].numpy()
            out.append(logits)
    return out, (time.time() - started) / max(1, len(items))


def beam(logits, language, options):
    alphabet = base_alphabet()
    with tempfile.TemporaryDirectory() as folder:
        flat = np.concatenate([l.reshape(-1) for l in logits]).astype('<f4')
        flat.tofile(os.path.join(folder, 'logits.f32'))
        lines = []
        offset = 0
        for l in logits:
            lines.append({'offset': offset, 'frames': l.shape[0]})
            offset += l.size
        json.dump({'alphabet': alphabet, 'lines': lines}, open(os.path.join(folder, 'index.json'), 'w'))
        args = [DECODER, os.path.join(folder, 'logits.f32'), os.path.join(folder, 'index.json')]
        if options.get('lm'):
            args += ['--lm', os.path.join(LM, f"{language}-{options['lm']}.fnlm")]
        if options.get('words', True):
            args += ['--words', os.path.join(LM, f'{language}-lexicon.txt')]
        for key in ('lm-weight', 'word-bonus', 'unknown-word-penalty', 'insertion-bonus', 'beam-width'):
            if key in options:
                args += [f'--{key}', str(options[key])]
        output = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    return [json.loads(line) for line in output.splitlines()]


def score(predictions, items):
    edits = chars = wedits = words = loose_edits = loose_chars = 0
    for prediction, (truth, _, _) in zip(predictions, items):
        truth = truth.replace('ß', 'ss')
        prediction = prediction.replace('ß', 'ss')
        edits += edit_distance(prediction, truth)
        chars += len(truth)
        wedits += edit_distance(prediction.split(), truth.split())
        words += len(truth.split())
        loose_edits += edit_distance(loose(prediction), loose(truth))
        loose_chars += max(1, len(loose(truth)))
    return 100 * edits / chars, 100 * wedits / words, 100 * loose_edits / loose_chars


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('checkpoint')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--lm', default='')
    parser.add_argument('--grid', action='store_true')
    args = parser.parse_args()
    torch.set_num_threads(4)
    model = load_base()
    if args.checkpoint != 'base':
        model.load_state_dict(torch.load(args.checkpoint, map_location='cpu'))
    model.eval()
    sets = test_sets(args.limit or None)
    for name, items in sets.items():
        logits, seconds = logits_for(model, items)
        language = items[0][2]
        greedy = [decode(l.argmax(-1).tolist()) for l in logits]
        cer, wer, lcer = score(greedy, items)
        print(f'{name:12s} n={len(items):4d} greedy   CER {cer:5.2f} WER {wer:5.2f} loose {lcer:5.2f}  {seconds * 1000:.0f} ms/line', flush=True)
        configs = [{'lm': args.lm}] if args.lm else [{}]
        if args.grid:
            configs = [{'lm': args.lm, 'lm-weight': w, 'word-bonus': b, 'insertion-bonus': i}
                       for w in (0.3, 0.5, 0.7) for b in (0.6, 1.2, 2.0) for i in (0.3, 0.6, 1.0)]
        for options in configs:
            decoded = beam(logits, language, options)
            cer, wer, lcer = score([d['text'] for d in decoded], items)
            print(f'{name:12s} beam {json.dumps(options)} CER {cer:5.2f} WER {wer:5.2f} loose {lcer:5.2f}', flush=True)


if __name__ == '__main__':
    main()
