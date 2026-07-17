#!/usr/bin/env python3
"""Evaluate a local TrOCR checkpoint on independent handwriting lines."""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import io
import json
import re
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import pyarrow.parquet as parquet
import torch
from PIL import Image, ImageOps
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

GERMAN_SPECIALS = set("ÄÖÜäöü")


@dataclass(frozen=True)
class Row:
    image_bytes: bytes
    text: str


@dataclass(frozen=True)
class Failure:
    normalized_distance: float
    truth: str
    prediction: str


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("ẞ", "SS").replace("ß", "ss")).strip()


def edit_distance(first: Sequence[object], second: Sequence[object]) -> int:
    if len(first) < len(second):
        first, second = second, first
    previous = list(range(len(second) + 1))
    for first_index, first_value in enumerate(first, start=1):
        current = [first_index]
        for second_index, second_value in enumerate(second, start=1):
            current.append(min(
                previous[second_index] + 1,
                current[second_index - 1] + 1,
                previous[second_index - 1] + int(first_value != second_value),
            ))
        previous = current
    return previous[-1]


def reference_class_edits(first: str, second: str, accepted: set[str]) -> int:
    """Count substitutions/deletions affecting a selected reference class."""
    rows = len(first) + 1
    columns = len(second) + 1
    matrix = [[0] * columns for _ in range(rows)]
    for row in range(rows):
        matrix[row][0] = row
    for column in range(columns):
        matrix[0][column] = column
    for row in range(1, rows):
        for column in range(1, columns):
            matrix[row][column] = min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                matrix[row - 1][column - 1] + int(first[row - 1] != second[column - 1]),
            )
    edits = 0
    row = len(first)
    column = len(second)
    while row or column:
        if row and column and first[row - 1] == second[column - 1]:
            row -= 1
            column -= 1
        elif row and column and matrix[row][column] == matrix[row - 1][column - 1] + 1:
            edits += int(first[row - 1] in accepted)
            row -= 1
            column -= 1
        elif row and matrix[row][column] == matrix[row - 1][column] + 1:
            edits += int(first[row - 1] in accepted)
            row -= 1
        else:
            column -= 1
    return edits


def writer_split(page_id: str) -> str:
    bucket = int.from_bytes(hashlib.sha256(page_id.encode("utf-8")).digest()[:4], "big") % 10
    if bucket == 0:
        return "test"
    if bucket == 1:
        return "validation"
    return "train"


def load_parquet(path: Path) -> list[Row]:
    table = parquet.read_table(path, columns=["image", "text"])
    rows: list[Row] = []
    for value in table.to_pylist():
        image = value.get("image")
        image_bytes = image.get("bytes") if isinstance(image, dict) else None
        text = normalize_text(str(value.get("text") or ""))
        if image_bytes and text:
            rows.append(Row(image_bytes, text))
    return rows


def load_scads(root: Path, split: str) -> list[Row]:
    rows: list[Row] = []
    with (root / "ground_truth/csv/line_annotations.csv").open(encoding="utf-8", newline="") as handle:
        for value in csv.DictReader(handle):
            if writer_split(value["page_id"]) != split:
                continue
            image_path = root / "images/lines" / value["line_file"]
            text = normalize_text(value["text"])
            if image_path.is_file() and text:
                rows.append(Row(image_path.read_bytes(), text))
    return rows


