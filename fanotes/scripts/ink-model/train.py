"""Fine-tunes the ink recognizer on rendered pen data."""
import argparse
import copy
import math
import os
import random
import re
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brushdata import load_all, strokes_of  # noqa: E402
from common import edit_distance  # noqa: E402
from inkline import render  # noqa: E402
from inknet import base_alphabet, load_base  # noqa: E402

ALPHABET = base_alphabet()
INDEX = {c: i + 1 for i, c in enumerate(ALPHABET)}
REPLACE = {'„': '"', '“': '"', '”': '"', '‚': "'", '‘': "'", '’': "'", '´': "'", '`': "'"}


def encode(text):
    text = ''.join(REPLACE.get(c, c) for c in text)
    if any(c not in INDEX for c in text):
        return None
    return [INDEX[c] for c in text]


def decode(ids):
    out = []
    previous = 0
    for index in ids:
        if index != 0 and index != previous:
            out.append(ALPHABET[index - 1])
        previous = index
    return ''.join(out)


def loose(value):
    return re.sub(r'[^a-zäöüß ]', '', value.lower()).strip()


def displacement_field(rng, amplitude):
    """Smooth elastic distortion shared by all strokes of a line (continuous across pen lifts)."""
    terms = [(amplitude * rng.uniform(-1, 1), rng.uniform(0.5, 3.0), rng.uniform(0, 1), rng.uniform(0.0, 0.6))
             for _ in range(3)]

    def apply(x, y, span):
        u = (x - x.min()) / max(1e-6, span) if len(x) else x
        dx = np.zeros_like(x)
        dy = np.zeros_like(y)
        for k, (a, frequency, phase, mix) in enumerate(terms):
            wave = a * np.sin(2 * np.pi * (frequency * u + phase))
            if k % 2:
                dx += wave
            else:
                dy += wave
            dx += mix * a * np.cos(2 * np.pi * (frequency * u * 1.7 + phase))
        return dx, dy
    return apply


def augment_strokes(strokes, rng, height, mild=False):
    sx = rng.uniform(0.94, 1.06) if mild else rng.uniform(0.82, 1.18)
    points = np.concatenate(strokes).astype(np.float64)
    lo = points[:, 0].min()
    span = (points[:, 0].max() - lo) * sx
    field = displacement_field(rng, height * (rng.uniform(0.0, 0.012) if mild else rng.uniform(0.0, 0.03)))
    bend = height * rng.uniform(-0.04, 0.04) if mild and rng.random() < 0.1 else (
        height * rng.uniform(-0.12, 0.12) if not mild and rng.random() < 0.15 else 0.0)
    out = []
    for stroke in strokes:
        s = stroke.astype(np.float64).copy()
        s[:, 0] = (s[:, 0] - lo) * sx
        dx, dy = field(np.append(s[:, 0], [0.0, span]), np.append(s[:, 1], [0.0, 0.0]), span)
        s[:, 0] += dx[:-2]
        s[:, 1] += dy[:-2]
        if bend:
            s[:, 1] += bend * np.sin(np.pi * s[:, 0] / max(1e-6, span))
        out.append(s)
    return out


def word_crop(row, rng):
    """Random contiguous word span using BRUSH per-point character labels."""
    text = row['text']
    spans = [(m.start(), m.end()) for m in re.finditer(r'\S+', text)]
    if len(spans) < 2:
        return None
    first = rng.integers(0, len(spans))
    last = rng.integers(first, min(len(spans), first + 2))
    lo, hi = spans[first][0], spans[last][1]
    keep = (row['chars'] >= lo) & (row['chars'] < hi)
    if keep.sum() < 4:
        return None
    ys = row['drawing'][:, 1]
    reference = float(ys.max() - ys.min()) if rng.random() < 0.7 else 0.0
    return text[lo:hi], strokes_of(row['drawing'], keep), reference


class Source:
    def sample(self, rng):
        raise NotImplementedError


class BrushSource(Source):
    def __init__(self, rows, crop_probability=0.2):
        self.rows = rows
        self.crop_probability = crop_probability

    def sample(self, rng):
        row = self.rows[rng.integers(len(self.rows))]
        if rng.random() < self.crop_probability:
            cropped = word_crop(row, rng)
            if cropped:
                return cropped
        return row['text'], strokes_of(row['drawing']), 0.0


