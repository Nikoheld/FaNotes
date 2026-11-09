'use strict'

// `fanotes-page-text-v1` sidecars: per-page text of one vault PDF, shared with
// other FaNotes clients. Mirrors src/lib/docSearch/pageText.ts (the reference
// implementation); the main process re-validates everything the renderer sends.

const crypto = require('node:crypto')

const FORMAT = 'fanotes-page-text-v1'
const DIRECTORY = 'page-text'
const MAX_PAGES = 2000
const MAX_PAGE_CHARS = 6000
const MAX_BYTES = 4 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 96 * 1024 * 1024
const STAMP = /^[a-f0-9]{8}$/u
const SOURCES = new Set(['text-layer', 'ocr'])
const STATUSES = new Set(['ok', 'empty', 'failed', 'skipped'])
const ROTATIONS = new Set([0, 90, 180, 270])

const sidecarName = (relativePath) => (
  crypto.createHash('sha256').update(String(relativePath)).digest('hex').slice(0, 32) + '.json'
)

const sidecarRelative = (relativePath) => `.fanotes/${DIRECTORY}/${sidecarName(relativePath)}`

const validPath = (value) => (
  typeof value === 'string'
  && value.length > 0
  && value.length <= 4096
  && !value.includes('\0')
  && !value.includes('\\')
  && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
)

const sanitize = (value) => {
  if (!value || typeof value !== 'object') return null
  if (value.format !== FORMAT || !validPath(value.path)) return null
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_DOCUMENT_BYTES) return null
  if (typeof value.stamp !== 'string' || !STAMP.test(value.stamp)) return null
  if (!Number.isSafeInteger(value.pageCount) || value.pageCount < 0 || value.pageCount > 100_000) return null
  if (typeof value.producer !== 'string' || value.producer.length > 200) return null
  if (value.ocrEngine !== undefined && (typeof value.ocrEngine !== 'string' || value.ocrEngine.length > 100)) return null
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null
  if (!Array.isArray(value.pages) || value.pages.length > MAX_PAGES) return null
  const pages = []
  const seen = new Set()
  for (const page of value.pages) {
    if (!page || typeof page !== 'object') return null
    if (!Number.isSafeInteger(page.page) || page.page < 1 || page.page > value.pageCount || seen.has(page.page)) return null
    seen.add(page.page)
    if (!SOURCES.has(page.source) || !STATUSES.has(page.status)) return null
    if (typeof page.text !== 'string' || page.text.length > MAX_PAGE_CHARS) return null
    if (page.confidence !== undefined && !(typeof page.confidence === 'number' && page.confidence >= 0 && page.confidence <= 1)) return null
    if (page.rotation !== undefined && !ROTATIONS.has(page.rotation)) return null
    if (page.reason !== undefined && (typeof page.reason !== 'string' || page.reason.length > 120)) return null
    pages.push({
      page: page.page,
      source: page.source,
      status: page.status,
      text: page.text,
      ...(page.confidence !== undefined ? { confidence: page.confidence } : {}),
      ...(page.rotation !== undefined ? { rotation: page.rotation } : {}),
      ...(page.reason !== undefined ? { reason: page.reason } : {}),
    })
  }
  pages.sort((left, right) => left.page - right.page)
  return {
    format: FORMAT,
    path: value.path,
    size: value.size,
    stamp: value.stamp,
    pageCount: value.pageCount,
    producer: value.producer,
    ...(value.ocrEngine !== undefined ? { ocrEngine: value.ocrEngine } : {}),
    createdAt: value.createdAt,
    pages,
  }
}

/** The record for this path and file size only; the stamp is compared by the reader. */
const recordForFile = (raw, file) => {
  let parsed = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { return null }
  }
  const record = sanitize(parsed)
  if (!record || !file || record.path !== file.path || record.size !== file.size) return null
  return record
}

/** Validates a renderer payload against the file on disk. */
const buildForWrite = (payload, file) => {
  const record = sanitize(payload)
  if (!record || record.path !== file.path || record.size !== file.size) return null
  const serialized = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) return null
  return { record, serialized }
}

module.exports = { FORMAT, DIRECTORY, MAX_BYTES, sidecarName, sidecarRelative, sanitize, recordForFile, buildForWrite }
