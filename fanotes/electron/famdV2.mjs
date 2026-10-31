'use strict'

/**
 * Compact FaNotes companion (`fanotes-famd:v2`).
 *
 * The markdown stays in front of the header, so a reader can take the note
 * text without decoding ink. Each point is 36 bytes: uint16 x, uint16 y, and
 * float64 pressure, time, tiltX, and tiltY. Coordinates use a 1/65535 page
 * step, under 1e-4. Pressure, time, and tilt are the saved numbers. A shared
 * pointer type is stored once per stroke; mixed types use a byte index.
 * The bytes are JSON-safe base-85 so a real ink-heavy note, tilt and pointer
 * included, is at most half the v1 JSON size.
 * A CRC-32 covers the payload; a short or mismatched file throws instead of
 * looking like an empty note.
 */

const FAMD_V2_SCHEMA = 'fanotes-famd-v2'
const FAMD_V2_TOKEN = 'fanotes-famd:v2'
const POINT_STRIDE = 36
const PACKED_POINT_KEYS = new Set(['x', 'y', 't', 'pressure', 'tiltX', 'tiltY', 'pointerType'])
const PACKED_STROKE_KEYS = new Set(['points', 'famdPts', 'famdPtExtra', 'famdPtr', 'famdPtrList', 'famdPtrIdx'])
const MAX_PAYLOAD_CHARS = 32 * 1024 * 1024
// 85 printable ASCII characters that JSON.stringify leaves unescaped.
// 4 bytes become 5 characters, and 85^5 covers every uint32.
const FAMD85 = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvw"
const FAMD85_INDEX = new Uint8Array(128).fill(255)
for (let index = 0; index < FAMD85.length; index += 1) FAMD85_INDEX[FAMD85.charCodeAt(index)] = index

class FamdCorruptError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FamdCorruptError'
    this.code = 'FAMD_CORRUPT'
  }
}

const crc32 = (text) => {
  const bytes = new TextEncoder().encode(text)
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

const crcHex = (text) => crc32(text).toString(16).padStart(8, '0')

const encode85 = (bytes) => {
  if (bytes.length % 4 !== 0) throw new FamdCorruptError('famd v2 point block length')
  const parts = new Array(bytes.length / 4)
  for (let index = 0, group = 0; index < bytes.length; index += 4, group += 1) {
    let value = (((bytes[index] * 256 + bytes[index + 1]) * 256 + bytes[index + 2]) * 256) + bytes[index + 3]
    const chars = ['', '', '', '', '']
    for (let digit = 4; digit >= 0; digit -= 1) {
      chars[digit] = FAMD85[value % 85]
      value = Math.floor(value / 85)
    }
    parts[group] = chars.join('')
  }
  return parts.join('')
}

const decode85 = (value) => {
  if (typeof value !== 'string' || value.length % 5 !== 0) {
    throw new FamdCorruptError('famd v2 point block')
  }
  const bytes = new Uint8Array((value.length / 5) * 4)
  for (let index = 0, offset = 0; index < value.length; index += 5, offset += 4) {
    let value32 = 0
    for (let digit = 0; digit < 5; digit += 1) {
      const code = value.charCodeAt(index + digit)
      const decoded = code < 128 ? FAMD85_INDEX[code] : 255
      if (decoded === 255) throw new FamdCorruptError('famd v2 point block')
      value32 = value32 * 85 + decoded
    }
    if (value32 > 0xffffffff) throw new FamdCorruptError('famd v2 point block')
    bytes[offset] = Math.floor(value32 / 16777216)
    bytes[offset + 1] = Math.floor(value32 / 65536) % 256
    bytes[offset + 2] = Math.floor(value32 / 256) % 256
    bytes[offset + 3] = value32 % 256
  }
  return bytes
}

const quantizeUnit = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const clamped = number < 0 ? 0 : number > 1 ? 1 : number
  return Math.round(clamped * 65535)
}

const finiteOrNaN = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
)

// Canonical quiet NaN. Engines disagree on the bits of a bare NaN.
const writeFloat64 = (view, offset, value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    view.setFloat64(offset, value, true)
    return
  }
  view.setUint32(offset, 0, true)
  view.setUint32(offset + 4, 0x7ff80000, true)
}

const pointExtras = (point, keepPointer) => {
  if (!point || typeof point !== 'object') return null
  const extra = {}
  for (const key of Object.keys(point)) {
    if (PACKED_POINT_KEYS.has(key) && (key !== 'pointerType' || !keepPointer)) continue
    extra[key] = point[key]
  }
  return Object.keys(extra).length ? extra : null
}

