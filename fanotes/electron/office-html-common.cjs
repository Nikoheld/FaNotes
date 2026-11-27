'use strict'

// Shared helpers for the built-in Office renderers. Everything that ends up in
// the generated HTML goes through these: text is escaped, colors and font names
// are whitelisted, pictures become data: URLs of known raster types only.
const path = require('node:path')
const { child } = require('./office-xml.cjs')

const MAX_IMAGE_BYTES = 24 * 1024 * 1024

const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const hexColor = (value) => (typeof value === 'string' && /^[0-9a-f]{6}$/iu.test(value) ? `#${value.toLowerCase()}` : null)
const num = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const round = (value, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Font family list for CSS from an Office font name; unknown characters are dropped. */
function fontFamily(name) {
  const clean = String(name ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60)
  if (!clean || clean.startsWith('+')) return null
  const serif = /times|georgia|garamond|cambria|palatino|book antiqua|serif$/iu.test(clean) && !/sans/iu.test(clean)
  const mono = /courier|consolas|mono|lucida console/iu.test(clean)
  const fallback = mono ? 'monospace' : serif ? 'serif' : 'sans-serif'
  const metric = /^calibri$/iu.test(clean) ? ', Carlito' : /^cambria$/iu.test(clean) ? ', Caladea' : /^arial$/iu.test(clean) ? ', "Liberation Sans"' : /^times new roman$/iu.test(clean) ? ', "Liberation Serif"' : /^courier new$/iu.test(clean) ? ', "Liberation Mono"' : ''
  return `"${clean}"${metric}, ${fallback}`
}

function imageMime(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 6 && bytes.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** data: URL for a picture inside the package, or null (missing, too big, vector or unknown format). */
function imageDataUrl(zip, partPath, cache) {
  if (!partPath || !zip.has(partPath)) return null
  if (cache?.has(partPath)) return cache.get(partPath)
  let url = null
  if (zip.size(partPath) <= MAX_IMAGE_BYTES) {
    const bytes = zip.read(partPath)
    const mime = bytes ? imageMime(bytes) : null
    if (mime) url = `data:${mime};base64,${bytes.toString('base64')}`
  }
  cache?.set(partPath, url)
  return url
}

function resolvePartPath(basePart, target) {
  if (!target || /^[a-z]+:/iu.test(target)) return null
  const joined = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(basePart), target)
  const normalized = path.posix.normalize(joined)
  return normalized.startsWith('..') ? null : normalized
}

/** Relationship id -> { target (package path), type } for one part. */
function readRelationships(zip, parseXml, partPath) {
  const result = new Map()
  const relsPath = `${path.posix.dirname(partPath)}/_rels/${path.posix.basename(partPath)}.rels`
  const text = zip.readText(relsPath)
  if (!text) return result
  const root = parseXml(text)
  for (const node of root.children) {
    if (node.name !== 'Relationship' || node.attrs.TargetMode === 'External') continue
    const target = resolvePartPath(partPath, node.attrs.Target)
    if (node.attrs.Id && target) result.set(node.attrs.Id, { target, type: String(node.attrs.Type ?? '').split('/').pop() })
  }
  return result
}

const documentShell = ({ title, css, body, head = '' }) => `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(title)}</title>${head}<style>${css}</style></head><body>${body}</body></html>`

module.exports = { esc, hexColor, num, round, fontFamily, imageDataUrl, resolvePartPath, readRelationships, documentShell, child }
