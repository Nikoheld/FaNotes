"""Exports an ink recognizer checkpoint for FaNotes (ONNX fp32 + int8, classifier head, manifest)."""
import argparse
import hashlib
import json
import os
import struct

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from torch import nn

from inknet import base_alphabet, load_base

MODEL_NAME = 'FaNotes_Ink_DE_EN'


class Exported(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, image):
        features = self.model.features(image)
        logits = self.model.head(features)
        return logits.transpose(0, 1), features.transpose(0, 1)


def sha256(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def descriptor(path, root):
    return {'file': os.path.relpath(path, root), 'size': os.path.getsize(path), 'sha256': sha256(path)}


def export(checkpoint, out, version):
    os.makedirs(out, exist_ok=True)
    model = load_base()
    if checkpoint != 'base':
        model.load_state_dict(torch.load(checkpoint, map_location='cpu'))
    model.eval()
    wrapper = Exported(model).eval()
    fp32 = os.path.join(out, 'ink-fp32.onnx')
    int8 = os.path.join(out, 'ink-int8.onnx')
    dummy = torch.ones(1, 1, 64, 256)
    torch.onnx.export(
        wrapper, (dummy,), fp32,
        input_names=['image'], output_names=['logits', 'features'],
        dynamic_axes={'image': {3: 'width'}, 'logits': {1: 'frames'}, 'features': {1: 'frames'}},
        opset_version=17, dynamo=False,
    )
    onnx.checker.check_model(onnx.load(fp32))
    quantize_dynamic(fp32, int8, weight_type=QuantType.QInt8)
    head = os.path.join(out, 'head.bin')
    weight = model.head.weight.detach().numpy().astype('<f4')
    bias = model.head.bias.detach().numpy().astype('<f4')
    with open(head, 'wb') as handle:
        handle.write(b'FNHD')
        handle.write(struct.pack('<III', 1, weight.shape[0], weight.shape[1]))
        handle.write(weight.tobytes())
        handle.write(bias.tobytes())
    # Parity: PyTorch vs both exports on a random ink-like input.
    rng = np.random.default_rng(0)
    x = np.ones((1, 1, 64, 320), np.float32)
    for _ in range(40):
        r, c = rng.integers(8, 56), rng.integers(8, 312)
        x[0, 0, r - 2:r + 2, c - 6:c + 6] = 0.0
    with torch.no_grad():
        reference_logits, reference_features = wrapper(torch.from_numpy(x))
    for path in (fp32, int8):
        session = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        logits, features = session.run(None, {'image': x})
        print(os.path.basename(path), os.path.getsize(path) // 1024, 'KiB',
              'logits diff', float(np.abs(logits - reference_logits.numpy()).max()),
              'argmax agree', float((logits.argmax(-1) == reference_logits.numpy().argmax(-1)).mean()))
    alphabet = base_alphabet()
    return model, {'fp32': fp32, 'int8': int8, 'head': head, 'alphabet': alphabet,
                   'classes': int(weight.shape[0]), 'featureDim': int(weight.shape[1]), 'version': version}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('checkpoint')
    from inkpaths import EXPORT
    parser.add_argument('--out', default=EXPORT)
    parser.add_argument('--version', default='1.0.0')
    parser.add_argument('--emit-checkpoint', action='store_true', help='also copy the base .pt for personalize.py')
    args = parser.parse_args()
    model, info = export(args.checkpoint, args.out, args.version)
    if args.emit_checkpoint and args.checkpoint != 'base':
        import shutil
        shutil.copyfile(args.checkpoint, os.path.join(args.out, 'ink-base.pt'))
        print('copied base checkpoint to ink-base.pt (feed it to personalize.py --base)')
    print(json.dumps({k: v for k, v in info.items() if k != 'alphabet'}, indent=1))
