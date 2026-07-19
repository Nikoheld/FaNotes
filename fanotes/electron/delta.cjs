'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { pipeline } = require('node:stream/promises')

const DELTA_FORMAT = 'fanotes-delta-v1'
const DELTA_MAGIC = Buffer.from('FANOTESDELTA1\0\0\0', 'ascii')
const DELTA_PREFIX_BYTES = DELTA_MAGIC.length + 4
const MAX_DELTA_HEADER_BYTES = 8 * 1024 * 1024
const MAX_DELTA_OPERATIONS = 100_000
const MAX_TARGET_BYTES = 1024 * 1024 * 1024
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSafeOffset = (value) => Number.isSafeInteger(value) && value >= 0
const isSafeSize = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_TARGET_BYTES

const sha256File = async (filePath) => {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

const validateFileDescriptor = (candidate, label) => {
  if (!isPlainObject(candidate)) throw new Error(`Die ${label}-Beschreibung des Delta-Updates fehlt.`)
  if (!['appimage', 'app-asar'].includes(candidate.kind)) throw new Error(`Der ${label}-Typ des Delta-Updates ist ungültig.`)
  if (!isSafeSize(candidate.sizeBytes)) throw new Error(`Die ${label}-Größe des Delta-Updates ist ungültig.`)
  if (typeof candidate.sha256 !== 'string' || !HASH_PATTERN.test(candidate.sha256)) throw new Error(`Die ${label}-Prüfsumme des Delta-Updates ist ungültig.`)
  if (label === 'Zieldatei' && (typeof candidate.fileName !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(candidate.fileName))) {
    throw new Error('Der Zieldateiname des Delta-Updates ist ungültig.')
  }
  return {
    kind: candidate.kind,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    ...(label === 'Zieldatei' ? { fileName: candidate.fileName } : {}),
  }
}

const validateDeltaHeader = (candidate, patchSize, dataStart) => {
  if (!isPlainObject(candidate) || candidate.format !== DELTA_FORMAT) throw new Error('Das Delta-Paket besitzt ein unbekanntes Format.')
  if (!['linux', 'windows'].includes(candidate.platform)) throw new Error('Das Delta-Paket gehört zu einer unbekannten Plattform.')
  if (!VERSION_PATTERN.test(candidate.baseVersion) || !VERSION_PATTERN.test(candidate.targetVersion)) throw new Error('Das Delta-Paket besitzt ungültige Versionsangaben.')
  const source = validateFileDescriptor(candidate.source, 'Quelldatei')
  const target = validateFileDescriptor(candidate.target, 'Zieldatei')
  if ((candidate.platform === 'linux' && (source.kind !== 'appimage' || target.kind !== 'appimage')) ||
      (candidate.platform === 'windows' && (source.kind !== 'app-asar' || target.kind !== 'app-asar'))) {
    throw new Error('Die Dateitypen des Delta-Pakets passen nicht zur Plattform.')
  }
  if (!Array.isArray(candidate.operations) || candidate.operations.length === 0 || candidate.operations.length > MAX_DELTA_OPERATIONS) {
    throw new Error('Der Delta-Operationsplan ist ungültig.')
  }

  let targetBytes = 0
  let payloadBytes = 0
  const operations = candidate.operations.map((operation) => {
    if (!isPlainObject(operation) || !isSafeSize(operation.sizeBytes)) throw new Error('Das Delta-Paket enthält eine ungültige Operation.')
    targetBytes += operation.sizeBytes
    if (!Number.isSafeInteger(targetBytes) || targetBytes > target.sizeBytes) throw new Error('Der Delta-Operationsplan überschreitet die Zieldatei.')
    if (operation.kind === 'copy') {
      if (!isSafeOffset(operation.sourceOffset) || operation.sourceOffset + operation.sizeBytes > source.sizeBytes) {
        throw new Error('Eine lokale Kopieroperation des Delta-Pakets liegt außerhalb der Quelldatei.')
      }
      return { kind: 'copy', sourceOffset: operation.sourceOffset, sizeBytes: operation.sizeBytes }
    }
    if (operation.kind === 'data') {
      if (!isSafeOffset(operation.dataOffset) || operation.dataOffset !== payloadBytes) throw new Error('Die Nutzdaten des Delta-Pakets sind nicht lückenlos angeordnet.')
      payloadBytes += operation.sizeBytes
      return { kind: 'data', dataOffset: operation.dataOffset, sizeBytes: operation.sizeBytes }
    }
    throw new Error('Das Delta-Paket enthält einen unbekannten Operationstyp.')
  })
  if (targetBytes !== target.sizeBytes) throw new Error('Der Delta-Operationsplan rekonstruiert nicht die vollständige Zieldatei.')
  if (dataStart + payloadBytes !== patchSize) throw new Error('Die Größe der Delta-Nutzdaten stimmt nicht mit dem Operationsplan überein.')

  return {
    format: DELTA_FORMAT,
    platform: candidate.platform,
    baseVersion: candidate.baseVersion,
    targetVersion: candidate.targetVersion,
    source,
    target,
    operations,
    payloadBytes,
  }
}

const readExactly = async (handle, buffer, position) => {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesRead) throw new Error('Das Delta-Paket oder seine Quelldatei endet unerwartet.')
    offset += bytesRead
  }
}

