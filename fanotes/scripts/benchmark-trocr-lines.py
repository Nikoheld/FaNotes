#!/usr/bin/env python3
"""Evaluate a local TrOCR checkpoint on independent handwriting lines."""

from __future__ import annotations

import argparse
from collections import deque
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
    group_id: str = ""
    local_holdout: bool = False


@dataclass(frozen=True)
class Failure:
    normalized_distance: float
    truth: str
    prediction: str
    candidates: tuple[str, ...] = ()


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
                rows.append(Row(image_path.read_bytes(), text, value["page_id"]))
    return rows


def load_image_directory(root: Path) -> list[Row]:
    """Load a local evaluation-only corpus whose filename stem is the truth.

    This path deliberately returns bytes directly and never stages, copies or
    augments the images. It is intended for user-provided holdouts which must
    remain excluded from model training.
    """
    accepted_suffixes = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
    rows = [
        Row(path.read_bytes(), normalize_text(path.stem), path.name, True)
        for path in sorted(root.iterdir(), key=lambda value: value.name.casefold())
        if path.is_file() and path.suffix.casefold() in accepted_suffixes and normalize_text(path.stem)
    ]
    if not rows:
        raise ValueError(f"No labelled images found in holdout directory: {root}")
    return rows


def production_equivalent_holdout_line(source: Image.Image) -> Image.Image:
    """Turn an app screenshot into the line raster produced from stored ink.

    FaNotes recognition never sends the paper grid or the bottom-right canvas
    resize affordance to TrOCR. The tablet strokes are rendered as black ink on
    white with 0.40 vertical and 0.22 horizontal margins. Local PNG holdouts do
    not carry the original vectors, so isolate only their dark ink and recreate
    that same model input without consulting the expected filename text.
    """
    rgb = ImageOps.exif_transpose(source).convert("RGB")
    pixels = np.asarray(rgb, dtype=np.uint8)
    # The app ink is near-black; paper and grid dots are light. Keep a generous
    # antialiasing range while rejecting both background layers.
    ink = np.max(pixels, axis=2) < 170
    height, width = ink.shape
    # Screenshot chrome (scrollbars, crop handles and editor side rails) is
    # connected to an outer edge. Real exported tablet ink has paper margin,
    # so remove every edge-connected component without inspecting its shape or
    # the expected transcription.
    boundary: deque[tuple[int, int]] = deque()
    for column in range(width):
        if ink[0, column]:
            boundary.append((0, column))
        if height > 1 and ink[height - 1, column]:
            boundary.append((height - 1, column))
    for row in range(1, max(1, height - 1)):
        if ink[row, 0]:
            boundary.append((row, 0))
        if width > 1 and ink[row, width - 1]:
            boundary.append((row, width - 1))
    while boundary:
        row, column = boundary.popleft()
        if not ink[row, column]:
            continue
        ink[row, column] = False
        for row_offset in (-1, 0, 1):
            for column_offset in (-1, 0, 1):
                neighbour_row = row + row_offset
                neighbour_column = column + column_offset
                if (
                    (row_offset or column_offset)
                    and 0 <= neighbour_row < height
                    and 0 <= neighbour_column < width
                    and ink[neighbour_row, neighbour_column]
                ):
                    boundary.append((neighbour_row, neighbour_column))
    # Screenshot exports contain a resize/cursor affordance in this corner.
    # Stored stroke recognition has no corresponding ink.
    corner = max(24, min(56, round(min(width, height) * 0.18)))
    ink[max(0, height - corner):, max(0, width - corner):] = False
    positions = np.argwhere(ink)
    if not positions.size:
        return Image.new("RGB", (32, 32), "white")
    top, left = positions.min(axis=0)
    bottom, right = positions.max(axis=0) + 1
    content = ink[top:bottom, left:right]
    content_height = max(1, content.shape[0])
    margin_y = round(min(36, max(4, content_height * 0.40)))
    margin_x = round(min(48, max(5, content_height * 0.22)))
    output = np.full(
        (content.shape[0] + margin_y * 2, content.shape[1] + margin_x * 2),
        255,
        dtype=np.uint8,
    )
    output[margin_y:margin_y + content.shape[0], margin_x:margin_x + content.shape[1]][content] = 0
    return Image.fromarray(output, mode="L").convert("RGB")


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
    source.add_argument("--image-directory", type=Path)
    parser.add_argument("--scads-split", choices=["train", "validation", "test"], default="test")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--maximum-target-length", type=int, default=128)
    parser.add_argument("--num-beams", type=int, choices=[1, 2, 4, 6], default=1)
    parser.add_argument("--num-return-sequences", type=int, default=1)
    parser.add_argument("--runtime", choices=["pytorch", "onnx"], default="pytorch")
    parser.add_argument("--encoder-file-name")
    parser.add_argument("--decoder-file-name")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--worst", type=int, default=12)
    parser.add_argument("--json-output", type=Path)
    parser.add_argument("--include-predictions", action="store_true")
    parser.add_argument("--include-sequence-scores", action="store_true")
    args = parser.parse_args()
    if args.num_return_sequences < 1 or args.num_return_sequences > args.num_beams:
        parser.error("--num-return-sequences must be between 1 and --num-beams")
    if args.image_directory and not args.image_directory.is_dir():
        parser.error("--image-directory must point to an existing directory")

    threads = max(1, min(8, args.threads))
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)

    rows = (
        load_parquet(args.dataset)
        if args.dataset
        else load_scads(args.scads_root, args.scads_split)
        if args.scads_root
        else load_image_directory(args.image_directory)
    )
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
    oracle_metrics = {
        "characterEdits": 0,
        "wordEdits": 0,
        "exact": 0,
        "uniqueCandidates": 0,
    }
    failures: list[Failure] = []
    prediction_records: list[dict[str, object]] = []
    wall_started = time.perf_counter()
    for start in range(0, len(rows), args.batch_size):
        batch = rows[start:start + args.batch_size]
        images = []
        for row in batch:
            with Image.open(io.BytesIO(row.image_bytes)) as source_image:
                images.append(
                    production_equivalent_holdout_line(source_image)
                    if row.local_holdout
                    else ImageOps.exif_transpose(source_image).convert("RGB")
                )
        pixel_values = processor(images=images, return_tensors="pt").pixel_values.to(device)
        started = time.perf_counter()
        autocast = torch.autocast(
            device_type="cuda",
            dtype=torch.float16,
            enabled=device.type == "cuda" and args.runtime == "pytorch",
        ) if device.type == "cuda" else contextlib.nullcontext()
        with torch.inference_mode(), autocast:
            generation = model.generate(
                pixel_values,
                max_new_tokens=args.maximum_target_length,
                num_beams=args.num_beams,
                num_return_sequences=args.num_return_sequences,
                return_dict_in_generate=args.include_sequence_scores,
                output_scores=args.include_sequence_scores,
            )
        generated = generation.sequences if args.include_sequence_scores else generation
        raw_sequence_scores = (
            generation.sequences_scores.detach().float().cpu().tolist()
            if args.include_sequence_scores and generation.sequences_scores is not None
            else [0.0] * len(generated)
        )
        if device.type == "cuda":
            torch.cuda.synchronize()
        per_line = (time.perf_counter() - started) * 1000 / len(batch)
        metrics["latencyMilliseconds"].extend([per_line] * len(batch))
        decoded = [
            normalize_text(value)
            for value in processor.batch_decode(generated, skip_special_tokens=True)
        ]
        candidate_groups: list[tuple[tuple[str, ...], tuple[float, ...]]] = []
        for index in range(len(batch)):
            start_index = index * args.num_return_sequences
            end_index = (index + 1) * args.num_return_sequences
            unique: dict[str, float] = {}
            for candidate, score in zip(decoded[start_index:end_index], raw_sequence_scores[start_index:end_index]):
                if candidate not in unique:
                    unique[candidate] = float(score)
            candidate_groups.append((tuple(unique), tuple(unique.values())))
        for row, (candidates, candidate_scores) in zip(batch, candidate_groups):
            prediction = candidates[0] if candidates else ""
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
            oracle = min(
                candidates or (prediction,),
                key=lambda candidate: (
                    edit_distance(row.text, candidate),
                    edit_distance(row.text.split(), candidate.split()),
                ),
            )
            oracle_metrics["characterEdits"] += edit_distance(row.text, oracle)
            oracle_metrics["wordEdits"] += edit_distance(row.text.split(), oracle.split())
            oracle_metrics["exact"] += int(row.text == oracle)
            oracle_metrics["uniqueCandidates"] += len(candidates)
            failures.append(Failure(
                character_edits / max(1, len(row.text)),
                row.text,
                prediction,
                candidates,
            ))
            if args.include_predictions:
                prediction_record: dict[str, object] = {
                    "truth": row.text,
                    "prediction": prediction,
                    "candidates": list(candidates),
                }
                if row.group_id:
                    prediction_record["groupId"] = row.group_id
                if args.include_sequence_scores:
                    prediction_record["candidateScores"] = list(candidate_scores)
                prediction_records.append(prediction_record)
        if start + len(batch) == len(rows) or (start + len(batch)) % 100 == 0:
            print(f"processed {start + len(batch)} lines", flush=True)

    count = max(1, len(rows))
    latency = metrics["latencyMilliseconds"]
    result = {
        "model": args.model,
        "runtime": args.runtime,
        "source": {
            "kind": "parquet" if args.dataset else "scads" if args.scads_root else "local-image-holdout",
            "role": (
                "test" if args.dataset and "test" in args.dataset.stem.lower()
                else "validation" if args.dataset and "validation" in args.dataset.stem.lower()
                else "train" if args.dataset and "train" in args.dataset.stem.lower()
                else args.scads_split if args.scads_root
                else "test"
            ),
            "writerDisjoint": bool(args.scads_root),
            "grouping": (
                "scads-page-id" if args.scads_root
                else "one-labelled-image-per-file" if args.image_directory
                else "not-provided"
            ),
            "trainingExcluded": bool(args.image_directory),
            "preprocessing": (
                "production-equivalent-ink-render" if args.image_directory
                else "checkpoint-processor"
            ),
        },
        "numBeams": args.num_beams,
        "numReturnSequences": args.num_return_sequences,
        "sampleCount": len(rows),
        **metrics,
        "cer": metrics["characterEdits"] / max(1, metrics["characters"]),
        "foldedCer": metrics["foldedCharacterEdits"] / max(1, metrics["characters"]),
        "wer": metrics["wordEdits"] / max(1, metrics["words"]),
        "exactRate": metrics["exact"] / count,
        "foldedExactRate": metrics["foldedExact"] / count,
        "germanSpecialCharacterErrorRate": metrics["germanSpecialCharacterEdits"] / max(1, metrics["germanSpecialCharacters"]),
        "oracleCer": oracle_metrics["characterEdits"] / max(1, metrics["characters"]),
        "oracleWer": oracle_metrics["wordEdits"] / max(1, metrics["words"]),
        "oracleExactRate": oracle_metrics["exact"] / count,
        "averageUniqueCandidates": oracle_metrics["uniqueCandidates"] / count,
        "medianMilliseconds": statistics.median(latency),
        "p95Milliseconds": float(np.percentile(np.asarray(latency), 95)),
        "wallSeconds": time.perf_counter() - wall_started,
    }
    if args.include_predictions:
        result["predictions"] = prediction_records
    print(json.dumps({
            key: round(value * 100, 2) if key in {"cer", "foldedCer", "wer", "exactRate", "foldedExactRate", "germanSpecialCharacterErrorRate", "oracleCer", "oracleWer", "oracleExactRate"} else value
        for key, value in result.items()
        if key not in {"latencyMilliseconds"}
    }, indent=2))
    for failure in sorted(failures, key=lambda entry: entry.normalized_distance, reverse=True)[:args.worst]:
        print(f"{failure.normalized_distance * 100:6.1f}% | {failure.truth!r} -> {failure.prediction!r}")
        if len(failure.candidates) > 1:
            print(f"         candidates: {list(failure.candidates)!r}")
    if args.json_output:
        args.json_output.write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
