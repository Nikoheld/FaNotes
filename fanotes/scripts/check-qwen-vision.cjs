'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const service = fs.readFileSync(path.join(root, 'electron', 'qwen-vision.cjs'), 'utf8')
const worker = fs.readFileSync(path.join(root, 'electron', 'qwen-vision-worker.py'), 'utf8')
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
const settings = fs.readFileSync(path.join(root, 'src', 'components', 'SettingsModal.tsx'), 'utf8')
const board = fs.readFileSync(path.join(root, 'src', 'components', 'DrawingBoard.tsx'), 'utf8')
const defaults = fs.readFileSync(path.join(root, 'src', 'defaults.ts'), 'utf8')
const types = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8')
const render = fs.readFileSync(path.join(root, 'src', 'lib', 'qwenVisionRecognition.ts'), 'utf8')

const checks = [
  [service, "id: 'qwen3-vl-2b-int4-npu'", 'Modell-ID INT4 NPU'],
  [service, "device: 'NPU'", 'NPU-only Policy'],
  [service, "precision: 'int4'", 'INT4-Präzision'],
  [service, 'createQwenVisionService', 'Service-Export'],
  [service, 'OPENVINO_DEVICE', 'OpenVINO Device-Hint'],
  [service, 'ensureMaterializedWorker', 'Worker-Materialisierung aus app.asar'],
  [service, 'resolvePythonExecutable', 'Python-Pfadauflösung'],
  [service, 'isAsarPath', 'Asar-Pfad-Erkennung gegen ENOTDIR'],
  [worker, 'VLMPipeline', 'OpenVINO GenAI VLMPipeline'],
  [worker, '"NPU"', 'Worker erzwingt NPU'],
  [worker, 'NPU-only', 'Worker-Dokumentation NPU-only'],
  [main, 'createQwenVisionService', 'Main bindet Service'],
  [main, 'qwenVisionGetState', 'IPC get state'],
  [main, 'qwenVisionInstall', 'IPC install'],
  [main, 'qwenVisionRecognize', 'IPC recognize'],
  [preload, 'getQwenVisionState', 'Preload get state'],
  [preload, 'installQwenVisionModel', 'Preload install'],
  [preload, 'recognizeQwenVision', 'Preload recognize'],
  [settings, 'Qwen3-VL Vision (Intel NPU)', 'Einstellungszeile'],
  [settings, 'qwenVisionRecognition', 'Toggle-Setting'],
  [settings, 'Lizenz akzeptieren & NPU-Modell laden', 'Install-Button'],
  [board, 'recognizeQwenVision', 'DrawingBoard nutzt Vision'],
  [board, 'renderQwenVisionImage', 'Vision-Renderpfad'],
  [defaults, 'qwenVisionRecognition: false', 'Default deaktiviert'],
  [defaults, 'qwenVisionLicenseAccepted: false', 'Default ohne Lizenz'],
  [types, 'qwenVisionRecognition: boolean', 'Typen Setting'],
  [types, "device: 'NPU'", 'Typen NPU'],
  [render, 'renderQwenVisionImage', 'Renderer-Export'],
  [render, 'shouldPreferQwenVisionText', 'Konservative Übernahme'],
]

for (const [source, needle, label] of checks) {
  if (!source.includes(needle)) throw new Error(`Qwen-Vision-Prüfung fehlgeschlagen: ${label}`)
}

console.log('Qwen-Vision-Prüfung erfolgreich: optionales Qwen3-VL INT4 NPU-only, Settings, IPC und DrawingBoard-Pfad sind verdrahtet.')
