// What the conflict page shows for one version of a document: its text, its
// handwriting, a PDF or an image, decoded from the raw bytes in the vault.
// Nothing here writes; resolving is the sync engine's job.
import { parseFamd, stripFamdPayload } from '../famd'
import { diffLines } from './markdownConflict'
import { storyRoleOf } from '../../writing/syncMerge'

export type ConflictFileBytes = { path: string; bytes: Uint8Array | null }

export type ConflictPreview =
  | { kind: 'missing' }
  | { kind: 'damaged'; size: number }
  | { kind: 'note'; lines: string[]; words: number; inkJson: string | null; strokes: number; textFields: number; size: number }
  | { kind: 'ink'; inkJson: string | null; strokes: number; size: number }
  | { kind: 'pdf'; bytes: Uint8Array; size: number }
  | { kind: 'image'; bytes: Uint8Array; mime: string; size: number }
  | { kind: 'text'; lines: string[]; size: number }
  /** A writing-mode file as the writer reads it: paragraphs, chapter and scene titles, a bible sheet. */
  | { kind: 'story'; role: 'scene' | 'manifest' | 'bible'; lines: string[]; words: number; paragraphs: number; size: number }
  | { kind: 'binary'; size: number }

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
}
const TEXT_TYPES = new Set(['txt', 'json', 'csv', 'tex', 'html', 'css', 'js', 'ts', 'yaml', 'yml', 'xml'])
const MAX_PREVIEW_LINES = 4000

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const decode = (bytes: Uint8Array) => {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/** Note text as the reader sees it: no famd payload, no hidden FaNotes markers. */
export const readableNoteText = (source: string) => stripFamdPayload(source)
  .replace(/\r\n/gu, '\n')
  .replace(/<!--[\s\S]*?-->/gu, '')
  .replace(/\n{3,}/gu, '\n\n')
  .trim()

const countStrokes = (ink: unknown): number => {
  if (!ink || typeof ink !== 'object') return 0
  const strokes = (ink as { strokes?: unknown }).strokes
  return Array.isArray(strokes) ? strokes.length : 0
}

/** Drawing JSON the ink painter accepts, or null when the page has no size or strokes. */
const inkJsonOf = (ink: unknown) => {
  if (!ink || typeof ink !== 'object') return null
  const page = ink as { strokes?: unknown; sourceWidth?: unknown; sourceHeight?: unknown }
  if (!Array.isArray(page.strokes) || !page.strokes.length) return null
  if (typeof page.sourceWidth !== 'number' || typeof page.sourceHeight !== 'number') return null
  return JSON.stringify(ink)
}

const wordsIn = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const runsText = (runs: unknown) => (Array.isArray(runs) ? runs.map((run) => str(record(run)?.text)).join('') : '')
const oneLine = (text: string) => text.replace(/\s*\n\s*/gu, ' ').trim()
/** Paragraph styles that read as headings in the preview (the page styles `#` lines as headings). */
const HEADING_STYLES: Record<string, string> = { chapter: '# ', heading: '## ', subheading: '### ' }

/**
 * Scenes, `story.json` and bible sheets as readable text, never raw JSON:
 * paragraphs one per line (deleted ones left out, ones kept from a merge
 * marked), the binder as an outline, a sheet as name, fields and notes.
 */
export const storyPreview = (path: string, bytes: Uint8Array): ConflictPreview | null => {
  const role = storyRoleOf(path)
  if (role !== 'scene' && role !== 'manifest' && role !== 'entity') return null
  const source = decode(bytes)
  let value: Record<string, unknown> | null = null
  try {
    value = source === null ? null : record(JSON.parse(source))
  } catch {
    value = null
  }
  if (!value) return { kind: 'damaged', size: bytes.byteLength }
  const lines: string[] = []
  let paragraphs = 0
  if (role === 'scene') {
    for (const entry of Array.isArray(value.paragraphs) ? value.paragraphs : []) {
      const paragraph = record(entry)
      if (!paragraph || paragraph.deleted === true) continue
      const text = runsText(paragraph.runs)
      paragraphs += 1
      const prefix = HEADING_STYLES[str(paragraph.style)] ?? (paragraph.style === 'quote' ? '> ' : '')
      lines.push(`${prefix}${paragraph.conflictOf ? '» ' : ''}${oneLine(text)}`)
    }
  } else if (role === 'manifest') {
    lines.push(`# ${oneLine(str(value.title))}`)
    if (str(value.subtitle)) lines.push(oneLine(str(value.subtitle)))
    if (str(value.author)) lines.push(oneLine(str(value.author)))
    const walk = (nodes: unknown, depth: number) => {
      for (const entry of Array.isArray(nodes) ? nodes : []) {
        const node = record(entry)
        if (!node || depth > 8) continue
        paragraphs += 1
        const title = oneLine(str(node.title))
        const synopsis = oneLine(str(node.synopsis))
        if (node.kind === 'scene') lines.push(`${'  '.repeat(Math.max(0, depth - 1))}- ${title}${synopsis ? ` – ${synopsis}` : ''}`)
        else {
          lines.push(`${depth === 0 ? '## ' : '### '}${title}${synopsis ? ` – ${synopsis}` : ''}`)
          walk(node.children, depth + 1)
        }
      }
    }
    walk(value.binder, 0)
    const dictionary = Array.isArray(value.dictionary) ? value.dictionary.filter((word): word is string => typeof word === 'string') : []
    if (dictionary.length) lines.push('', `${dictionary.slice(0, 200).join(', ')}${dictionary.length > 200 ? ' …' : ''}`)
  } else {
    lines.push(`# ${oneLine(str(value.name))}${value.archived === true ? ' (archiviert / archived)' : ''}`)
    if (str(value.role)) lines.push(oneLine(str(value.role)))
    const aliases = Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === 'string') : []
    if (aliases.length) lines.push(aliases.join(', '))
    if (str(value.when)) lines.push(oneLine(str(value.when)))
    for (const entry of Array.isArray(value.fields) ? value.fields : []) {
      const field = record(entry)
      if (field && str(field.value).trim()) lines.push(`- ${oneLine(str(field.label))}: ${oneLine(str(field.value))}`)
    }
    if (str(value.notes).trim()) lines.push('', ...str(value.notes).replace(/\r\n/gu, '\n').split('\n'))
    paragraphs = lines.length
  }
  const text = lines.join('\n')
  return { kind: 'story', role: role === 'entity' ? 'bible' : role, lines: lines.slice(0, MAX_PREVIEW_LINES), words: wordsIn(text.replace(/^#+\s|^-\s/gmu, '')), paragraphs, size: bytes.byteLength }
}

/**
 * One version of a document from its files: a note's `.md` (text) and `.famd`
 * (text, handwriting, fields) are read together.
 */
export const previewOfVersion = (files: ConflictFileBytes[]): ConflictPreview => {
  const present = files.filter((file): file is { path: string; bytes: Uint8Array } => Boolean(file.bytes))
  if (!present.length) return { kind: 'missing' }
  const size = present.reduce((sum, file) => sum + file.bytes.byteLength, 0)
  const story = present.length === 1 ? storyPreview(present[0].path, present[0].bytes) : null
  if (story) return story
  const markdown = present.find((file) => /^(md|markdown)$/u.test(extensionOf(file.path)))
  const famd = present.find((file) => extensionOf(file.path) === 'famd')
  if (markdown || famd) {
    let text = ''
    let ink: unknown = null
    let textFields = 0
    if (famd) {
      const source = decode(famd.bytes)
      if (source === null) return { kind: 'damaged', size }
      try {
        const parsed = parseFamd(source)
        if (source.includes('fanotes-famd:') && !parsed.payload) return { kind: 'damaged', size }
        ink = parsed.payload?.ink ?? null
        textFields = parsed.payload?.textFields?.filter((field) => typeof field.text === 'string' && field.text.trim()).length ?? 0
        text = readableNoteText(parsed.markdown)
      } catch {
        return { kind: 'damaged', size }
      }
    }
    if (markdown) {
      const source = decode(markdown.bytes)
      if (source === null) return { kind: 'damaged', size }
      text = readableNoteText(source)
    }
    return { kind: 'note', lines: text ? text.split('\n').slice(0, MAX_PREVIEW_LINES) : [], words: wordsIn(text), inkJson: inkJsonOf(ink), strokes: countStrokes(ink), textFields, size }
  }
  const [file] = present
  const extension = extensionOf(file.path)
  if (extension === 'pdf') return { kind: 'pdf', bytes: file.bytes, size }
  if (IMAGE_TYPES[extension]) return { kind: 'image', bytes: file.bytes, mime: IMAGE_TYPES[extension], size }
  if (file.path.startsWith('.fanotes/assets/') && extension === 'json') {
    const source = decode(file.bytes)
    try {
      const parsed = source === null ? null : JSON.parse(source) as unknown
      if (parsed && typeof parsed === 'object') return { kind: 'ink', inkJson: inkJsonOf(parsed), strokes: countStrokes(parsed), size }
    } catch {
      // falls through to plain text
    }
  }
  if (TEXT_TYPES.has(extension)) {
    const source = decode(file.bytes)
    if (source !== null) return { kind: 'text', lines: source.replace(/\r\n/gu, '\n').split('\n').slice(0, MAX_PREVIEW_LINES), size }
  }
  return { kind: 'binary', size }
}

/** Which lines differ: indices into the original's and the copy's lines. */
export const changedLines = (original: string[], copy: string[]) => {
  const rows = diffLines(original.join('\n'), copy.join('\n'))
  const left = new Set<number>()
  const right = new Set<number>()
  let leftIndex = 0
  let rightIndex = 0
  for (const row of rows) {
    if (row.kind === 'same') {
      leftIndex += 1
      rightIndex += 1
    } else if (row.kind === 'removed') {
      left.add(leftIndex)
      leftIndex += 1
    } else {
      right.add(rightIndex)
      rightIndex += 1
    }
  }
  return { left, right }
}
