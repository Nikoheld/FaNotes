/**
 * Study blocks live inside a note as fenced code blocks, e.g.
 *
 *   ```fanotes-key
 *   { "v": 1, ... }
 *   ```
 *
 * The note stays plain text: any Markdown viewer shows the JSON as code, sync
 * treats it like any other text, and FaNotes renders it as a diagram or table.
 * Every parser here is total: bad JSON or odd values yield a safe default.
 */

export const STUDY_KINDS = ['key', 'sort', 'map', 'plate', 'term'] as const
export type StudyKind = (typeof STUDY_KINDS)[number]

export const STUDY_KIND_LABELS: Record<StudyKind, string> = {
  key: 'Tabelle und Bestimmungsschlüssel',
  sort: 'Sortier-Board',
  map: 'Begriffsnetz (Ursache und Wirkung)',
  plate: 'Bildtafel',
  term: 'Definitionskarten',
}

export const isStudyKind = (value: unknown): value is StudyKind => typeof value === 'string' && (STUDY_KINDS as readonly string[]).includes(value)

export type StudyBlockRef = {
  kind: StudyKind
  /** Offset of the opening fence. */
  from: number
  /** Offset just after the closing fence (no trailing newline). */
  to: number
  /** JSON text between the fences. */
  body: string
  startLine: number
  endLine: number
}

const OPEN = /^( {0,3})(`{3,})fanotes-(key|sort|map|plate|term)[ \t]*$/u

/** All study blocks of a note, ignoring look-alikes inside other fences. */
export const findStudyBlocks = (markdown: string): StudyBlockRef[] => {
  const blocks: StudyBlockRef[] = []
  const raw = markdown.split('\n')
  const lines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const starts: number[] = []
  let offset = 0
  for (const line of raw) { starts.push(offset); offset += line.length + 1 }
  let other: RegExp | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (other) {
      if (other.test(line)) other = null
      continue
    }
    const open = OPEN.exec(line)
    if (open) {
      const closer = new RegExp(`^ {0,3}\`{${open[2].length},}\\s*$`, 'u')
      let end = -1
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        if (closer.test(lines[scan])) { end = scan; break }
      }
      if (end < 0) continue
      blocks.push({
        kind: open[3] as StudyKind,
        from: starts[index],
        to: starts[end] + lines[end].length,
        body: lines.slice(index + 1, end).join('\n'),
        startLine: index + 1,
        endLine: end + 1,
      })
      index = end
      continue
    }
    const plain = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    if (plain) other = new RegExp(`^ {0,3}${plain[1][0] === '`' ? '`' : '~'}{${plain[1].length},}\\s*$`, 'u')
  }
  return blocks
}

/** JSON text of a block body. Unknown top-level fields the user (or a newer version) added are kept. */
export const studyBlockBody = (data: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ ...(data as object), ...extra }, null, 1)

export const serializeStudyBlock = (kind: StudyKind, data: unknown, extra: Record<string, unknown> = {}): string => `\`\`\`fanotes-${kind}\n${studyBlockBody(data, extra)}\n\`\`\``

/** Short fingerprint of a block body, used to recognise the block again after the note changed. */
export const hashText = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`
}

/**
 * Finds the block again by kind and body fingerprint. The offset is only a hint: if the same text appears in
 * several blocks, only the one at the hint is accepted; if nothing matches, the caller must not write.
 */
export const locateStudyBlock = (markdown: string, kind: StudyKind, hash: string, hintFrom: number): StudyBlockRef | null => {
  const matches = findStudyBlocks(markdown).filter((block) => block.kind === kind && hashText(block.body) === hash)
  if (matches.length === 1) return matches[0]
  return matches.find((block) => block.from === hintFrom) ?? null
}

export const replaceStudyBlock = (markdown: string, ref: Pick<StudyBlockRef, 'from' | 'to'>, kind: StudyKind, data: unknown) => (
  `${markdown.slice(0, ref.from)}${serializeStudyBlock(kind, data)}${markdown.slice(ref.to)}`
)

/** Inserts a block as its own paragraph at `at` (end of text when omitted). */
export const insertStudyBlock = (markdown: string, kind: StudyKind, data: unknown, at = markdown.length) => {
  const before = markdown.slice(0, at)
  const after = markdown.slice(at)
  const lead = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const tail = after.length === 0 ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  return `${before}${lead}${serializeStudyBlock(kind, data)}${tail}${after}`
}

export const parseJsonObject = (body: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// -- small normalisation helpers shared by every model ------------------------

export const asText = (value: unknown, max: number, fallback = '') => (
  typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback
)
export const asArray = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : [])
export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export const newId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`

/** Pictures live as files in the vault; older notes may still carry a small data URL. */
export const IMAGE_DATA_LIMIT = 220_000
export const VAULT_IMAGE_PATTERN = /^\.fanotes\/worksheets\/[A-Za-z0-9-]{8,64}\.(?:png|jpe?g|webp|gif)$/u
export const isVaultImageRef = (value: string) => VAULT_IMAGE_PATTERN.test(value)
export const asImage = (value: unknown) => {
  if (typeof value !== 'string') return ''
  if (isVaultImageRef(value)) return value
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(value) && value.length <= IMAGE_DATA_LIMIT ? value : ''
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, (char) => (
  char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;'
))
