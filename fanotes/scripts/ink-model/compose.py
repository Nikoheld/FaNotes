"""Composes natural German/English lines from one BRUSH writer's real character strokes."""
import os
import random
import re
from collections import defaultdict

import numpy as np

from brushdata import strokes_of

from inkpaths import DATA
TEXT_ROOT = os.path.join(DATA, 'text')
FLAT_LOWER = set('acemnorsuvwxz')
UMLAUT_BASE = {'ä': 'a', 'ö': 'o', 'ü': 'u', 'Ä': 'A', 'Ö': 'O', 'Ü': 'U'}


def _baseline(row):
    """Median bottom of the writer's non-descending lowercase letters in one sample."""
    bottoms = []
    for index, char in enumerate(row['text']):
        if char in FLAT_LOWER:
            mask = row['chars'] == index
            if mask.sum() >= 2:
                bottoms.append(float(row['drawing'][mask, 1].max()))
    return float(np.median(bottoms)) if bottoms else None


class WriterGlyphs:
    def __init__(self, rows):
        self.glyphs = defaultdict(list)
        self.inner_gaps = []
        self.word_gaps = []
        self.dots = []
        heights = []
        for row in rows:
            baseline = _baseline(row)
            if baseline is None:
                continue
            text = row['text']
            boxes = {}
            for index, char in enumerate(text):
                if char == ' ':
                    continue
                mask = row['chars'] == index
                if mask.sum() < 1:
                    continue
                strokes = strokes_of(row['drawing'], mask)
                strokes = [s - np.array([0.0, baseline]) for s in strokes if len(s)]
                if not strokes:
                    continue
                points = np.concatenate(strokes)
                box = (points[:, 0].min(), points[:, 0].max())
                boxes[index] = box
                self.glyphs[char].append((strokes, box))
                if char in FLAT_LOWER:
                    heights.append(-points[:, 1].min())
                if char == 'i' and len(strokes) >= 2:
                    small = min(strokes, key=lambda s: np.ptp(s[:, 0]) + np.ptp(s[:, 1]))
                    if np.ptp(small[:, 0]) + np.ptp(small[:, 1]) < 6:
                        self.dots.append(small - small.mean(0))
            for index in range(len(text) - 1):
                if index in boxes and index + 1 in boxes:
                    self.inner_gaps.append(boxes[index + 1][0] - boxes[index][1])
                elif text[index + 1] == ' ' and index in boxes and index + 2 in boxes:
                    self.word_gaps.append(boxes[index + 2][0] - boxes[index][1])
        self.x_height = float(np.median(heights)) if heights else 20.0
        if not self.inner_gaps:
            self.inner_gaps = [1.0]
        if not self.word_gaps:
            self.word_gaps = [self.x_height]

    def supports(self, text):
        for char in text:
            if char == ' ':
                continue
            base = UMLAUT_BASE.get(char, char)
            if not self.glyphs.get(base):
                return False
        return True

    def _dot(self, rng, x, y):
        if self.dots and rng.random() < 0.8:
            dot = self.dots[rng.integers(len(self.dots))]
            return dot + np.array([x, y])
        r = self.x_height * rng.uniform(0.03, 0.09)
        return np.array([[x - r, y], [x + r, y + rng.uniform(-r, r)]])

    def compose(self, text, rng):
        strokes = []
        cursor = 0.0
        drift = rng.uniform(-0.08, 0.08) * self.x_height
        for position, char in enumerate(text):
            if char == ' ':
                cursor += max(self.x_height * 0.35, rng.choice(self.word_gaps)) - rng.choice(self.inner_gaps)
                continue
            base = UMLAUT_BASE.get(char, char)
            options = self.glyphs[base]
            glyph_strokes, (left, right) = options[rng.integers(len(options))]
            dy = drift * position / max(1, len(text)) + rng.normal(0, 0.03) * self.x_height
            shifted = [s + np.array([cursor - left, dy]) for s in glyph_strokes]
            strokes.extend(shifted)
            if char in UMLAUT_BASE:
                points = np.concatenate(shifted)
                top = points[:, 1].min()
                width = points[:, 0].max() - points[:, 0].min()
                center = points[:, 0].min() + width / 2
                y = top - self.x_height * rng.uniform(0.25, 0.45)
                spread = max(self.x_height * 0.18, width * 0.22)
                strokes.append(self._dot(rng, center - spread, y))
                strokes.append(self._dot(rng, center + spread, y))
            cursor += right - left + float(np.clip(rng.choice(self.inner_gaps), -self.x_height * 0.5, self.x_height * 0.8))
        return strokes


def _sentences(language, limit=400_000):
    path = os.path.join(TEXT_ROOT, f'{language}_sentences.tsv')
    lines = []
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            parts = line.rstrip('\n').split('\t')
            if len(parts) == 3 and 8 <= len(parts[2]) <= 140:
                lines.append(parts[2])
            if len(lines) >= limit:
                break
    return lines


def _wiki(language, limit=300_000):
    import pyarrow.parquet as pq
    folder = os.path.join(TEXT_ROOT, '20231101.' + {'deu': 'de', 'eng': 'en'}[language])
    files = sorted(os.listdir(folder))
    table = pq.read_table(os.path.join(folder, files[0]), columns=['text'])
    out = []
    for article in table.column('text').to_pylist():
        for paragraph in article.split('\n'):
            paragraph = paragraph.strip()
            if len(paragraph) < 40 or paragraph.startswith(('|', '{', '<', '*', '#', '=')):
                continue
            for sentence in re.split(r'(?<=[.!?])\s+', paragraph):
                if 12 <= len(sentence) <= 220:
                    out.append(sentence)
        if len(out) >= limit:
            break
    return out


class TextPool:
    def __init__(self, seed=3):
        rng = random.Random(seed)
        self.pools = {}
        for language in ('deu', 'eng'):
            pool = _sentences(language) + _wiki(language)
            rng.shuffle(pool)
            self.pools[language] = pool

    def line(self, rng, language=None):
        language = language or ('deu' if rng.random() < 0.6 else 'eng')
        pool = self.pools[language]
        sentence = pool[rng.integers(len(pool))]
        sentence = sentence.replace('ß', 'ss').replace('ẞ', 'SS')
        words = sentence.split()
        if not words:
            return 'test'
        length = int(rng.choice([1, 2, 3, 4, 5, 6, 7, 8, 9], p=[0.06, 0.1, 0.14, 0.16, 0.16, 0.14, 0.1, 0.08, 0.06]))
        start = rng.integers(0, max(1, len(words) - length + 1))
        return ' '.join(words[start:start + length])


class ComposedSource:
    def __init__(self, rows, pool=None):
        by_writer = defaultdict(list)
        for row in rows:
            by_writer[row['writer']].append(row)
        self.writers = [WriterGlyphs(writer_rows) for writer_rows in by_writer.values()]
        self.pool = pool or TextPool()

    def sample(self, rng):
        for _ in range(20):
            writer = self.writers[rng.integers(len(self.writers))]
            text = self.pool.line(rng)
            if writer.supports(text):
                return text, writer.compose(text, rng)
        return None, None
