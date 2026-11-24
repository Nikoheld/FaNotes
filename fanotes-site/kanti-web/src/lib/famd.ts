// Reader for FaNotes handwriting notes (.famd, v1 and v2), ported from the website viewer
// (fanotes-site/public/viewer/famd-read.js), which mirrors fanotes/src/lib/famd.ts and the verified
// reference reader: v2 container with CRC-32, base-85 packed points, v1 container. Read only; never throws.

const V1_TOKEN = 'fanotes-famd:v1'
const V2_TOKEN = 'fanotes-famd:v2'
const V1_SCHEMA = 'fanotes-famd-v1'
const V2_SCHEMA = 'fanotes-famd-v2'
const V1_HEADER = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/gu
const V2_HEADER = /^<!--\s*fanotes-famd:v2\s+chars=(\d+)\s+crc=([0-9a-fA-F]{8})\s*-->\n/u
const MAX_JSON_CHARS = 32 * 1024 * 1024
const POINT_STRIDE = 36
const PACKED_KEYS = ['famdPts', 'famdPtExtra', 'famdPtr', 'famdPtrList', 'famdPtrIdx']
export const PAPER_STYLES = ['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter'] as const
export type PaperStyle = typeof PAPER_STYLES[number]

export class FamdError extends Error {
  constructor(message: string) { super(message); this.name = 'FamdError' }
}

// Base-85 alphabet of the app (not Ascii85/Z85).
const A85 = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvw"
const A85_INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < A85.length; i += 1) A85_INDEX[A85.charCodeAt(i)] = i

export const decode85 = (text: unknown): Uint8Array => {
  if (typeof text !== 'string' || text.length % 5 !== 0) throw new FamdError('bad base-85 length')
  const out = new Uint8Array((text.length / 5) * 4)
  for (let p = 0, o = 0; p < text.length; p += 5, o += 4) {
    let v = 0
    for (let k = 0; k < 5; k += 1) {
      const c = text.charCodeAt(p + k)
      const d = c < 128 ? A85_INDEX[c] : -1
      if (d < 0) throw new FamdError('bad base-85 digit')
      v = v * 85 + d
    }
    if (v > 0xffffffff) throw new FamdError('base-85 group overflows uint32')
    out[o] = v >>> 24
    out[o + 1] = (v >>> 16) & 255
    out[o + 2] = (v >>> 8) & 255
    out[o + 3] = v & 255
  }
  return out
}

const CRC = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let b = 0; b < 8; b += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  CRC[n] = c >>> 0
}
export const crc32Hex = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let c = 0xffffffff
  for (let j = 0; j < bytes.length; j += 1) c = (CRC[(c ^ bytes[j]) & 255] ^ (c >>> 8)) >>> 0
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

type Json = Record<string, unknown>
export interface InkPoint { x: number; y: number; t?: number; pressure?: number; [key: string]: unknown }

export const unpackStroke = (stroke: Json): Json => {
  const bytes = decode85(stroke.famdPts)
  if (bytes.length % POINT_STRIDE !== 0) throw new FamdError('point block is not a multiple of 36 bytes')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = bytes.length / POINT_STRIDE
  const extras = Array.isArray(stroke.famdPtExtra) ? stroke.famdPtExtra : null
  const points: InkPoint[] = []
  for (let i = 0; i < count; i += 1) {
    const o = i * POINT_STRIDE
    const point: InkPoint = { x: view.getUint16(o, true) / 65535, y: view.getUint16(o + 2, true) / 65535 }
    const pressure = view.getFloat64(o + 4, true)
    const t = view.getFloat64(o + 12, true)
    if (!Number.isNaN(t)) point.t = t
    if (!Number.isNaN(pressure)) point.pressure = pressure
    const extra = extras?.[i]
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(point, extra)
    points.push(point)
  }
  const next: Json = {}
  for (const key of Object.keys(stroke)) if (!PACKED_KEYS.includes(key)) next[key] = stroke[key]
  next.points = points
  return next
}

const unpackDeep = (value: unknown, depth: number): unknown => {
  if (depth > 24 || !value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => unpackDeep(item, depth + 1))
  const record = value as Json
  if (typeof record.famdPts === 'string') return unpackStroke(record)
  const out: Json = {}
  for (const key of Object.keys(record)) out[key] = unpackDeep(record[key], depth + 1)
  return out
}

const isSidecarJson = (text: string): boolean => {
  const t = text.trim()
  if (t.charAt(0) !== '{' || !t.includes(V1_SCHEMA)) return false
  try { return (JSON.parse(t) as Json).schema === V1_SCHEMA } catch { return false }
}

const locateV2 = (source: string) => {
  const tokenAt = source.lastIndexOf(V2_TOKEN)
  if (tokenAt < 0) return null
  const start = source.lastIndexOf('<!--', tokenAt)
  if (start < 0) throw new FamdError('truncated v2 header')
  const m = V2_HEADER.exec(source.slice(start))
  if (!m) throw new FamdError('truncated v2 header')
  const length = Number(m[1])
  if (!Number.isSafeInteger(length) || length < 2 || length > MAX_JSON_CHARS) throw new FamdError('bad v2 length')
  return { cut: start > 0 && source.charAt(start - 1) === '\n' ? start - 1 : start, jsonStart: start + m[0].length, length, crc: m[2].toLowerCase() }
}

