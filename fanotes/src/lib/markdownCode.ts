const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/u

const maskInlineCode = (chars: string[]) => {
  let index = 0
  while (index < chars.length) {
    if (chars[index] !== '`') {
      index += 1
      continue
    }
    let length = 0
    while (chars[index + length] === '`') length += 1
    let cursor = index + length
    let closed = -1
    while (cursor < chars.length) {
      if (chars[cursor] !== '`') {
        cursor += 1
        continue
      }
      let run = 0
      while (chars[cursor + run] === '`') run += 1
      if (run === length) {
        closed = cursor
        break
      }
      cursor += run
    }
    if (closed < 0) {
      index += length
      continue
    }
    for (let slot = index; slot < closed + length; slot += 1) chars[slot] = ' '
    index = closed + length
  }
  return chars.join('')
}

/**
 * Spaces stand in for fenced and inline code. The result has the same length,
 * so a match index still points at the same place in the original note.
 */
export const maskMarkdownCode = (markdown: string) => {
  const source = String(markdown ?? '')
  const chars = source.split('')
  const lines = source.split('\n')
  let offset = 0
  let fenceMarker = ''
  let fenceLength = 0
  for (const rawLine of lines) {
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
      } else if (fenceMarker) {
        hide = true
      }
    } else if (fenceMarker) {
      hide = true
    }
    if (hide) {
      for (let slot = 0; slot < rawLine.length; slot += 1) chars[offset + slot] = ' '
    }
    offset += rawLine.length + 1
  }
  return maskInlineCode(chars)
}
