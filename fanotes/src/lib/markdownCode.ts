const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/u

/** Replaces inline code spans (also across lines) with spaces. Works on string slices, not on a char array. */
const maskInlineCode = (source: string) => {
  let index = source.indexOf('`')
  if (index < 0) return source
  const parts: string[] = []
  let copied = 0
  while (index >= 0 && index < source.length) {
    let length = 0
    while (source.charCodeAt(index + length) === 96) length += 1
    let cursor = index + length
    let closed = -1
    while (cursor < source.length) {
      const next = source.indexOf('`', cursor)
      if (next < 0) break
      let run = 0
      while (source.charCodeAt(next + run) === 96) run += 1
      if (run === length) {
        closed = next
        break
      }
      cursor = next + run
    }
    if (closed < 0) {
      index = source.indexOf('`', index + length)
      continue
    }
    parts.push(source.slice(copied, index), ' '.repeat(closed + length - index))
    copied = closed + length
    index = source.indexOf('`', copied)
  }
  if (!copied) return source
  parts.push(source.slice(copied))
  return parts.join('')
}

/** Fenced code: every line from the opening to the closing fence becomes spaces (newlines stay). */
const maskFences = (source: string) => {
  if (!source.includes('```') && !source.includes('~~~')) return source
  const parts: string[] = []
  let copied = 0
  let offset = 0
  let fenceMarker = ''
  let fenceLength = 0
  while (offset <= source.length) {
    let end = source.indexOf('\n', offset)
    if (end < 0) end = source.length
    const rawLine = source.slice(offset, end)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const fence = FENCE_RE.exec(line)
    let hide = false
    if (fence) {
      const token = fence[1] ?? ''
      const marker = token[0] ?? ''
      const rest = fence[2] ?? ''
      if (!fenceMarker) {
        if (marker !== '`' || !rest.includes('`')) {
          fenceMarker = marker
          fenceLength = token.length
          hide = true
        }
      } else if (marker === fenceMarker && token.length >= fenceLength && rest.trim() === '') {
        fenceMarker = ''
        fenceLength = 0
        hide = true
      } else {
        hide = true
      }
    } else if (fenceMarker) {
      hide = true
    }
    if (hide && rawLine.length) {
      parts.push(source.slice(copied, offset), ' '.repeat(rawLine.length))
      copied = end
    }
    offset = end + 1
  }
  if (!copied) return source
  parts.push(source.slice(copied))
  return parts.join('')
}

/**
 * Spaces stand in for fenced and inline code. The result has the same length,
 * so a match index still points at the same place in the original note.
 */
export const maskMarkdownCode = (markdown: string) => {
  const source = String(markdown ?? '')
  if (!source.includes('`') && !source.includes('~~~')) return source
  return maskInlineCode(maskFences(source))
}
