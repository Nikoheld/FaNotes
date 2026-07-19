#!/usr/bin/env python3
"""Fine-tune TrOCR on writer-disjoint German handwriting plus IAM English.

The script intentionally keeps every ScaDS.AI page (one anonymous writer) in
exactly one split. This prevents line crops from the same hand leaking into the
validation or test set and gives FaNotes a reproducible bilingual quality gate.

Example:
  python scripts/train-bilingual-trocr.py \
    --iam-train /tmp/iam-train.parquet \
    --iam-validation /tmp/iam-validation.parquet \
    --scads-root /tmp/scadsai-german-v01 \
    --iam-cache /var/cache/fanotes-ocr/iam-images \
    --output /var/lib/fanotes-ocr/trocr-bilingual
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import pyarrow.parquet as parquet
import torch
import torch.nn.functional as functional
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from torch.utils.data import DataLoader, Dataset
from transformers import TrOCRProcessor, VisionEncoderDecoderModel


@dataclass(frozen=True)
class Sample:
    text: str
    language: str
    image_bytes: bytes | None = None
    image_path: Path | None = None


class HandwritingDataset(Dataset):
    def __init__(self, samples: Sequence[Sample], augment: bool, seed: int):
        self.samples = samples
        self.augment = augment
        self.seed = seed
        self.epoch = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> tuple[Image.Image, str, str]:
        sample = self.samples[index]
        if sample.image_bytes is not None:
            source = Image.open(io.BytesIO(sample.image_bytes))
        elif sample.image_path is not None:
            source = Image.open(sample.image_path)
        else:
            raise ValueError("Sample contains no image.")
        with source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        if self.augment:
            image = augment_line(image, random.Random(self.seed + self.epoch * len(self.samples) + index))
        return image, sample.text, sample.language


def normalize_text(value: str) -> str:
    # FaNotes targets Swiss Standard German and never trains a separate
    # sharp-S class. Apply the same boundary normalization as the app.
    return re.sub(r"\s+", " ", value.replace("ẞ", "SS").replace("ß", "ss")).strip()


def writer_split(page_id: str) -> str:
    bucket = int.from_bytes(hashlib.sha256(page_id.encode("utf-8")).digest()[:4], "big") % 10
    if bucket == 0:
        return "test"
    if bucket == 1:
        return "validation"
    return "train"


def load_iam(path: Path, language: str = "en", cache_root: Path | None = None) -> list[Sample]:
    """Load IAM without retaining the complete image column in host RAM.

    Hugging Face's IAM parquet uses compact 100-row groups. With a cache root,
    each group is decoded and released independently, while subsequent runs
    open the extracted images lazily through ``Sample.image_path``. The cache
    key includes the source path, size, and nanosecond timestamp; a manifest is
    published atomically only after every referenced image exists.
    """
    if cache_root is None:
        table = parquet.read_table(path, columns=["image", "text"])
        samples: list[Sample] = []
        for row in table.to_pylist():
            image = row.get("image")
            image_bytes = image.get("bytes") if isinstance(image, dict) else None
            text = normalize_text(str(row.get("text") or ""))
            if image_bytes and text:
                samples.append(Sample(text=text, language=language, image_bytes=image_bytes))
        return samples

    resolved = path.resolve()
    source_stat = resolved.stat()
    source = {
        "path": str(resolved),
        "size": source_stat.st_size,
        "mtimeNs": source_stat.st_mtime_ns,
    }
    cache_key = hashlib.sha256(
        json.dumps(source, sort_keys=True).encode("utf-8"),
    ).hexdigest()[:16]
    dataset_root = cache_root.resolve() / f"{resolved.stem}-{cache_key}"
    manifest_path = dataset_root / "manifest.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            records = manifest.get("records") if isinstance(manifest, dict) else None
            if (
                isinstance(manifest, dict)
                and manifest.get("format") == "fanotes-iam-image-cache-v2"
                and manifest.get("source") == source
                and isinstance(records, list)
                and records
            ):
                cached = [
                    Sample(
                        text=str(record["text"]),
                        language=language,
                        image_path=dataset_root / str(record["file"]),
                    )
                    for record in records
                    if (
                        isinstance(record, dict)
                        and record.get("text")
                        and record.get("file")
                        and re.fullmatch(r"\d{6}\.image", str(record["file"]))
                        and isinstance(record.get("size"), int)
                        and record["size"] > 0
                    )
                ]
                if len(cached) == len(records) and all(
                    sample.image_path.is_file()
                    and sample.image_path.stat().st_size == record["size"]
                    for sample, record in zip(cached, records)
                ):
                    return cached
        except (OSError, ValueError, TypeError, KeyError):
            pass

    dataset_root.mkdir(parents=True, exist_ok=True)
    parquet_file = parquet.ParquetFile(resolved)
    records: list[dict[str, object]] = []
    for row_group in range(parquet_file.num_row_groups):
        table = parquet_file.read_row_group(row_group, columns=["image", "text"])
        for row in table.to_pylist():
            image = row.get("image")
            image_bytes = image.get("bytes") if isinstance(image, dict) else None
            text = normalize_text(str(row.get("text") or ""))
            if not image_bytes or not text:
                continue
            file_name = f"{len(records):06d}.image"
            (dataset_root / file_name).write_bytes(image_bytes)
            records.append({"file": file_name, "text": text, "size": len(image_bytes)})
        del table
    if not records:
        raise ValueError(f"IAM parquet contains no usable samples: {resolved}")
    manifest = {
        "format": "fanotes-iam-image-cache-v2",
        "source": source,
        "records": records,
    }
    temporary_manifest = dataset_root / "manifest.json.tmp"
    temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    temporary_manifest.replace(manifest_path)
    return [
        Sample(
            text=str(record["text"]),
            language=language,
            image_path=dataset_root / str(record["file"]),
        )
        for record in records
    ]


def load_scads(root: Path) -> dict[str, list[Sample]]:
    annotation_path = root / "ground_truth/csv/line_annotations.csv"
    image_root = root / "images/lines"
    splits = {"train": [], "validation": [], "test": []}
    with annotation_path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            image_path = image_root / row["line_file"]
            text = normalize_text(row["text"])
            if image_path.is_file() and text:
                splits[writer_split(row["page_id"])].append(
                    Sample(text=text, language="de", image_path=image_path),
                )
    return splits


def augment_line(image: Image.Image, rng: random.Random) -> Image.Image:
    background = (255, 255, 255)
    if rng.random() < 0.75:
        image = image.rotate(
            rng.uniform(-1.7, 1.7),
            resample=Image.Resampling.BICUBIC,
            expand=True,
            fillcolor=background,
        )
    if rng.random() < 0.7:
        shear = math.tan(math.radians(rng.uniform(-2.4, 2.4)))
        translate = rng.uniform(-0.018, 0.018) * image.width
        image = image.transform(
            image.size,
            Image.Transform.AFFINE,
            (1, shear, translate, 0, 1, 0),
            resample=Image.Resampling.BICUBIC,
            fillcolor=background,
        )
    if rng.random() < 0.7:
        image = ImageEnhance.Contrast(image).enhance(rng.uniform(0.82, 1.22))
    if rng.random() < 0.28:
        image = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.15, 0.55)))
    return image


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


def collator(processor: TrOCRProcessor, maximum_target_length: int):
    def collate(batch: Iterable[tuple[Image.Image, str, str]]) -> dict[str, object]:
        rows = list(batch)
        images, texts, languages = zip(*rows)
        pixel_values = processor(images=list(images), return_tensors="pt").pixel_values
        tokenized = processor.tokenizer(
            list(texts),
            padding=True,
            truncation=True,
            max_length=maximum_target_length,
            return_tensors="pt",
        )
        labels = tokenized.input_ids
        bos_token_id = processor.tokenizer.bos_token_id
        if labels.shape[1] > 1 and bos_token_id is not None and torch.all(labels[:, 0] == bos_token_id):
            # TrOCR generates <s> internally after its decoder-start token.
            # The supervised targets therefore begin with the first visible
            # token; retaining <s> shifts every target by one position.
            labels = labels[:, 1:]
        labels[labels == processor.tokenizer.pad_token_id] = -100
        return {
            "pixel_values": pixel_values,
            "labels": labels,
            "texts": list(texts),
            "languages": list(languages),
        }
    return collate


@torch.inference_mode()
def evaluate(
    model: VisionEncoderDecoderModel,
    processor: TrOCRProcessor,
    loader: DataLoader,
    device: torch.device,
    maximum_target_length: int,
    autocast_dtype: torch.dtype,
) -> dict[str, dict[str, float]]:
    model.eval()
    totals: dict[str, dict[str, float]] = {}
    for batch in loader:
        pixel_values = batch["pixel_values"].to(device, non_blocking=True)
        with torch.autocast(device_type="cuda", dtype=autocast_dtype, enabled=device.type == "cuda"):
            generated = model.generate(
                pixel_values,
                max_new_tokens=maximum_target_length,
                num_beams=1,
            )
        predictions = [
            normalize_text(value)
            for value in processor.batch_decode(generated, skip_special_tokens=True)
        ]
        for truth, prediction, language in zip(batch["texts"], predictions, batch["languages"]):
            target = totals.setdefault(language, {
                "lines": 0,
                "characters": 0,
                "character_edits": 0,
                "words": 0,
                "word_edits": 0,
                "exact": 0,
            })
            target["lines"] += 1
            target["characters"] += len(truth)
            target["character_edits"] += edit_distance(truth, prediction)
            target["words"] += len(truth.split())
            target["word_edits"] += edit_distance(truth.split(), prediction.split())
            target["exact"] += int(truth == prediction)
    return {
        language: {
            "lines": int(values["lines"]),
            "cer": values["character_edits"] / max(1, values["characters"]),
            "wer": values["word_edits"] / max(1, values["words"]),
            "exact": values["exact"] / max(1, values["lines"]),
        }
        for language, values in totals.items()
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iam-train", type=Path, required=True)
    parser.add_argument("--iam-validation", type=Path, required=True)
    parser.add_argument(
        "--iam-cache",
        type=Path,
        help="Persistent extracted-image cache that keeps IAM parquet bytes out of host RAM.",
    )
    parser.add_argument(
        "--prepare-iam-cache-only",
        action="store_true",
        help="Validate/extract the IAM cache and exit before loading the model or CUDA.",
    )
    parser.add_argument(
        "--evaluate-only",
        action="store_true",
        help="Evaluate the selected checkpoint on the validation splits without training.",
    )
    parser.add_argument("--scads-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="microsoft/trocr-small-handwritten")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--evaluation-batch-size", type=int, default=16)
    parser.add_argument("--gradient-accumulation", type=int, default=4)
    parser.add_argument("--encoder-learning-rate", type=float, default=1.5e-5)
    parser.add_argument("--decoder-learning-rate", type=float, default=4e-5)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--label-smoothing", type=float, default=0.02)
    parser.add_argument("--warmup-ratio", type=float, default=0.06)
    parser.add_argument("--maximum-target-length", type=int, default=128)
    # A single loader is fast enough for the small line crops and avoids each
    # worker retaining its own decoder state and filesystem-cache view.
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--seed", type=int, default=45)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    if args.prepare_iam_cache_only:
        if args.iam_cache is None:
            parser.error("--prepare-iam-cache-only requires --iam-cache")
        iam_train = load_iam(args.iam_train, cache_root=args.iam_cache)
        iam_validation = load_iam(args.iam_validation, cache_root=args.iam_cache)
        print(json.dumps({
            "cache": str(args.iam_cache.resolve()),
            "train": len(iam_train),
            "validation": len(iam_validation),
        }, indent=2), flush=True)
        return

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    processor = TrOCRProcessor.from_pretrained(args.model, use_fast=False)
    model = VisionEncoderDecoderModel.from_pretrained(args.model)
    model.config.decoder_start_token_id = model.generation_config.decoder_start_token_id
    model.config.pad_token_id = processor.tokenizer.pad_token_id
    model.config.vocab_size = model.config.decoder.vocab_size
    model.config.decoder.use_cache = False
    model.generation_config.use_cache = False
    model.to(device)
    # TrOCR's decoder occasionally overflows fp16 late in a long line batch.
    # Ampere and newer GPUs support bf16, which has fp32's exponent range and
    # avoids silently poisoning an otherwise healthy epoch with NaNs.
    use_bfloat16 = device.type == "cuda" and torch.cuda.is_bf16_supported()
    autocast_dtype = torch.bfloat16 if use_bfloat16 else torch.float16

    iam_train = load_iam(args.iam_train, cache_root=args.iam_cache)
    iam_validation = load_iam(args.iam_validation, cache_root=args.iam_cache)
    scads = load_scads(args.scads_root)
    # Keep both languages equally visible to the optimizer without discarding
    # a single real line. German samples are repeated only in the training set.
    german_repetitions = max(1, math.ceil(len(iam_train) / max(1, len(scads["train"]))))
    train_samples = [*iam_train, *(scads["train"] * german_repetitions)]
    validation_samples = [*iam_validation, *scads["validation"]]

    train_dataset = HandwritingDataset(train_samples, augment=True, seed=args.seed)
    validation_dataset = HandwritingDataset(validation_samples, augment=False, seed=args.seed)
    collate = collator(processor, args.maximum_target_length)
    generator = torch.Generator().manual_seed(args.seed)
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        generator=generator,
        num_workers=args.workers,
        pin_memory=device.type == "cuda",
        persistent_workers=args.workers > 0,
        collate_fn=collate,
    )
    validation_loader = DataLoader(
        validation_dataset,
        batch_size=args.evaluation_batch_size,
        shuffle=False,
        num_workers=args.workers,
        pin_memory=device.type == "cuda",
        persistent_workers=args.workers > 0,
        collate_fn=collate,
    )

    if args.evaluate_only:
        metrics = evaluate(
            model,
            processor,
            validation_loader,
            device,
            args.maximum_target_length,
            autocast_dtype,
        )
        balanced_score = sum(
            metrics.get(language, {}).get("cer", 1.0)
            for language in ("de", "en")
        ) / 2
        print(json.dumps({
            "model": str(args.model),
            "metrics": metrics,
            "balancedCer": balanced_score,
        }, indent=2), flush=True)
        return

    optimizer = torch.optim.AdamW([
        {"params": model.encoder.parameters(), "lr": args.encoder_learning_rate},
        {"params": model.decoder.parameters(), "lr": args.decoder_learning_rate},
    ], weight_decay=args.weight_decay)
    updates_per_epoch = math.ceil(len(train_loader) / args.gradient_accumulation)
    total_updates = max(1, updates_per_epoch * args.epochs)
    warmup_updates = round(total_updates * args.warmup_ratio)

    def schedule(step: int) -> float:
        if step < warmup_updates:
            return (step + 1) / max(1, warmup_updates)
        progress = (step - warmup_updates) / max(1, total_updates - warmup_updates)
        return 0.08 + 0.92 * 0.5 * (1 + math.cos(math.pi * min(1, progress)))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, schedule)
    scaler = torch.amp.GradScaler(
        "cuda",
        enabled=device.type == "cuda" and not use_bfloat16,
    )
    best_score = math.inf
    history: list[dict[str, object]] = []
    update = 0
    optimizer.zero_grad(set_to_none=True)

    print(json.dumps({
        "device": str(device),
        "train": {"en": len(iam_train), "de": len(scads["train"]), "deRepeats": german_repetitions},
        "validation": {"en": len(iam_validation), "de": len(scads["validation"])},
        "test": {"de": len(scads["test"])},
        "updates": total_updates,
        "mixedPrecision": "bf16" if use_bfloat16 else ("fp16" if device.type == "cuda" else "off"),
    }, indent=2), flush=True)

    for epoch in range(args.epochs):
        train_dataset.set_epoch(epoch)
        model.train()
        started = time.perf_counter()
        loss_total = 0.0
        finite_batches = 0
        skipped_batches = 0
        for batch_index, batch in enumerate(train_loader):
            pixel_values = batch["pixel_values"].to(device, non_blocking=True)
            labels = batch["labels"].to(device, non_blocking=True)
            decoder_labels = labels.masked_fill(labels == -100, model.config.pad_token_id)
            decoder_input_ids = torch.cat([
                torch.full(
                    (labels.shape[0], 1),
                    model.config.decoder_start_token_id,
                    dtype=labels.dtype,
                    device=device,
                ),
                decoder_labels[:, :-1],
            ], dim=1)
            with torch.autocast(device_type="cuda", dtype=autocast_dtype, enabled=device.type == "cuda"):
                logits = model(
                    pixel_values=pixel_values,
                    decoder_input_ids=decoder_input_ids,
                    decoder_attention_mask=decoder_input_ids.ne(model.config.pad_token_id),
                    use_cache=False,
                ).logits
                # Transformers 4.51+ applies a causal-language-model shift
                # inside the decoder loss. VisionEncoderDecoderModel already
                # shifts decoder inputs, so using that generic loss would
                # train every target against the following token. Compute the
                # aligned seq2seq loss explicitly.
                loss = functional.cross_entropy(
                    # Keep the reduction in fp32 even when matrix operations
                    # use mixed precision. This is especially important for
                    # the 50k-token decoder vocabulary and label smoothing.
                    logits.float().reshape(-1, logits.shape[-1]),
                    labels.reshape(-1),
                    ignore_index=-100,
                    label_smoothing=args.label_smoothing,
                )
                scaled_loss = loss / args.gradient_accumulation
            if not torch.isfinite(loss):
                skipped_batches += 1
                optimizer.zero_grad(set_to_none=True)
                print(
                    f"warning: skipped non-finite batch {batch_index + 1} "
                    f"in epoch {epoch + 1}",
                    flush=True,
                )
                continue
            scaler.scale(scaled_loss).backward()
            loss_total += float(loss.detach())
            finite_batches += 1
            should_update = (
                (batch_index + 1) % args.gradient_accumulation == 0
                or batch_index + 1 == len(train_loader)
            )
            if should_update:
                scaler.unscale_(optimizer)
                gradient_norm = torch.nn.utils.clip_grad_norm_(
                    model.parameters(),
                    1.0,
                    error_if_nonfinite=False,
                )
                if torch.isfinite(gradient_norm):
                    scaler.step(optimizer)
                    scaler.update()
                    scheduler.step()
                    update += 1
                else:
                    skipped_batches += 1
                    print(
                        f"warning: discarded non-finite gradients after batch "
                        f"{batch_index + 1} in epoch {epoch + 1}",
                        flush=True,
                    )
                optimizer.zero_grad(set_to_none=True)
            if (batch_index + 1) % 200 == 0:
                print(
                    f"epoch {epoch + 1}/{args.epochs} batch {batch_index + 1}/{len(train_loader)} "
                    f"loss {loss_total / max(1, finite_batches):.4f} skipped {skipped_batches}",
                    flush=True,
                )

        metrics = evaluate(
            model,
            processor,
            validation_loader,
            device,
            args.maximum_target_length,
            autocast_dtype,
        )
        balanced_score = sum(
            metrics.get(language, {}).get("cer", 1.0)
            for language in ("de", "en")
        ) / 2
        record = {
            "epoch": epoch + 1,
            "loss": loss_total / max(1, finite_batches),
            "skippedBatches": skipped_batches,
            "seconds": time.perf_counter() - started,
            "metrics": metrics,
            "balancedCer": balanced_score,
        }
        history.append(record)
        print(json.dumps(record, indent=2), flush=True)
        (args.output / "history.json").write_text(json.dumps(history, indent=2), encoding="utf-8")
        if balanced_score < best_score:
            best_score = balanced_score
            best = args.output / "best"
            best.mkdir(parents=True, exist_ok=True)
            # Training does not need an autoregressive key/value cache and
            # keeping it disabled reduces GPU memory. Published inference
            # checkpoints do need it: browser generation otherwise recomputes
            # the entire decoder prefix for every character. Temporarily save
            # the inference configuration, then continue training leanly.
            model.config.decoder.use_cache = True
            model.generation_config.use_cache = True
            try:
                model.save_pretrained(best, safe_serialization=True)
                processor.save_pretrained(best)
            finally:
                model.config.decoder.use_cache = False
                model.generation_config.use_cache = False
            (best / "training-metrics.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
            print(f"saved new best model with balanced CER {best_score * 100:.2f}%", flush=True)


if __name__ == "__main__":
    main()
