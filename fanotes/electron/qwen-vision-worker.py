#!/usr/bin/env python3
"""FaNotes Qwen3-VL worker: local VLM inference forced onto the Intel NPU.

Protocol (one JSON line on stdin → one JSON line on stdout):
  request:  {"command":"probe"} | {"command":"recognize","modelDir":"...","imagePath":"...","prompt":"...","maxNewTokens":96}
  response: {"ok":true,"devices":[...],"npu":true,...} | {"ok":true,"text":"...","device":"NPU",...} | {"ok":false,"error":"..."}
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def host_npu_driver_hints() -> dict:
    """OS-level hints so users know if the Intel NPU driver is missing."""
    hints: list[str] = []
    driver_paths: list[str] = []
    if sys.platform.startswith("linux"):
        for candidate in (
            "/dev/accel/accel0",
            "/dev/accel/accel1",
            "/sys/class/accel",
            "/dev/ivpu0",
        ):
            if Path(candidate).exists():
                driver_paths.append(candidate)
        if not driver_paths:
            hints.append(
                "Kein Linux-NPU-Gerät gefunden (/dev/accel/…). "
                "Installiere den Intel NPU Driver (linux-npu-driver / intel-driver-compiler-npu "
                "+ level-zero) und starte neu. Core Ultra X9/H/V braucht einen aktuellen Treiber."
            )
        else:
            hints.append(f"NPU-Gerätedatei vorhanden: {', '.join(driver_paths)}")
    elif sys.platform.startswith("win"):
        hints.append(
            "Unter Windows: Intel NPU-Treiber und Intel Graphics/NPU-Software aus dem "
            "Intel Driver & Support Assistant installieren, dann neu starten."
        )
    return {"driverPaths": driver_paths, "hints": hints}


def pick_npu_device(core, devices: list[str]) -> str | None:
    """Return the OpenVINO device id for the Intel NPU, if any."""
    ranked: list[str] = []
    for device in devices:
        upper = device.upper()
        if upper == "NPU" or upper.startswith("NPU.") or upper.startswith("NPU:"):
            ranked.append(device)
        elif "NPU" in upper and "CPU" not in upper and "GPU" not in upper:
            ranked.append(device)
    if ranked:
        ranked.sort(key=lambda value: (0 if value.upper() == "NPU" else 1, value))
        return ranked[0]
    # Some builds only expose NPU after a property query loads the plugin.
    for candidate in ("NPU", "NPU.0"):
        try:
            core.get_property(candidate, "SUPPORTED_PROPERTIES")
            return candidate
        except Exception:  # noqa: BLE001
            continue
    return None


def probe() -> dict:
    # Never force OV_NPU_PLATFORM during probe. Hardcoding MTL (3720) can hide
    # newer Core Ultra NPUs (Series 2 / X9 388H / NPU4000-class silicon).
    os.environ.pop("OV_NPU_PLATFORM", None)
    os.environ.pop("OPENVINO_DEVICE", None)

    host = host_npu_driver_hints()
    try:
        from openvino import Core  # type: ignore
    except Exception as error:  # noqa: BLE001
        detail = str(error).strip() or error.__class__.__name__
        hint = (
            "Installiere OpenVINO für denselben Python-Interpreter: "
            'python3 -m pip install --user "openvino>=2024.4" "openvino-genai>=2024.4" pillow'
        )
        if sys.platform.startswith("win"):
            hint = (
                "Installiere OpenVINO für denselben Python-Interpreter: "
                'py -3 -m pip install --user "openvino>=2024.4" "openvino-genai>=2024.4" pillow'
            )
        return {
            "ok": False,
            "error": f"OpenVINO ist nicht verfügbar ({detail}). {hint}",
            "devices": [],
            "npu": False,
            "genai": False,
            "npuDevice": None,
            "host": host,
        }
    try:
        core = Core()
        devices = [str(device) for device in core.available_devices]
    except Exception as error:  # noqa: BLE001
        return {
            "ok": False,
            "error": f"OpenVINO-Geräte konnten nicht gelesen werden: {error}",
            "devices": [],
            "npu": False,
            "genai": False,
            "npuDevice": None,
            "host": host,
        }

    npu_device = pick_npu_device(core, devices)
    has_npu = bool(npu_device)
    openvino_version = getattr(__import__("openvino"), "__version__", "unknown")

    try:
        import openvino_genai  # type: ignore  # noqa: F401
        genai = True
        genai_error = None
    except Exception as error:  # noqa: BLE001
        genai = False
        genai_error = error

    if not has_npu:
        device_list = ", ".join(devices) if devices else "keine"
        host_hint = " ".join(host.get("hints") or [])
        return {
            "ok": True,
            "devices": devices,
            "npu": False,
            "genai": genai,
            "npuDevice": None,
            "openvinoVersion": openvino_version,
            "host": host,
            "error": (
                "Keine Intel-NPU von OpenVINO erkannt "
                f"(sichtbare Geräte: {device_list}). "
                "Dein Core Ultra besitzt eine NPU – OpenVINO sieht sie aber nicht. "
                f"{host_hint} "
                "Aktualisiere OpenVINO (≥2024.6 empfohlen für neue Core Ultra) und den NPU-Treiber."
            ),
        }

    if not genai:
        return {
            "ok": True,
            "devices": devices,
            "npu": True,
            "genai": False,
            "npuDevice": npu_device,
            "openvinoVersion": openvino_version,
            "host": host,
            "error": (
                "openvino-genai fehlt "
                f"({genai_error}). Installiere: "
                + (
                    'py -3 -m pip install --user "openvino-genai>=2024.4"'
                    if sys.platform.startswith("win")
                    else 'python3 -m pip install --user "openvino-genai>=2024.4"'
                )
            ),
        }

    return {
        "ok": True,
        "devices": devices,
        "npu": True,
        "genai": True,
        "npuDevice": npu_device,
        "openvinoVersion": openvino_version,
        "host": host,
    }


def load_rgb_image(image_path: Path):
    try:
        from PIL import Image, ImageOps  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError(f"Pillow fehlt für Bildvorbereitung: {error}") from error
    with Image.open(image_path) as image:
        rgb = image.convert("RGB")
    try:
        from PIL import ImageEnhance, ImageFilter  # type: ignore
        # Gentle local contrast — aggressive autocontrast erases thin pen joins.
        rgb = ImageEnhance.Contrast(rgb).enhance(1.16)
        rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1.1, percent=115, threshold=2))
    except Exception:  # noqa: BLE001
        try:
            rgb = ImageOps.autocontrast(rgb, cutoff=0.4)
        except Exception:  # noqa: BLE001
            pass
    width, height = rgb.size
    # Qwen3-VL needs enough pixels per glyph; upscale small line crops.
    longest = max(width, height)
    if longest < 480:
        factor = 480 / max(1, longest)
        rgb = rgb.resize(
            (max(96, int(round(width * factor))), max(80, int(round(height * factor)))),
            Image.Resampling.LANCZOS,
        )
        width, height = rgb.size
    # Qwen3-VL vision tokens align to 28px patches.
    pad_w = (28 - width % 28) % 28
    pad_h = (28 - height % 28) % 28
    if pad_w or pad_h:
        padded = Image.new("RGB", (width + pad_w, height + pad_h), (255, 255, 255))
        padded.paste(rgb, (pad_w // 2, pad_h // 2))
        rgb = padded
    return rgb


def clean_output_text(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    # Some GenAI builds return GenerationOutput-like objects.
    if hasattr(value, "texts") and value.texts:  # type: ignore[attr-defined]
        text = str(value.texts[0]).strip()  # type: ignore[index]
    elif hasattr(value, "text"):
        text = str(getattr(value, "text") or text).strip()
    text = text.replace("\r\n", "\n")
    text = text.strip().strip("`").strip()
    for prefix in (
        "the handwritten text is:",
        "the handwritten text reads:",
        "the text is:",
        "transcription:",
        "transcribed text:",
        "erkannte text:",
        "der text lautet:",
        "hier ist der text:",
    ):
        lower = text.lower()
        if lower.startswith(prefix):
            text = text[len(prefix):].strip()
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1].strip()
    return text


def recognize(model_dir: Path, image_path: Path, prompt: str, max_new_tokens: int) -> dict:
    probe_state = probe()
    if not probe_state.get("ok"):
        return probe_state
    if not probe_state.get("npu"):
        return {
            "ok": False,
            "error": probe_state.get("error")
            or "Keine Intel-NPU gefunden. Qwen3-VL ist in FaNotes absichtlich NPU-only.",
            "devices": probe_state.get("devices", []),
            "npu": False,
            "host": probe_state.get("host"),
        }
    if not probe_state.get("genai"):
        return {
            "ok": False,
            "error": "openvino-genai fehlt. Installiere OpenVINO GenAI für die NPU-Laufzeit.",
            "devices": probe_state.get("devices", []),
            "npu": True,
        }
    if not model_dir.is_dir():
        return {"ok": False, "error": "Das Qwen3-VL-Modellverzeichnis fehlt."}
    if not image_path.is_file():
        return {"ok": False, "error": "Das Eingabebild fehlt."}

    npu_device = str(probe_state.get("npuDevice") or "NPU")
    # Force NPU exclusively — never fall back to CPU for this optional model.
    # Do NOT pin OV_NPU_PLATFORM: older "3720" (Meteor Lake) breaks newer silicon
    # such as Core Ultra X9 388H (NPU4000-class). Let OpenVINO auto-detect.
    os.environ.pop("OV_NPU_PLATFORM", None)
    os.environ["OPENVINO_DEVICE"] = npu_device

    try:
        from openvino_genai import VLMPipeline  # type: ignore
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"OpenVINO GenAI VLMPipeline nicht ladbar: {error}"}

    try:
        pipeline = VLMPipeline(str(model_dir), npu_device)
    except Exception as error:  # noqa: BLE001
        detail = str(error)
        if "qwen3_vl" in detail.lower() and "unsupported" in detail.lower():
            return {
                "ok": False,
                "error": (
                    "OpenVINO GenAI ist zu alt für Qwen3-VL (Unsupported 'qwen3_vl'). "
                    "FaNotes braucht openvino-genai ≥2026.1. "
                    "In den Einstellungen erneut „Lizenz akzeptieren & alles laden“ wählen "
                    "— die Laufzeit wird dann automatisch auf 2026.1+ aktualisiert. "
                    f"Gerät={npu_device}."
                ),
                "device": npu_device,
                "needsRuntimeUpgrade": True,
            }
        return {
            "ok": False,
            "error": (
                "Qwen3-VL konnte auf der NPU nicht geladen werden. "
                "Aktuelle OpenVINO/GenAI-Wheels (≥2026.1) und den aktuellen Intel-NPU-Treiber "
                f"für Core Ultra nutzen. Gerät={npu_device}. Details: {detail}"
            ),
            "device": npu_device,
        }

    try:
        image = load_rgb_image(image_path)
        generation_kwargs = {"max_new_tokens": max_new_tokens}
        # Prefer deterministic decoding for OCR-style transcription when supported.
        try:
            from openvino_genai import GenerationConfig  # type: ignore
            config = GenerationConfig()
            config.max_new_tokens = max_new_tokens
            if hasattr(config, "do_sample"):
                config.do_sample = False
            if hasattr(config, "temperature"):
                config.temperature = 0.0
            if hasattr(config, "top_p"):
                config.top_p = 1.0
            if hasattr(config, "repetition_penalty"):
                config.repetition_penalty = 1.08
            generation_kwargs = {"generation_config": config}
        except Exception:  # noqa: BLE001
            generation_kwargs = {"max_new_tokens": max_new_tokens}

        try:
            result = pipeline.generate(prompt, image=image, **generation_kwargs)
        except TypeError:
            try:
                result = pipeline.generate(prompt, images=[image], **generation_kwargs)
            except TypeError:
                result = pipeline.generate(prompt, images=[image], max_new_tokens=max_new_tokens)
        text = clean_output_text(result)
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"NPU-Inferenz fehlgeschlagen: {error}", "device": npu_device}

    if not text:
        return {"ok": False, "error": "Qwen3-VL lieferte keinen Text.", "device": npu_device}
    if len(text) > 4_000:
        text = text[:4_000].rstrip()
    # Normalize device label for the main process policy check.
    device_label = "NPU" if "NPU" in npu_device.upper() else npu_device
    return {
        "ok": True,
        "text": text,
        "device": device_label,
        "precision": "int4-npu",
        "model": "qwen3-vl-2b",
    }


def main() -> int:
    try:
        raw = sys.stdin.readline()
        if not raw:
            emit({"ok": False, "error": "Leere Worker-Anfrage."})
            return 2
        request = json.loads(raw)
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "error": f"Ungültige Worker-Anfrage: {error}"})
        return 2

    command = request.get("command")
    if command == "probe":
        emit(probe())
        return 0
    if command != "recognize":
        emit({"ok": False, "error": f"Unbekannter Befehl: {command!r}"})
        return 2

    model_dir = Path(str(request.get("modelDir") or ""))
    image_path = Path(str(request.get("imagePath") or ""))
    prompt = str(request.get("prompt") or "").strip()
    max_new_tokens = int(request.get("maxNewTokens") or 220)
    max_new_tokens = max(48, min(512, max_new_tokens))
    if not prompt:
        prompt = (
            "Transcribe the handwriting in the image exactly, top to bottom. "
            "Keep line breaks and diacritics. Output only the text. "
            "Do not translate, invent words, or fix spelling."
        )
    emit(recognize(model_dir, image_path, prompt, max_new_tokens))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