const lastV1Header = (source: string): RegExpMatchArray | null => {
  const all = Array.from(source.matchAll(V1_HEADER))
  return all.length ? all[all.length - 1] : null
}

/** The markdown of a handwriting note without its embedded drawing payload. */
export const stripPayload = (source: string): string => {
  if (typeof source !== 'string' || !source) return ''
  let text = source
  const v1 = lastV1Header(text)
  let cut = v1 && v1.index !== undefined ? v1.index : -1
  let v2cut = -1
  if (text.includes(V2_TOKEN)) {
    try { v2cut = locateV2(text)?.cut ?? -1 } catch {
      const tokenAt = text.lastIndexOf(V2_TOKEN)
      const start = text.lastIndexOf('<!--', tokenAt)
      v2cut = start < 0 ? tokenAt : start > 0 && text.charAt(start - 1) === '\n' ? start - 1 : start
    }
  }
  if (v2cut >= 0 && v2cut > cut) cut = v2cut
  if (cut >= 0) text = text.slice(0, cut)
  text = text.replace(/\s+$/u, '')
  if (isSidecarJson(text)) return ''
  const trailing = /\n(\{[\s\S]*\})\s*$/u.exec(text)
  if (trailing && trailing[1] && isSidecarJson(trailing[1])) return text.slice(0, trailing.index).replace(/\s+$/u, '')
  return text
}

export interface FamdRead { version: 1 | 2 | null; markdown: string; payload: Json | null; error?: string }

export const readFamd = (source: string): FamdRead => {
  if (typeof source !== 'string' || !source) return { version: null, markdown: '', payload: null }
  const markdown = stripPayload(source)
  const v2Token = source.lastIndexOf(V2_TOKEN)
  const v1Token = source.lastIndexOf(V1_TOKEN)
  if (v2Token >= 0 && v2Token > v1Token) {
    try {
      const at = locateV2(source)
      if (!at) throw new FamdError('truncated v2 header')
      if (at.jsonStart + at.length > source.length) throw new FamdError('truncated v2 payload')
      const json = source.slice(at.jsonStart, at.jsonStart + at.length)
      if (crc32Hex(json) !== at.crc) throw new FamdError('v2 checksum mismatch')
      let parsed: Json
      try { parsed = JSON.parse(json) as Json } catch { throw new FamdError('v2 json') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== V2_SCHEMA) throw new FamdError('v2 schema')
      parsed.ink = unpackDeep(parsed.ink == null ? null : parsed.ink, 0)
      return { version: 2, markdown, payload: parsed }
    } catch (error) {
      return { version: 2, markdown, payload: null, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const m = lastV1Header(source)
  if (!m || m.index === undefined) return { version: null, markdown, payload: null }
  const length = Number(m[1])
  if (!Number.isSafeInteger(length) || length < 2 || length > MAX_JSON_CHARS) return { version: 1, markdown, payload: null }
  const s = m.index + m[0].length
  const raw = source.slice(s, s + length)
  if (raw.length !== length) return { version: 1, markdown, payload: null }
  try {
    const p1 = JSON.parse(raw) as Json
    if (!p1 || typeof p1 !== 'object' || Array.isArray(p1) || (p1.schema !== V1_SCHEMA && p1.schema !== V2_SCHEMA)) return { version: 1, markdown, payload: null }
    p1.ink = unpackDeep(p1.ink == null ? null : p1.ink, 0)
    return { version: 1, markdown, payload: p1 }
  } catch { return { version: 1, markdown, payload: null } }
}

export interface InkDoc { strokes: unknown[]; sourceWidth?: number; sourceHeight?: number; paperStyle?: string; [key: string]: unknown }
const isDoc = (doc: unknown): doc is InkDoc => Boolean(doc) && typeof doc === 'object' && Array.isArray((doc as InkDoc).strokes)
export interface FamdPage { label: string; doc: InkDoc; paper?: PaperStyle | null }

/** Pages to draw: one page for a note, one per entry for a PDF side-pages companion. */
export const collectPages = (payload: Json | null): FamdPage[] => {
  const ink = payload?.ink as Json | null | undefined
  if (!ink || typeof ink !== 'object') return []
  if (ink.kind === 'fanotes-pdf-side-pages') {
    const entries = Array.isArray(ink.ink) ? (ink.ink as Json[]) : []
    const byPage = new Map<number, FamdPage>()
    for (const entry of entries) {
      if (!entry || !Number.isInteger(entry.page) || (entry.page as number) < 1 || !isDoc(entry.ink)) continue
      const doc = entry.ink
      if (!(Number(doc.sourceWidth) > 0) || !(Number(doc.sourceHeight) > 0)) continue
      byPage.set(entry.page as number, { label: `PDF ${entry.page}`, doc })
    }
    return [...byPage.keys()].sort((a, b) => a - b).map((key) => byPage.get(key) as FamdPage)
  }
  if (!isDoc(ink)) return []
  const paper = (PAPER_STYLES as readonly string[]).includes(payload?.paperStyle as string) ? (payload?.paperStyle as PaperStyle) : null
  return [{ label: '', doc: ink, paper }]
}
