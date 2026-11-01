'use strict'

// Host side of the native line OCR (crates/fanotes-ort). The `fanotes-ocr` sidecar is started on the
// first conversion; it checks the model against the manifest digest and builds the ONNX session only
// when that first line arrives. Frames: u32 LE header length, JSON header, u32 LE payload length,
// payload (crates/fanotes-ort/src/protocol.rs).

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ENGINE = 'fanotes-ort-cpu'
const MODEL_HEIGHT = 128
const MAX_HEADER_BYTES = 4096
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
const MAX_PENDING = 4
const REQUEST_TIMEOUT_MS = 120_000
const STOP_GRACE_MS = 2_000
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024

if (os.endianness() !== 'LE') throw new Error('Die native OCR-Laufzeit erwartet ein Little-Endian-System.')

function encodeFrame(header, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  if (json.length > MAX_HEADER_BYTES || payload.length > MAX_PAYLOAD_BYTES) throw new Error('Der native OCR-Auftrag ist zu groß.')
  const frame = Buffer.allocUnsafe(8 + json.length + payload.length)
  frame.writeUInt32LE(json.length, 0)
  json.copy(frame, 4)
  frame.writeUInt32LE(payload.length, 4 + json.length)
  payload.copy(frame, 8 + json.length)
  return frame
}

function createFrameReader(onFrame, onError) {
  let buffered = Buffer.alloc(0)
  let failed = false
  return (chunk) => {
    if (failed) return
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
    while (buffered.length >= 4) {
      const headerLength = buffered.readUInt32LE(0)
      if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
        failed = true
        onError(new Error('Die native OCR-Antwort ist ungültig.'))
        return
      }
      if (buffered.length < 8 + headerLength) return
      const payloadLength = buffered.readUInt32LE(4 + headerLength)
      if (payloadLength > MAX_PAYLOAD_BYTES) {
        failed = true
        onError(new Error('Die native OCR-Antwort ist ungültig.'))
        return
      }
      const end = 8 + headerLength + payloadLength
      if (buffered.length < end) return
      let header = null
      try {
        header = JSON.parse(buffered.toString('utf8', 4, 4 + headerLength))
      } catch {
        failed = true
        onError(new Error('Die native OCR-Antwort ist ungültig.'))
        return
      }
      const payload = buffered.subarray(8 + headerLength, end)
      buffered = buffered.subarray(end)
      onFrame(header, payload)
    }
  }
}

function validDims(dims, payloadLength) {
  if (!Array.isArray(dims) || dims.length !== 3 || !dims.every((dim) => Number.isSafeInteger(dim) && dim > 0)) return false
  return dims.reduce((total, dim) => total * dim, 1) * Float32Array.BYTES_PER_ELEMENT === payloadLength
}

function checkedExecutable(executable) {
  let info = null
  try {
    info = fs.lstatSync(executable)
  } catch {
    info = null
  }
  if (
    !info
    || !info.isFile()
    || info.isSymbolicLink()
    || info.size <= 0
    || info.size > MAX_EXECUTABLE_BYTES
    || (process.platform !== 'win32' && (info.mode & 0o111) === 0)
  ) throw new Error('Die native OCR-Laufzeit ist nicht verfügbar.')
  return executable
}

/**
 * @param {{ executable: string, model: { path: string, size: number, sha256: string }, runtime?: string | null,
 *   spawnImpl?: typeof spawn }} options
 */
