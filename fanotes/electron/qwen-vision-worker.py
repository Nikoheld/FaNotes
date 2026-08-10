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


def probe() -> dict:
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
        }
    has_npu = any(device.upper().startswith("NPU") for device in devices)
    try:
        import openvino_genai  # type: ignore  # noqa: F401
        genai = True
    except Exception as genai_error:  # noqa: BLE001
        return {
            "ok": True,
            "devices": devices,
            "npu": has_npu,
            "genai": False,
            "openvinoVersion": getattr(__import__("openvino"), "__version__", "unknown"),
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
        "npu": has_npu,
        "genai": genai,
        "openvinoVersion": getattr(__import__("openvino"), "__version__", "unknown"),
    }


def load_rgb_image(image_path: Path):
    try:
        from PIL import Image  # type: ignore
    except Exception as error:  # noqa: BLE001
        raise RuntimeError(f"Pillow fehlt für Bildvorbereitung: {error}") from error
    with Image.open(image_path) as image:
        return image.convert("RGB")


def recognize(model_dir: Path, image_path: Path, prompt: str, max_new_tokens: int) -> dict:
    probe_state = probe()
    if not probe_state.get("ok"):
        return probe_state
    if not probe_state.get("npu"):
        return {
            "ok": False,
            "error": "Keine Intel-NPU gefunden. Qwen3-VL ist in FaNotes absichtlich NPU-only (geringer Strom, hohe Effizienz auf Core Ultra).",
            "devices": probe_state.get("devices", []),
            "npu": False,
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

    # Force NPU exclusively — never fall back to CPU for this optional model.
    os.environ["OPENVINO_DEVICE"] = "NPU"
    os.environ["OV_NPU_PLATFORM"] = os.environ.get("OV_NPU_PLATFORM", "3720")

    try:
        from openvino_genai import VLMPipeline  # type: ignore
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"OpenVINO GenAI VLMPipeline nicht ladbar: {error}"}

    try:
        pipeline = VLMPipeline(str(model_dir), "NPU")
    except Exception as error:  # noqa: BLE001
        return {
            "ok": False,
            "error": (
                "Qwen3-VL konnte nicht auf der NPU geladen werden. "
                "Nutze das INT4/NPU-freundliche OpenVINO-Paket und aktuelle NPU-Treiber "
                f"(Core Ultra). Details: {error}"
            ),
            "device": "NPU",
        }

    try:
        image = load_rgb_image(image_path)
        # Prefer the modern keyword API; fall back to older signatures if needed.
        try:
            result = pipeline.generate(
                prompt,
                image=image,
                max_new_tokens=max_new_tokens,
            )
        except TypeError:
            result = pipeline.generate(prompt, images=[image], max_new_tokens=max_new_tokens)
        text = str(result).strip()
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"NPU-Inferenz fehlgeschlagen: {error}", "device": "NPU"}

    if not text:
        return {"ok": False, "error": "Qwen3-VL lieferte keinen Text.", "device": "NPU"}
    if len(text) > 4_000:
        text = text[:4_000].rstrip()
    return {
        "ok": True,
        "text": text,
        "device": "NPU",
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
    max_new_tokens = int(request.get("maxNewTokens") or 96)
    max_new_tokens = max(16, min(256, max_new_tokens))
    if not prompt:
        prompt = (
            "Transcribe the handwritten text in this image exactly. "
            "Return only the plain text, no markdown, no explanations."
        )
    emit(recognize(model_dir, image_path, prompt, max_new_tokens))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