def selected(rows: list[Row], limit: int) -> list[Row]:
    if limit <= 0 or limit >= len(rows):
        return rows
    indexes = np.linspace(0, len(rows) - 1, num=limit, dtype=np.int64)
    return [rows[index] for index in indexes.tolist()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--dataset", type=Path)
    source.add_argument("--scads-root", type=Path)
    parser.add_argument("--scads-split", choices=["train", "validation", "test"], default="test")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--maximum-target-length", type=int, default=128)
    parser.add_argument("--num-beams", type=int, choices=[1, 2, 4, 6], default=1)
    parser.add_argument("--runtime", choices=["pytorch", "onnx"], default="pytorch")
    parser.add_argument("--encoder-file-name")
    parser.add_argument("--decoder-file-name")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--worst", type=int, default=12)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()

    rows = load_parquet(args.dataset) if args.dataset else load_scads(args.scads_root, args.scads_split)
    rows = selected(rows, args.limit)
    device = torch.device(args.device)
    processor = TrOCRProcessor.from_pretrained(args.model, use_fast=False)
    if args.runtime == "onnx":
        if device.type != "cpu":
            raise ValueError("The bounded ONNX benchmark currently supports --device cpu only.")
        from optimum.onnxruntime import ORTModelForVision2Seq

        model = ORTModelForVision2Seq.from_pretrained(
            args.model,
            encoder_file_name=args.encoder_file_name,
            decoder_file_name=args.decoder_file_name,
            use_merged=True,
        )
    else:
        model = VisionEncoderDecoderModel.from_pretrained(args.model).to(device).eval()
    metrics = {
        "characterEdits": 0,
        "foldedCharacterEdits": 0,
        "characters": 0,
        "wordEdits": 0,
        "words": 0,
        "exact": 0,
        "foldedExact": 0,
        "germanSpecialCharacters": 0,
        "germanSpecialCharacterEdits": 0,
        "latencyMilliseconds": [],
    }
    failures: list[Failure] = []
    wall_started = time.perf_counter()
    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        images = []
        for row in batch:
            with Image.open(io.BytesIO(row.image_bytes)) as source_image:
                images.append(ImageOps.exif_transpose(source_image).convert("RGB"))
        pixel_values = processor(images=images, return_tensors="pt").pixel_values.to(device)
        started = time.perf_counter()
        autocast = torch.autocast(
            device_type="cuda",
            dtype=torch.float16,
            enabled=device.type == "cuda" and args.runtime == "pytorch",
        ) if device.type == "cuda" else contextlib.nullcontext()
        with torch.inference_mode(), autocast:
            generated = model.generate(
                pixel_values,
                max_new_tokens=args.maximum_target_length,
                num_beams=args.num_beams,
            )
        if device.type == "cuda":
            torch.cuda.synchronize()
        per_line = (time.perf_counter() - started) * 1000 / len(batch)
        metrics["latencyMilliseconds"].extend([per_line] * len(batch))
        predictions = [
            normalize_text(value)
            for value in processor.batch_decode(generated, skip_special_tokens=True)
        ]
        for row, prediction in zip(batch, predictions):
            character_edits = edit_distance(row.text, prediction)
            metrics["characterEdits"] += character_edits
            metrics["foldedCharacterEdits"] += edit_distance(row.text.casefold(), prediction.casefold())
            metrics["characters"] += len(row.text)
            metrics["wordEdits"] += edit_distance(row.text.split(), prediction.split())
            metrics["words"] += len(row.text.split())
            metrics["exact"] += int(row.text == prediction)
            metrics["foldedExact"] += int(row.text.casefold() == prediction.casefold())
            metrics["germanSpecialCharacters"] += sum(character in GERMAN_SPECIALS for character in row.text)
            metrics["germanSpecialCharacterEdits"] += reference_class_edits(
                row.text,
                prediction,
                GERMAN_SPECIALS,
            )
            failures.append(Failure(
                character_edits / max(1, len(row.text)),
                row.text,
                prediction,
            ))
        if start + len(batch) == len(rows) or (start + len(batch)) % 100 == 0:
            print(f"processed {start + len(batch)} lines", flush=True)

    count = max(1, len(rows))
    latency = metrics["latencyMilliseconds"]
    result = {
        "model": args.model,
        "runtime": args.runtime,
        "numBeams": args.num_beams,
        "sampleCount": len(rows),
        **metrics,
        "cer": metrics["characterEdits"] / max(1, metrics["characters"]),
        "foldedCer": metrics["foldedCharacterEdits"] / max(1, metrics["characters"]),
        "wer": metrics["wordEdits"] / max(1, metrics["words"]),
        "exactRate": metrics["exact"] / count,
        "foldedExactRate": metrics["foldedExact"] / count,
        "germanSpecialCharacterErrorRate": metrics["germanSpecialCharacterEdits"] / max(1, metrics["germanSpecialCharacters"]),
        "medianMilliseconds": statistics.median(latency),
        "p95Milliseconds": float(np.percentile(np.asarray(latency), 95)),
        "wallSeconds": time.perf_counter() - wall_started,
    }
    print(json.dumps({
        key: round(value * 100, 2) if key in {"cer", "foldedCer", "wer", "exactRate", "foldedExactRate", "germanSpecialCharacterErrorRate"} else value
        for key, value in result.items()
        if key not in {"latencyMilliseconds"}
    }, indent=2))
    for failure in sorted(failures, key=lambda entry: entry.normalized_distance, reverse=True)[:args.worst]:
        print(f"{failure.normalized_distance * 100:6.1f}% | {failure.truth!r} -> {failure.prediction!r}")
    if args.json_output:
        args.json_output.write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
