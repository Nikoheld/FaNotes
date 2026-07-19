#!/usr/bin/env python3
"""Create the bounded q8 TrOCR assets consumed by Transformers.js.

The encoder contains a convolution and therefore uses unsigned 8-bit weights,
which ONNX Runtime Web supports for ConvInteger. The decoder uses signed 8-bit
weights, which is faster on most CPUs. Activations remain dynamically
quantized unsigned values. This mirrors the official Transformers.js q8
conversion policy without retaining redundant fp32 models in the application.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import shutil
from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType, QuantizationMode
from onnxruntime.quantization.onnx_quantizer import ONNXQuantizer
from onnxruntime.quantization.registry import IntegerOpsRegistry


MODEL_FILES = ("encoder_model.onnx", "decoder_model_merged.onnx")
METADATA_FILES = (
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "sentencepiece.bpe.model",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
)


def operators(model: onnx.ModelProto) -> set[str]:
    found: set[str] = set()

    def visit(graph: onnx.GraphProto) -> None:
        for node in graph.node:
            found.add(node.op_type)
            for attribute in node.attribute:
                if attribute.type == onnx.AttributeProto.GRAPH:
                    visit(attribute.g)

    visit(model.graph)
    return found


def quantize_q8(source: Path, destination: Path) -> None:
    model = onnx.load_model(source)
    weight_type = QuantType.QUInt8 if "Conv" in operators(model) else QuantType.QInt8
    quantizer = ONNXQuantizer(
        model,
        per_channel=False,
        reduce_range=False,
        mode=QuantizationMode.IntegerOps,
        static=False,
        weight_qType=weight_type,
        activation_qType=QuantType.QUInt8,
        tensors_range=None,
        nodes_to_quantize=[],
        nodes_to_exclude=[],
        op_types_to_quantize=set(IntegerOpsRegistry.keys()),
        extra_options={"EnableSubgraph": True, "MatMulConstBOnly": True},
    )
    quantizer.quantize_model()
    quantized = quantizer.model.model
    onnx.checker.check_model(quantized)
    onnx.save_model(quantized, destination)


def quantize_q4(source: Path, destination: Path) -> None:
    # Imported only for Q4 so the production Q8 path keeps its minimal
    # dependency surface. Block size 32 matches Transformers.js' established
    # browser conversion policy and quantizes constant MatMul weights while
    # leaving convolution and normalization operators intact.
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    options = {
        "model": str(source),
        "block_size": 32,
        "is_symmetric": True,
    }
    if "bits" in inspect.signature(MatMulNBitsQuantizer).parameters:
        options["bits"] = 4
    quantizer = MatMulNBitsQuantizer(**options)
    quantizer.process()
    quantized = quantizer.model.model
    onnx.checker.check_model(quantized)
    onnx.save_model(quantized, destination)


def descriptor(path: Path, root: Path) -> dict[str, object]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return {
        "file": path.relative_to(root).as_posix(),
        "size": path.stat().st_size,
        "sha256": digest.hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=("q8", "q4", "decoder-q8", "encoder-q4-decoder-q8", "encoder-q8-decoder-q8"), required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(f"Output already exists: {args.output}")
    args.output.mkdir(parents=True)
    onnx_output = args.output / "onnx"
    onnx_output.mkdir()

    for name in METADATA_FILES:
        source = args.input / name
        if not source.is_file():
            raise FileNotFoundError(source)
        shutil.copy2(source, args.output / name)
    for name in MODEL_FILES:
        source = args.input / name
        if not source.is_file():
            source = args.input / "onnx" / name
        if not source.is_file():
            raise FileNotFoundError(source)
        if args.mode == "decoder-q8":
            destination = onnx_output / name
            if name == "encoder_model.onnx":
                shutil.copy2(source, destination)
            else:
                quantize_q8(source, destination)
        elif args.mode in {"encoder-q4-decoder-q8", "encoder-q8-decoder-q8"}:
            destination = onnx_output / name
            if name == "encoder_model.onnx":
                (quantize_q4 if args.mode == "encoder-q4-decoder-q8" else quantize_q8)(source, destination)
            else:
                shutil.copy2(source, destination)
        else:
            suffix = "quantized" if args.mode == "q8" else "q4"
            destination = onnx_output / name.replace(".onnx", f"_{suffix}.onnx")
            (quantize_q8 if args.mode == "q8" else quantize_q4)(source, destination)

    assets = [
        descriptor(path, args.output)
        for path in sorted(args.output.rglob("*"))
        if path.is_file()
    ]
    manifest = {
        "format": "fanotes-trocr-web-v1",
        "model": "FaNotes_TrOCR_DE_EN",
        "opset": 18,
        "quantization": {
            "q8": "q8-dynamic",
            "q4": "q4-weight-only",
            "decoder-q8": "fp32-encoder-q8-decoder",
            "encoder-q4-decoder-q8": "q4-encoder-q8-decoder",
            "encoder-q8-decoder-q8": "q8-encoder-q8-decoder",
        }[args.mode],
        "assets": assets,
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
