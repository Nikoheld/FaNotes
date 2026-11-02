'use strict'

// Desktop host for the FaNotes ink recognizer. The renderer renders each line and decodes the
// output; only the ONNX model runs here, natively, through the same `fanotes-ocr` sidecar as the
// PyLaia path (crates/fanotes-ort). That keeps detection on the desktop app only: the web and
// Android clients have no sidecar.
//
// The base model ships in dist/ocr/fanotes-ink. An optional fine-tuned personal model, produced
// offline by scripts/ink-model/personalize.py and imported by the user, is stored under the
// Electron profile and served from a second sidecar.

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { createNativeOcrHost, nativeOcrExecutable, nativeOcrRuntime } = require('./native-ocr.cjs')

const MODEL_HEIGHT = 64
const INPUT_NAME = 'image'
const OUTPUT_NAME = 'logits'
const MAX_MODEL_BYTES = 64 * 1024 * 1024
const MANIFEST_FORMAT = 'fanotes-ink-recognizer-v1'
const SHA256 = /^[a-f0-9]{64}$/u
const FILE_NAME = /^[a-z0-9][a-z0-9._-]*$/u
const ONNX_PROTOBUF_START = 0x08

function createInkOcr({ appPath, resourcesPath, packaged, userDataPath, threadsFor, keepAliveMs }) {
  const personalDirectory = path.join(userDataPath, 'ink-recognition')
  const personalModelPath = path.join(personalDirectory, 'personal-model.onnx')
  const personalReportPath = path.join(personalDirectory, 'personal-model.json')
  const location = { packaged, resourcesPath, appPath }
  let baseModelPromise = null
  const hosts = new Map()
  const idleTimers = new Map()

  const resolvedModelDirectory = () => {
    const directory = path.join(appPath, packaged ? 'dist' : 'public', 'ocr', 'fanotes-ink')
    const nativeDirectory = packaged
      ? path.join(resourcesPath, 'app.asar.unpacked', 'dist', 'ocr', 'fanotes-ink')
      : directory
    return { directory, nativeDirectory }
  }

  const verifiedBaseModel = () => {
    baseModelPromise ??= (async () => {
      const { directory, nativeDirectory } = resolvedModelDirectory()
      const manifestInfo = await fsp.lstat(path.join(directory, 'manifest.json'))
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size <= 0 || manifestInfo.size > 64 * 1024) {
        throw new Error('Ungültiges Handschriftmodell-Manifest.')
      }
      const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'))
      const descriptor = manifest?.models?.desktop
      if (
        manifest?.format !== MANIFEST_FORMAT
        || typeof manifest.version !== 'string'
        || typeof descriptor?.file !== 'string'
        || !FILE_NAME.test(descriptor.file)
        || !Number.isSafeInteger(descriptor.size)
        || descriptor.size <= 0
        || descriptor.size > MAX_MODEL_BYTES
        || !SHA256.test(descriptor.sha256)
      ) throw new Error('Unbekanntes natives Handschriftmodell.')
      return {
        version: manifest.version,
        model: { path: path.join(nativeDirectory, descriptor.file), size: descriptor.size, sha256: descriptor.sha256 },
      }
    })().catch((error) => {
      baseModelPromise = null
      throw error
    })
    return baseModelPromise
  }

  const readPersonalReport = async () => {
    try {
      const report = JSON.parse(await fsp.readFile(personalReportPath, 'utf8'))
      if (report?.format !== 'fanotes-ink-personal-model-v1' || !SHA256.test(report.sha256 ?? '') || !Number.isSafeInteger(report.size)) {
        return null
      }
      const info = await fsp.lstat(personalModelPath)
      if (!info.isFile() || info.size !== report.size) return null
      return report
    } catch {
      return null
    }
  }

  const hostFor = async (kind) => {
    if (hosts.has(kind)) return hosts.get(kind)
    let model
    if (kind === 'personal') {
      const report = await readPersonalReport()
      if (!report) throw new Error('Es ist kein persönliches Handschriftmodell installiert.')
      model = { path: personalModelPath, size: report.size, sha256: report.sha256 }
    } else {
      model = (await verifiedBaseModel()).model
    }
    const host = createNativeOcrHost({
      executable: nativeOcrExecutable(location),
      runtime: nativeOcrRuntime(location),
      model,
      modelHeight: MODEL_HEIGHT,
      inputName: INPUT_NAME,
      outputName: OUTPUT_NAME,
      minWidth: 16,
    })
    hosts.set(kind, host)
    return host
  }

  const stopHost = (kind) => {
    const timer = idleTimers.get(kind)
    if (timer) clearTimeout(timer)
    idleTimers.delete(kind)
    hosts.get(kind)?.stop()
    hosts.delete(kind)
  }

  const scheduleShutdown = (kind) => {
    const timer = idleTimers.get(kind)
    if (timer) clearTimeout(timer)
    const next = setTimeout(() => {
      idleTimers.delete(kind)
      if (!hosts.get(kind)?.pending) stopHost(kind)
    }, keepAliveMs())
    next.unref?.()
    idleTimers.set(kind, next)
  }

  const recognizeLine = async (request) => {
    if (
      !request
      || typeof request !== 'object'
      || !(request.input instanceof Float32Array)
      || !Number.isSafeInteger(request.width)
      || request.width < 16
      || request.width > 4096
      || request.height !== MODEL_HEIGHT
      || request.input.length !== request.width * request.height
    ) throw new Error('Die native OCR-Eingabe ist ungültig.')
    const kind = request.model === 'personal' ? 'personal' : 'base'
    const host = await hostFor(kind)
    const timer = idleTimers.get(kind)
    if (timer) clearTimeout(timer)
    idleTimers.delete(kind)
    try {
      const result = await host.recognize({
        input: request.input,
        width: request.width,
        height: MODEL_HEIGHT,
        threads: threadsFor(request.threads),
      })
      return { logits: result.probabilities, dims: result.dims, engine: 'fanotes-ink' }
    } finally {
      scheduleShutdown(kind)
    }
  }

  const personalState = async () => {
    const [report, base] = await Promise.all([readPersonalReport(), verifiedBaseModel().catch(() => null)])
    return {
      installed: Boolean(report),
      baseVersion: report?.baseVersion ?? null,
      currentBaseVersion: base?.version ?? null,
      compatible: Boolean(report && base && report.baseVersion === base.version),
      size: report?.size ?? null,
      name: report?.name ?? null,
      importedAt: report?.importedAt ?? null,
      sampleCount: report?.sampleCount ?? null,
      errorBefore: report?.errorBefore ?? null,
      errorAfter: report?.errorAfter ?? null,
    }
  }

  const installPersonalModel = async (request) => {
    const bytes = request?.bytes
    const buffer = bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Buffer.isBuffer(bytes) ? bytes
        : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : null
    if (!buffer || buffer.length < 1_000_000 || buffer.length > MAX_MODEL_BYTES || buffer[0] !== ONNX_PROTOBUF_START) {
      throw new Error('Die Datei ist kein persönliches FaNotes-Handschriftmodell.')
    }
    const base = await verifiedBaseModel()
    const details = request?.report && typeof request.report === 'object' ? request.report : {}
    const number = (key) => (typeof details[key] === 'number' && Number.isFinite(details[key]) ? details[key] : null)
    const report = {
      format: 'fanotes-ink-personal-model-v1',
      name: typeof details.name === 'string' ? details.name.slice(0, 120) : 'personal-model.onnx',
      baseVersion: typeof details.baseVersion === 'string' ? details.baseVersion.slice(0, 40) : base.version,
      size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      importedAt: new Date().toISOString(),
      sampleCount: number('sampleCount'),
      errorBefore: number('errorBefore'),
      errorAfter: number('errorAfter'),
    }
    await fsp.mkdir(personalDirectory, { recursive: true })
    const temporary = `${personalModelPath}.${crypto.randomUUID()}.tmp`
    await fsp.writeFile(temporary, buffer, { mode: 0o600 })
    await fsp.rename(temporary, personalModelPath)
    await fsp.writeFile(personalReportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    stopHost('personal')
    return personalState()
  }

  const removePersonalModel = async () => {
    stopHost('personal')
    await fsp.rm(personalModelPath, { force: true })
    await fsp.rm(personalReportPath, { force: true })
    return personalState()
  }

  const stop = () => {
    for (const kind of [...hosts.keys()]) stopHost(kind)
    baseModelPromise = null
  }

  return { recognizeLine, personalState, installPersonalModel, removePersonalModel, stop }
}

module.exports = { createInkOcr, MODEL_HEIGHT: MODEL_HEIGHT }
