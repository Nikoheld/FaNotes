/**
 * Everyday note actions: a safe duplicate name, a wiki link, the date stamp
 * from the user's format, and turning the current line into a task.
 * Pure functions so the checks can exercise every rule without the editor.
 */

const COPY_SUFFIX = / (?:Kopie|Copy)(?: \d+)?$/u
const NOTE_EXTENSION = /\.(md|markdown|famd|pdf)$/iu
const INK_MARKER = /[ \t]*<!--\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\s*-->[ \t]*\n?/gu
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:[a-zA-Z0-9_-]{1,96}\s*-->/u
const WORKSHEET_MARKER_GLOBAL = /[ \t]*<!--\s*fanotes-worksheet:[a-zA-Z0-9_-]{1,96}\s*-->[ \t]*\n?/gu
const CODE_FENCE = /^\s*(```+|~~~+)/u
const MATH_FENCE = /^\s*\$\$\s*$/u
const TABLE_ROW = /^\s*\|/u
const RULE = /^\s*([-*_])\1{2,}\s*$/u
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u
const QUOTE = /^(\s*>\s?)(.*)$/u
const TASK = /^(\s*)([-+*]|\d+[.)])(\s+)\[([ xX])\](.*)$/u
const LIST = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/u

const pad = (value: number) => String(value).padStart(2, '0')

export const isMarkdownNotePath = (path: string) => /\.(md|markdown)$/iu.test(path)

/** "Mechanik.md" → "Mechanik Kopie". An existing "Kopie" / "Copy" suffix is not nested. */
export const duplicateNoteStem = (fileName: string, copyWord = 'Kopie') => {
  const stem = fileName.replace(NOTE_EXTENSION, '').replace(COPY_SUFFIX, '').trim()
  const word = copyWord.trim() || 'Kopie'
  return `${stem} ${word}`.replace(/[ \t]+/gu, ' ').trim()
}

/**
 * Markdown for the copy. The ink marker is removed so the copy does not share
 * the original drawing id; the caller attaches a new drawing afterwards.
 * Worksheet markers are removed too: those files are shared by id, and a
 * duplicate must not write into the original sheet.
 */
export const prepareDuplicateMarkdown = (source: string) => {
  const hadWorksheet = WORKSHEET_MARKER.test(source)
  const markdown = source.replace(INK_MARKER, '').replace(WORKSHEET_MARKER_GLOBAL, '')
  return { markdown, hadWorksheet }
}

export const wikiLinkForPath = (path: string) => {
  const name = path.split('/').pop() ?? path
  const stem = name.replace(NOTE_EXTENSION, '').replace(/[\]|#^]/gu, '').trim()
  return `[[${stem || name}]]`
}

/** The settings date pattern. HH, mm and ss are available in addition to YYYY, YY, MM and DD. */
export const formatDatePattern = (pattern: string, date: Date) => (
  (pattern || 'YYYY-MM-DD')
    .replaceAll('YYYY', String(date.getFullYear()))
    .replaceAll('YY', String(date.getFullYear()).slice(-2))
    .replaceAll('MM', pad(date.getMonth() + 1))
    .replaceAll('DD', pad(date.getDate()))
    .replaceAll('HH', pad(date.getHours()))
    .replaceAll('mm', pad(date.getMinutes()))
    .replaceAll('ss', pad(date.getSeconds()))
)

export const formatClock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`

export const drawingTitleFromJson = (drawingJson: string) => {
  try {
    const parsed = JSON.parse(drawingJson) as { title?: unknown }
    if (typeof parsed.title === 'string' && parsed.title.trim() && parsed.title.length <= 180) return parsed.title
  } catch {
    return null
  }
  return null
}

export const retargetCopiedLinks = <T extends { id: string; sourcePath: string; targetPath: string }>(
  links: readonly T[],
  sourcePath: string,
  newId: (index: number) => string,
): T[] => links
  .filter((link) => link.targetPath !== sourcePath)
  .map((link, index) => ({ ...link, id: newId(index), sourcePath }))

export const isStructuralLine = (line: string) => (
  CODE_FENCE.test(line) || MATH_FENCE.test(line) || TABLE_ROW.test(line) || RULE.test(line) || HEADING.test(line)
)

/** True when a line sits inside a fenced code block or a $$ math block. */
export const lineInsideFence = (lines: readonly string[], index: number) => {
  let code = false
  let math = false
  const last = Math.min(index, lines.length)
  for (let i = 0; i < last; i += 1) {
    const line = lines[i]
    if (!math && CODE_FENCE.test(line)) code = !code
    else if (!code && MATH_FENCE.test(line)) math = !math
  }
  return code || math
}

/** A heading stays a heading. Ctrl+Enter inserts the task on the following line. */
export const taskAfterHeading = (line: string) => (HEADING.test(line) ? '- [ ] ' : null)

export const toggleTaskLine = (line: string): string => {
  const quote = QUOTE.exec(line)
  if (quote) {
    const inner = toggleTaskLine(quote[2])
    return inner === quote[2] ? line : `${quote[1]}${inner}`
  }
  if (isStructuralLine(line)) return line
  const task = TASK.exec(line)
  if (task) {
    const mark = task[4].toLowerCase() === 'x' ? ' ' : 'x'
    return `${task[1]}${task[2]}${task[3]}[${mark}]${task[5]}`
  }
  const list = LIST.exec(line)
  if (list) return `${list[1]}${list[2]}${list[3]}[ ] ${list[4]}`
  if (!line.trim()) return '- [ ] '
  return `- [ ] ${line}`
}

export type TaskLineChange = { line: number; insert: string }

/**
 * Replacements for the inclusive 1-based line range. Lines inside fences and
 * lines that would not change are omitted. A lone heading asks for a new
 * task line after itself (`insert` starts with a newline).
 */
export const taskToggleChanges = (
  lines: readonly string[],
  fromLine: number,
  toLine: number,
): TaskLineChange[] => {
  const start = Math.max(1, fromLine)
  const end = Math.min(lines.length, Math.max(start, toLine))
  if (start === end) {
    const heading = taskAfterHeading(lines[start - 1] ?? '')
    if (heading && !lineInsideFence(lines, start - 1)) return [{ line: start, insert: `\n${heading}` }]
  }
  const changes: TaskLineChange[] = []
  for (let line = start; line <= end; line += 1) {
    if (lineInsideFence(lines, line - 1)) continue
    const current = lines[line - 1] ?? ''
    const next = toggleTaskLine(current)
    if (next !== current) changes.push({ line, insert: next })
  }
  return changes
}
