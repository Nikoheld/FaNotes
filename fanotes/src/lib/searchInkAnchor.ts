/** Locate a vault-search hit inside an invisible handwriting transcript. */

export type InkSearchAnchor = {
  /** 0 at the top of the page, 1 at the bottom. */
  y: number
}

const POSITIONED_LINE = /^(\d+(?:\.\d+)?)\t(.*)$/u

export const formatTranscriptLine = (y: number, text: string) => {
  const clamped = Math.min(1, Math.max(0, y))
  const body = text.replace(/\s+/gu, ' ').trim()
  return `${clamped.toFixed(4)}\t${body}`
}

export const parseTranscriptLine = (line: string): { y: number | null; text: string } => {
  const match = POSITIONED_LINE.exec(line.trim())
  if (!match) return { y: null, text: line.trim() }
  const y = Number(match[1])
  if (!Number.isFinite(y)) return { y: null, text: line.trim() }
  return { y: Math.min(1, Math.max(0, y)), text: match[2].trim() }
}

/** The page position of the first transcript line that contains `query`. */
export const inkAnchorForQuery = (transcript: string, query: string): InkSearchAnchor | null => {
  const needle = query.trim().toLocaleLowerCase('de-DE')
  if (needle.length < 2 || !transcript.trim()) return null
  const lines = transcript.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return null
  const parsed = lines.map(parseTranscriptLine)
  const index = parsed.findIndex((line) => line.text.toLocaleLowerCase('de-DE').includes(needle))
  if (index < 0) return null
  const positioned = parsed[index].y
  if (positioned !== null) return { y: positioned }
  if (parsed.length === 1) return { y: 0.15 }
  return { y: index / (parsed.length - 1) }
}

export const scrollTopForNormalizedY = (scrollHeight: number, clientHeight: number, y: number) => {
  const span = Math.max(0, scrollHeight - clientHeight)
  const clamped = Math.min(1, Math.max(0, y))
  return Math.round(Math.min(span, Math.max(0, clamped * scrollHeight - clientHeight / 2)))
}
