/**
 * Everyday note actions that stay pure: wiki links, task checkboxes, date
 * stamps, neighbouring daily notes, and a safe text/ink duplicate.
 * Nothing here touches the editor or the vault.
 */

const INK_OR_WORKSHEET_LINE = /^[ \t]*<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->[ \t]*$/gmu
const INK_OR_WORKSHEET_MARKER = /<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->/gu
const TASK_LINE = /^(\s*)([-*+]|\d+[.)])[ \t]+\[([ xX])\](.*)$/u
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/u
const HEADING_LINE = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/u

type DateToken = 'Y' | 'y' | 'M' | 'D'

const datePatternCache = new Map<string, { expression: RegExp; order: DateToken[] } | null>()

const cleanWikiPart = (value: string) => value.replace(/[\[\]|#]/gu, '').replace(/\s+/gu, ' ').trim()

export const normalizeVaultFolder = (value: string) => (
  String(value ?? '').replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '').replace(/\/{2,}/gu, '/')
)

export const noteTitleFromPath = (relativePath: string) => {
  const base = String(relativePath ?? '').replace(/\\/gu, '/').split('/').pop() ?? ''
  const stem = base.replace(/\.(md|markdown|famd|pdf)$/iu, '')
  return cleanWikiPart(stem) || 'Notiz'
}

/** `[[Mechanik]]` — the same title form backlinks already resolve. */
export const wikiLinkForPath = (relativePath: string) => `[[${noteTitleFromPath(relativePath)}]]`

export const wikiLinkForHeading = (relativePath: string, heading: string) => {
  const title = cleanWikiPart(heading)
  if (!title) return wikiLinkForPath(relativePath)
  return `[[${noteTitleFromPath(relativePath)}#${title}]]`
}

export const headingTitleOnLine = (line: string) => HEADING_LINE.exec(line)?.[2]?.trim() ?? ''

/** Heading on this line, or the nearest heading above it. Empty when the note has none. */
export const nearestHeadingTitle = (markdown: string, lineNumber: number) => {
  const lines = String(markdown ?? '').split('\n')
  if (!lines.length) return ''
  const start = Math.min(Math.max(1, Math.trunc(lineNumber) || 1), lines.length) - 1
  for (let index = start; index >= 0; index -= 1) {
    const title = headingTitleOnLine(lines[index] ?? '')
    if (title) return title
  }
  return ''
}

/**
 * Flip a task, or turn the line into one.
 * `- [ ]` becomes `- [x]`, a list item gains a box, plain text becomes `- [ ]`.
 */
export const toggleTaskLine = (line: string) => {
  const task = TASK_LINE.exec(line)
  if (task) {
    const mark = /x/iu.test(task[3]) ? ' ' : 'x'
    return `${task[1]}${task[2]} [${mark}]${task[4]}`
  }
  const list = LIST_LINE.exec(line)
  if (list) {
    const body = list[3].trimStart()
    return `${list[1]}${list[2]} [ ] ${body}`.trimEnd() + (body ? '' : ' ')
  }
  const indent = /^\s*/u.exec(line)?.[0] ?? ''
  const body = line.slice(indent.length)
  if (!body.trim()) return `${indent}- [ ] `
  return `${indent}- [ ] ${body}`
}

export const formatNoteDate = (pattern: string, date: Date) => {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return (pattern || 'YYYY-MM-DD')
    .replaceAll('YYYY', year)
    .replaceAll('YY', year.slice(-2))
    .replaceAll('MM', month)
    .replaceAll('DD', day)
}

export const formatNoteStamp = (pattern: string, date: Date, withTime: boolean) => {
  const day = formatNoteDate(pattern, date)
  if (!withTime) return day
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day} ${hours}:${minutes}`
}

const yearFromTwoDigits = (yy: number, referenceYear: number) => {
  const pivot = (referenceYear % 100) + 10
  return yy <= pivot ? 2000 + yy : 1900 + yy
}

const compileDatePattern = (pattern: string) => {
  const cached = datePatternCache.get(pattern)
  if (cached !== undefined) return cached
  const order: DateToken[] = []
  let source = '^'
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith('YYYY', index)) { source += '(\\d{4})'; order.push('Y'); index += 4; continue }
    if (pattern.startsWith('YY', index)) { source += '(\\d{2})'; order.push('y'); index += 2; continue }
    if (pattern.startsWith('MM', index)) { source += '(\\d{2})'; order.push('M'); index += 2; continue }
    if (pattern.startsWith('DD', index)) { source += '(\\d{2})'; order.push('D'); index += 2; continue }
    const char = pattern[index] ?? ''
    source += /[.*+?^${}()|[\]\\]/u.test(char) ? `\\${char}` : char
    index += 1
  }
  const compiled = order.includes('M') && order.includes('D') && (order.includes('Y') || order.includes('y'))
    ? { expression: new RegExp(`${source}$`, 'u'), order }
    : null
  datePatternCache.set(pattern, compiled)
  return compiled
}

/** Local noon, so a daylight-saving midnight cannot move the calendar day. */
export const parseNoteDate = (title: string, pattern: string, referenceYear = new Date().getFullYear()): Date | null => {
  const compiled = compileDatePattern(pattern || 'YYYY-MM-DD')
  if (!compiled) return null
  const match = compiled.expression.exec(title.trim())
  if (!match) return null
  let year = 0
  let month = 0
  let day = 0
  compiled.order.forEach((token, index) => {
    const value = Number(match[index + 1])
    if (token === 'Y') year = value
    else if (token === 'y') year = yearFromTwoDigits(value, referenceYear)
    else if (token === 'M') month = value
    else day = value
  })
  if (month < 1 || month > 12 || day < 1 || day > 31 || !Number.isInteger(year)) return null
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

/** Stem of a daily note that lives in the daily-notes folder and matches the date format. */
export const dailyNoteStem = (relativePath: string, folder: string, pattern: string) => {
  const normalized = String(relativePath ?? '').replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (!/\.md$/iu.test(normalized)) return null
  const parent = normalized.split('/').slice(0, -1).join('/')
  if (parent !== normalizeVaultFolder(folder)) return null
  const stem = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.md$/iu, '')
  return parseNoteDate(stem, pattern) ? stem : null
}

export const shiftDailyNote = (relativePath: string, folder: string, pattern: string, days: number): Date | null => {
  const stem = dailyNoteStem(relativePath, folder, pattern)
  if (!stem || !Number.isFinite(days)) return null
  const parsed = parseNoteDate(stem, pattern)
  if (!parsed) return null
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + Math.trunc(days), 12, 0, 0, 0)
}

/** Drop ink and worksheet markers so the copy does not share their files. */
export const markdownForDuplicate = (markdown: string) => {
  const withoutOwnLines = String(markdown ?? '').replace(INK_OR_WORKSHEET_LINE, '')
  const withoutMarkers = withoutOwnLines.replace(INK_OR_WORKSHEET_MARKER, '')
  const collapsed = withoutMarkers.replace(/\n{3,}/gu, '\n\n').trim()
  return collapsed ? `${collapsed}\n` : ''
}

export const duplicatePreferredName = (relativePath: string, copyWord = 'Kopie') => {
  const word = copyWord.trim() || 'Kopie'
  return `${noteTitleFromPath(relativePath)} ${word}`
}

export type InkDuplicate = { title: string; drawingJson: string }

/** A new drawing document. Empty pages and foreign schemas are not copied. */
export const inkDuplicatePayload = (drawingJson: string, updatedAt = new Date().toISOString()): InkDuplicate | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(drawingJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const document = parsed as Record<string, unknown>
  if (document.schemaVersion !== 1) return null
  if (typeof document.title !== 'string' || !document.title.trim() || document.title.length > 180) return null
  if (!Array.isArray(document.strokes) || document.strokes.length === 0) return null
  const next: Record<string, unknown> = { ...document, updatedAt }
  delete next.id
  return { title: document.title, drawingJson: JSON.stringify(next) }
}

export const newDuplicateInkId = () => {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `ink${Date.now().toString(36)}`
  const cleaned = uuid.replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 96)
  return cleaned || 'ink'
}
