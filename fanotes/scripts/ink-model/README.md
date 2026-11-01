# FaNotes ink recognizer

The FaNotes handwriting-to-text engine. Pen strokes are grouped into lines and rendered into one
fixed-height model image, a CTC line model reads the image, and a prefix-beam search guided by a
character language model and the spelling dictionary decodes it. Recognition runs **only in the
desktop app**: the renderer groups, renders and decodes in `crates/fanotes-recog` (WebAssembly),
and the ONNX model runs natively in the `fanotes-ocr` sidecar (`crates/fanotes-ort`). The web and
Android clients have no sidecar and do not do this detection.

These scripts reproduce the shipped model and build a personal model. They are not run by the app
or by CI; the app ships the built artifacts under `fanotes/public/ocr/fanotes-ink/`.

## Layout

| File | Role |
| --- | --- |
| `inkline.py` | Reference renderer for `fanotes-ink-line-v1`. The Rust port in `crates/fanotes-recog/src/ink.rs` is checked against it by `crates/fanotes-recog/tests/ink.rs`. |
| `inknet.py` | The recognizer: an ImageNet ResNet stem + 3× BiLSTM + CTC head, rebuilt from the Apache-2.0 `naeyn/de-htr-web-v2` weights as the starting point. |
| `build_charlm.py` | Builds the character n-gram language model (`fanotes-charlm-v1`); `crates/fanotes-recog/src/charlm.rs` reads the format. |
| `compose.py`, `scans.py`, `prepare_scans.py`, `brushdata.py`, `common.py` | Training data: online pen strokes (BRUSH), offline lines traced into pen strokes (IAM, ScaDS.AI German, fhswf), and writer-composed synthetic lines. |
| `train.py` | Fine-tunes the recognizer on the mixed corpus. |
| `export.py` | Exports a checkpoint to ONNX (fp32 for the desktop sidecar). |
| `stage.py` | Stages the ONNX model, the two language models and the manifest into `fanotes/public/ocr/fanotes-ink/`. |
| `evalink.py`, `make_cases.py` | Writer-disjoint evaluation and the check fixtures. |
| `personalize.py` | Fine-tunes a personal model from a writer's exported lines. |

Set `FANOTES_INK_HOME` (default `~/.cache/fanotes-ink`) to choose where datasets and checkpoints
live. Install the Python dependencies with `pip install torch torchvision onnx onnxruntime pillow
numpy numba scikit-image pyarrow huggingface_hub`.

## Rebuild the shipped model

```bash
# 1. Datasets into $FANOTES_INK_HOME/data (BRUSH, IAM-line, fhswf, ScaDS.AI, Tatoeba + Wikipedia
#    text for the language models). See the dataset licences below.
python prepare_scans.py            # trace offline line images into pen strokes
python build_charlm.py --language de --order 6
python build_charlm.py --language en --order 6

# 2. Train, export, stage.
python train.py --steps 7000 --validate-scans \
  --sources brush:0.36,iam:0.2,fhswf:0.14,scads:0.14,composed:0.16 --out $FANOTES_INK_HOME/runs/full
# A shorter pass from a known-good checkpoint. `--product-eval` keeps the weights only when
# the desktop beam decoder still reads the golden lines and the real-pen error is lower.
# `--mild-augment` stays close to the pen width and slant the app uses at inference.
python train.py --init /path/to/a-checkpoint-that-passes-the-golden-check.pt --steps 600 --lr 4e-5 --warmup 40 \
  --mild-augment --distill-weight 8 --product-eval --product-brush /path/pen-cases.json \
  --validate-scans --sources brush:0.62,composed:0.38 --out $FANOTES_INK_HOME/runs/pen
# `--distill-weight` keeps unaugmented German and IAM scan logits near the init checkpoint,
# so a pen update is discarded when it moves the golden lines.
python export.py $FANOTES_INK_HOME/runs/full/best.pt --version 2026.11.1 --emit-checkpoint
python stage.py --model $FANOTES_INK_HOME/export/ink-fp32.onnx \
  --lm-de $FANOTES_INK_HOME/lm/de-6.fnlm --lm-en $FANOTES_INK_HOME/lm/en-6.fnlm --version 2026.11.1
```

Then rebuild the WebAssembly decoder if `crates/fanotes-recog` changed
(`cd fanotes && node scripts/build-rust-wasm.mjs`) and run `node scripts/check-ink-recognition.mjs`.

## Personalize on your own handwriting

In the app, handwriting you convert and confirm is already learned: the writer style and your
vocabulary adapt automatically (Einstellungen → Handschrift). For a deeper, fully local
fine-tune, export your training lines from that screen and run:

```bash
python personalize.py --base <ink-base.pt> --bundle writer-training.json --out ./personal
```

Import the resulting `personal-model.onnx` and `personal-model.json` under Einstellungen →
Handschrift → Persönliches Modell. The base checkpoint is the `ink-base.pt` written by
`export.py --emit-checkpoint` for the model version you run.

## Dataset and model licences

The shipped model derives from `naeyn/de-htr-web-v2` (Apache-2.0) and is fine-tuned on the IAM
Handwriting/On-Line databases (research use, cite Marti & Bunke 2002), the ScaDS.AI German
Line/Word dataset (CC BY 4.0, DOI 10.5281/zenodo.18301532), `fhswf/german_handwriting` (AFL-3.0)
and the BRUSH online handwriting dataset (non-commercial research). The character language models
are built from Tatoeba (CC BY 2.0 FR) and Wikipedia (CC BY-SA 4.0) text. See
`fanotes/public/ocr/fanotes-ink/NOTICE.md` for the shipped-artifact attribution.
