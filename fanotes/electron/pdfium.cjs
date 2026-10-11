'use strict'

// Host side of PDFium page rasters (crates/fanotes-pdf). The `fanotes-pdfium` sidecar starts on the
// first paint. Frames: u32 LE header length, JSON header, u32 LE payload length, payload.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const MAX_HEADER_BYTES = 8192
const MAX_PAYLOAD_BYTES = 96 * 1024 * 1024
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 120_000
const STOP_GRACE_MS = 2_000

function encodeFrame(header, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  if (json.length > MAX_HEADER_BYTES || payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error('Der PDF-Rasterauftrag ist zu groß.')
  }
  const frame = Buffer.allocUnsafe(8 + json.length + payload.length)
  frame.writeUInt32LE(json.length, 0)
  json.copy(frame, 4)
  frame.writeUInt32LE(payload.length, 4 + json.length)
  if (payload.length) payload.copy(frame, 8 + json.length)
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
        onError(new Error('Die PDFium-Antwort ist ungültig.'))
        return
      }
      if (buffered.length < 8 + headerLength) return
      const payloadLength = buffered.readUInt32LE(4 + headerLength)
      if (payloadLength > MAX_PAYLOAD_BYTES) {
        failed = true
        onError(new Error('Die PDFium-Antwort ist ungültig.'))
        return
      }
      const end = 8 + headerLength + payloadLength
      if (buffered.length < end) return
      let header = null
      try {
        header = JSON.parse(buffered.toString('utf8', 4, 4 + headerLength))
      } catch {
        failed = true
        onError(new Error('Die PDFium-Antwort ist ungültig.'))
        return
      }
      const payload = buffered.subarray(8 + headerLength, end)
      buffered = buffered.subarray(end)
      onFrame(header, payload)
    }
  }
}

function isRunnable(executable) {
  let info = null
  try {
    info = fs.lstatSync(executable)
  } catch {
    return false
  }
  return Boolean(
    info
    && info.isFile()
    && !info.isSymbolicLink()
    && info.size > 0
    && info.size <= MAX_EXECUTABLE_BYTES
    && (process.platform === 'win32' || (info.mode & 0o111) !== 0),
  )
}

function findExecutable() {
  const name = process.platform === 'win32' ? 'fanotes-pdfium.exe' : 'fanotes-pdfium'
  const candidates = []
  if (process.env.FANOTES_PDFIUM_BIN) candidates.push(process.env.FANOTES_PDFIUM_BIN)
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'pdfium', name))
  const repo = path.resolve(__dirname, '..', '..')
  candidates.push(path.join(repo, 'target', 'release', name))
  candidates.push(path.join(repo, 'target', 'debug', name))
  return candidates.find((candidate) => isRunnable(candidate)) ?? null
}

function createPdfiumHost(spawnImpl = spawn) {
  const executable = findExecutable()
  if (!executable) return null
  let child = null
  let nextId = 1
  let stderrTail = ''
  const pending = new Map()
  const opened = new Set()
  let chain = Promise.resolve()
  let failures = 0

  const rejectAll = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
  }

  const stop = (reason) => {
    const previous = child
    child = null
    opened.clear()
    if (previous) {
      previous.stdout.removeAllListeners('data')
      previous.stdin.end()
      const killer = setTimeout(() => previous.kill(), STOP_GRACE_MS)
      killer.unref?.()
      previous.once('exit', () => clearTimeout(killer))
    }
    if (pending.size) rejectAll(reason ?? new Error('PDFium wurde beendet.'))
  }

  const settle = (header, payload) => {
    const request = pending.get(header?.id)
    if (!request) return
    pending.delete(header.id)
    clearTimeout(request.timeout)
    if (header.ok === false) request.reject(new Error(String(header.error || 'PDFium konnte die Seite nicht rasterisieren.').slice(0, 500)))
    else request.resolve({ header, payload: Buffer.from(payload) })
  }

  const start = () => {
    const spawned = spawnImpl(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    stderrTail = ''
    spawned.stdout.on('data', createFrameReader(settle, (error) => {
      if (child === spawned) stop(error)
    }))
    spawned.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000)
    })
    spawned.stdin.on('error', () => {})
    spawned.once('error', (error) => {
      if (child === spawned) stop(error)
    })
    spawned.once('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      opened.clear()
      if (pending.size) {
        const detail = stderrTail.trim()
        rejectAll(new Error(detail || `PDFium wurde mit Status ${code ?? signal} beendet.`))
      }
    })
    child = spawned
  }

  const send = (header, payload) => new Promise((resolve, reject) => {
    if (!child) start()
    if (!child?.stdin?.writable) {
      reject(new Error('PDFium ist nicht verfügbar.'))
      return
    }
    const id = nextId
    nextId += 1
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('PDFium hat die Seite nicht rechtzeitig gerastert.'))
    }, REQUEST_TIMEOUT_MS)
    timeout.unref?.()
    pending.set(id, { resolve, reject, timeout })
    try {
      child.stdin.write(encodeFrame({ ...header, id }, payload))
    } catch (error) {
      pending.delete(id)
      clearTimeout(timeout)
      reject(error)
    }
  })

  const renderPdfPage = (request) => {
    const run = chain.then(async () => {
      if (failures >= 2) return { unavailable: true }
      const geometry = ['pageIndex', 'pixelWidth', 'pixelHeight', 'pagePixelWidth', 'pagePixelHeight', 'originX', 'originY', 'rotation']
      if (!request || typeof request.key !== 'string' || request.key.length === 0 || request.key.length > 4096) {
        throw new Error('Die PDF-Rasteranfrage ist unvollständig.')
      }
      for (const name of geometry) {
        if (!Number.isSafeInteger(request[name])) throw new Error('Die PDF-Rasteranfrage ist unvollständig.')
      }
      const password = typeof request.password === 'string' ? request.password.slice(0, 1024) : ''
      if (!opened.has(request.key)) {
        const bytes = await request.readBytes()
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Die PDF-Datei ist leer oder zu groß.')
        await send({ op: 'open', key: request.key }, bytes)
        opened.add(request.key)
      }
      const rendered = await send({
        op: 'render',
        key: request.key,
        pageIndex: request.pageIndex,
        pixelWidth: request.pixelWidth,
        pixelHeight: request.pixelHeight,
        pagePixelWidth: request.pagePixelWidth,
        pagePixelHeight: request.pagePixelHeight,
        originX: request.originX,
        originY: request.originY,
        rotation: request.rotation,
        password,
      }, Buffer.alloc(0))
      const width = rendered.header.width
      const height = rendered.header.height
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw new Error('PDFium lieferte keine Bitmap.')
      }
      if (rendered.payload.length !== width * height * 4) throw new Error('PDFium lieferte keine Bitmap.')
      failures = 0
      return { width, height, rgba: rendered.payload }
    })
    chain = run.then(() => undefined, () => undefined)
    return run.catch((error) => {
      failures += 1
      if (failures >= 2) return { unavailable: true }
      throw error
    })
  }

  return { renderPdfPage }
}

let host = null
let hostMissing = false

function renderPdfPage(request) {
  if (hostMissing) return Promise.resolve({ unavailable: true })
  if (!host) {
    host = createPdfiumHost()
    if (!host) {
      hostMissing = true
      return Promise.resolve({ unavailable: true })
    }
  }
  return host.renderPdfPage(request)
}

module.exports = { createPdfiumHost, findExecutable, renderPdfPage }
