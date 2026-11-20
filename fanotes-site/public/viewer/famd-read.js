/* Standalone FaNotes .famd reader for the website viewer (v1 and v2).
 * Logic mirrors fanotes/src/lib/famd.ts and the verified reference reader
 * (SPEC.md, read-famd.mjs): v2 container with crc32, base-85 packed points
 * (famdPts, famdPtExtra, famdPtr, famdPtrList, famdPtrIdx) and the v1 container.
 * Exposes window.FamdRead and, for node tests, module.exports. */
(function (root) {
  'use strict'

  var V1_TOKEN = 'fanotes-famd:v1'
  var V2_TOKEN = 'fanotes-famd:v2'
  var V1_SCHEMA = 'fanotes-famd-v1'
  var V2_SCHEMA = 'fanotes-famd-v2'
  var V1_HEADER = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/gu
  var V2_HEADER = /^<!--\s*fanotes-famd:v2\s+chars=(\d+)\s+crc=([0-9a-fA-F]{8})\s*-->\n/u
  var MAX_JSON_CHARS = 32 * 1024 * 1024
  var POINT_STRIDE = 36
  var PACKED_KEYS = ['famdPts', 'famdPtExtra', 'famdPtr', 'famdPtrList', 'famdPtrIdx']
  var PAPER_STYLES = ['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter']

  function FamdError(message) {
    this.name = 'FamdError'
    this.message = message
  }
  FamdError.prototype = Object.create(Error.prototype)

  // Base-85 alphabet of the app (not Ascii85/Z85).
  var A85 = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvw"
  var A85_INDEX = new Int16Array(128).fill(-1)
  for (var i = 0; i < A85.length; i += 1) A85_INDEX[A85.charCodeAt(i)] = i

  function decode85(text) {
    if (typeof text !== 'string' || text.length % 5 !== 0) throw new FamdError('bad base-85 length')
    var out = new Uint8Array((text.length / 5) * 4)
    for (var p = 0, o = 0; p < text.length; p += 5, o += 4) {
      var v = 0
      for (var k = 0; k < 5; k += 1) {
        var c = text.charCodeAt(p + k)
        var d = c < 128 ? A85_INDEX[c] : -1
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

  var CRC = new Uint32Array(256)
  for (var n = 0; n < 256; n += 1) {
    var cc = n
    for (var b = 0; b < 8; b += 1) cc = cc & 1 ? (cc >>> 1) ^ 0xedb88320 : cc >>> 1
    CRC[n] = cc >>> 0
  }
  function crc32Hex(text) {
    var bytes = new TextEncoder().encode(text)
    var c = 0xffffffff
    for (var j = 0; j < bytes.length; j += 1) c = (CRC[(c ^ bytes[j]) & 255] ^ (c >>> 8)) >>> 0
    return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
  }

  function unpackStroke(stroke) {
    var bytes = decode85(stroke.famdPts)
    if (bytes.length % POINT_STRIDE !== 0) throw new FamdError('point block is not a multiple of 36 bytes')
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    var count = bytes.length / POINT_STRIDE
    var extras = Array.isArray(stroke.famdPtExtra) ? stroke.famdPtExtra : null
    var points = []
    for (var i2 = 0; i2 < count; i2 += 1) {
      var o = i2 * POINT_STRIDE
      var p = { x: view.getUint16(o, true) / 65535, y: view.getUint16(o + 2, true) / 65535 }
      var pressure = view.getFloat64(o + 4, true)
      var t = view.getFloat64(o + 12, true)
      if (!Number.isNaN(t)) p.t = t
      if (!Number.isNaN(pressure)) p.pressure = pressure
      var extra = extras && extras[i2]
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(p, extra)
      points.push(p)
    }
    var next = {}
    Object.keys(stroke).forEach(function (key) {
      if (PACKED_KEYS.indexOf(key) < 0) next[key] = stroke[key]
    })
    next.points = points
    return next
  }

  function unpackDeep(value, depth) {
    if (depth > 24 || !value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(function (v) { return unpackDeep(v, depth + 1) })
    if (typeof value.famdPts === 'string') return unpackStroke(value)
    var out = {}
    Object.keys(value).forEach(function (key) { out[key] = unpackDeep(value[key], depth + 1) })
    return out
  }

  function isSidecarJson(text) {
    var t = text.trim()
    if (t.charAt(0) !== '{' || t.indexOf(V1_SCHEMA) < 0) return false
    try { return JSON.parse(t).schema === V1_SCHEMA } catch (e) { return false }
  }

  function locateV2(source) {
    var tokenAt = source.lastIndexOf(V2_TOKEN)
    if (tokenAt < 0) return null
    var start = source.lastIndexOf('<!--', tokenAt)
    if (start < 0) throw new FamdError('truncated v2 header')
    var m = V2_HEADER.exec(source.slice(start))
    if (!m) throw new FamdError('truncated v2 header')
    var length = Number(m[1])
    if (!Number.isSafeInteger(length) || length < 2 || length > MAX_JSON_CHARS) throw new FamdError('bad v2 length')
    return {
      cut: start > 0 && source.charAt(start - 1) === '\n' ? start - 1 : start,
      jsonStart: start + m[0].length,
      length: length,
      crc: m[2].toLowerCase(),
    }
  }

  function lastV1Header(source) {
    var all = Array.from(source.matchAll(V1_HEADER))
    return all.length ? all[all.length - 1] : null
  }

  function stripPayload(source) {
    if (typeof source !== 'string' || !source) return ''
    var text = source
    var v1 = lastV1Header(text)
    var cut = v1 ? v1.index : -1
    var v2cut = -1
    if (text.indexOf(V2_TOKEN) >= 0) {
      try { v2cut = locateV2(text).cut } catch (e) {
        var tokenAt = text.lastIndexOf(V2_TOKEN)
        var start = text.lastIndexOf('<!--', tokenAt)
        v2cut = start < 0 ? tokenAt : start > 0 && text.charAt(start - 1) === '\n' ? start - 1 : start
      }
    }
    if (v2cut >= 0 && v2cut > cut) cut = v2cut
    if (cut >= 0) text = text.slice(0, cut)
    text = text.replace(/\s+$/u, '')
    if (isSidecarJson(text)) return ''
    var trailing = text.match(/\n(\{[\s\S]*\})\s*$/u)
    if (trailing && trailing[1] && isSidecarJson(trailing[1])) return text.slice(0, trailing.index).replace(/\s+$/u, '')
    return text
  }

  /** Returns { version: 1|2|null, markdown, payload|null, error? }. Never throws. */
  function readFamd(source) {
    if (typeof source !== 'string' || !source) return { version: null, markdown: '', payload: null }
    var markdown = stripPayload(source)
    var v2Token = source.lastIndexOf(V2_TOKEN)
    var v1Token = source.lastIndexOf(V1_TOKEN)
    if (v2Token >= 0 && v2Token > v1Token) {
      try {
        var at = locateV2(source)
        if (at.jsonStart + at.length > source.length) throw new FamdError('truncated v2 payload')
        var json = source.slice(at.jsonStart, at.jsonStart + at.length)
        if (crc32Hex(json) !== at.crc) throw new FamdError('v2 checksum mismatch')
        var parsed
        try { parsed = JSON.parse(json) } catch (e) { throw new FamdError('v2 json') }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== V2_SCHEMA) throw new FamdError('v2 schema')
        parsed.ink = unpackDeep(parsed.ink == null ? null : parsed.ink, 0)
        return { version: 2, markdown: markdown, payload: parsed }
      } catch (error) {
        return { version: 2, markdown: markdown, payload: null, error: String(error.message || error) }
      }
    }
    var m = lastV1Header(source)
    if (!m) return { version: null, markdown: markdown, payload: null }
    var length = Number(m[1])
    if (!Number.isSafeInteger(length) || length < 2 || length > MAX_JSON_CHARS) return { version: 1, markdown: markdown, payload: null }
    var s = m.index + m[0].length
    var raw = source.slice(s, s + length)
    if (raw.length !== length) return { version: 1, markdown: markdown, payload: null }
    try {
      var p1 = JSON.parse(raw)
      if (!p1 || typeof p1 !== 'object' || Array.isArray(p1) || (p1.schema !== V1_SCHEMA && p1.schema !== V2_SCHEMA)) {
        return { version: 1, markdown: markdown, payload: null }
      }
      p1.ink = unpackDeep(p1.ink == null ? null : p1.ink, 0)
      return { version: 1, markdown: markdown, payload: p1 }
    } catch (e) {
      return { version: 1, markdown: markdown, payload: null }
    }
  }

  var isDoc = function (doc) { return doc && typeof doc === 'object' && Array.isArray(doc.strokes) }

  /** Pages to draw: one page for a note, one per entry for a PDF side-pages companion. */
  function collectPages(payload) {
    var ink = payload && payload.ink
    if (!ink || typeof ink !== 'object') return []
    if (ink.kind === 'fanotes-pdf-side-pages') {
      var entries = Array.isArray(ink.ink) ? ink.ink : []
      var byPage = new Map()
      entries.forEach(function (entry) {
        if (!entry || !Number.isInteger(entry.page) || entry.page < 1 || !isDoc(entry.ink)) return
        if (!(Number(entry.ink.sourceWidth) > 0) || !(Number(entry.ink.sourceHeight) > 0)) return
        byPage.set(entry.page, { label: 'PDF ' + entry.page, doc: entry.ink })
      })
      return Array.from(byPage.keys()).sort(function (a, b) { return a - b }).map(function (k) { return byPage.get(k) })
    }
    if (!isDoc(ink)) return []
    var paper = PAPER_STYLES.indexOf(payload.paperStyle) >= 0 ? payload.paperStyle : null
    return [{ label: '', doc: ink, paper: paper }]
  }

  var api = {
    FamdError: FamdError, decode85: decode85, crc32Hex: crc32Hex, unpackStroke: unpackStroke,
    stripPayload: stripPayload, readFamd: readFamd, collectPages: collectPages, PAPER_STYLES: PAPER_STYLES,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  root.FamdRead = api
})(typeof window !== 'undefined' ? window : globalThis)
