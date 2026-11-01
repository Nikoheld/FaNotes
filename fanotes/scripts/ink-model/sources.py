"""Training sources beyond the real BRUSH lines: traced scans and writer-composed lines."""
import os
import pickle

from inkpaths import DATA

SCANS = os.path.join(DATA, 'scan-strokes.pkl')
_scans = None


def scan_rows():
    global _scans
    if _scans is None:
        _scans = pickle.load(open(SCANS, 'rb'))
    return _scans


def build(name, rows):
    if name == 'composed':
        from compose import ComposedSource
        return ComposedSource([row for row in rows if row['split'] == 'train'])
    if name in ('scads', 'iam', 'fhswf'):
        from scans import PackedScanSource
        return PackedScanSource([row for row in scan_rows() if row['source'] == name and row['split'] == 'train'])
    raise ValueError(name)


def validation(name, limit=150):
    import random
    from scans import detokenize, unpack
    chosen = [row for row in scan_rows() if row['source'] == name and row['split'] == 'val' and len(row['strokes'][1]) and row['text']]
    random.Random(3).shuffle(chosen)
    return [(detokenize(row['text']) if name == 'iam' else row['text'], unpack(row['strokes'])) for row in chosen[:limit]]
