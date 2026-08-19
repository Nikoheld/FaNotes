'use strict'

const SUBJECT_BOOK_PLACEMENTS = Object.freeze(['links', 'rechts', 'oben', 'unten', 'popout'])
const MAX_PATH = 500
const MAX_BOOKS = 200

function sanitizeFolderPath(value) {
  if (typeof value !== 'string') return ''
  const path = value.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '').trim()
  if (!path || path.length > MAX_PATH || path.includes('..') || path.includes('\0') || /\.(md|markdown|famd|pdf)$/iu.test(path)) {
    return ''
  }
  return path
}

function sanitizePdfPath(value) {
  if (typeof value !== 'string') return ''
  const path = value.replace(/\\/gu, '/').replace(/^\/+/u, '').trim()
  if (!path || path.length > MAX_PATH || path.includes('..') || path.includes('\0') || !/\.pdf$/iu.test(path)) return ''
  return path
}

function sanitizeSubjectBook(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const subjectPath = sanitizeFolderPath(value.subjectPath)
  const bookPath = sanitizePdfPath(value.bookPath)
  if (!subjectPath || !bookPath) return null
  const page = Number(value.lastPage)
  return {
    subjectPath,
    bookPath,
    lastPage: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  }
}

function parseSubjectBooks(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const books = []
  for (const entry of value) {
    const book = sanitizeSubjectBook(entry)
    if (!book || seen.has(book.subjectPath)) continue
    seen.add(book.subjectPath)
    books.push(book)
  }
  return books.slice(0, MAX_BOOKS)
}

module.exports = {
  SUBJECT_BOOK_PLACEMENTS,
  parseSubjectBooks,
  sanitizeSubjectBook,
}
