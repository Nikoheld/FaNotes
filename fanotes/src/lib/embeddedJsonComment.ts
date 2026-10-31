/**
 * HTML-comment blocks that store JSON (`<!-- fanotes-…` … `-->`).
 * User text inside the JSON may itself contain `-->`. The closer is the one
 * after the JSON object, not the first three characters.
 */
export type EmbeddedJsonComment = {
  start: number
  jsonStart: number
  jsonEnd: number
  end: number
}

export const locateEmbeddedJsonComment = (source: string, startMarker: string): EmbeddedJsonComment | null => {
  if (typeof source !== 'string' || !source || !startMarker) return null
  const start = source.indexOf(startMarker)
  if (start < 0) return null
  let index = start + startMarker.length
  while (index < source.length && /\s/u.test(source[index])) index += 1
  if (source[index] !== '{') return null
  const jsonStart = index
  let depth = 0
  let inString = false
  let escape = false
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (char === '\\') {
        escape = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const jsonEnd = index + 1
        let closer = jsonEnd
        while (closer < source.length && /\s/u.test(source[closer])) closer += 1
        if (!source.startsWith('-->', closer)) return null
        return { start, jsonStart, jsonEnd, end: closer + 3 }
      }
    }
  }
  return null
}
