#!/usr/bin/env python3
"""Build and audit compact writer-independent handwriting prototypes.

The input is the official HASYv2 archive (ODbL-1.0).  Raw dataset material is
never copied into the application.  The generated file contains only bounded,
quantized class centroids and explicit source/license metadata.  Evaluation is
writer-disjoint for every sample whose contributor identity is available.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


FEATURE_SIZE = 24
ANALYSIS_SIZE = 96
INK_SPAN = 76
DATASET_MD5 = "fddf23f36e24b5236f6b3a0880c778e3"
DATASET_DOI = "https://doi.org/10.5281/zenodo.259444"


def catalog_mapping() -> dict[str, str]:
    mapping = {str(value): f"digit_{value}" for value in range(10)}
    mapping.update({chr(value): f"latin_upper_{chr(value)}" for value in range(65, 91)})
    mapping.update({chr(value): f"latin_lower_{chr(value)}" for value in range(97, 123)})
    mapping.update({
        r"\alpha": "greek_alpha", r"\beta": "greek_beta",
        r"\gamma": "greek_gamma", r"\delta": "greek_delta",
        r"\epsilon": "greek_epsilon", r"\varepsilon": "greek_epsilon",
        r"\zeta": "greek_zeta", r"\eta": "greek_eta",
        r"\theta": "greek_theta", r"\vartheta": "greek_theta",
        r"\iota": "greek_iota", r"\kappa": "greek_kappa",
        r"\varkappa": "greek_kappa", r"\lambda": "greek_lambda",
        r"\mu": "greek_mu", r"\nu": "greek_nu", r"\xi": "greek_xi",
        r"\pi": "greek_pi", r"\varpi": "greek_pi", r"\rho": "greek_rho",
        r"\varrho": "greek_rho", r"\sigma": "greek_sigma",
        r"\tau": "greek_tau", r"\phi": "greek_phi",
        r"\varphi": "greek_phi", r"\chi": "greek_chi",
        r"\psi": "greek_psi", r"\omega": "greek_omega",
        r"\Delta": "greek_delta_upper", r"\Lambda": "greek_lambda_upper",
        r"\Omega": "greek_omega_upper",
        "+": "operator_plus", "-": "operator_minus", r"\times": "operator_multiply",
        r"\cdot": "operator_dot", r"\div": "operator_divide",
        r"\neq": "relation_not_equal", "<": "relation_less", ">": "relation_greater",
        r"\leq": "relation_less_equal", r"\leqslant": "relation_less_equal",
        r"\geq": "relation_greater_equal", r"\geqslant": "relation_greater_equal",
        r"\pm": "operator_plus_minus", r"\approx": "relation_approx",
        r"\equiv": "relation_equiv", r"\infty": "symbol_infinity",
        r"\sum": "operator_sum", r"\Sigma": "operator_sum",
        r"\prod": "operator_product", r"\int": "operator_integral",
        r"\oint": "operator_contour_integral", r"\sqrt{}": "operator_sqrt",
        r"\partial": "operator_partial", r"\nabla": "operator_nabla",
        r"\%": "operator_percent", r"\prime": "operator_prime",
        r"\degree": "symbol_degree", r"\circ": "symbol_degree", "/": "operator_slash",
        "|": "absolute_bar", r"\propto": "relation_proportional",
        r"\in": "set_element", r"\notin": "set_not_element",
        r"\subset": "set_subset", r"\subseteq": "set_subset_equal",
        r"\cup": "set_union", r"\cap": "set_intersection",
        r"\emptyset": "set_empty", r"\varnothing": "set_empty",
        r"\forall": "logic_forall", r"\exists": "logic_exists",
        r"\wedge": "logic_and", r"\vee": "logic_or", r"\neg": "logic_not",
        r"\rightarrow": "arrow_right", r"\longrightarrow": "arrow_right",
        r"\leftrightarrow": "arrow_both", r"\Rightarrow": "arrow_implies",
        r"\Longrightarrow": "arrow_implies", r"\Leftrightarrow": "arrow_iff",
        r"\Longleftrightarrow": "arrow_iff", r"\parallel": "geometry_parallel",
        r"\|": "geometry_parallel", r"\perp": "geometry_perpendicular",
        r"\bot": "geometry_perpendicular", "[": "bracket_left_square",
        "]": "bracket_right_square", r"\{": "bracket_left_curly",
        r"\}": "bracket_right_curly",
    })
    return mapping


def contributor_is_holdout(user_id: str) -> bool:
    if user_id == "16925":
        return False
    digest = hashlib.sha256(f"fanotes-hasy-holdout:{user_id}".encode()).digest()
    return int.from_bytes(digest[:4], "big") % 5 == 0


def pooled_feature(image: Image.Image) -> tuple[np.ndarray, float]:
    gray = np.asarray(image.convert("L"), dtype=np.float32)
    ink = np.clip((255.0 - gray) / 255.0 * 1.25, 0.0, 1.0)
    positions = np.argwhere(ink > 0.035)
    if not len(positions):
        return np.zeros(FEATURE_SIZE * FEATURE_SIZE, dtype=np.float32), 1.0
    min_y, min_x = positions.min(axis=0)
    max_y, max_x = positions.max(axis=0)
    cropped = Image.fromarray(np.uint8(np.clip(ink[min_y:max_y + 1, min_x:max_x + 1] * 255, 0, 255)))
    width, height = cropped.size
    scale = INK_SPAN / max(1, max(width, height))
    target_width = max(1, round(width * scale))
    target_height = max(1, round(height * scale))
    resized = cropped.resize((target_width, target_height), Image.Resampling.LANCZOS)
    canvas = Image.new("L", (ANALYSIS_SIZE, ANALYSIS_SIZE), 0)
    canvas.paste(resized, ((ANALYSIS_SIZE - target_width) // 2, (ANALYSIS_SIZE - target_height) // 2))
    values = np.asarray(canvas, dtype=np.float32) / 255.0
    pools = values.reshape(FEATURE_SIZE, 4, FEATURE_SIZE, 4).transpose(0, 2, 1, 3)
    feature = pools.max(axis=(2, 3)) * 0.72 + pools.mean(axis=(2, 3)) * 0.28
    feature[feature < 0.025] = 0
    return feature.reshape(-1), width / max(1, height)


def normalized_rows(values: np.ndarray) -> np.ndarray:
    lengths = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.maximum(lengths, 1e-7)


def kmeans(values: np.ndarray, count: int) -> np.ndarray:
    vectors = normalized_rows(values.astype(np.float32, copy=False))
    # Deterministic farthest-first seeds retain rare handwriting styles and do
    # not need a large pairwise distance matrix.
    seeds = [int(np.argmax(np.linalg.norm(vectors - vectors.mean(axis=0), axis=1)))]
    while len(seeds) < count:
        similarity = vectors @ vectors[seeds].T
        nearest_distance = 1 - similarity.max(axis=1)
        nearest_distance[seeds] = -1
        seeds.append(int(np.argmax(nearest_distance)))
    centers = vectors[seeds].copy()
    for _ in range(14):
        assignments = np.argmax(vectors @ centers.T, axis=1)
        updated = centers.copy()
        for index in range(count):
            members = vectors[assignments == index]
            if len(members):
                updated[index] = members.mean(axis=0)
        updated = normalized_rows(updated)
        if np.max(np.abs(updated - centers)) < 1e-5:
            break
        centers = updated
    return centers


def predict(features: np.ndarray, centers: np.ndarray, center_labels: list[str]) -> list[str]:
    normalized = normalized_rows(features)
    predictions: list[str] = []
    for start in range(0, len(normalized), 512):
        indexes = np.argmax(normalized[start:start + 512] @ centers.T, axis=1)
        predictions.extend(center_labels[index] for index in indexes)
    return predictions


def parse_mathwriting(path: Path) -> tuple[str, Image.Image] | None:
    source = path.read_text(encoding="utf8")
    expected = re.search(r'<annotation\s+type="(?:normalizedLabel|label)">([\s\S]*?)</annotation>', source)
    if not expected:
        return None
    traces = []
    for match in re.finditer(r'<trace\s+id="\d+">([\s\S]*?)</trace>', source):
        points = []
        for raw in re.split(r"\s*,\s*", match.group(1).strip()):
            values = raw.split()
            if len(values) >= 2:
                points.append((float(values[0]), float(values[1])))
        if points:
            traces.append(points)
    if not traces:
        return None
    all_points = [point for trace in traces for point in trace]
    min_x = min(point[0] for point in all_points)
    max_x = max(point[0] for point in all_points)
    min_y = min(point[1] for point in all_points)
    max_y = max(point[1] for point in all_points)
    scale = 84 / max(1, max(max_x - min_x, max_y - min_y))
    image = Image.new("L", (96, 96), 255)
    draw = ImageDraw.Draw(image)
    for trace in traces:
        points = [
            ((x - (min_x + max_x) / 2) * scale + 48, (y - (min_y + max_y) / 2) * scale + 48)
            for x, y in trace
        ]
        if len(points) == 1:
            x, y = points[0]
            draw.ellipse((x - 1.5, y - 1.5, x + 1.5, y + 1.5), fill=0)
        else:
            draw.line(points, fill=0, width=3, joint="curve")
    return expected.group(1).replace("&lt;", "<").replace("&gt;", ">"), image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--mathwriting", type=Path)
    parser.add_argument("--prototypes", type=int, default=5)
    parser.add_argument("--max-per-class", type=int, default=1600)
    parser.add_argument("--max-per-contributor-class", type=int, default=80)
    args = parser.parse_args()

    mapping = catalog_mapping()
    symbols = {row["symbol_id"]: row["latex"] for row in csv.DictReader((args.dataset / "symbols.csv").open())}
    rows = list(csv.DictReader((args.dataset / "hasy-data-labels.csv").open()))
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    holdout_rows: list[dict[str, str]] = []
    for row in rows:
        label = mapping.get(symbols.get(row["symbol_id"], ""))
        if not label:
            continue
        row["label_id"] = label
        if contributor_is_holdout(row["user_id"]):
            holdout_rows.append(row)
        else:
            grouped[label].append(row)

    training: dict[str, list[dict[str, str]]] = {}
    for label, candidates in grouped.items():
        contributor_counts: Counter[str] = Counter()
        selected = []
        for row in candidates:
            if contributor_counts[row["user_id"]] >= args.max_per_contributor_class:
                continue
            contributor_counts[row["user_id"]] += 1
            selected.append(row)
            if len(selected) >= args.max_per_class:
                break
        training[label] = selected

    centers_list = []
    center_labels: list[str] = []
    center_aspects: list[float] = []
    for label in sorted(training):
        vectors = []
        aspects = []
        for row in training[label]:
            vector, aspect = pooled_feature(Image.open(args.dataset / row["path"]))
            vectors.append(vector)
            aspects.append(aspect)
        values = np.stack(vectors)
        count = min(args.prototypes, max(1, math.ceil(math.sqrt(len(values) / 18))))
        centers = kmeans(values, count)
        centers_list.extend(centers)
        center_labels.extend([label] * len(centers))
        center_aspects.extend([float(np.median(aspects))] * len(centers))
    center_matrix = normalized_rows(np.stack(centers_list))

    validation_features = []
    validation_labels = []
    validation_users = set()
    for row in holdout_rows:
        validation_features.append(pooled_feature(Image.open(args.dataset / row["path"]))[0])
        validation_labels.append(row["label_id"])
        validation_users.add(row["user_id"])
    validation_predictions = predict(np.stack(validation_features), center_matrix, center_labels)
    correct = sum(first == second for first, second in zip(validation_labels, validation_predictions))
    per_class = defaultdict(lambda: [0, 0])
    for expected, predicted in zip(validation_labels, validation_predictions):
        per_class[expected][1] += 1
        per_class[expected][0] += expected == predicted

    report = {
        "dataset": "HASYv2",
        "source": DATASET_DOI,
        "datasetMd5": DATASET_MD5,
        "license": "ODbL-1.0",
        "classes": len(training),
        "trainingSamples": sum(map(len, training.values())),
        "holdoutContributors": len(validation_users),
        "holdoutSamples": len(validation_labels),
        "holdoutAccuracy": correct / max(1, len(validation_labels)),
        "holdoutClasses": {
            key: {"correct": value[0], "samples": value[1], "accuracy": value[0] / value[1]}
            for key, value in sorted(per_class.items())
        },
        "weakestHoldoutClasses": sorted(
            ({"labelId": key, "correct": value[0], "samples": value[1], "accuracy": value[0] / value[1]}
             for key, value in per_class.items()),
            key=lambda row: (row["accuracy"], -row["samples"]),
        )[:20],
    }

    if args.mathwriting:
        math_features = []
        math_labels = []
        for path in sorted((args.mathwriting / "symbols").glob("*.inkml")):
            parsed = parse_mathwriting(path)
            if not parsed:
                continue
            latex, image = parsed
            label = mapping.get(latex)
            if not label:
                continue
            math_features.append(pooled_feature(image)[0])
            math_labels.append(label)
        math_predictions = predict(np.stack(math_features), center_matrix, center_labels)
        math_correct = sum(first == second for first, second in zip(math_labels, math_predictions))
        report["mathWritingMappedSymbols"] = len(math_labels)
        report["mathWritingMappedAccuracy"] = math_correct / max(1, len(math_labels))

    if args.output:
        quantized = np.uint8(np.clip(np.stack(centers_list) * 255, 0, 255).round())
        payload = {
            "version": 1,
            "featureSize": FEATURE_SIZE,
            "source": DATASET_DOI,
            "datasetMd5": DATASET_MD5,
            "license": "ODbL-1.0",
            "labels": center_labels,
            "physicalAspects": center_aspects,
            "rasters": base64.b64encode(quantized.tobytes()).decode("ascii"),
            "audit": report,
        }
        args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf8")

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