const writeExactly = async (handle, buffer, position) => {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesWritten) throw new Error('Die rekonstruierte Update-Datei konnte nicht vollständig geschrieben werden.')
    offset += bytesWritten
  }
}

const inspectDeltaPatch = async (patchPath) => {
  const stats = await fsp.lstat(patchPath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < DELTA_PREFIX_BYTES + 2) throw new Error('Das Delta-Paket ist keine sichere reguläre Datei.')
  const handle = await fsp.open(patchPath, 'r')
  try {
    const prefix = Buffer.alloc(DELTA_PREFIX_BYTES)
    await readExactly(handle, prefix, 0)
    if (!prefix.subarray(0, DELTA_MAGIC.length).equals(DELTA_MAGIC)) throw new Error('Das Delta-Paket besitzt keine gültige FaNotes-Kennung.')
    const headerBytes = prefix.readUInt32BE(DELTA_MAGIC.length)
    if (!headerBytes || headerBytes > MAX_DELTA_HEADER_BYTES || DELTA_PREFIX_BYTES + headerBytes >= stats.size) throw new Error('Der Kopf des Delta-Pakets ist ungültig groß.')
    const encodedHeader = Buffer.alloc(headerBytes)
    await readExactly(handle, encodedHeader, DELTA_PREFIX_BYTES)
    let candidate
    try {
      candidate = JSON.parse(encodedHeader.toString('utf8'))
    } catch {
      throw new Error('Der Kopf des Delta-Pakets enthält kein gültiges JSON.')
    }
    const dataStart = DELTA_PREFIX_BYTES + headerBytes
    return { header: validateDeltaHeader(candidate, stats.size, dataStart), dataStart, patchSize: stats.size }
  } finally {
    await handle.close()
  }
}

const assertExpectedHeader = (header, expected) => {
  if (!expected) return
  for (const key of ['platform', 'baseVersion', 'targetVersion']) {
    if (expected[key] != null && header[key] !== expected[key]) throw new Error(`Das Delta-Paket besitzt eine unerwartete ${key}-Bindung.`)
  }
  for (const side of ['source', 'target']) {
    if (!expected[side]) continue
    for (const key of ['kind', 'fileName', 'sizeBytes', 'sha256']) {
      if (expected[side][key] != null && header[side][key] !== expected[side][key]) throw new Error(`Die ${side}-Bindung des Delta-Pakets stimmt nicht mit dem signierten Manifest überein.`)
    }
  }
}

const applyDeltaPatch = async ({ patchPath, sourcePath, outputPath, expected, signal, onProgress }) => {
  const { header, dataStart } = await inspectDeltaPatch(patchPath)
  assertExpectedHeader(header, expected)
  const sourceStats = await fsp.lstat(sourcePath)
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.size !== header.source.sizeBytes) throw new Error('Die installierte Quelldatei passt nicht zum Delta-Update.')
  if (await sha256File(sourcePath) !== header.source.sha256) throw new Error('Die installierte Version wurde verändert und kann nicht als Delta-Basis verwendet werden.')
  const existingOutput = await fsp.lstat(outputPath).catch(() => null)
  if (existingOutput?.isSymbolicLink()) throw new Error('Das Delta-Ziel darf kein symbolischer Link sein.')

  const sourceHandle = await fsp.open(sourcePath, 'r')
  const patchHandle = await fsp.open(patchPath, 'r')
  const outputHandle = await fsp.open(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let outputOffset = 0
  let lastProgressAt = 0
  try {
    for (const operation of header.operations) {
      let remaining = operation.sizeBytes
      let inputOffset = operation.kind === 'copy' ? operation.sourceOffset : dataStart + operation.dataOffset
      const inputHandle = operation.kind === 'copy' ? sourceHandle : patchHandle
      while (remaining > 0) {
        if (signal?.aborted) throw Object.assign(new Error('Die Delta-Rekonstruktion wurde abgebrochen.'), { name: 'AbortError' })
        const length = Math.min(buffer.length, remaining)
        const chunk = buffer.subarray(0, length)
        await readExactly(inputHandle, chunk, inputOffset)
        await writeExactly(outputHandle, chunk, outputOffset)
        inputOffset += length
        outputOffset += length
        remaining -= length
        const now = Date.now()
        if (onProgress && (now - lastProgressAt > 180 || outputOffset === header.target.sizeBytes)) {
          lastProgressAt = now
          onProgress(outputOffset, header.target.sizeBytes)
        }
      }
    }
    await outputHandle.sync()
  } catch (error) {
    await outputHandle.close().catch(() => {})
    await fsp.rm(outputPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await Promise.allSettled([sourceHandle.close(), patchHandle.close(), outputHandle.close()])
  }
  const outputStats = await fsp.lstat(outputPath)
  if (!outputStats.isFile() || outputStats.isSymbolicLink() || outputStats.size !== header.target.sizeBytes || await sha256File(outputPath) !== header.target.sha256) {
    await fsp.rm(outputPath, { force: true }).catch(() => {})
    throw new Error('Die rekonstruierte Update-Datei hat die abschließende SHA-256-Prüfung nicht bestanden.')
  }
  return header
}

module.exports = {
  DELTA_FORMAT,
  DELTA_MAGIC,
  DELTA_PREFIX_BYTES,
  applyDeltaPatch,
  inspectDeltaPatch,
  sha256File,
  validateDeltaHeader,
}
