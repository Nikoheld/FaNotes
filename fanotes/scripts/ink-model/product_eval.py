"""Score a checkpoint with the desktop recognizer (the same check the app ships).

Prints one JSON object: German and English golden error, the stacked IAM page,
and, when a pen-line file is passed, that file's character error. The committed
model is left untouched.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile

import torch
from torch import nn

from inknet import load_base

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHIPPED = os.path.join(APP, 'public', 'ocr', 'fanotes-ink')
CHECK = os.path.join(APP, 'scripts', 'check-ink-recognition.mjs')


class Exported(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, image):
        features = self.model.features(image)
        logits = self.model.head(features)
        return logits.transpose(0, 1), features.transpose(0, 1)


def export_fp32(checkpoint, dest):
    model = load_base()
    if checkpoint != 'base':
        model.load_state_dict(torch.load(checkpoint, map_location='cpu'))
    model.eval()
    wrapper = Exported(model).eval()
    dummy = torch.ones(1, 1, 64, 256)
    torch.onnx.export(
        wrapper, (dummy,), dest,
        input_names=['image'], output_names=['logits', 'features'],
        dynamic_axes={'image': {3: 'width'}, 'logits': {1: 'frames'}, 'features': {1: 'frames'}},
        opset_version=17, dynamo=False,
    )


def stage_dir(checkpoint, directory):
    os.makedirs(directory, exist_ok=True)
    onnx_path = os.path.join(directory, 'ink.onnx')
    export_fp32(checkpoint, onnx_path)
    for name in ('de.fnlm', 'en.fnlm'):
        source = os.path.join(SHIPPED, name)
        target = os.path.join(directory, name)
        if os.path.lexists(target):
            os.remove(target)
        os.symlink(source, target)
    manifest = json.load(open(os.path.join(SHIPPED, 'manifest.json'), encoding='utf8'))
    data = open(onnx_path, 'rb').read()
    manifest['models']['desktop']['size'] = len(data)
    manifest['models']['desktop']['sha256'] = hashlib.sha256(data).hexdigest()
    json.dump(manifest, open(os.path.join(directory, 'manifest.json'), 'w', encoding='utf8'), indent=2)
    open(os.path.join(directory, 'manifest.json'), 'a', encoding='utf8').write('\n')


def run_check(directory, cases):
    env = os.environ.copy()
    env['FANOTES_INK_DIR'] = directory
    if cases:
        env['FANOTES_INK_CASES'] = cases
    else:
        env.pop('FANOTES_INK_CASES', None)
    completed = subprocess.run(
        ['node', '--experimental-strip-types', CHECK],
        cwd=APP,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        sys.stderr.write(completed.stdout)
        sys.stderr.write(completed.stderr)
        raise SystemExit(completed.returncode)
    lines = completed.stdout.splitlines()
    start = max(index for index, line in enumerate(lines) if line == '{')
    return json.loads('\n'.join(lines[start:]))


def score(checkpoint, brush):
    with tempfile.TemporaryDirectory(prefix='ink-product-') as directory:
        stage_dir(checkpoint, directory)
        golden = run_check(directory, '')
        report = {
            'deCharacterError': golden['report'].get('de', {}).get('cer'),
            'deWordError': golden['report'].get('de', {}).get('wer'),
            'enCharacterError': golden['report'].get('en', {}).get('cer'),
            'pageCharacterError': golden['pages'][0]['cer'] if golden.get('pages') else None,
        }
        if brush:
            pen = run_check(directory, brush)
            report['penCharacterError'] = pen['report'].get('en', {}).get('cer')
            report['penWordError'] = pen['report'].get('en', {}).get('wer')
        return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('checkpoint')
    parser.add_argument('--brush', default='')
    args = parser.parse_args()
    json.dump(score(args.checkpoint, args.brush), sys.stdout)
    sys.stdout.write('\n')