const packPointer = (points) => {
  const types = points.map((point) => (
    point && typeof point === 'object' && typeof point.pointerType === 'string' ? point.pointerType : null
  ))
  if (types.every((type) => type == null)) return { packed: false }
  const first = types[0]
  if (types.every((type) => type === first)) return { packed: true, famdPtr: first }
  const dict = []
  const indexOf = new Map()
  for (const type of types) {
    if (type != null && !indexOf.has(type)) {
      if (dict.length === 255) return { packed: false, overflow: true }
      indexOf.set(type, dict.length)
      dict.push(type)
    }
  }
  const raw = new Uint8Array(types.length)
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index]
    raw[index] = type == null ? 255 : indexOf.get(type)
  }
  const paddedLength = raw.length + ((4 - (raw.length % 4)) % 4)
  const padded = paddedLength === raw.length ? raw : new Uint8Array(paddedLength)
  if (padded !== raw) padded.set(raw)
  return { packed: true, famdPtrList: dict, famdPtrIdx: encode85(padded) }
}

const packPoints = (points, keepPointer) => {
  const bytes = new Uint8Array(points.length * POINT_STRIDE)
  const view = new DataView(bytes.buffer)
  const extras = []
  let anyExtra = false
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] && typeof points[index] === 'object' ? points[index] : {}
    const offset = index * POINT_STRIDE
    view.setUint16(offset, quantizeUnit(point.x), true)
    view.setUint16(offset + 2, quantizeUnit(point.y), true)
    writeFloat64(view, offset + 4, finiteOrNaN(point.pressure))
    writeFloat64(view, offset + 12, finiteOrNaN(point.t))
    writeFloat64(view, offset + 20, finiteOrNaN(point.tiltX))
    writeFloat64(view, offset + 28, finiteOrNaN(point.tiltY))
    const extra = pointExtras(point, keepPointer)
    extras.push(extra)
    if (extra) anyExtra = true
  }
  return {
    famdPts: encode85(bytes),
    ...(anyExtra ? { famdPtExtra: extras } : {}),
  }
}

const packStroke = (stroke) => {
  if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke) || !Array.isArray(stroke.points)) {
    return stroke
  }
  const next = {}
  for (const key of Object.keys(stroke)) {
    if (PACKED_STROKE_KEYS.has(key)) continue
    next[key] = stroke[key]
  }
  const pointer = packPointer(stroke.points)
  const packed = packPoints(stroke.points, pointer.overflow === true)
  next.famdPts = packed.famdPts
  if (packed.famdPtExtra) next.famdPtExtra = packed.famdPtExtra
  if (typeof pointer.famdPtr === 'string') next.famdPtr = pointer.famdPtr
  if (Array.isArray(pointer.famdPtrList)) {
    next.famdPtrList = pointer.famdPtrList
    next.famdPtrIdx = pointer.famdPtrIdx
  }
  return next
}

const packInk = (ink) => {
  if (!ink || typeof ink !== 'object' || Array.isArray(ink)) return ink ?? null
  if (!Array.isArray(ink.strokes)) return ink
  const next = {}
  for (const key of Object.keys(ink)) {
    if (key === 'strokes') continue
    next[key] = ink[key]
  }
  next.strokes = ink.strokes.map((stroke) => packStroke(stroke))
  return next
}

const unpackStroke = (stroke) => {
  if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke) || typeof stroke.famdPts !== 'string') {
    return stroke
  }
  const bytes = decode85(stroke.famdPts)
  if (bytes.length % POINT_STRIDE !== 0) throw new FamdCorruptError('famd v2 point block length')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const extras = Array.isArray(stroke.famdPtExtra) ? stroke.famdPtExtra : null
  const points = []
  const count = bytes.length / POINT_STRIDE
  for (let index = 0; index < count; index += 1) {
    const offset = index * POINT_STRIDE
    const point = {
      x: view.getUint16(offset, true) / 65535,
      y: view.getUint16(offset + 2, true) / 65535,
    }
    const pressure = view.getFloat64(offset + 4, true)
    const time = view.getFloat64(offset + 12, true)
    const tiltX = view.getFloat64(offset + 20, true)
    const tiltY = view.getFloat64(offset + 28, true)
    if (!Number.isNaN(time)) point.t = time
    if (!Number.isNaN(pressure)) point.pressure = pressure
    if (!Number.isNaN(tiltX)) point.tiltX = tiltX
    if (!Number.isNaN(tiltY)) point.tiltY = tiltY
    const extra = extras && extras[index] && typeof extras[index] === 'object' && !Array.isArray(extras[index])
      ? extras[index]
      : null
    if (extra) Object.assign(point, extra)
    if (typeof stroke.famdPtr === 'string') point.pointerType = stroke.famdPtr
    points.push(point)
  }
  if (Array.isArray(stroke.famdPtrList) && typeof stroke.famdPtrIdx === 'string') {
    const raw = decode85(stroke.famdPtrIdx)
    if (raw.length < count) throw new FamdCorruptError('famd v2 pointer index')
    for (let index = 0; index < count; index += 1) {
      const code = raw[index]
      if (code === 255) continue
      const name = stroke.famdPtrList[code]
      if (typeof name !== 'string') throw new FamdCorruptError('famd v2 pointer index')
      points[index].pointerType = name
    }
  }
  const next = {}
  for (const key of Object.keys(stroke)) {
    if (key === 'famdPts' || key === 'famdPtExtra' || key === 'famdPtr' || key === 'famdPtrList' || key === 'famdPtrIdx') continue
    next[key] = stroke[key]
  }
  next.points = points
  return next
}

