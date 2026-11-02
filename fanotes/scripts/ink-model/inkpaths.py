"""Filesystem roots for the ink-model scripts.

Datasets, intermediate caches, language models and checkpoints live outside the repository.
Override the base with `FANOTES_INK_HOME` (default `~/.cache/fanotes-ink`).
"""
import os

HOME = os.environ.get('FANOTES_INK_HOME', os.path.expanduser('~/.cache/fanotes-ink'))
DATA = os.path.join(HOME, 'data')
LM = os.path.join(HOME, 'lm')
RUNS = os.path.join(HOME, 'runs')
MODELS = os.path.join(HOME, 'models')
EXPORT = os.path.join(HOME, 'export')
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

for directory in (DATA, LM, RUNS, MODELS, EXPORT):
    os.makedirs(directory, exist_ok=True)
