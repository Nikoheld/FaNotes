'use strict'

/**
 * Line endings of note files. The editor and the app state work on LF only;
 * the file keeps the ending it had (a Windows note stays CRLF on disk).
 */

/** 'crlf' when most breaks in the text are CRLF, otherwise 'lf'. */
function detectLineEnding(text) {
  if (typeof text !== 'string' || !text.includes('\r\n')) return 'lf'
  const crlf = (text.match(/\r\n/gu) || []).length
  const lf = (text.match(/\n/gu) || []).length - crlf
  return crlf > lf ? 'crlf' : 'lf'
}

/** CRLF and lone CR become LF. */
function toLf(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/gu, '\n') : ''
}

/** LF text written with the file's own ending. */
function applyLineEnding(text, ending) {
  return ending === 'crlf' ? toLf(text).replace(/\n/gu, '\r\n') : text
}

/** Notepad saves UTF-8 with a byte order mark; the editor must not see it as text (it breaks a leading "# "). */
function hasBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff
}

function stripBom(text) {
  return hasBom(text) ? text.slice(1) : text
}

module.exports = { detectLineEnding, toLf, applyLineEnding, hasBom, stripBom }
