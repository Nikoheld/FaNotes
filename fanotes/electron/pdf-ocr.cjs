'use strict'

const crypto = require('node:crypto')

const FORMAT = 'fanotes-pdf-ocr-v1'
const MIN_TEXT = 20
const MAX_PAGES = 60
const MAX_PAGE_CHARS = 6_000
const MAX_BYTES = 512 * 1024
const MAX_PDF_BYTES = 96 * 1024 * 1024
const MAX_TOTAL_CHARS = MAX_PAGES * MAX_PAGE_CHARS
const STAMP_PATTERN = /^[a-f0-9]{8}$/u

const sidecarName = (relativePath) => (
  crypto.createHash('sha256').update(String(relativePath)).digest('hex').slice(0, 32) + '.json'
)

const sidecarRelative = (relativePath) => `.fanotes/pdf-ocr/${sidecarName(relativePath)}`

const sanitizePages = (value) => {
  if (!Array.isArray(value) || value.length > MAX_PAGES) return null
  const pages = []
  const seen = new Set()
  let total = 0
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const page = entry.page
    const text = entry.text
    if (!Number.isInteger(page) || page < 1 || page > 2000) return null
    if (typeof text !== 'string' || text.length > MAX_PAGE_CHARS) return null
    if (seen.has(page)) return null
    seen.add(page)
    total += text.length
    if (total > MAX_TOTAL_CHARS) return null
    pages.push({ page, text })
  }
  return pages
}

const sanitize = (value) => {
  if (!value || typeof value !== 'object') return null
  if (value.format !== FORMAT) return null
  if (typeof value.path !== 'string' || value.path.length < 1 || value.path.length > 4096) return null
  if (value.path.includes('\0') || value.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_PDF_BYTES) return null
  if (!Number.isSafeInteger(value.mtimeMs) || value.mtimeMs < 0) return null
  if (typeof value.stamp !== 'string' || !STAMP_PATTERN.test(value.stamp)) return null
  const pages = sanitizePages(value.pages)
  if (!pages) return null
  return {
    format: FORMAT,
    path: value.path,
    size: value.size,
    mtimeMs: value.mtimeMs,
    stamp: value.stamp,
    pages,
  }
}

/** Stored transcript for this path only while size and mtime still match the PDF. */
const currentDocument = (raw, file) => {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const doc = sanitize(parsed)
  if (!doc || !file) return null
  if (doc.path !== file.path || doc.size !== file.size || doc.mtimeMs !== file.mtimeMs) return null
  return doc
}

const transcriptForFile = (raw, file) => {
  const doc = currentDocument(raw, file)
  if (!doc) return ''
  return doc.pages.map((page) => page.text).join('\n').slice(0, MAX_TOTAL_CHARS)
}

const buildDocument = (payload, file) => {
  if (!payload || typeof payload !== 'object' || !file) return null
  if (payload.path !== file.path || payload.size !== file.size) return null
  if (typeof payload.stamp !== 'string' || !STAMP_PATTERN.test(payload.stamp)) return null
  const pages = sanitizePages(payload.pages)
  if (!pages) return null
  if (!Number.isSafeInteger(file.mtimeMs) || file.mtimeMs < 0) return null
  return {
    format: FORMAT,
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    stamp: payload.stamp,
    pages,
  }
}

module.exports = {
  FORMAT,
  MIN_TEXT,
  MAX_PAGES,
  MAX_PAGE_CHARS,
  MAX_BYTES,
  sidecarName,
  sidecarRelative,
  sanitize,
  currentDocument,
  transcriptForFile,
  buildDocument,
}
