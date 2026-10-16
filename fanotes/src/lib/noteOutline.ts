import { parseNoteTags } from './noteTags'

export type NoteOutlineHeading = {
  level: number
  title: string
  line: number
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u

/** Headings outside fenced code. A closing `#` sequence needs a space before it, so `C#` stays. */
export const parseNoteOutline = (content: string): NoteOutlineHeading[] => {
  const lines = String(content ?? '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n')
  const headings: NoteOutlineHeading[] = []
  let fenceMarker = ''
  let fenceLength = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const token = fence[1] ?? ''
      const marker = token[0] ?? ''
      const rest = fence[2] ?? ''
      if (!fenceMarker) {
        if (marker !== '`' || !rest.includes('`')) {
          fenceMarker = marker
          fenceLength = token.length
        }
      } else if (marker === fenceMarker && token.length >= fenceLength && rest.trim() === '') {
        fenceMarker = ''
        fenceLength = 0
      }
      continue
    }
    if (fenceMarker) continue
    const match = HEADING_RE.exec(line)
    if (!match) continue
    headings.push({ level: match[1].length, title: match[2], line: index + 1 })
  }
  return headings
}

export const outlineTagsFromNote = (content: string): string[] => parseNoteTags(content)

export const revealDocumentLine = (
  doc: { lines: number; line: (number: number) => { from: number } },
  line: number,
): { line: number; from: number } | null => {
  if (!doc || !Number.isSafeInteger(doc.lines) || doc.lines < 1) return null
  if (!Number.isFinite(line)) return null
  const clamped = Math.min(Math.max(1, Math.trunc(line)), doc.lines)
  return { line: clamped, from: doc.line(clamped).from }
}
