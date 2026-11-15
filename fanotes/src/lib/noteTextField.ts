import { keepMarkOnPage } from './noteCanvas'

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
}

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
const TEXT_FIELD_MAX_CHARS = 8000
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

export const newNoteTextFieldId = () => (
  `tf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
)

export const sanitizeNoteTextField = (value: unknown): NoteTextField | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' && TEXT_FIELD_ID.test(raw.id) ? raw.id : newNoteTextFieldId()
  const text = typeof raw.text === 'string' ? raw.text.slice(0, TEXT_FIELD_MAX_CHARS) : ''
  const color = typeof raw.color === 'string' && COLOR_PATTERN.test(raw.color) ? raw.color.toLowerCase() : undefined
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

/** Click point becomes the top-left of a new empty field, kept on the page. */
export const placeNoteTextField = (point: { page: number; x: number; y: number }): NoteTextField => {
  const width = DEFAULT_WIDTH
  const field = sanitizeNoteTextField({
    id: newNoteTextFieldId(),
    page: point.page,
    x: Math.min(clampUnit(point.x, 0.5), 1 - width),
    y: Math.min(clampUnit(point.y, 0.5), 0.92),
    width,
    fontSize: DEFAULT_FONT_SIZE,
    text: '',
  })
  if (!field) throw new Error('Das Textfeld konnte nicht gesetzt werden.')
  return field
}

export const patchNoteTextField = (
  fields: readonly NoteTextField[],
  id: string,
  patch: Partial<Pick<NoteTextField, 'page' | 'x' | 'y' | 'width' | 'text' | 'fontSize'>> & { color?: string | undefined; bold?: boolean | undefined },
): NoteTextField[] => {
  const current = parseNoteTextFields(fields)
  return parseNoteTextFields(current.map((field) => field.id === id ? { ...field, ...patch } : field))
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
