#!/usr/bin/env python3
"""Create the bounded Q8 PyLaia model used only by the Web app.

The convolution stack stays in FP32 because dynamic ConvInteger support varies
between browser WASM builds. Recurrent and projection weights are quantized to
signed 8-bit values, which removes most of the model weight memory while
retaining the exact input/output contract of the desktop FP32 model.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--keep-fp32-node", action="append", default=[])
    parser.add_argument("--quantize-node", action="append", default=[])
    parser.add_argument("--maximum-size-ratio", type=float, default=0.9)
    args = parser.parse_args()
    if not args.input.is_file():
        raise FileNotFoundError(args.input)
    if args.output.exists():
        raise FileExistsError(args.output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        model_input=str(args.input),
        model_output=str(args.output),
        op_types_to_quantize=["LSTM", "MatMul"],
        per_channel=False,
        reduce_range=False,
        weight_type=QuantType.QInt8,
        nodes_to_quantize=args.quantize_node or None,
        nodes_to_exclude=args.keep_fp32_node,
        extra_options={"EnableSubgraph": True},
    )
    model = onnx.load(args.output, load_external_data=False)
    onnx.checker.check_model(model)
    if [value.name for value in model.graph.input] != ["x"]:
        raise RuntimeError("The quantized model changed the input contract.")
    if [value.name for value in model.graph.output] != ["probabilities"]:
        raise RuntimeError("The quantized model changed the output contract.")
    if args.output.stat().st_size >= args.input.stat().st_size * args.maximum_size_ratio:
        raise RuntimeError("Q8 did not reduce the model enough to justify a Web variant.")
    print(f"{args.output} {args.output.stat().st_size} {sha256(args.output)}")


if __name__ == "__main__":
    main()
