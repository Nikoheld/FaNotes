"""Writes recognition check cases: the committed license-clean set and a private evaluation set."""
import json
import os
import pickle
import random
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brushdata import load_all, strokes_of  # noqa: E402
from scans import detokenize, unpack  # noqa: E402
from train import encode  # noqa: E402

from inkpaths import REPO, DATA
REPO_FIXTURE = os.path.join(REPO, 'scripts', 'fixtures', 'ink-recognition-cases.json')


def simplify(points, epsilon):
    if len(points) < 3:
        return points
    start, end = points[0], points[-1]
    direction = end - start
    length = np.hypot(*direction)
    if length < 1e-9:
        distances = np.hypot(*(points - start).T)
    else:
        offset = points - start
        distances = np.abs(direction[0] * offset[:, 1] - direction[1] * offset[:, 0]) / length
    index = int(np.argmax(distances))
    if distances[index] > epsilon:
        return np.vstack([simplify(points[:index + 1], epsilon)[:-1], simplify(points[index:], epsilon)])
    return np.vstack([start, end])


def case(name, language, truth, strokes, epsilon=0.0, digits=5):
    points = np.concatenate(strokes)
    margin = 4.0
    min_x, min_y = points.min(0) - margin
    width = float(points[:, 0].max() - min_x + margin)
    height = float(points[:, 1].max() - min_y + margin)
    out = []
    for stroke in strokes:
        s = np.asarray(stroke, dtype=np.float64)
        if epsilon and len(s) > 2:
            s = simplify(s, epsilon)
        out.append([[round((x - min_x) / width, digits), round((y - min_y) / height, digits)] for x, y in s])
    return {'name': name, 'language': language, 'truth': truth, 'sourceWidth': round(width, 2), 'sourceHeight': round(height, 2), 'strokes': out}


def main():
    scans = pickle.load(open(os.path.join(DATA, 'scan-strokes.pkl'), 'rb'))
    scads = [r for r in scans if r['source'] == 'scads' and r['split'] == 'test' and len(r['strokes'][1]) and encode(r['text'])]
    random.Random(21).shuffle(scads)
    iam_fixture = json.load(open(os.path.join(REPO, 'scripts', 'fixtures', 'iam-online-a01-001z-01.json')))
    W, H = iam_fixture['sourceWidth'], iam_fixture['sourceHeight']
    iam_strokes = [np.array([[p[0] * W, p[1] * H] for p in stroke]) for stroke in iam_fixture['strokes']]
    committed = [case('iam-ondb-a01-001z-01', 'en', iam_fixture['truth'], iam_strokes)]
    for index, row in enumerate(scads[:16]):
        committed.append(case(f'scads-test-{index:02d}', 'de', row['text'], unpack(row['strokes']), epsilon=0.6, digits=4))
    json.dump(committed, open(REPO_FIXTURE, 'w'), separators=(',', ':'), ensure_ascii=False)
    print('committed', len(committed), os.path.getsize(REPO_FIXTURE) // 1024, 'KiB')

    private = list(committed)
    rows = [r for r in load_all() if r['split'] == 'test' and encode(r['text'])]
    random.Random(4).shuffle(rows)
    for index, row in enumerate(rows[:150]):
        private.append(case(f'brush-{row["writer"]}-{row["name"]}', 'en', row['text'], strokes_of(row['drawing'])))
    iam = [r for r in scans if r['source'] == 'iam' and r['split'] == 'test' and len(r['strokes'][1]) and encode(detokenize(r['text']))]
    random.Random(8).shuffle(iam)
    for index, row in enumerate(iam[:120]):
        private.append(case(f'iam-test-{index:03d}', 'en', detokenize(row['text']), unpack(row['strokes']), epsilon=0.6, digits=4))
    for index, row in enumerate(scads[16:136]):
        private.append(case(f'scads-test-{index + 16:03d}', 'de', row['text'], unpack(row['strokes']), epsilon=0.6, digits=4))
    json.dump(private, open(os.path.join(DATA, 'ink-eval-cases.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
    print('private', len(private), os.path.getsize('/tmp/ink-eval-cases.json') // 1024, 'KiB')


if __name__ == '__main__':
    main()
