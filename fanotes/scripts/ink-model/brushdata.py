"""BRUSH loading, writer-disjoint splits and per-character glyph extraction."""
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import BRUSH_ROOT, brush_writers  # noqa: E402

from inkpaths import DATA
CACHE = os.path.join(DATA, 'brush-cache.pkl')


def split_of(writer):
    w = int(writer)
    if w % 10 == 5:
        return 'test'
    if w % 10 == 0:
        return 'val'
    return 'train'


def load_all():
    if os.path.exists(CACHE):
        return pickle.load(open(CACHE, 'rb'))
    rows = []
    for writer in brush_writers():
        folder = os.path.join(BRUSH_ROOT, writer)
        for name in sorted(os.listdir(folder)):
            if '_' in name:
                continue
            sentence, drawing, label = pickle.load(open(os.path.join(folder, name), 'rb'))
            rows.append({
                'writer': writer,
                'split': split_of(writer),
                'name': name,
                'text': sentence,
                'drawing': np.asarray(drawing, dtype=np.float32),
                'chars': np.asarray(label, dtype=np.float32).argmax(1).astype(np.int16),
            })
    pickle.dump(rows, open(CACHE, 'wb'), protocol=4)
    return rows


def strokes_of(drawing, keep=None):
    """(N,3) drawing -> list of (K,2) arrays; `keep` is an optional boolean point mask."""
    strokes = []
    current = []
    for index, (x, y, eos) in enumerate(drawing):
        if keep is None or keep[index]:
            current.append((x, y))
        elif current:
            strokes.append(np.array(current))
            current = []
        if eos >= 0.5:
            if current:
                strokes.append(np.array(current))
            current = []
    if current:
        strokes.append(np.array(current))
    return strokes


if __name__ == '__main__':
    rows = load_all()
    from collections import Counter
    print(len(rows), Counter(r['split'] for r in rows))
