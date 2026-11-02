"""PyTorch rebuild of de-htr-web-v2 (Apache-2.0) used as the FaNotes ink recognizer base.

BatchNorm is folded into the convolutions exactly as in the published ONNX file, so the
weights load one-to-one and fine-tuning starts from the released function.
"""
import json
import os

import numpy as np
import onnx
import torch
import torch.nn.functional as F
from onnx import numpy_helper
from torch import nn

from inkpaths import MODELS
BASE_ONNX = os.path.join(MODELS, 'de-htr-web-v2', 'model-fp32.onnx')
BASE_CONFIG = os.path.join(MODELS, 'de-htr-web-v2', 'config.json')
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def conv(cin, cout, kernel, stride, padding):
    return nn.Conv2d(cin, cout, kernel, stride=stride, padding=padding, bias=True)


class Block(nn.Module):
    def __init__(self, cin, cout, stride):
        super().__init__()
        self.conv1 = conv(cin, cout, 3, stride, 1)
        self.conv2 = conv(cout, cout, 3, 1, 1)
        self.downsample = conv(cin, cout, 1, stride, 0) if stride != (1, 1) or cin != cout else None

    def forward(self, x):
        y = self.conv2(F.relu(self.conv1(x)))
        return F.relu(y + (self.downsample(x) if self.downsample is not None else x))


class InkNet(nn.Module):
    def __init__(self, classes=112, hidden=256):
        super().__init__()
        self.register_buffer('mean', torch.tensor(IMAGENET_MEAN).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor(IMAGENET_STD).view(1, 3, 1, 1))
        self.stem = conv(3, 64, 7, 2, 3)
        self.layer1 = nn.Sequential(Block(64, 64, (1, 1)), Block(64, 64, (1, 1)))
        self.layer2 = nn.Sequential(Block(64, 128, (2, 2)), Block(128, 128, (1, 1)))
        self.layer3 = nn.Sequential(Block(128, 256, (2, 1)), Block(256, 256, (1, 1)))
        self.project = conv(256, 1536, 1, 1, 0)
        self.rnn = nn.LSTM(1536, hidden, num_layers=3, bidirectional=True)
        self.dropout = nn.Dropout(0.0)
        self.head = nn.Linear(2 * hidden, classes)

    def features(self, image):
        """image: [B, 1, 64, W] in 0..1 (white paper = 1). Returns [T, B, 512]."""
        x = (image.expand(-1, 3, -1, -1) - self.mean) / self.std
        x = F.relu(self.stem(x))
        x = F.max_pool2d(x, 3, stride=(2, 1), padding=1)
        x = self.layer3(self.layer2(self.layer1(x)))
        x = F.relu(self.project(x)).mean(dim=2)
        x = x.permute(2, 0, 1)
        out, _ = self.rnn(x)
        return out

    def forward(self, image):
        return self.head(self.dropout(self.features(image)))

    @staticmethod
    def frames(width):
        return (width + 3) // 4


def _onnx_gates_to_torch(weight, hidden):
    i, o, f, c = (weight[k * hidden:(k + 1) * hidden] for k in range(4))
    return np.concatenate([i, f, c, o], axis=0)


def load_base(classes_extra=0):
    model = InkNet()
    graph = onnx.load(BASE_ONNX).graph
    inits = {i.name: numpy_helper.to_array(i) for i in graph.initializer}
    convs = [n for n in graph.node if n.op_type == 'Conv']
    targets = [model.stem]
    for layer in (model.layer1, model.layer2, model.layer3):
        for block in layer:
            targets += [block.conv1, block.conv2]
            if block.downsample is not None:
                targets.append(block.downsample)
    targets.append(model.project)
    assert len(convs) == len(targets), (len(convs), len(targets))
    with torch.no_grad():
        for node, module in zip(convs, targets):
            module.weight.copy_(torch.from_numpy(inits[node.input[1]]))
            module.bias.copy_(torch.from_numpy(inits[node.input[2]]))
        lstms = [n for n in graph.node if n.op_type == 'LSTM']
        hidden = model.rnn.hidden_size
        for layer, node in enumerate(lstms):
            W, R, B = (inits[name] for name in node.input[1:4])
            for direction, suffix in enumerate(['', '_reverse']):
                getattr(model.rnn, f'weight_ih_l{layer}{suffix}').copy_(torch.from_numpy(_onnx_gates_to_torch(W[direction], hidden)))
                getattr(model.rnn, f'weight_hh_l{layer}{suffix}').copy_(torch.from_numpy(_onnx_gates_to_torch(R[direction], hidden)))
                getattr(model.rnn, f'bias_ih_l{layer}{suffix}').copy_(torch.from_numpy(_onnx_gates_to_torch(B[direction][:4 * hidden], hidden)))
                getattr(model.rnn, f'bias_hh_l{layer}{suffix}').copy_(torch.from_numpy(_onnx_gates_to_torch(B[direction][4 * hidden:], hidden)))
        matmul = next(n for n in graph.node if n.op_type == 'MatMul')
        model.head.weight.copy_(torch.from_numpy(inits[matmul.input[1]].T.copy()))
        model.head.bias.copy_(torch.from_numpy(inits['classifier.bias']))
    if classes_extra:
        old = model.head
        model.head = nn.Linear(old.in_features, old.out_features + classes_extra)
        with torch.no_grad():
            model.head.weight[:old.out_features] = old.weight
            model.head.bias[:old.out_features] = old.bias
            model.head.weight[old.out_features:] = old.weight.mean(0, keepdim=True)
            model.head.bias[old.out_features:] = old.bias.min() - 2.0
    return model


def base_alphabet():
    return json.load(open(BASE_CONFIG))['alphabet']


if __name__ == '__main__':
    import onnxruntime as ort
    model = load_base().eval()
    session = ort.InferenceSession(BASE_ONNX, providers=['CPUExecutionProvider'])
    x = np.random.RandomState(0).rand(1, 1, 64, 320).astype(np.float32)
    x[x > 0.2] = 1.0
    reference = session.run(None, {'image': x})[0][0]
    with torch.no_grad():
        ours = model(torch.from_numpy(x))[:, 0].numpy()
    print('shapes', reference.shape, ours.shape, 'max abs diff', np.abs(reference - ours).max())
