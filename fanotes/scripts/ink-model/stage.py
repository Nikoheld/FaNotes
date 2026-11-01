"""Stages an exported ink model, the language models and the ONNX Runtime glue into FaNotes."""
import argparse
import hashlib
import json
import os
import shutil

from inknet import base_alphabet

from inkpaths import REPO as APP
TARGET = os.path.join(APP, 'public', 'ocr', 'fanotes-ink')


def describe(path):
    data = open(path, 'rb').read()
    return {'file': os.path.basename(path), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, help='fp32 ONNX run natively by the fanotes-ocr sidecar')
    parser.add_argument('--precision', default='fp32')
    parser.add_argument('--lm-de', required=True)
    parser.add_argument('--lm-en', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--decoder', default='{"lmWeight":0.55,"wordBonus":1.2,"unknownWordPenalty":-0.4,"insertionBonus":0.6,"beamWidth":16}')
    parser.add_argument('--training', default='{}', help='JSON metadata about data and metrics')
    args = parser.parse_args()
    os.makedirs(TARGET, exist_ok=True)
    for name in os.listdir(TARGET):
        if name.endswith(('.onnx', '.fnlm', '.mjs')):
            os.remove(os.path.join(TARGET, name))
    model = os.path.join(TARGET, 'ink.onnx')
    shutil.copyfile(args.model, model)
    lm_de = os.path.join(TARGET, 'de.fnlm')
    lm_en = os.path.join(TARGET, 'en.fnlm')
    shutil.copyfile(args.lm_de, lm_de)
    shutil.copyfile(args.lm_en, lm_en)
    model_descriptor = {**describe(model), 'precision': args.precision}
    alphabet = base_alphabet()
    manifest = {
        'format': 'fanotes-ink-recognizer-v1',
        'name': 'FaNotes_Ink_DE_EN',
        'version': args.version,
        'alphabet': alphabet,
        'height': 64,
        'frameStride': 4,
        'featureDim': 512,
        'classes': len(alphabet) + 1,
        'models': {'desktop': model_descriptor},
        'languageModels': {'de': describe(lm_de), 'en': describe(lm_en)},
        'decoder': json.loads(args.decoder),
        'training': json.loads(args.training),
    }
    with open(os.path.join(TARGET, 'manifest.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    print(json.dumps({k: v for k, v in manifest.items() if k not in ('alphabet', 'training')}, indent=1))


if __name__ == '__main__':
    main()
