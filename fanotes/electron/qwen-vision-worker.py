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
        return {
            "ok": False,
            "error": (
                "Qwen3-VL konnte nicht auf der NPU geladen werden. "
                "Nutze aktuelle OpenVINO/GenAI-Wheels und den aktuellen Intel-NPU-Treiber "
                f"für Core Ultra. Gerät={npu_device}. Details: {error}"
            ),
            "device": npu_device,
        }

    try:
        image = load_rgb_image(image_path)
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
