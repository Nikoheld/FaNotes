'use strict'

/**
 * Copy worksheet bytes from an IPC payload without trusting a plain object's
 * `length`. `Buffer.from({ length })` allocates that many bytes before any cap.
 */
function coerceWorksheetBytes(bytes, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Das Bild ist leer oder zu groß.')
  }
  if (Buffer.isBuffer(bytes) || ArrayBuffer.isView(bytes)) {
    if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) throw new Error('Das Bild ist leer oder zu groß.')
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  if (bytes instanceof ArrayBuffer) {
    if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) throw new Error('Das Bild ist leer oder zu groß.')
    return Buffer.from(bytes)
  }
  if (Array.isArray(bytes)) {
    if (bytes.length <= 0 || bytes.length > maxBytes) throw new Error('Das Bild ist leer oder zu groß.')
    return Buffer.from(bytes)
  }
  throw new Error('Das Bild ist leer oder zu groß.')
}

module.exports = { coerceWorksheetBytes }
