"""Precomputes pen-domain skeleton strokes for every scanned/offline line source."""
import glob
import io
import os
import pickle
import sys
import zlib
from multiprocessing import Pool

import numpy as np
import pyarrow.parquet as pq
from PIL import Image

from scans import load_scads, skeleton_strokes

from inkpaths import DATA
OUT = os.path.join(DATA, 'scan-strokes.pkl')


def _job(args):
    source, key, split, writer, text, payload = args
    try:
        image = Image.open(io.BytesIO(payload) if isinstance(payload, bytes) else payload).convert('L')
        strokes = skeleton_strokes(image)
        packed = (np.concatenate(strokes).astype(np.float32) if strokes else np.zeros((0, 2), np.float32),
                  np.array([len(s) for s in strokes], dtype=np.int32))
    except Exception:
        packed = (np.zeros((0, 2), np.float32), np.zeros(0, np.int32))
    return {'source': source, 'key': key, 'split': split, 'writer': writer, 'text': text, 'strokes': packed}


def jobs():
    for row in load_scads():
        bucket = zlib.crc32(row['writer'].encode()) % 10
        split = 'test' if bucket in (5, 6) else 'val' if bucket == 0 else 'train'
        yield ('scads', row['path'], split, row['writer'], row['text'], row['path'])
    for split_name, split in (('train', 'train'), ('validation', 'val'), ('test', 'test')):
        table = pq.read_table(os.path.join(DATA, 'iam-line', 'data', f'{split_name}.parquet'))
        for index, row in enumerate(table.to_pylist()):
            yield ('iam', f'iam-{split_name}-{index}', split, '', ' '.join((row['text'] or '').split()), row['image']['bytes'])
    for path in sorted(glob.glob(os.path.join(DATA, 'fhswf', 'data', '*.parquet'))):
        table = pq.read_table(path)
        for index, row in enumerate(table.to_pylist()):
            yield ('fhswf', f'{os.path.basename(path)}-{index}', 'train', '', ' '.join((row['text'] or '').split()), row['image']['bytes'])


if __name__ == '__main__':
    processes = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    with Pool(processes) as pool:
        rows = []
        for count, row in enumerate(pool.imap_unordered(_job, jobs(), chunksize=16), 1):
            rows.append(row)
            if count % 1000 == 0:
                print(count, flush=True)
    pickle.dump(rows, open(OUT, 'wb'), protocol=4)
    from collections import Counter
    print(Counter((r['source'], r['split']) for r in rows))
    print('empty', sum(1 for r in rows if not len(r['strokes'][1])))