const unpackInk = (ink) => {
  if (!ink || typeof ink !== 'object' || Array.isArray(ink) || !Array.isArray(ink.strokes)) return ink ?? null
  return {
    ...ink,
    strokes: ink.strokes.map((stroke) => unpackStroke(stroke)),
  }
}

const markerRank = (source) => ({
  v1: source.lastIndexOf('fanotes-famd:v1'),
  v2: source.lastIndexOf(FAMD_V2_TOKEN),
})

const isActiveV2 = (source) => {
  if (typeof source !== 'string' || !source) return false
  const rank = markerRank(source)
  return rank.v2 >= 0 && rank.v2 > rank.v1
}

const famdEncodingForSave = (existing) => {
  if (typeof existing !== 'string' || existing.length === 0) return 'v2'
  if (isActiveV2(existing)) return 'v2'
  if (existing.includes('fanotes-famd:v1')) return 'v1'
  return 'v2'
}

const locateV2 = (source) => {
  const tokenAt = source.lastIndexOf(FAMD_V2_TOKEN)
  if (tokenAt < 0) return null
  const start = source.lastIndexOf('<!--', tokenAt)
  if (start < 0) throw new FamdCorruptError('truncated famd v2 header')
  const slice = source.slice(start)
  const match = /^<!--\s*fanotes-famd:v2\s+chars=(\d+)\s+crc=([0-9a-fA-F]{8})\s*-->\n/u.exec(slice)
  if (!match) throw new FamdCorruptError('truncated famd v2 header')
  const length = Number(match[1])
  if (!Number.isSafeInteger(length) || length < 2 || length > MAX_PAYLOAD_CHARS) {
    throw new FamdCorruptError('famd v2 length')
  }
  const cut = start > 0 && source[start - 1] === '\n' ? start - 1 : start
  return {
    cut,
    jsonStart: start + match[0].length,
    length,
    crc: match[2].toLowerCase(),
  }
}

const v2CutIndex = (source) => {
  if (typeof source !== 'string' || !source.includes(FAMD_V2_TOKEN)) return -1
  try {
    const located = locateV2(source)
    return located ? located.cut : -1
  } catch {
    const tokenAt = source.lastIndexOf(FAMD_V2_TOKEN)
    const start = source.lastIndexOf('<!--', tokenAt)
    if (start < 0) return tokenAt
    return start > 0 && source[start - 1] === '\n' ? start - 1 : start
  }
}

const readV2Payload = (source) => {
  const located = locateV2(source)
  if (!located) throw new FamdCorruptError('missing famd v2 header')
  if (located.jsonStart + located.length > source.length) throw new FamdCorruptError('truncated famd v2 payload')
  const json = source.slice(located.jsonStart, located.jsonStart + located.length)
  if (json.length !== located.length) throw new FamdCorruptError('truncated famd v2 payload')
  if (crcHex(json) !== located.crc) throw new FamdCorruptError('famd v2 checksum')
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new FamdCorruptError('famd v2 json')
  }
  if (!parsed || parsed.schema !== FAMD_V2_SCHEMA || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FamdCorruptError('famd v2 schema')
  }
  return {
    ...parsed,
    ink: unpackInk(parsed.ink),
  }
}

const encodeV2Document = (body, payload) => {
  const stored = {
    schema: FAMD_V2_SCHEMA,
    updatedAt: payload.updatedAt,
    ink: packInk(payload.ink),
    worksheets: Array.isArray(payload.worksheets) ? payload.worksheets : [],
  }
  if (payload.paperStyle) stored.paperStyle = payload.paperStyle
  if (Array.isArray(payload.noteLinks) && payload.noteLinks.length) stored.noteLinks = payload.noteLinks
  if (Array.isArray(payload.noteBackups) && payload.noteBackups.length) stored.noteBackups = payload.noteBackups
  if (payload.pageStats) stored.pageStats = payload.pageStats
  if (Array.isArray(payload.textFields) && payload.textFields.length) stored.textFields = payload.textFields
  const json = JSON.stringify(stored)
  const header = `<!-- fanotes-famd:v2 chars=${json.length} crc=${crcHex(json)} -->\n`
  const text = typeof body === 'string' ? body : ''
  return `${text ? `${text}\n\n` : ''}${header}${json}\n`
}

export {
  FAMD_V2_SCHEMA,
  FAMD_V2_TOKEN,
  FamdCorruptError,
  crcHex,
  encodeV2Document,
  famdEncodingForSave,
  isActiveV2,
  readV2Payload,
  v2CutIndex,
}
