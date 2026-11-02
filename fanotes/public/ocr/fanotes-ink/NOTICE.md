# FaNotes ink recognizer notices

`FaNotes_Ink_DE_EN` is a local German/English handwriting line recognizer. The model runs on the
desktop through the native `fanotes-ocr` runtime (ONNX Runtime, MIT); grouping, rendering and
decoding run in the FaNotes `fanotes-recog` WebAssembly module. No handwriting leaves the device.

The model is built by `fanotes/scripts/ink-model` and derives from:

- de-htr-web v2 (ResNet + BiLSTM CTC), Christian N., Apache License 2.0 —
  https://huggingface.co/naeyn/de-htr-web-v2
- IAM Handwriting Database / IAM On-Line Handwriting Database, non-commercial research use; cite
  U. Marti and H. Bunke, "The IAM-database", IJDAR 5 (2002), 39-46.
- ScaDS.AI German Line- and Word-Level Handwriting Dataset v1.0, Burghardt, Alzin et al.,
  CC BY 4.0, DOI 10.5281/zenodo.18301532.
- fhswf/german_handwriting, FH Südwestfalen, AFL-3.0.
- BRUSH online handwriting dataset, Kotani, Tellex, Tompkin (ECCV 2020), non-commercial research.

The character language models (`de.fnlm`, `en.fnlm`) are built from Tatoeba sentences
(CC BY 2.0 FR) and Wikipedia text (CC BY-SA 4.0); the source text is not redistributed.

These model files are separate third-party/derived data components and are not relicensed by
FaNotes' MIT application-code licence.
