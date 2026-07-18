#!/usr/bin/env python3
"""Evaluate FaNotes-compatible CTC recognizers on unseen handwriting lines.

The benchmark intentionally lives outside the product runtime. It reads a
Hugging Face image/text parquet such as Teklia/IAM-line and applies the same
model-specific line normalization used by src/lib/neuralTextRecognition.ts.
This gives model selection a reproducible blind test instead of relying on
hand-picked screenshots.

Example:
  python scripts/benchmark-handwriting-lines.py \
    --dataset /tmp/iam-test.parquet \
    --candidate pylaia=/tmp/pylaia-iam.onnx=/tmp/pylaia-iam-syms.txt=pylaia \
    --candidate ppocr=/tmp/ppocr.onnx=/tmp/ppocr-inference.yml
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import onnxruntime as ort
import pyarrow.parquet as parquet
import yaml
from PIL import Image, ImageChops, ImageOps


MODEL_HEIGHT = 48
DEFAULT_MAX_MODEL_WIDTH = 1600
ALLOWED_CHARACTER = re.compile(r"""^[A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]$""")


@dataclass(frozen=True)
class CandidateSpec:
    name: str
    model_path: Path
    characters_path: Path
    profile: str


@dataclass
class CandidateRuntime:
    spec: CandidateSpec
    session: ort.InferenceSession
    input_name: str
    output_name: str
    characters: list[str]
    allowed_indexes: np.ndarray


@dataclass(frozen=True)
class LanguageEvidence:
    words: frozenset[str]
    bigrams: frozenset[str]
    trigrams: frozenset[str]


@dataclass(frozen=True)
class ArpaEntry:
    log_probability: float
    backoff: float


@dataclass(frozen=True)
class ArpaLanguageModel:
    order: int
    ngrams: tuple[dict[tuple[str, ...], ArpaEntry], ...]
    unknown_log_probability: float

    @staticmethod
    def token(character: str) -> str:
        return "⎵" if character == " " else character

    def score(self, history: Sequence[str], token: str) -> float:
        context = tuple(history[-(self.order - 1):]) if self.order > 1 else ()
        accumulated_backoff = 0.0
        for length in range(min(self.order, len(context) + 1), 0, -1):
            prefix_length = length - 1
            prefix = context[-prefix_length:] if prefix_length else ()
            entry = self.ngrams[length - 1].get((*prefix, token))
            if entry is not None:
                return accumulated_backoff + entry.log_probability
            if prefix_length:
                history_entry = self.ngrams[prefix_length - 1].get(prefix)
                if history_entry is not None:
                    accumulated_backoff += history_entry.backoff
        return accumulated_backoff + self.unknown_log_probability

    def extension_score(self, prefix: str, character: str) -> float:
        history = ["<s>", *(self.token(value) for value in prefix)]
        return self.score(history, self.token(character))

    def end_score(self, prefix: str) -> float:
        history = ["<s>", *(self.token(value) for value in prefix)]
        return self.score(history, "</s>")


@dataclass(frozen=True)
class Recognition:
    text: str
    confidence: float
    elapsed_ms: float


@dataclass(frozen=True)
class Failure:
    normalized_distance: float
    truth: str
    predicted: str
    confidence: float


def parse_candidate(raw: str) -> CandidateSpec:
    parts = raw.split("=")
    if len(parts) not in (3, 4) or not all(parts):
        raise argparse.ArgumentTypeError(
            "candidate must use NAME=MODEL.onnx=CHARACTERS[=ppocr|pylaia]"
        )
    profile = parts[3] if len(parts) == 4 else "ppocr"
    if profile not in {"ppocr", "pylaia"}:
        raise argparse.ArgumentTypeError(f"unsupported preprocessing profile: {profile}")
    return CandidateSpec(parts[0], Path(parts[1]), Path(parts[2]), profile)


def load_characters(path: Path) -> list[str]:
    if path.suffix.lower() == ".json":
        parsed = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(parsed, list) or not all(isinstance(entry, str) for entry in parsed):
            raise ValueError(f"Invalid JSON character dictionary: {path}")
        return parsed
    if path.suffix.lower() == ".txt":
        indexed: dict[int, str] = {}
        for raw in path.read_text(encoding="utf-8").splitlines():
            token, raw_index = raw.rsplit(maxsplit=1)
            index = int(raw_index)
            if index == 0:
                continue
            indexed[index] = " " if token == "<space>" else "\ufffd" if token == "<unk>" else token
        return [indexed[index] for index in range(1, max(indexed) + 1)]
    parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
    characters = parsed.get("PostProcess", {}).get("character_dict")
    if not isinstance(characters, list) or not all(isinstance(entry, str) for entry in characters):
        raise ValueError(f"Invalid PaddleOCR character dictionary: {path}")
    return characters


def create_runtime(spec: CandidateSpec, threads: int) -> CandidateRuntime:
    if not spec.model_path.is_file():
        raise FileNotFoundError(spec.model_path)
    if not spec.characters_path.is_file():
        raise FileNotFoundError(spec.characters_path)
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    session = ort.InferenceSession(
        str(spec.model_path),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    output_shape = session.get_outputs()[0].shape
    class_count = output_shape[-1] if isinstance(output_shape[-1], int) else None
    characters = load_characters(spec.characters_path)
    # Some exported PaddleOCR dictionaries omit the implicit space character
    # even though CTCLabelDecode added it during training.
    if class_count == len(characters) + 2 and " " not in characters:
        characters.append(" ")
    if class_count is not None and class_count != len(characters) + 1:
        raise ValueError(
            f"{spec.name}: model has {class_count} CTC classes but dictionary has "
            f"{len(characters)} characters"
        )
    allowed = [
        index + 1
        for index, character in enumerate(characters)
        if ALLOWED_CHARACTER.match(character)
    ]
    if not allowed:
        raise ValueError(f"{spec.name} exposes no supported Latin characters")
    return CandidateRuntime(
        spec=spec,
        session=session,
        input_name=session.get_inputs()[0].name,
        output_name=session.get_outputs()[0].name,
        characters=characters,
        allowed_indexes=np.asarray(allowed, dtype=np.int64),
    )


def load_language_evidence(dictionary_path: Path | None, language_data_path: Path | None) -> LanguageEvidence:
    words: set[str] = set()
    if dictionary_path:
        for line_index, raw in enumerate(dictionary_path.read_text(encoding="utf-8", errors="ignore").splitlines()):
            if line_index == 0 and raw.strip().isdigit():
                continue
            word = raw.split("/", 1)[0].strip().casefold()
            if re.fullmatch(r"[a-z]+(?:'[a-z]+)?", word):
                words.add(word)
    bigrams: set[str] = set()
    trigrams: set[str] = set()
    if language_data_path:
        source = language_data_path.read_text(encoding="utf-8")
        for name, target in (("BIGRAMS", bigrams), ("TRIGRAMS", trigrams)):
            match = re.search(rf"COMMON_{name}\s*=\s*new Set\(`(.*?)`", source, re.DOTALL)
            if match:
                target.update(match.group(1).split())
        common_words = re.search(r"const words\s*=\s*`(.*?)`", source, re.DOTALL)
        if common_words:
            words.update(word.casefold() for word in common_words.group(1).split())
    return LanguageEvidence(frozenset(words), frozenset(bigrams), frozenset(trigrams))


def load_arpa_language_model(path: Path | None) -> ArpaLanguageModel | None:
    if path is None:
        return None
    if not path.is_file():
        raise FileNotFoundError(path)
    ngrams: list[dict[tuple[str, ...], ArpaEntry]] = []
    current_order = 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        section = re.fullmatch(r"\\(\d+)-grams:", stripped)
        if section:
            current_order = int(section.group(1))
            while len(ngrams) < current_order:
                ngrams.append({})
            continue
        if not current_order or not stripped or stripped.startswith("\\"):
            continue
        columns = raw.split("\t")
        if len(columns) < 2:
            continue
        tokens = tuple(columns[1].split())
        if len(tokens) != current_order:
            continue
        # ARPA probabilities use log10. Convert once so acoustic and language
        # scores share the natural-log scale during CTC prefix decoding.
        log_probability = float(columns[0]) * math.log(10.0)
        backoff = float(columns[2]) * math.log(10.0) if len(columns) >= 3 else 0.0
        ngrams[current_order - 1][tokens] = ArpaEntry(log_probability, backoff)
    if not ngrams or not ngrams[0]:
        raise ValueError(f"ARPA language model contains no n-grams: {path}")
    unknown = ngrams[0].get(("<unk>",))
    return ArpaLanguageModel(
        order=len(ngrams),
        ngrams=tuple(ngrams),
        unknown_log_probability=unknown.log_probability if unknown else -12.0,
    )


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def isolate_primary_line(grayscale: Image.Image) -> Image.Image:
    """Remove neighbouring IAM lines that leak into a labelled line crop."""
    pixels = np.asarray(grayscale, dtype=np.float32)
    projection = np.clip((255.0 - pixels) / 255.0, 0.0, 1.0).sum(axis=1)
    if projection.size < 24 or float(projection.max(initial=0)) <= 0:
        return grayscale
    smoothed = np.convolve(projection, np.ones(7, dtype=np.float32) / 7.0, mode="same")
    radius = max(18, grayscale.height // 5)
    remaining = smoothed.copy()
    peaks: list[int] = []
    for _ in range(4):
        peak = int(np.argmax(remaining))
        value = float(remaining[peak])
        if value < float(smoothed.max()) * 0.28:
            break
        peaks.append(peak)
        remaining[max(0, peak - radius): min(grayscale.height, peak + radius + 1)] = -1
    peaks.sort()
    if len(peaks) < 2:
        return grayscale

    target = min(peaks, key=lambda peak: abs(peak - grayscale.height / 2))
    target_index = peaks.index(target)
    top = 0
    bottom = grayscale.height
    if target_index:
        previous = peaks[target_index - 1]
        valley = previous + int(np.argmin(smoothed[previous: target + 1]))
        if smoothed[valley] < min(smoothed[previous], smoothed[target]) * 0.68:
            top = valley
    if target_index + 1 < len(peaks):
        following = peaks[target_index + 1]
        valley = target + int(np.argmin(smoothed[target: following + 1]))
        if smoothed[valley] < min(smoothed[target], smoothed[following]) * 0.68:
            bottom = valley
    if bottom - top < grayscale.height * 0.28:
        return grayscale
    return grayscale.crop((0, max(0, top - 2), grayscale.width, min(grayscale.height, bottom + 2)))


def crop_handwriting(image: Image.Image) -> Image.Image:
    grayscale = isolate_primary_line(ImageOps.grayscale(image))
    # IAM scans are nearly white, but compression leaves a little background
    # noise. A soft threshold retains antialiased ink while finding the actual
    # line bounds.
    background = Image.new("L", grayscale.size, 255)
    difference = ImageChops.difference(grayscale, background)
    mask = difference.point(lambda value: 255 if value >= 10 else 0)
    bounds = mask.getbbox()
    if not bounds:
        return grayscale
    left, top, right, bottom = bounds
    content_height = max(1, bottom - top)
    margin_y = min(16, max(4, round(content_height * 0.16)))
    margin_x = min(20, max(5, round(content_height * 0.22)))
    return grayscale.crop((
        max(0, left - margin_x),
        max(0, top - margin_y),
        min(grayscale.width, right + margin_x),
        min(grayscale.height, bottom + margin_y),
    ))


def line_tensor(image_bytes: bytes, max_model_width: int, profile: str) -> np.ndarray:
    with Image.open(io.BytesIO(image_bytes)) as source:
        cropped = crop_handwriting(source)
        model_height = 128 if profile == "pylaia" else MODEL_HEIGHT
        width = min(
            max_model_width,
            max(32, math.ceil(model_height * cropped.width / max(1, cropped.height))),
        )
        resized = cropped.resize((width, model_height), Image.Resampling.LANCZOS)
        pixels = np.asarray(resized, dtype=np.float32)
    if profile == "pylaia":
        return (1.0 - pixels[np.newaxis, np.newaxis, :, :] / 255.0).astype(np.float32)
    normalized = pixels / 127.5 - 1.0
    return np.repeat(normalized[np.newaxis, np.newaxis, :, :], 3, axis=1)


def greedy_decode(runtime: CandidateRuntime, probabilities: np.ndarray) -> tuple[str, float]:
    visible = probabilities[:, runtime.allowed_indexes]
    allowed_positions = np.argmax(visible, axis=1)
    allowed_probabilities = visible[
        np.arange(visible.shape[0], dtype=np.int64),
        allowed_positions,
    ]
    best_indexes = runtime.allowed_indexes[allowed_positions]
    blank_probabilities = probabilities[:, 0]
    use_blank = blank_probabilities >= allowed_probabilities
    best_indexes = np.where(use_blank, 0, best_indexes)
    best_probabilities = np.where(use_blank, blank_probabilities, allowed_probabilities)

    output_characters: list[str] = []
    output_confidences: list[float] = []
    previous = -1
    for index, confidence in zip(best_indexes.tolist(), best_probabilities.tolist()):
        if index and index != previous:
            output_characters.append(runtime.characters[index - 1])
            output_confidences.append(float(confidence))
        previous = index
    text = normalize_space("".join(output_characters))
    confidence = statistics.fmean(output_confidences) if output_confidences else 0.0
    return text, confidence


def trailing_word(value: str) -> str:
    match = re.search(r"([A-Za-z]+(?:'[A-Za-z]+)?)$", value)
    return match.group(1).casefold() if match else ""


def word_completion_score(word: str, evidence: LanguageEvidence) -> float:
    if not word:
        return 0.0
    if word in evidence.words:
        return 1.25 + min(1.1, len(word) * 0.09)
    if len(word) == 1 and word in {"a", "i"}:
        return 0.65
    # Unknown names and technical terms must remain possible.
    return -min(0.42, 0.08 + len(word) * 0.025)


def extension_language_delta(prefix: str, character: str, evidence: LanguageEvidence) -> float:
    delta = 0.0
    if character.isalpha():
        letters = "".join(re.findall(r"[A-Za-z]", prefix[-3:] + character)).casefold()
        if len(letters) >= 2:
            delta += 0.10 if letters[-2:] in evidence.bigrams else -0.025
        if len(letters) >= 3:
            delta += 0.17 if letters[-3:] in evidence.trigrams else -0.02
    elif character.isspace() or character in ",.;:!?":
        delta += word_completion_score(trailing_word(prefix), evidence)
        if character.isspace() and (not prefix or prefix[-1].isspace()):
            delta -= 1.2
        if character in ",.;:!?" and prefix.endswith(character):
            delta -= 0.8
    return delta


def prefix_beam_decode(
    runtime: CandidateRuntime,
    probabilities: np.ndarray,
    evidence: LanguageEvidence,
    arpa: ArpaLanguageModel | None,
    beam_width: int,
    top_k: int,
    language_weight: float,
    insertion_bonus: float,
) -> tuple[str, float]:
    negative_infinity = float("-inf")
    # prefix -> (probability ending in blank, probability ending in nonblank,
    # accumulated language evidence, visible character count)
    beam: dict[str, tuple[float, float, float, int]] = {
        "": (0.0, negative_infinity, 0.0, 0),
    }
    allowed = runtime.allowed_indexes
    tiny = np.finfo(np.float32).tiny
    for step in range(probabilities.shape[0]):
        row = probabilities[step]
        visible = row[allowed]
        count = min(top_k, visible.size)
        positions = np.argpartition(visible, -count)[-count:]
        positions = positions[np.argsort(visible[positions])[::-1]]
        indexes = allowed[positions].tolist()
        next_beam: dict[str, list[float | int]] = {}

        def entry(prefix: str, language_score: float, characters: int) -> list[float | int]:
            return next_beam.setdefault(
                prefix,
                [negative_infinity, negative_infinity, language_score, characters],
            )

        blank_log = math.log(max(tiny, float(row[0])))
        for prefix, (blank, nonblank, language_score, characters) in beam.items():
            total = float(np.logaddexp(blank, nonblank))
            same = entry(prefix, language_score, characters)
            same[0] = float(np.logaddexp(float(same[0]), total + blank_log))
            last = prefix[-1] if prefix else ""
            for index in indexes:
                character = runtime.characters[index - 1]
                character_log = math.log(max(tiny, float(row[index])))
                if character == last:
                    same[1] = float(np.logaddexp(float(same[1]), nonblank + character_log))
                    source = blank
                else:
                    source = total
                extended_prefix = prefix + character
                extended_score = language_score + (
                    arpa.extension_score(prefix, character)
                    if arpa is not None
                    else extension_language_delta(prefix, character, evidence)
                )
                extended_characters = characters + int(not character.isspace())
                extended = entry(extended_prefix, extended_score, extended_characters)
                extended[1] = float(np.logaddexp(float(extended[1]), source + character_log))

        ranked = sorted(
            next_beam.items(),
            key=lambda item: (
                float(np.logaddexp(float(item[1][0]), float(item[1][1])))
                + language_weight * float(item[1][2])
                + insertion_bonus * int(item[1][3])
            ),
            reverse=True,
        )[:beam_width]
        beam = {
            prefix: (float(values[0]), float(values[1]), float(values[2]), int(values[3]))
            for prefix, values in ranked
        }

    def final_score(item: tuple[str, tuple[float, float, float, int]]) -> float:
        prefix, (blank, nonblank, language_score, characters) = item
        completed = language_score + (
            arpa.end_score(prefix)
            if arpa is not None
            else word_completion_score(trailing_word(prefix), evidence)
        )
        return (
            float(np.logaddexp(blank, nonblank))
            + language_weight * completed
            + insertion_bonus * characters
        )

    prefix, (blank, nonblank, _, _) = max(beam.items(), key=final_score)
    text = normalize_space(prefix)
    # Keep confidence comparable to greedy decoding. Prefix probability is a
    # sequence score and not a calibrated per-character probability.
    _, confidence = greedy_decode(runtime, probabilities)
    return text, confidence


def recognize(
    runtime: CandidateRuntime,
    tensor: np.ndarray,
    evidence: LanguageEvidence,
    arpa: ArpaLanguageModel | None,
    beam_width: int,
    top_k: int,
    language_weight: float,
    insertion_bonus: float,
) -> Recognition:
    started = time.perf_counter()
    output = runtime.session.run(
        [runtime.output_name],
        {runtime.input_name: tensor},
    )[0]
    probabilities = output[0]
    if beam_width > 1:
        text, confidence = prefix_beam_decode(
            runtime,
            probabilities,
            evidence,
            arpa,
            beam_width,
            top_k,
            language_weight,
            insertion_bonus,
        )
    else:
        text, confidence = greedy_decode(runtime, probabilities)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return Recognition(text, confidence, elapsed_ms)


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


def selected_rows(
    dataset_path: Path,
    limit: int,
    offset: int,
    sequential: bool,
) -> Iterable[dict]:
    table = parquet.read_table(dataset_path, columns=["image", "text"])
    total = table.num_rows
    if offset >= total:
        raise ValueError(f"offset {offset} exceeds dataset size {total}")
    available = total - offset
    count = available if limit <= 0 else min(limit, available)
    # Evenly spread a limited benchmark over the complete official test split
    # so a lucky first page or writer cannot dominate the result.
    indexes = (
        np.arange(offset, offset + count, dtype=np.int64)
        if sequential
        else np.linspace(offset, total - 1, num=count, dtype=np.int64)
    )
    for index in indexes.tolist():
        yield table.slice(index, 1).to_pylist()[0]


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values, dtype=np.float64), fraction * 100))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--candidate", type=parse_candidate, action="append", required=True)
    parser.add_argument("--limit", type=int, default=300)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--sequential", action="store_true")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-width", type=int, default=DEFAULT_MAX_MODEL_WIDTH)
    parser.add_argument("--beam-width", type=int, default=1)
    parser.add_argument("--beam-top-k", type=int, default=10)
    parser.add_argument("--language-weight", type=float, default=0.42)
    parser.add_argument("--insertion-bonus", type=float, default=0.04)
    parser.add_argument("--dictionary", type=Path)
    parser.add_argument("--language-data", type=Path)
    parser.add_argument("--arpa", type=Path)
    parser.add_argument("--worst", type=int, default=12)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()
    if not args.dataset.is_file():
        raise FileNotFoundError(args.dataset)

    runtimes = [create_runtime(spec, max(1, args.threads)) for spec in args.candidate]
    evidence = load_language_evidence(args.dictionary, args.language_data)
    arpa = load_arpa_language_model(args.arpa)
    stats = {
        runtime.spec.name: {
            "character_edits": 0,
            "characters": 0,
            "folded_character_edits": 0,
            "word_edits": 0,
            "words": 0,
            "exact": 0,
            "folded_exact": 0,
            "confidence": [],
            "milliseconds": [],
            "failures": [],
        }
        for runtime in runtimes
    }
    sample_count = 0
    benchmark_started = time.perf_counter()
    for sample_count, row in enumerate(
        selected_rows(args.dataset, args.limit, args.offset, args.sequential),
        start=1,
    ):
        truth = normalize_space(row["text"])
        image = row["image"]
        image_bytes = image.get("bytes") if isinstance(image, dict) else None
        if not truth or not image_bytes:
            continue
        for runtime in runtimes:
            tensor = line_tensor(
                image_bytes,
                max(32, args.max_width),
                runtime.spec.profile,
            )
            result = recognize(
                runtime,
                tensor,
                evidence,
                arpa,
                max(1, args.beam_width),
                max(1, args.beam_top_k),
                args.language_weight,
                args.insertion_bonus,
            )
            candidate = stats[runtime.spec.name]
            character_edits = edit_distance(truth, result.text)
            candidate["character_edits"] += character_edits
            candidate["characters"] += len(truth)
            candidate["folded_character_edits"] += edit_distance(truth.casefold(), result.text.casefold())
            candidate["word_edits"] += edit_distance(truth.split(), result.text.split())
            candidate["words"] += len(truth.split())
            candidate["exact"] += int(result.text == truth)
            candidate["folded_exact"] += int(result.text.casefold() == truth.casefold())
            candidate["confidence"].append(result.confidence)
            candidate["milliseconds"].append(result.elapsed_ms)
            candidate["failures"].append(Failure(
                character_edits / max(1, len(truth)),
                truth,
                result.text,
                result.confidence,
            ))
        if sample_count % 50 == 0:
            print(f"processed {sample_count} lines", flush=True)

    elapsed = time.perf_counter() - benchmark_started
    print(f"\nDataset: {args.dataset} | lines: {sample_count} | wall time: {elapsed:.2f}s")
    machine_results = {}
    for runtime in runtimes:
        candidate = stats[runtime.spec.name]
        lines = max(1, sample_count)
        character_error_rate = candidate["character_edits"] / max(1, candidate["characters"])
        folded_character_error_rate = (
            candidate["folded_character_edits"] / max(1, candidate["characters"])
        )
        word_error_rate = candidate["word_edits"] / max(1, candidate["words"])
        machine_results[runtime.spec.name] = {
            "characterEdits": candidate["character_edits"],
            "characters": candidate["characters"],
            "foldedCharacterEdits": candidate["folded_character_edits"],
            "wordEdits": candidate["word_edits"],
            "words": candidate["words"],
            "exact": candidate["exact"],
            "foldedExact": candidate["folded_exact"],
            "confidenceTotal": float(sum(candidate["confidence"])),
            "latencyMilliseconds": candidate["milliseconds"],
        }
        print(
            f"\n{runtime.spec.name}\n"
            f"  CER: {character_error_rate * 100:.2f}% "
            f"(case-folded {folded_character_error_rate * 100:.2f}%)\n"
            f"  WER: {word_error_rate * 100:.2f}%\n"
            f"  exact lines: {candidate['exact'] / lines * 100:.2f}% "
            f"(case-folded {candidate['folded_exact'] / lines * 100:.2f}%)\n"
            f"  confidence: {statistics.fmean(candidate['confidence']) * 100:.2f}%\n"
            f"  latency: median {statistics.median(candidate['milliseconds']):.2f}ms, "
            f"p95 {percentile(candidate['milliseconds'], 0.95):.2f}ms"
        )
        failures = sorted(
            candidate["failures"],
            key=lambda failure: failure.normalized_distance,
            reverse=True,
        )[: max(0, args.worst)]
        if failures:
            print("  worst lines:")
            for failure in failures:
                print(
                    f"    {failure.normalized_distance * 100:6.1f}% | "
                    f"{failure.truth!r} -> {failure.predicted!r} "
                    f"({failure.confidence * 100:.1f}%)"
                )
    if args.json_output:
        args.json_output.write_text(json.dumps({
            "dataset": str(args.dataset),
            "sampleCount": sample_count,
            "offset": args.offset,
            "sequential": args.sequential,
            "wallSeconds": elapsed,
            "candidates": machine_results,
        }), encoding="utf-8")


if __name__ == "__main__":
    main()
