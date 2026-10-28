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
}

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
  return {
    id,
    page: clampPage(raw.page),
    x: clampUnit(raw.x, 0.5),
    y: clampUnit(raw.y, 0.5),
    width: clampWidth(raw.width),
    fontSize: clampFontSize(raw.fontSize),
    text,
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
  patch: Partial<Pick<NoteTextField, 'page' | 'x' | 'y' | 'width' | 'text' | 'fontSize'>>,
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
