import { keepMarkOnPage } from './noteCanvas'
import { sameNoteTextFieldContent } from '../../electron/noteTextFieldMerge.mjs'

/** A keyboard text box placed on a markdown note or a PDF note. */
export type NoteTextField = {
  id: string
  page: number
  x: number
  y: number
  width: number
  text: string
  fontSize: number
  /** Optional #rrggbb ink colour. Absent means the default dark ink. */
  color?: string
  /** Optional bold weight. Absent means regular. */
  bold?: boolean
  /**
   * Epoch milliseconds of the last edit of this box. Lets two windows, devices
   * or share editors decide which edit of one box is newer. Files from older
   * builds have none, and older builds drop it again when they save.
   */
  updatedAt?: number
}

/** A deleted box. Kept in the payload next to `textFields`, never inside it. */
export type NoteTextFieldTombstone = { id: string; deletedAt: number }

export const NOTE_TEXT_FIELD_FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48] as const
export const NOTE_TEXT_FIELD_COLORS = [
  { value: undefined, label: 'Schwarz', css: '#20222b' },
  { value: '#c62f4a', label: 'Rot', css: '#c62f4a' },
  { value: '#c8741a', label: 'Orange', css: '#c8741a' },
  { value: '#1f8a5b', label: 'Grün', css: '#1f8a5b' },
  { value: '#2563c9', label: 'Blau', css: '#2563c9' },
  { value: '#7a4bc4', label: 'Violett', css: '#7a4bc4' },
] as const
/** Page width (layout px) at which a stored font size is shown 1:1 on a PDF. */
export const NOTE_TEXT_FIELD_REFERENCE_PAGE_WIDTH = 820

const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu

const TEXT_FIELD_ID = /^[a-zA-Z0-9._-]{1,96}$/u
export const NOTE_TEXT_FIELD_LIMIT = 200
/** Longest text one box stores; the textarea stops at it, so a paste never snaps back and loses the caret. */
export const NOTE_TEXT_FIELD_MAX_CHARS = 8000
/** Largest epoch millisecond a JS Date can hold; a stamp beyond it is junk. */
const TEXT_FIELD_STAMP_MAX = 8.64e15
const DEFAULT_WIDTH = 0.32
const DEFAULT_FONT_SIZE = 16

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const clampUnit = (value: unknown, fallback: number) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!isFiniteNumber(number)) return fallback
  if (number < 0) return 0
  if (number > 1) return 1
  return number
}

const clampWidth = (value: unknown) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!isFiniteNumber(number)) return DEFAULT_WIDTH
  if (number < 0.12) return 0.12
  if (number > 0.92) return 0.92
  return number
}

const clampPage = (value: unknown) => {
  const page = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) return 1
  return page
}

const clampFontSize = (value: unknown) => {
  const size = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(size) || size < 10 || size > 48) return DEFAULT_FONT_SIZE
  return size
}

/** Epoch milliseconds of an edit or delete. Anything that is not a positive finite number is "unknown". */
const sanitizeStamp = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= TEXT_FIELD_STAMP_MAX
    ? Math.floor(value)
    : null
)

