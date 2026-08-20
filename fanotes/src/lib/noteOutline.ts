import { parseNoteTags } from './noteTags'

export type NoteOutlineHeading = {
  level: number
  title: string
  line: number
}

export const parseNoteOutline = (content: string): NoteOutlineHeading[] => (
  String(content ?? '').split('\n').flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line)
    return match ? [{ level: match[1].length, title: match[2], line: index + 1 }] : []
  })
)

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
