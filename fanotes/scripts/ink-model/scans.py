"""Turns scanned handwriting lines into pen-domain strokes (binarize, thin, trace)."""
import csv
import os
import re
import zlib

import numpy as np
from PIL import Image
from skimage.filters import threshold_otsu
from skimage.morphology import remove_small_objects, skeletonize

from inkpaths import DATA
SCADS = os.path.join(DATA, 'scads')


def skeleton_strokes(gray):
    """gray: uint8 array (dark ink). Returns 2-point strokes along the ink centerline."""
    array = np.asarray(gray, dtype=np.float32)
    if array.size == 0 or array.max() - array.min() < 20:
        return []
    threshold = threshold_otsu(array)
    ink = array < threshold
    ink = remove_small_objects(ink, max(3, int(ink.size * 0.00002)))
    skeleton = skeletonize(ink)
    ys, xs = np.nonzero(skeleton)
    if len(xs) < 10:
        return []
    present = set(zip(ys.tolist(), xs.tolist()))
    offsets = ((0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1))

    def neighbours(pixel):
        y, x = pixel
        return [(y + dy, x + dx) for dy, dx in offsets if (y + dy, x + dx) in present]

    degree = {pixel: len(neighbours(pixel)) for pixel in present}
    seen = set()
    polylines = []
    for start in sorted(present, key=lambda pixel: (degree[pixel] == 2, pixel)):
        if degree[start] == 0:
            polylines.append([start])
            continue
        for first in neighbours(start):
            edge = (min(start, first), max(start, first))
            if edge in seen:
                continue
            seen.add(edge)
            path = [start, first]
            previous, current = start, first
            while degree[current] == 2:
                following = [pixel for pixel in neighbours(current) if pixel != previous]
                if not following:
                    break
                step = following[0]
                edge = (min(current, step), max(current, step))
                if edge in seen:
                    break
                seen.add(edge)
                path.append(step)
                previous, current = current, step
            polylines.append(path)
    return [np.array([[x, y] for y, x in path], dtype=np.float32) for path in polylines]


def scads_writer(page_meta, page_id):
    meta = page_meta.get(int(page_id))
    return f'{meta[0]}-{meta[1]}' if meta else f'page-{page_id}'


def scads_split(writer):
    bucket = zlib.crc32(writer.encode()) % 10
    return 'test' if bucket == 5 else 'val' if bucket == 0 else 'train'


def load_scads():
    page_meta = {}
    with open(os.path.join(SCADS, 'metadata', 'Uni_Leipzig_01-export-251205.csv'), encoding='utf-8') as handle:
        for row in csv.DictReader(handle):
            page_meta[int(row['pageid'])] = (row['gender'], row['yearofbirth'])
    rows = []
    with open(os.path.join(SCADS, 'ground_truth', 'csv', 'line_annotations.csv'), encoding='utf-8') as handle:
        for row in csv.DictReader(handle):
            writer = scads_writer(page_meta, row['page_id'])
            rows.append({
                'path': os.path.join(SCADS, 'images', 'lines', row['line_file']),
                'text': ' '.join(row['text'].split()),
                'writer': writer,
                'split': scads_split(writer),
            })
    return rows


class ScanSource:
    def __init__(self, rows):
        self.rows = rows
        self.cache = {}

    def strokes(self, row):
        key = row['path']
        if key not in self.cache:
            gray = Image.open(key).convert('L')
            self.cache[key] = skeleton_strokes(gray)
        return self.cache[key]

    def sample(self, rng):
        for _ in range(10):
            row = self.rows[rng.integers(len(self.rows))]
            strokes = self.strokes(row)
            if strokes and row['text']:
                return row['text'], strokes
        return None, None


def unpack(packed):
    points, lengths = packed
    out = []
    start = 0
    for length in lengths:
        out.append(points[start:start + length].astype(np.float64))
        start += length
    return out


def detokenize(text):
    """IAM transcriptions separate punctuation and clitics; notes do not."""
    words = text.split()
    out = []
    quote_open = False
    for word in words:
        if word == '"':
            if quote_open:
                if out:
                    out[-1] += '"'
                else:
                    out.append('"')
            else:
                out.append('"')
            quote_open = not quote_open
            continue
        if out and (out[-1] == '"' and quote_open or out[-1] in ('(', '[')):
            out[-1] += word
        elif out and re.fullmatch(r"[.,;:!?)\]]+|'(?:s|t|ll|ve|re|d|m)|n't", word, re.IGNORECASE):
            out[-1] += word
        else:
            out.append(word)
    return ' '.join(out)


class PackedScanSource:
    """Scan lines from `prepare_scans.py` (already traced into pen polylines)."""

    def __init__(self, rows):
        self.rows = [row for row in rows if len(row['strokes'][1]) and row['text']]
        for row in self.rows:
            if row['source'] == 'iam':
                row['text'] = detokenize(row['text'])

    def sample(self, rng):
        row = self.rows[rng.integers(len(self.rows))]
        return row['text'], unpack(row['strokes'])