def make_image(text, strokes, rng, augment=True, reference=0.0, mild=False):
    if augment:
        points = np.concatenate(strokes)
        height = max(1.0, points[:, 1].max() - points[:, 1].min())
        strokes = augment_strokes(strokes, rng, height, mild=mild)
        if mild:
            pen, shear, rotation, scale = rng.uniform(2.1, 3.2), rng.uniform(-0.08, 0.08), rng.uniform(-0.015, 0.015), rng.uniform(0.94, 1.06)
        else:
            pen, shear, rotation, scale = rng.uniform(1.5, 4.0), rng.uniform(-0.22, 0.22), rng.uniform(-0.035, 0.035), rng.uniform(0.86, 1.06)
        image = render(strokes, pen=pen, extra_shear=shear, extra_rotation=rotation, scale_jitter=scale,
                       ref_height=reference)
        if image is not None and rng.random() < 0.25:
            image = np.clip(image + rng.normal(0, 0.04, image.shape).astype(np.float32), 0, 1)
    else:
        image = render(strokes)
    return image


def batch_tensors(items):
    width = max(image.shape[1] for image, _ in items)
    images = np.ones((len(items), 1, 64, width), dtype=np.float32)
    targets, target_lengths, input_lengths = [], [], []
    for k, (image, ids) in enumerate(items):
        images[k, 0, :, :image.shape[1]] = image
        targets.extend(ids)
        target_lengths.append(len(ids))
        input_lengths.append(image.shape[1] // 4)
    return (torch.from_numpy(images), torch.tensor(targets, dtype=torch.long),
            torch.tensor(input_lengths, dtype=torch.long), torch.tensor(target_lengths, dtype=torch.long))


def evaluate(model, items, limit=None):
    """items: (text, strokes) pairs."""
    model.eval()
    edits = chars = loose_edits = loose_chars = 0
    examples = []
    with torch.no_grad():
        for text, strokes in items[:limit]:
            image = render(strokes)
            if image is None:
                continue
            logits = model(torch.from_numpy(image)[None, None])[:, 0]
            prediction = decode(logits.argmax(-1).tolist())
            edits += edit_distance(prediction, text)
            chars += len(text)
            loose_edits += edit_distance(loose(prediction), loose(text))
            loose_chars += max(1, len(loose(text)))
            if len(examples) < 6:
                examples.append((text, prediction))
    model.train()
    return 100 * edits / max(1, chars), 100 * loose_edits / max(1, loose_chars), examples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--steps', type=int, default=1500)
    parser.add_argument('--batch', type=int, default=24)
    parser.add_argument('--lr', type=float, default=2e-4)
    parser.add_argument('--eval-every', type=int, default=250)
    from inkpaths import RUNS
    parser.add_argument('--out', default=os.path.join(RUNS, 'quick'))
    parser.add_argument('--init', default='')
    parser.add_argument('--sources', default='brush')
    parser.add_argument('--validate-scans', action='store_true')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--warmup', type=int, default=150)
    parser.add_argument('--mild-augment', action='store_true',
                        help='keep pen width, slant and stretch near the desktop defaults')
    parser.add_argument('--product-eval', action='store_true',
                        help='after each validation, score the desktop beam decoder and keep the best pen checkpoint that holds the golden lines')
    parser.add_argument('--product-brush', default='')
    parser.add_argument('--distill-weight', type=float, default=0.0,
                        help='keep German and IAM scan logits near the init checkpoint while CTC trains the pen')
    parser.add_argument('--distill-decisions', action='store_true',
                        help='anchor the init model\'s chosen character on confident frames instead of the full distribution')
    parser.add_argument('--distill-batch', type=int, default=8)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    os.makedirs(args.out, exist_ok=True)
    rng = np.random.default_rng(1234)
    rows = load_all()
    train_rows = [r for r in rows if r['split'] == 'train' and encode(r['text'])]
    val_rows = [r for r in rows if r['split'] == 'val' and encode(r['text'])]
    random.Random(7).shuffle(val_rows)
    validation = {'brush': [(r['text'], strokes_of(r['drawing'])) for r in val_rows[:200]]}
    if args.validate_scans:
        import sources as extra
        for name in ('iam', 'scads'):
            validation[name] = extra.validation(name)
    sources = []
    for spec in args.sources.split(','):
        name, _, weight = spec.partition(':')
        weight = float(weight or 1)
        if name == 'brush':
            sources.append((BrushSource(train_rows), weight))
        else:
            import sources as extra
            sources.append((extra.build(name, rows), weight))
    weights = np.array([w for _, w in sources]) / sum(w for _, w in sources)
    model = load_base()
    if args.init:
        model.load_state_dict(torch.load(args.init, map_location='cpu'))
    model.train()
    teacher = None
    anchor_sources = []
    if args.distill_weight > 0:
        if not args.init:
            raise SystemExit('--distill-weight requires --init, the checkpoint whose readings must stay put')
        teacher = copy.deepcopy(model).eval()
        for parameter in teacher.parameters():
            parameter.requires_grad_(False)
        import sources as extra
        anchor_sources = [(extra.build('scads', rows), 0.6), (extra.build('iam', rows), 0.4)]
    backbone = [p for n, p in model.named_parameters() if not n.startswith(('rnn', 'head'))]
    top = [p for n, p in model.named_parameters() if n.startswith(('rnn', 'head'))]
    optimizer = torch.optim.AdamW([
        {'params': backbone, 'lr': args.lr * 0.5},
        {'params': top, 'lr': args.lr},
    ], weight_decay=1e-4)
    base_lrs = [g['lr'] for g in optimizer.param_groups]
    ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)
    product_baseline = None

    def remember_product(checkpoint, step):
        nonlocal product_baseline
        if not args.product_eval:
            return
        import json as product_json
        import subprocess as product_subprocess
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'product_eval.py')
        command = [sys.executable, script, checkpoint]
        if args.product_brush:
            command.extend(['--brush', args.product_brush])
        completed = product_subprocess.run(command, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            print(completed.stderr[-2000:], flush=True)
            raise SystemExit(completed.returncode)
        report = product_json.loads([row for row in completed.stdout.splitlines() if row.startswith('{')][-1])
        print(f'step {step} product {product_json.dumps(report)}', flush=True)
        # The first call is the init. A later checkpoint is kept only when every exact
        # golden line remains exact, the error rates do not rise, and the pen error falls.
        if product_baseline is None:
            product_baseline = report
            torch.save(model.state_dict(), os.path.join(args.out, 'best-product.pt'))
            print(f'step {step} product baseline kept', flush=True)
            return
        holds = (
            report.get('enCharacterError') <= product_baseline.get('enCharacterError')
            and report.get('pageCharacterError') <= product_baseline.get('pageCharacterError')
            and             report.get('deCharacterError') <= product_baseline.get('deCharacterError')
            and report.get('deWordError') <= product_baseline.get('deWordError')
            and (report.get('deExact') or 0) >= (product_baseline.get('deExact') or 0)
            and (report.get('enExact') or 0) >= (product_baseline.get('enExact') or 0)
            and report.get('penCharacterError') is not None
            and report['penCharacterError'] < product_baseline.get('penCharacterError')
        )
        if holds:
            product_baseline = report
            torch.save(model.state_dict(), os.path.join(args.out, 'best-product.pt'))
            print(f'step {step} product checkpoint kept', flush=True)

    def validate(step):
        scores = {}
        for name, items in validation.items():
            cer, loose_cer, examples = evaluate(model, items)
            scores[name] = cer
            print(f'step {step} val {name} CER {cer:.2f} loose {loose_cer:.2f}', flush=True)
            for truth, prediction in examples[:2]:
                print(f'   {truth!r} -> {prediction!r}', flush=True)
        return sum(scores.values()) / len(scores)
    validate(0)
    if args.product_eval:
        baseline = args.init
        if not baseline:
            baseline = os.path.join(args.out, 'step0.pt')
            torch.save(model.state_dict(), baseline)
        remember_product(baseline, 0)
    started = time.time()
    running = []
    running_kl = []
    pending = []
    anchor_pending = []
    anchor_weights = np.array([weight for _, weight in anchor_sources])
    if len(anchor_weights):
        anchor_weights = anchor_weights / anchor_weights.sum()
    best = float('inf')

    def take_anchor():
        nonlocal anchor_pending
        if not anchor_pending:
            pool = []
            attempts = 0
            while len(pool) < args.distill_batch and attempts < args.distill_batch * 20:
                attempts += 1
                source = anchor_sources[int(rng.choice(len(anchor_sources), p=anchor_weights))][0]
                sampled = source.sample(rng)
                text, strokes = sampled[0], sampled[1]
                reference = sampled[2] if len(sampled) > 2 else 0.0
                ids = encode(text) if text else None
                if not ids or not strokes:
                    continue
                image = make_image(text, strokes, rng, augment=False, reference=reference)
                if image is None or image.shape[1] // 4 < 2 * len(ids) + 1:
                    continue
                pool.append((image, ids))
            if not pool:
                return None
            pool.sort(key=lambda item: item[0].shape[1])
            anchor_pending = [pool[k:k + args.distill_batch] for k in range(0, len(pool), args.distill_batch)]
        return anchor_pending.pop()
    for step in range(1, args.steps + 1):
        warm = min(1.0, step / max(1, args.warmup))
        decay = 0.5 * (1 + math.cos(math.pi * step / args.steps))
        for group, lr in zip(optimizer.param_groups, base_lrs):
            group['lr'] = lr * warm * max(0.05, decay)
        if not pending:
            pool = []
            while len(pool) < args.batch * 4:
                source = sources[rng.choice(len(sources), p=weights)][0]
                sampled = source.sample(rng)
                text, strokes = sampled[0], sampled[1]
                reference = sampled[2] if len(sampled) > 2 else 0.0
                ids = encode(text) if text else None
                if not ids or not strokes:
                    continue
                image = make_image(text, strokes, rng, reference=reference, mild=args.mild_augment)
                if image is None or image.shape[1] // 4 < 2 * len(ids) + 1:
                    continue
                pool.append((image, ids))
            # Width buckets: similar line lengths share a batch, so little compute goes to padding.
            pool.sort(key=lambda item: item[0].shape[1])
            pending = [pool[k:k + args.batch] for k in range(0, len(pool), args.batch)]
            rng.shuffle(pending)
        items = pending.pop()
        images, targets, input_lengths, target_lengths = batch_tensors(items)
        log_probs = model(images).log_softmax(-1)
        loss = ctc(log_probs, targets, input_lengths, target_lengths)
        if teacher is not None:
            anchored = take_anchor()
            if anchored:
                anchor_images = batch_tensors(anchored)[0]
                student_logits = model(anchor_images)
                with torch.no_grad():
                    teacher_logits = teacher(anchor_images)
                if args.distill_decisions:
                    top = teacher_logits.argmax(-1, keepdim=True)
                    student_log = student_logits.log_softmax(-1)
                    chosen = student_log.gather(-1, top).squeeze(-1)
                    rival = student_log.scatter(-1, top, -1e9).amax(-1)
                    with torch.no_grad():
                        teacher_log = teacher_logits.log_softmax(-1)
                        teacher_chosen = teacher_log.gather(-1, top).squeeze(-1)
                        teacher_rival = teacher_log.scatter(-1, top, -1e9).amax(-1)
                        target_margin = (teacher_chosen - teacher_rival).clamp(0, 2)
                        confident = target_margin > 0.4
                    shortfall = torch.relu(target_margin - (chosen - rival))
                    anchor_loss = shortfall[confident].mean() if bool(confident.any()) else shortfall.new_zeros(())
                else:
                    student = student_logits.log_softmax(-1)
                    target = teacher_logits.log_softmax(-1)
                    anchor_loss = (target.exp() * (target - student)).sum(-1).mean()
                loss = loss + args.distill_weight * anchor_loss
                running_kl.append(float(anchor_loss.detach()))
        optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        optimizer.step()
        running.append(loss.item())
        if step % 50 == 0:
            kl_note = f' kl {np.mean(running_kl[-50:]):.4f}' if running_kl else ''
            print(f'step {step} loss {np.mean(running[-50:]):.3f}{kl_note} {(time.time() - started) / step:.2f}s/step', flush=True)
        if step % args.eval_every == 0 or step == args.steps:
            cer = validate(step)
            print(f'step {step} val mean CER {cer:.2f}', flush=True)
            saved = os.path.join(args.out, f'step{step}.pt')
            torch.save(model.state_dict(), saved)
            torch.save(model.state_dict(), os.path.join(args.out, 'last.pt'))
            remember_product(saved, step)
            if cer < best:
                best = cer
                torch.save(model.state_dict(), os.path.join(args.out, 'best.pt'))


if __name__ == '__main__':
    main()
