'use strict'

const { germanIndexOf } = require('./german-search.cjs')

const POSITIONED_LINE = /^(\d+(?:\.\d+)?)\t(.*)$/u

const parseTranscriptLine = (line) => {
  const match = POSITIONED_LINE.exec(line.trim())
  if (!match) return { y: null, text: line.trim() }
  const y = Number(match[1])
  if (!Number.isFinite(y)) return { y: null, text: line.trim() }
  return { y: Math.min(1, Math.max(0, y)), text: match[2].trim() }
}

const inkAnchorForQuery = (transcript, query) => {
  const needle = String(query || '').trim().toLocaleLowerCase('de-DE')
  if (needle.length < 2 || !String(transcript || '').trim()) return null
  const lines = String(transcript).split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return null
  const parsed = lines.map(parseTranscriptLine)
  const index = parsed.findIndex((line) => germanIndexOf(line.text.toLocaleLowerCase('de-DE'), needle) >= 0)
  if (index < 0) return null
  if (parsed[index].y !== null) return { y: parsed[index].y }
  if (parsed.length === 1) return { y: 0.15 }
  return { y: index / (parsed.length - 1) }
}

const TRANSCRIPT_POSITION = /^[ \t]*\d+(?:\.\d+)?\t/gmu

const readableTranscript = (transcript) => String(transcript || '').replace(TRANSCRIPT_POSITION, '')

const noteSearchExcerpt = ({ relativePath, content, transcript, needle, queryLength, excerpt }) => {
  const contentIndex = germanIndexOf(String(content || '').toLocaleLowerCase('de-DE'), needle)
  if (contentIndex >= 0) return excerpt(content, contentIndex, queryLength)
  const readable = readableTranscript(transcript)
  const readableIndex = germanIndexOf(readable.toLocaleLowerCase('de-DE'), needle)
  if (readableIndex >= 0) return excerpt(readable, readableIndex, queryLength)
  return `Dateiname · ${relativePath}`
}

/** Internal markers (`<!-- fanotes-ink:id -->`, famd header, onenote, worksheet ...) are not note text. */
const INTERNAL_COMMENT = /<!--\s*fanotes-[\s\S]*?-->/giu
const stripInternalComments = (text) => String(text || '').replace(INTERNAL_COMMENT, '')

/** A window of text around a match; internal markers are cut out on both sides so the index stays valid. */
function createExcerpt(rawText, rawIndex, queryLength) {
  const before = stripInternalComments(rawText.slice(0, rawIndex))
  const text = `${before}${rawText.slice(rawIndex, rawIndex + queryLength)}${stripInternalComments(rawText.slice(rawIndex + queryLength))}`
  const matchIndex = before.length
  const start = Math.max(0, matchIndex - 95)
  const end = Math.min(text.length, matchIndex + queryLength + 145)
  const excerpt = text.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`
}

module.exports = { inkAnchorForQuery, noteSearchExcerpt, readableTranscript, stripInternalComments, createExcerpt }
