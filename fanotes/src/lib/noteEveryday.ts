import { newNoteLinkId, type NoteLinkRecord } from './noteLink'

const COPY_SUFFIX = / (?:Kopie|Copy)(?: (\d+))?$/u
const TASK_LINE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\](.*)$/u
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u
const STRUCTURAL_LINE = /^\s*(?:#{1,6}(?:\s|$)|>(?:\s|$)|[|]|```|~~~|-{3,}\s*$|_{3,}\s*$|\*{3,}\s*$)/u
const FENCE_LINE = /^\s*(?:```|~~~)/u
const INK_MARKER = /<!--\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\s*-->\s*/gu
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:[a-zA-Z0-9_-]{1,96}\s*-->/u
const WORKSHEET_MARKER_GLOBAL = /<!--\s*fanotes-worksheet:[a-zA-Z0-9_-]{1,96}\s*-->\s*/gu
const INK_ID = /^[a-zA-Z0-9_-]{1,96}$/u

export const noteStemFromPath = (relativePath: string) => {
  const base = String(relativePath || '').replace(/\\/gu, '/').split('/').filter(Boolean).pop() || 'Notiz'
  return base.replace(/\.(md|markdown|famd|pdf)$/iu, '') || 'Notiz'
}

export const parentFolderOf = (relativePath: string) => {
  const parts = String(relativePath || '').replace(/\\/gu, '/').split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

export const canDuplicateNote = (relativePath: string) => /\.(md|markdown)$/iu.test(relativePath)

/** Wiki link resolved by title, the form backlinks already understand. */
export const wikiLinkForPath = (relativePath: string) => `[[${noteStemFromPath(relativePath)}]]`

/**
 * Next file stem beside the original. "Mechanik" becomes "Mechanik Kopie",
 * then "Mechanik Kopie 2". An existing copy keeps the same base, so duplicating
 * "Mechanik Kopie" yields "Mechanik Kopie 2" rather than "Mechanik Kopie Kopie".
 */
export const duplicateStem = (stem: string, takenLower: ReadonlySet<string>, copyWord = 'Kopie') => {
  const word = copyWord.trim() || 'Kopie'
  const base = stem.replace(COPY_SUFFIX, '').trim() || stem.trim() || 'Notiz'
  const first = `${base} ${word}`
  if (!takenLower.has(first.toLocaleLowerCase('de-DE'))) return first
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${base} ${word} ${index}`
    if (!takenLower.has(candidate.toLocaleLowerCase('de-DE'))) return candidate
  }
  return `${base} ${word} ${Date.now()}`
}

export const takenStemsInFolder = (paths: Iterable<string>, parent: string) => {
  const taken = new Set<string>()
  for (const raw of paths) {
    const path = String(raw || '').replace(/\\/gu, '/').replace(/^\/+/u, '')
    if (parentFolderOf(path) !== parent) continue
    taken.add(noteStemFromPath(path).toLocaleLowerCase('de-DE'))
  }
  return taken
}

/** The date pattern already used for daily notes. YYYY is replaced before YY. */
export const formatNoteDate = (pattern: string, date = new Date()) => (pattern || 'YYYY-MM-DD')
  .replaceAll('YYYY', String(date.getFullYear()))
  .replaceAll('YY', String(date.getFullYear()).slice(-2))
  .replaceAll('MM', String(date.getMonth() + 1).padStart(2, '0'))
  .replaceAll('DD', String(date.getDate()).padStart(2, '0'))

export const formatNoteTime = (date = new Date()) => (
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
)

/**
 * Toggle a task, or turn a normal line into one. Headings, quotes, tables,
 * rules and fences stay as they are so a shortcut in those lines does nothing.
 */
export const toggleTaskLine = (line: string) => {
  const task = TASK_LINE.exec(line)
  if (task) {
    const mark = task[3] === ' ' ? 'x' : ' '
    return `${task[1]}${task[2]} [${mark}]${task[4]}`
  }
  if (STRUCTURAL_LINE.test(line)) return line
  const list = LIST_LINE.exec(line)
  if (list) return `${list[1]}${list[2]} [ ] ${list[3]}`
  if (!line.trim()) return `${line.match(/^\s*/u)?.[0] ?? ''}- [ ] `
  const indent = line.match(/^\s*/u)?.[0] ?? ''
  return `${indent}- [ ] ${line.slice(indent.length)}`
}

export const isFenceLine = (line: string) => FENCE_LINE.test(line)

export const fenceIsOpen = (linesBefore: readonly string[]) => {
  let open = false
  for (const line of linesBefore) if (isFenceLine(line)) open = !open
  return open
}

/** Replace the first heading whose text is exactly the old title. */
export const retitleMatchingHeading = (markdown: string, fromStem: string, toStem: string) => {
  if (!fromStem || fromStem === toStem) return markdown
  const escaped = fromStem.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const heading = new RegExp(`^(#{1,6}\\s+)${escaped}\\s*$`, 'u')
  const lines = markdown.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!heading.test(lines[index])) continue
    lines[index] = lines[index].replace(heading, `$1${toStem}`)
    break
  }
  return lines.join('\n')
}

/**
 * Text for the copy. Handwriting is retargeted at a new ink id so the two
 * notes do not share one drawing. Worksheet markers are removed: those files
 * belong to the original, and sharing the id would edit both notes at once.
 */
export const markdownForDuplicate = (markdown: string, inkId: string | null) => {
  const droppedWorksheets = WORKSHEET_MARKER.test(markdown)
  let body = markdown.replace(WORKSHEET_MARKER_GLOBAL, '').replace(INK_MARKER, '')
  body = body.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').replace(/^\n+/u, '')
  if (inkId && INK_ID.test(inkId)) {
    const separator = body.length === 0 ? '' : body.endsWith('\n') ? '\n' : '\n\n'
    body = `${body}${separator}<!-- fanotes-ink:${inkId} -->\n`
  }
  if (body && !body.endsWith('\n')) body += '\n'
  return { markdown: body, droppedWorksheets }
}

/** Placed links on the copy point at the new note and get fresh ids. */
export const remapDuplicateLinks = (
  links: readonly NoteLinkRecord[],
  fromPath: string,
  toPath: string,
  newId: () => string = newNoteLinkId,
): NoteLinkRecord[] => {
  const seen = new Set<string>()
  const next: NoteLinkRecord[] = []
  for (const link of links) {
    if (link.sourcePath && link.sourcePath !== fromPath) continue
    const targetPath = link.targetPath === fromPath ? toPath : link.targetPath
    if (!targetPath || targetPath === toPath || !/\.md$/iu.test(targetPath)) continue
    let id = newId()
    while (!id || seen.has(id)) id = newId()
    seen.add(id)
    next.push({ ...link, id, sourcePath: toPath, targetPath })
  }
  return next
}
