#!/usr/bin/env python3
"""Create a deterministic linear interpolation of two TrOCR checkpoints."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate-weight", type=float, required=True)
    args = parser.parse_args()

    if not 0 < args.candidate_weight < 1:
        parser.error("--candidate-weight must be strictly between zero and one")
    base = args.base.resolve()
    candidate = args.candidate.resolve()
    output = args.output.resolve()
    if output in {base, candidate}:
        parser.error("--output must differ from both input checkpoints")
    base_model = base / "model.safetensors"
    candidate_model = candidate / "model.safetensors"
    if not base_model.is_file() or not candidate_model.is_file():
        parser.error("both checkpoints must contain model.safetensors")

    output.mkdir(parents=True, exist_ok=True)
    with (
        safe_open(base_model, framework="pt", device="cpu") as base_handle,
        safe_open(candidate_model, framework="pt", device="cpu") as candidate_handle,
    ):
        base_keys = list(base_handle.keys())
        candidate_keys = list(candidate_handle.keys())
        if base_keys != candidate_keys:
            raise ValueError("checkpoint parameter sets differ")
        tensors: dict[str, torch.Tensor] = {}
        for key in base_keys:
            base_tensor = base_handle.get_tensor(key)
            candidate_tensor = candidate_handle.get_tensor(key)
            if base_tensor.shape != candidate_tensor.shape or base_tensor.dtype != candidate_tensor.dtype:
                raise ValueError(f"incompatible parameter: {key}")
            if base_tensor.is_floating_point():
                tensors[key] = torch.lerp(base_tensor, candidate_tensor, args.candidate_weight)
            else:
                if not torch.equal(base_tensor, candidate_tensor):
                    raise ValueError(f"non-floating parameter differs: {key}")
                tensors[key] = base_tensor.clone()
        metadata = base_handle.metadata()
    output_model = output / "model.safetensors"
    save_file(tensors, output_model, metadata=metadata)

    copied_assets: list[str] = []
    for source in sorted(base.iterdir()):
        if not source.is_file() or source.name in {"model.safetensors", "training-metrics.json"}:
            continue
        shutil.copy2(source, output / source.name)
        copied_assets.append(source.name)
    provenance = {
        "format": "fanotes-trocr-interpolation-v1",
        "base": {"path": str(base), "sha256": sha256(base_model)},
        "candidate": {"path": str(candidate), "sha256": sha256(candidate_model)},
        "candidateWeight": args.candidate_weight,
        "model": {"file": output_model.name, "sha256": sha256(output_model)},
        "copiedAssets": copied_assets,
    }
    (output / "interpolation.json").write_text(
        json.dumps(provenance, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(provenance, indent=2), flush=True)


if __name__ == "__main__":
    main()
