'use strict'

// Minimal, defensive ZIP reader for untrusted Office files (docx/pptx). Only
// what the converter needs: stored/deflated entries, no encryption, no zip64.
// Every size is checked against caps before anything is inflated, so a zip bomb
// is rejected from its central directory (declared sizes) and again while
// inflating (the inflater is capped at the declared size).
const zlib = require('node:zlib')

const LIMITS = Object.freeze({
  maxEntries: 4000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  // Compression ratio above which a single entry is treated as a bomb (XML compresses well; 200x is generous).
  maxRatio: 200,
  minRatioCheckBytes: 1024 * 1024,
})

class OfficeZipError extends Error {}

function readZip(buffer, overrides = {}) {
  const limits = { ...LIMITS, ...overrides }
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new OfficeZipError('Die Datei ist kein gültiges Office-Dokument.')
  // End of central directory record: last 22 + comment bytes.
  let eocd = -1
  const stop = Math.max(0, buffer.length - 22 - 65535)
  for (let index = buffer.length - 22; index >= stop; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break }
  }
  if (eocd < 0) throw new OfficeZipError('Die Datei ist kein gültiges Office-Dokument.')
  const count = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new OfficeZipError('ZIP64-Dokumente werden nicht unterstützt.')
  if (count > limits.maxEntries) throw new OfficeZipError('Das Dokument enthält zu viele Dateien.')
  if (directoryOffset + directorySize > buffer.length) throw new OfficeZipError('Die Datei ist beschädigt.')

  const entries = new Map()
  let cursor = directoryOffset
  let total = 0
  for (let number = 0; number < count; number += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new OfficeZipError('Die Datei ist beschädigt.')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength).replace(/\\/gu, '/')
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (flags & 1) throw new OfficeZipError('Verschlüsselte Dokumente werden nicht unterstützt.')
    if (size > limits.maxEntryBytes) throw new OfficeZipError('Das Dokument enthält eine zu große Datei.')
    if (size > limits.minRatioCheckBytes && size / Math.max(1, compressed) > limits.maxRatio) throw new OfficeZipError('Das Dokument sieht wie eine Zip-Bombe aus.')
    total += size
    if (total > limits.maxTotalBytes) throw new OfficeZipError('Das Dokument ist entpackt zu groß.')
    if (name.split('/').includes('..')) continue
    entries.set(name, { name, method, compressed, size, offset })
  }

  function read(name) {
    const entry = entries.get(name)
    if (!entry) return null
    if (entry.offset + 30 > buffer.length || buffer.readUInt32LE(entry.offset) !== 0x04034b50) throw new OfficeZipError('Die Datei ist beschädigt.')
    const start = entry.offset + 30 + buffer.readUInt16LE(entry.offset + 26) + buffer.readUInt16LE(entry.offset + 28)
    if (start + entry.compressed > buffer.length) throw new OfficeZipError('Die Datei ist beschädigt.')
    const raw = buffer.subarray(start, start + entry.compressed)
    if (entry.method === 0) return Buffer.from(raw)
    if (entry.method !== 8) throw new OfficeZipError('Unbekanntes Kompressionsverfahren im Dokument.')
    let out
    try {
      out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) })
    } catch {
      throw new OfficeZipError('Das Dokument ist beschädigt oder zu groß.')
    }
    return out
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    readText: (name) => {
      const bytes = read(name)
      return bytes ? bytes.toString('utf8').replace(/^﻿/u, '') : null
    },
    size: (name) => entries.get(name)?.size ?? 0,
  }
}

module.exports = { readZip, OfficeZipError, ZIP_LIMITS: LIMITS }
