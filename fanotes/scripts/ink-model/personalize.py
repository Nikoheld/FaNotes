"""Fine-tunes the ink recognizer on one writer's exported lines and writes a personal model.

Input is the training bundle FaNotes exports (Einstellungen → Handschrift → Training
exportieren): JSON `{ "format": "fanotes-ink-personal-v1", "lines": [...] }`, each line carrying
its confirmed text and the pen strokes. The backbone and recurrent encoder stay close to the
base; the writer's lines mostly move the classifier. Held-out lines are scored after every epoch. The exported model is the epoch with the
lowest held-out error, so a long run cannot overwrite an earlier improvement. The result is
`personal-model.onnx` plus a `personal-model.json` report the app imports.

    python personalize.py --base <base-checkpoint.pt> --bundle writer.json --out ./personal

`--base` is a checkpoint from `train.py` (the same weights the shipped model was exported from;
`export.py --emit-checkpoint` writes one next to the ONNX). Runs on CPU in a few minutes for a
few dozen lines.
"""
import argparse
import copy
import hashlib
import json
import os
import random

import numpy as np
import torch

from export import Exported
from inkline import render
from inknet import InkNet, base_alphabet
from train import decode, encode

ALPHABET = base_alphabet()


def bundle_lines(path):
    bundle = json.load(open(path, encoding='utf-8'))
    if bundle.get('format') != 'fanotes-ink-personal-v1':
        raise SystemExit('Not a FaNotes ink training bundle.')
    lines = []
    for entry in bundle.get('lines', []):
        text = entry.get('text', '')
        ids = encode(text)
        strokes = [
            np.array([[p['x'] * entry['sourceWidth'], p['y'] * entry['sourceHeight']] for p in stroke['points']], dtype=np.float64)
            for stroke in entry.get('strokes', []) if stroke.get('points')
        ]
        strokes = [s for s in strokes if len(s)]
        if ids and strokes:
            lines.append({'text': text, 'strokes': strokes, 'reference': float(entry.get('referenceHeight', 0) or 0)})
    return lines


def loss_and_cer(model, lines):
    total_edits = total_chars = 0
    with torch.no_grad():
        for line in lines:
            image = render(line['strokes'], ref_height=line['reference'])
            if image is None:
                continue
            logits = model(torch.from_numpy(image)[None, None])[:, 0]
            prediction = decode(logits.argmax(-1).tolist())
            total_edits += _distance(prediction, line['text'])
            total_chars += len(line['text'])
    return 100 * total_edits / max(1, total_chars)


def _distance(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', required=True, help='base checkpoint .pt from train.py')
    parser.add_argument('--bundle', required=True, help='training bundle exported by FaNotes')
    parser.add_argument('--out', default='./personal')
    parser.add_argument('--base-version', default='', help='version string of the shipped base model')
    parser.add_argument('--epochs', type=int, default=40)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--holdout', type=float, default=0.25)
    args = parser.parse_args()
    torch.set_num_threads(max(1, os.cpu_count() // 2))
    os.makedirs(args.out, exist_ok=True)

    model = InkNet()
    model.load_state_dict(torch.load(args.base, map_location='cpu'))
    model.eval()
    lines = bundle_lines(args.bundle)
    if len(lines) < 8:
        raise SystemExit(f'Need at least 8 labelled lines, found {len(lines)}.')
    random.Random(17).shuffle(lines)
    cut = max(2, int(len(lines) * args.holdout))
    holdout, train_lines = lines[:cut], lines[cut:]
    error_before = loss_and_cer(model, holdout)
    print(f'held-out CER before {error_before:.2f}% on {len(holdout)} lines', flush=True)

    tuned = copy.deepcopy(model)
    base_state = {name: tensor.detach().clone() for name, tensor in tuned.named_parameters()}
    best_state = copy.deepcopy(tuned.state_dict())
    best_error = error_before
    # Encoder stays close to the base; the classifier and the top recurrent layer move most.
    for name, parameter in tuned.named_parameters():
        parameter.requires_grad = name.startswith(('head', 'rnn')) or 'layer3' in name
    optimizer = torch.optim.AdamW([p for p in tuned.parameters() if p.requires_grad], lr=args.lr, weight_decay=1e-4)
    ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)
    rng = np.random.default_rng(3)
    tuned.train()
    for epoch in range(args.epochs):
        order = rng.permutation(len(train_lines))
        for index in order:
            line = train_lines[index]
            image = render(line['strokes'], ref_height=line['reference'],
                           pen=rng.uniform(1.8, 3.6), extra_shear=rng.uniform(-0.1, 0.1), scale_jitter=rng.uniform(0.92, 1.05))
            if image is None:
                continue
            ids = encode(line['text'])
            frames = image.shape[1] // 4
            if frames < 2 * len(ids) + 1:
                continue
            logits = tuned(torch.from_numpy(image)[None, None]).log_softmax(-1)
            loss = ctc(logits, torch.tensor(ids), torch.tensor([logits.shape[0]]), torch.tensor([len(ids)]))
            anchor = sum(((p - base_state[n]) ** 2).sum() for n, p in tuned.named_parameters() if p.requires_grad)
            optimizer.zero_grad()
            (loss + 5e-3 * anchor).backward()
            torch.nn.utils.clip_grad_norm_(tuned.parameters(), 5.0)
            optimizer.step()
        tuned.eval()
        error = loss_and_cer(tuned, holdout)
        print(f'epoch {epoch + 1} held-out CER {error:.2f}%', flush=True)
        if error < best_error:
            best_error = error
            best_state = copy.deepcopy(tuned.state_dict())
        tuned.train()
    tuned.load_state_dict(best_state)
    tuned.eval()
    error_after = best_error
    print(f'held-out CER {error_before:.2f}% -> {error_after:.2f}% on {len(holdout)} lines')

    onnx_path = os.path.join(args.out, 'personal-model.onnx')
    dummy = torch.ones(1, 1, 64, 256)
    torch.onnx.export(Exported(tuned).eval(), (dummy,), onnx_path,
                      input_names=['image'], output_names=['logits', 'features'],
                      dynamic_axes={'image': {3: 'width'}, 'logits': {1: 'frames'}, 'features': {1: 'frames'}},
                      opset_version=17, dynamo=False)
    report = {
        'format': 'fanotes-ink-personal-model-v1',
        'baseVersion': args.base_version,
        'lines': len(lines),
        'errorBefore': round(error_before, 2),
        'errorAfter': round(error_after, 2),
        'sha256': hashlib.sha256(open(onnx_path, 'rb').read()).hexdigest(),
        'size': os.path.getsize(onnx_path),
    }
    json.dump(report, open(os.path.join(args.out, 'personal-model.json'), 'w'), indent=2)
    print('wrote', onnx_path, f'({report["size"] // 1024} KiB); import personal-model.onnx and personal-model.json in FaNotes')


if __name__ == '__main__':
    main()
