/**
 * Everyday note actions that stay free of the DOM and the vault: a unique
 * duplicate name, a wiki link, a date stamp, recent notes, and folder folding.
 */

const NOTE_EXTENSION = /\.(md|markdown|famd|pdf)$/iu
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu
const INK_MARKER = /(?:\r?\n)*<!--\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\s*-->\s*/gu

export const noteTitleFromPath = (relativePath: string) => {
  const name = relativePath.split('/').filter(Boolean).pop() ?? relativePath
  return name.replace(NOTE_EXTENSION, '')
}

/** `[[Title]]` for the note. Brackets and pipes in the title would break the link. */
export const wikiLinkForNote = (relativePath: string) => {
  const title = noteTitleFromPath(relativePath).replace(/[\[\]|]/g, ' ').replace(/\s+/g, ' ').trim()
  return `[[${title || 'Notiz'}]]`
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The name createNote should be asked for. A second duplicate of "Mechanik Kopie"
 * still asks for "Mechanik Kopie"; the vault adds the number. `copyWord` follows
 * the interface language, and an older German or English suffix is peeled off too.
 */
export const duplicatePreferredStem = (fileName: string, copyWord = 'Kopie') => {
  const suffix = copyWord.trim() || 'Kopie'
  const words = [...new Set([suffix, 'Kopie', 'Copy'])]
  let base = fileName.replace(NOTE_EXTENSION, '').trim()
  let changed = true
  while (changed && base) {
    changed = false
    for (const word of words) {
      const next = base.replace(new RegExp(` ${escapeRegExp(word)}(?: \\d+)?$`, 'u'), '').trim()
      if (next && next !== base) {
        base = next
        changed = true
      }
    }
  }
  return `${base || 'Notiz'} ${suffix}`
}

export const formatNoteStamp = (pattern: string, date: Date, withTime = false) => {
  const datePart = (pattern || 'YYYY-MM-DD')
    .replaceAll('YYYY', String(date.getFullYear()))
    .replaceAll('YY', String(date.getFullYear()).slice(-2))
    .replaceAll('MM', String(date.getMonth() + 1).padStart(2, '0'))
    .replaceAll('DD', String(date.getDate()).padStart(2, '0'))
  if (!withTime) return datePart
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${datePart} ${hours}:${minutes}`
}

type DateToken = 'Y' | 'y' | 'M' | 'D'

const datePatternCache = new Map<string, { expression: RegExp; order: DateToken[] } | null>()

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

const vaultFolder = (folder: string) => folder.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')

/** Stem of a daily note that lives in the daily-notes folder and matches the date format. */
export const dailyNoteStem = (relativePath: string, folder: string, pattern: string) => {
  const normalized = String(relativePath ?? '').replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (!/\.md$/iu.test(normalized)) return null
  const parent = normalized.split('/').slice(0, -1).join('/')
  if (parent !== vaultFolder(folder)) return null
  const stem = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.md$/iu, '')
  return parseNoteDate(stem, pattern) ? stem : null
}

/** The calendar day `days` away from the open daily note, or null when this file is not one. */
export const shiftDailyNote = (relativePath: string, folder: string, pattern: string, days: number): Date | null => {
  const stem = dailyNoteStem(relativePath, folder, pattern)
  if (!stem || !Number.isFinite(days)) return null
  const parsed = parseNoteDate(stem, pattern)
  if (!parsed) return null
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + Math.trunc(days), 12, 0, 0, 0)
}

/** A stamp typed against a word gets one separating space. A line start stays flush. */
export const stampToInsert = (textBeforeCursor: string, stamp: string) => {
  if (!stamp) return ''
  if (!textBeforeCursor || /[\s\n]$/u.test(textBeforeCursor)) return stamp
  return ` ${stamp}`
}

/** Newest existing visits first, each path once. The open note can be left out. */
export const recentNotePaths = (
  history: readonly string[],
  exists: (path: string) => boolean,
  limit = 5,
  skip: string | null = null,
) => {
  const seen = new Set<string>()
  const result: string[] = []
  for (let index = history.length - 1; index >= 0 && result.length < limit; index -= 1) {
    const path = history[index]
    if (!path || path === skip || seen.has(path) || !exists(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}

export type FolderNode = {
  kind?: string
  relativePath?: string
  children?: FolderNode[]
}

export const folderPathsIn = (entries: readonly FolderNode[] | null | undefined): string[] => {
  const paths: string[] = []
  const visit = (items: readonly FolderNode[] | undefined) => {
    if (!items) return
    for (const entry of items) {
      if (entry.kind !== 'folder' || !entry.relativePath) continue
      paths.push(entry.relativePath)
      visit(entry.children)
    }
  }
  visit(entries ?? undefined)
  return paths
}

/** One click folds every open folder, or opens every folder when all are shut. */
export const nextExpandedFolders = (current: ReadonlySet<string>, folders: readonly string[]) => {
  const anyOpen = folders.some((path) => current.has(path))
  return anyOpen ? new Set<string>() : new Set(folders)
}

export const worksheetIdsIn = (markdown: string) => (
  [...markdown.matchAll(WORKSHEET_MARKER)].map((match) => match[1])
)

export const retargetWorksheetMarkers = (markdown: string, idMap: ReadonlyMap<string, string>) => (
  markdown.replace(WORKSHEET_MARKER, (full, id: string) => {
    const next = idMap.get(id)
    return next ? `<!-- fanotes-worksheet:${next} -->` : full
  })
)

export const withoutWorksheetMarker = (markdown: string, id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(id)) return markdown
  return markdown
    .replace(new RegExp(`(?:\\r?\\n)*<!--\\s*fanotes-worksheet:${id}\\s*-->\\s*`, 'gu'), '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+/u, '')
}

/** Drop the ink marker so the copy cannot keep writing into the original drawing. */
export const withoutInkMarker = (markdown: string) => (
  markdown
    .replace(INK_MARKER, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+/u, '')
)

export const withInkMarker = (markdown: string, id: string) => {
  if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(id)) return markdown
  const stripped = withoutInkMarker(markdown)
  const separator = stripped && !stripped.endsWith('\n') ? '\n\n' : stripped ? '\n' : ''
  return `${stripped}${separator}<!-- fanotes-ink:${id} -->\n`
}

export const drawingTitleFromJson = (drawingJson: string, fallback: string) => {
  try {
    const parsed = JSON.parse(drawingJson) as { title?: unknown }
    if (typeof parsed.title === 'string') {
      const title = parsed.title.trim()
      if (title && title.length <= 180 && !/[\0-\x1f\x7f]/u.test(title)) return title
    }
  } catch {
    // The vault still validates the drawing. A bad title only changes the label.
  }
  const safeFallback = fallback.trim()
  return safeFallback || 'Handschrift'
}

export type WorksheetCloneSource = {
  title: string
  textBoxes: unknown
  highlights?: unknown
  pageWidth?: number
  pageHeight?: number
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The new worksheet keeps the original answers and points at its own file. */
export const clonedWorksheetDocument = <T extends WorksheetCloneSource & { id: string }>(
  created: T,
  original: WorksheetCloneSource,
): T => ({
  ...created,
  title: original.title,
  textBoxes: cloneJson(original.textBoxes),
  highlights: cloneJson(original.highlights ?? []),
  ...(Number.isFinite(original.pageWidth) && Number.isFinite(original.pageHeight)
    ? { pageWidth: original.pageWidth, pageHeight: original.pageHeight }
    : {}),
}) as T