export const newNoteTextFieldId = () => (
  `tf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
)

export const sanitizeNoteTextField = (value: unknown): NoteTextField | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' && TEXT_FIELD_ID.test(raw.id) ? raw.id : newNoteTextFieldId()
  const text = typeof raw.text === 'string' ? raw.text.slice(0, NOTE_TEXT_FIELD_MAX_CHARS) : ''
  const color = typeof raw.color === 'string' && COLOR_PATTERN.test(raw.color) ? raw.color.toLowerCase() : undefined
  const updatedAt = sanitizeStamp(raw.updatedAt)
  return {
    id,
    page: clampPage(raw.page),
    x: clampUnit(raw.x, 0.5),
    y: clampUnit(raw.y, 0.5),
    width: clampWidth(raw.width),
    fontSize: clampFontSize(raw.fontSize),
    text,
    ...(color ? { color } : {}),
    ...(raw.bold === true ? { bold: true } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

export const parseNoteTextFields = (value: unknown): NoteTextField[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const fields: NoteTextField[] = []
  for (const entry of value) {
    const field = sanitizeNoteTextField(entry)
    if (!field || seen.has(field.id)) continue
    seen.add(field.id)
    fields.push(field)
    if (fields.length >= NOTE_TEXT_FIELD_LIMIT) break
  }
  return fields
}

/** Deleted boxes from a payload, newest first, one per id. Mirrors `parseNoteTextFieldTombstones` in `electron/famd.cjs`. */
export const parseNoteTextFieldTombstones = (value: unknown): NoteTextFieldTombstone[] => {
  if (!Array.isArray(value)) return []
  const latest = new Map<string, number>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || !TEXT_FIELD_ID.test(raw.id)) continue
    const deletedAt = sanitizeStamp(raw.deletedAt)
    if (!deletedAt) continue
    latest.set(raw.id, Math.max(latest.get(raw.id) ?? 0, deletedAt))
  }
  return [...latest]
    .sort((left, right) => right[1] - left[1])
    .slice(0, NOTE_TEXT_FIELD_LIMIT)
    .map(([id, deletedAt]) => ({ id, deletedAt }))
}

const LAST_FONT_SIZE_KEY = 'fanotes-note-text-field-font-size'

const fontSizeStorage = (): Storage | null => {
  try { return globalThis.localStorage ?? null } catch { return null }
}

/** Font size the owner last chose for a text field; new fields start with it. */
export const readLastNoteTextFieldFontSize = (): number => {
  try {
    const raw = fontSizeStorage()?.getItem(LAST_FONT_SIZE_KEY)
    return raw === null || raw === undefined ? DEFAULT_FONT_SIZE : clampFontSize(Number(raw))
  } catch { return DEFAULT_FONT_SIZE }
}

export const rememberNoteTextFieldFontSize = (size: number): void => {
  if (clampFontSize(size) !== size) return
  try { fontSizeStorage()?.setItem(LAST_FONT_SIZE_KEY, String(size)) } catch { /* storage unavailable */ }
}

/** Click point becomes the top-left of a new empty field, kept on the page. */
export const placeNoteTextField = (point: { page: number; x: number; y: number }): NoteTextField => {
  const width = DEFAULT_WIDTH
  const field = sanitizeNoteTextField({
    id: newNoteTextFieldId(),
    page: point.page,
    x: Math.min(clampUnit(point.x, 0.5), 1 - width),
    y: Math.min(clampUnit(point.y, 0.5), 0.92),
    width,
    fontSize: readLastNoteTextFieldFontSize(),
    text: '',
    updatedAt: Date.now(),
  })
  if (!field) throw new Error('Das Textfeld konnte nicht gesetzt werden.')
  return field
}

/** A real change of one box stamps it; a patch that changes nothing keeps the box (and its stamp) as it was. */
export const patchNoteTextField = (
  fields: readonly NoteTextField[],
  id: string,
  patch: Partial<Pick<NoteTextField, 'page' | 'x' | 'y' | 'width' | 'text' | 'fontSize'>> & { color?: string | undefined; bold?: boolean | undefined },
  now: number = Date.now(),
): NoteTextField[] => {
  if (patch.fontSize !== undefined) rememberNoteTextFieldFontSize(patch.fontSize)
  // The list is cleaned once; only the patched box is cleaned again. This runs on every keystroke.
  return parseNoteTextFields(fields).map((field) => {
    if (field.id !== id) return field
    const next = sanitizeNoteTextField({ ...field, ...patch })
    if (!next || sameNoteTextFieldContent(field, next)) return field
    return { ...next, updatedAt: Math.max(now, (field.updatedAt ?? 0) + 1) }
  })
}

/**
 * Stored x/y/width are fractions of the painted sheet, the same space as ink.
 * A page grow keeps the box on the same paper instead of stretching it.
 */
export const noteTextFieldsAfterOriginGrow = (
  fields: readonly NoteTextField[],
  prev: { width: number; height: number },
  next: { width: number; height: number; padX?: number; padY?: number },
): readonly NoteTextField[] => {
  const padX = Math.max(0, Number.isFinite(next.padX) ? Number(next.padX) : 0)
  const padY = Math.max(0, Number.isFinite(next.padY) ? Number(next.padY) : 0)
  const prevW = prev.width > 0 ? prev.width : 1
  const nextW = next.width > 0 ? next.width : prevW
  const widthScale = prevW / nextW
  let changed = false
  const remapped = fields.map((field) => {
    const x = keepMarkOnPage(field.x, prev.width, next.width, padX)
    const y = keepMarkOnPage(field.y, prev.height, next.height, padY)
    const width = clampWidth(field.width * widthScale)
    if (x === field.x && y === field.y && width === field.width) return field
    changed = true
    return { ...field, x, y, width }
  })
  return changed ? remapped : fields
}

/** Next/previous step of the font-size ladder; unknown sizes snap to the nearest rung first. */
export const stepNoteTextFieldFontSize = (size: number, direction: 1 | -1): number => {
  const sizes = NOTE_TEXT_FIELD_FONT_SIZES
  let nearest = 0
  for (let index = 1; index < sizes.length; index += 1) {
    if (Math.abs(sizes[index] - size) < Math.abs(sizes[nearest] - size)) nearest = index
  }
  const exact = sizes[nearest] === size
  const target = exact ? nearest + direction : (direction > 0 ? (sizes[nearest] > size ? nearest : nearest + 1) : (sizes[nearest] < size ? nearest : nearest - 1))
  return sizes[Math.max(0, Math.min(sizes.length - 1, target))]
}

export type NoteTextFieldPageRect = { page: number; left: number; top: number; width: number; height: number }

/**
 * Map a client point to a page fraction. A point outside every page (gutter,
 * margin, drag past the edge) snaps to the nearest page instead of page 1.
 */
export const noteTextFieldPointFromRects = (
  rects: readonly NoteTextFieldPageRect[],
  clientX: number,
  clientY: number,
): { page: number; x: number; y: number } | null => {
  let best: NoteTextFieldPageRect | null = null
  let bestDistance = Infinity
  for (const rect of rects) {
    if (!(rect.width > 0) || !(rect.height > 0)) continue
    const dx = Math.max(rect.left - clientX, 0, clientX - (rect.left + rect.width))
    const dy = Math.max(rect.top - clientY, 0, clientY - (rect.top + rect.height))
    const distance = dy * 4 + dx
    if (distance < bestDistance) {
      best = rect
      bestDistance = distance
    }
  }
  if (!best) return null
  return {
    page: best.page,
    x: clampUnit((clientX - best.left) / best.width, 0),
    y: clampUnit((clientY - best.top) / best.height, 0),
  }
}

/**
 * Runs text box jobs (writes and re-reads) one after the other. A job starts
 * only when every earlier job has finished, and `run` resolves with that job's
 * result, so a caller that awaits it knows nothing is still in flight before it.
 */
export type SerialJobQueue = {
  /** `write` jobs count as unsaved work while they are queued or running. */
  run: (job: () => Promise<boolean>, write?: boolean) => Promise<boolean>
  /** Queued or running write jobs. */
  writes: () => number
  /** Resolves after everything queued so far (false when the last job failed). Never rejects. */
  drained: () => Promise<boolean>
}

export const createSerialJobQueue = (): SerialJobQueue => {
  let tail: Promise<boolean> = Promise.resolve(true)
  let writes = 0
  return {
    run: (job, write = true) => {
      if (write) writes += 1
      const result = tail.then(job)
      tail = result.catch(() => false)
      return result.finally(() => { if (write) writes -= 1 })
    },
    writes: () => writes,
    drained: () => tail,
  }
}
