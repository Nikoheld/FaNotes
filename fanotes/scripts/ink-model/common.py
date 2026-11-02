"""Shared helpers for the handwriting evaluation experiments (not part of the repo)."""
import os
import pickle
import random
import unicodedata

import numpy as np
from PIL import Image, ImageDraw

from inkpaths import DATA
BRUSH_ROOT = os.path.join(DATA, 'brush', 'BRUSH')


def edit_distance(a, b):
    a = list(a)
    b = list(b)
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[-1]


def cer(pred, truth):
    return edit_distance(pred, truth), max(1, len(truth))


def wer(pred, truth):
    return edit_distance(pred.split(), truth.split()), max(1, len(truth.split()))


def brush_writers():
    return sorted([w for w in os.listdir(BRUSH_ROOT) if w.isdigit()], key=int)


def brush_samples(writer):
    folder = os.path.join(BRUSH_ROOT, writer)
    out = []
    for name in sorted(os.listdir(folder)):
        if '_' in name:
            continue
        sentence, drawing, label = pickle.load(open(os.path.join(folder, name), 'rb'))
        out.append((name, sentence, drawing, label))
    return out


def drawing_to_strokes(drawing):
    """BRUSH (N,3) with end-of-stroke flags -> list of (K,2) arrays in pixel units."""
    strokes = []
    current = []
    for x, y, eos in drawing:
        current.append((float(x), float(y)))
        if eos >= 0.5:
            strokes.append(np.array(current))
            current = []
    if current:
        strokes.append(np.array(current))
    return [s for s in strokes if len(s)]


def fanotes_render(strokes, base_width=3.5, pressure=0.55, model_height=128, margin_y_ratio=0.34,
                   margin_x_ratio=0.22, max_width=4096, supersample=4):
    """Python port of neuralTextRecognition.renderLineImage (white paper, black ink)."""
    pts = np.concatenate(strokes)
    radius = min(20.0, max(0.5, base_width / 2))
    min_x, min_y = pts.min(0) - radius
    max_x, max_y = pts.max(0) + radius
    content_w = max(1.0, max_x - min_x)
    content_h = max(1.0, max_y - min_y)
    clamp = lambda v, lo, hi: max(lo, min(hi, v))
    margin_y = clamp(content_h * clamp(margin_y_ratio, 0.04, 0.6), 4, 36)
    margin_x = clamp(content_h * clamp(margin_x_ratio, 0.04, 0.8), 5, 48)
    img_w = content_w + margin_x * 2
    img_h = content_h + margin_y * 2
    width = int(clamp(np.ceil(model_height * img_w / img_h), 32, max_width))
    sx = width / img_w
    sy = model_height / img_h
    ss = supersample
    canvas = Image.new('L', (width * ss, model_height * ss), 255)
    draw = ImageDraw.Draw(canvas)
    line_width = clamp(base_width * np.sqrt(sx * sy), 1, 10)
    for s in strokes:
        mapped = [((x - min_x + margin_x) * sx * ss, (y - min_y + margin_y) * sy * ss) for x, y in s]
        lw = line_width * ss
        if len(mapped) == 1:
            x, y = mapped[0]
            draw.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=0)
            continue
        draw.line(mapped, fill=0, width=max(1, int(round(lw))), joint='curve')
        for x, y in (mapped[0], mapped[-1]):
            draw.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=0)
    return canvas.resize((width, model_height), Image.LANCZOS)


def normalize_text(value):
    return unicodedata.normalize('NFC', ' '.join(value.split()))