function createNativeOcrHost({
  executable,
  model,
  runtime = null,
  spawnImpl = spawn,
  modelHeight = MODEL_HEIGHT,
  inputName = 'x',
  outputName = 'probabilities',
  minWidth = 32,
}) {
  if (
    !path.isAbsolute(executable)
    || !path.isAbsolute(model?.path ?? '')
    || !Number.isSafeInteger(model.size)
    || model.size <= 0
    || !/^[a-f0-9]{64}$/u.test(model.sha256)
    || (runtime !== null && !path.isAbsolute(runtime))
    || !Number.isSafeInteger(modelHeight)
    || modelHeight < 16
    || modelHeight > 256
    || !/^[\w.\-/]{1,64}$/u.test(inputName)
    || !/^[\w.\-/]{1,64}$/u.test(outputName)
  ) throw new Error('Ungültige native OCR-Konfiguration.')
  let child = null
  let stderrTail = ''
  const pending = new Map()

  const rejectAll = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
  }

  const settle = (header, payload) => {
    const request = pending.get(header?.id)
    if (!request) return
    pending.delete(header.id)
    clearTimeout(request.timeout)
    if (typeof header.error === 'string') {
      request.reject(new Error(header.error.slice(0, 500)))
    } else if (header.engine !== ENGINE || !validDims(header.dims, payload.length) || payload.length === 0) {
      request.reject(new Error('Die native OCR-Antwort ist ungültig.'))
    } else {
      const probabilities = new Float32Array(payload.length / Float32Array.BYTES_PER_ELEMENT)
      new Uint8Array(probabilities.buffer).set(payload)
      request.resolve({ probabilities, dims: header.dims.slice(), engine: ENGINE })
    }
  }

  const stop = (reason) => {
    const previous = child
    child = null
    if (previous) {
      previous.stdout.removeAllListeners('data')
      previous.stdin.end()
      const killer = setTimeout(() => previous.kill(), STOP_GRACE_MS)
      killer.unref?.()
      previous.once('exit', () => clearTimeout(killer))
    }
    if (pending.size) rejectAll(reason ?? new Error('Die native OCR-Laufzeit wurde beendet.'))
  }

  const start = () => {
    const args = ['--model', model.path, '--size', String(model.size), '--sha256', model.sha256]
    if (runtime) args.push('--runtime', runtime)
    const spawned = spawnImpl(checkedExecutable(executable), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    stderrTail = ''
    spawned.stdout.on('data', createFrameReader(settle, (error) => {
      if (child === spawned) stop(error)
    }))
    spawned.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000)
    })
    spawned.stdin.on('error', () => {
      // A sidecar that died closes the pipe; its exit handler reports the failure.
    })
    spawned.once('error', (error) => {
      if (child === spawned) stop(error)
    })
    spawned.once('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      if (pending.size) rejectAll(new Error(`Die native OCR-Laufzeit wurde mit Status ${code ?? signal} beendet.`))
    })
    child = spawned
  }

  const recognize = ({ input, width, height, threads }) => {
    if (
      !(input instanceof Float32Array)
      || !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width < minWidth
      || width > 4096
      || height !== modelHeight
      || input.length !== width * height
      || !Number.isSafeInteger(threads)
      || threads < 1
      || threads > 4
    ) return Promise.reject(new Error('Die native OCR-Eingabe ist ungültig.'))
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Zu viele native OCR-Aufträge sind gleichzeitig aktiv.'))
    try {
      if (!child) start()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = crypto.randomUUID()
    const header = { id, width, height, threads }
    if (inputName !== 'x') header.input_name = inputName
    if (outputName !== 'probabilities') header.output_name = outputName
    const frame = encodeFrame(header, Buffer.from(input.buffer, input.byteOffset, input.byteLength))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        const error = new Error('Die native OCR-Erkennung hat das Zeitlimit überschritten.')
        stop(error)
        reject(error)
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timeout })
      child.stdin.write(frame)
    })
  }

  return {
    recognize,
    stop,
    get pid() {
      return child?.pid ?? null
    },
    get pending() {
      return pending.size
    },
    get stderr() {
      return stderrTail
    },
  }
}

/** `fanotes-ocr` next to ONNX Runtime: `resources/native-ocr` when packaged, `native-ocr/<platform>-<arch>` in a checkout. */
function nativeOcrExecutable({ packaged, resourcesPath, appPath, platform = process.platform, arch = process.arch }) {
  const file = platform === 'win32' ? 'fanotes-ocr.exe' : 'fanotes-ocr'
  return packaged
    ? path.join(resourcesPath, 'native-ocr', file)
    : path.join(appPath, 'native-ocr', `${platform}-${arch}`, file)
}

/** Packaged builds ship ONNX Runtime beside the sidecar; a checkout uses the pinned onnxruntime-node@1.21.0 copy. */
function nativeOcrRuntime({ packaged, appPath, platform = process.platform, arch = process.arch }) {
  if (packaged) return null
  const file = platform === 'win32'
    ? 'onnxruntime.dll'
    : platform === 'darwin' ? 'libonnxruntime.1.21.0.dylib' : 'libonnxruntime.so.1'
  return path.join(appPath, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', platform, arch, file)
}

module.exports = {
  ENGINE,
  createNativeOcrHost,
  encodeFrame,
  createFrameReader,
  nativeOcrExecutable,
  nativeOcrRuntime,
}
