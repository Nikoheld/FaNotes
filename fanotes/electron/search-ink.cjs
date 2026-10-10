'use strict'

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
  const index = parsed.findIndex((line) => line.text.toLocaleLowerCase('de-DE').includes(needle))
  if (index < 0) return null
  if (parsed[index].y !== null) return { y: parsed[index].y }
  if (parsed.length === 1) return { y: 0.15 }
  return { y: index / (parsed.length - 1) }
}

module.exports = { inkAnchorForQuery }
