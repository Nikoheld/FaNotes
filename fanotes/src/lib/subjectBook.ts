import { companionNotePath, emptyFamdPayload, isPdfNotePath, parseFamd, serializeFamd } from './famd'

export const SUBJECT_BOOK_PLACEMENTS = ['links', 'rechts', 'oben', 'unten', 'popout'] as const
export type SubjectBookPlacement = (typeof SUBJECT_BOOK_PLACEMENTS)[number]

export const SUBJECT_BOOK_PLACEMENT_OPTIONS: Array<{ id: SubjectBookPlacement; label: string }> = [
  { id: 'links', label: 'Links' },
  { id: 'rechts', label: 'Rechts' },
  { id: 'oben', label: 'Oben' },
  { id: 'unten', label: 'Unten' },
  { id: 'popout', label: 'Auspoppen' },
]

export const SUBJECT_BOOK_TOOLBAR_SLOT_ID = 'fanotes-subject-book-pdf-toolbar'

const MAX_PATH = 500
const MAX_BOOKS = 200

export type SubjectBookRecord = {
  subjectPath: string
  bookPath: string
  lastPage: number
}

export type SubjectBookViewPolicy = {
  controlVisible: boolean
  paneVisible: boolean
  placement: SubjectBookPlacement | null
}

const sanitizeFolderPath = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const path = value.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '').trim()
  if (!path || path.length > MAX_PATH || path.includes('..') || path.includes('\0') || /\.(md|markdown|famd|pdf)$/iu.test(path)) {
    return ''
  }
  return path
}

const sanitizePdfPath = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const path = value.replace(/\\/gu, '/').replace(/^\/+/u, '').trim()
  if (!path || path.length > MAX_PATH || path.includes('..') || path.includes('\0') || !isPdfNotePath(path)) return ''
  return path
}

const sanitizePage = (value: unknown, pageCount?: unknown) => {
  const page = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(page) || page < 1) return 0
  const count = typeof pageCount === 'number' ? pageCount : Number(pageCount)
  if (Number.isSafeInteger(count) && count >= 1 && page > count) return 0
  return page
}

export const parseSubjectBookPlacement = (value: unknown): SubjectBookPlacement | null => (
  typeof value === 'string' && (SUBJECT_BOOK_PLACEMENTS as readonly string[]).includes(value)
    ? value as SubjectBookPlacement
    : null
)

export const emptySubjectBooks = (): SubjectBookRecord[] => []

export const sanitizeSubjectBook = (value: unknown): SubjectBookRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const subjectPath = sanitizeFolderPath(raw.subjectPath)
  const bookPath = sanitizePdfPath(raw.bookPath)
  if (!subjectPath || !bookPath) return null
  const lastPage = sanitizePage(raw.lastPage) || 1
  return { subjectPath, bookPath, lastPage }
}

export const parseSubjectBooks = (value: unknown): SubjectBookRecord[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const books: SubjectBookRecord[] = []
  for (const entry of value) {
    const book = sanitizeSubjectBook(entry)
    if (!book || seen.has(book.subjectPath)) continue
    seen.add(book.subjectPath)
    books.push(book)
  }
  return books.slice(0, MAX_BOOKS)
}

export const serializeSubjectBooks = (list: SubjectBookRecord[] | null | undefined) => (
  parseSubjectBooks(list).map((book) => ({
    subjectPath: book.subjectPath,
    bookPath: book.bookPath,
    lastPage: book.lastPage,
  }))
)

export const subjectBookFor = (list: unknown, subjectPath: unknown) => {
  const path = sanitizeFolderPath(subjectPath)
  if (!path) return null
  return parseSubjectBooks(list).find((book) => book.subjectPath === path) ?? null
}

export const subjectHasBook = (list: unknown, subjectPath: unknown) => Boolean(subjectBookFor(list, subjectPath))

export const subjectBookForNote = (list: unknown, notePath: unknown) => {
  if (typeof notePath !== 'string' || !notePath) return null
  const normalized = notePath.replace(/\\/gu, '/').replace(/^\/+/u, '').trim()
  if (!normalized || normalized.includes('..')) return null
  const books = parseSubjectBooks(list)
  if (!books.length) return null
  const direct = subjectBookFor(books, normalized)
  if (direct) return direct
  const parts = normalized.split('/').filter(Boolean)
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const folder = parts.slice(0, index).join('/')
    const found = subjectBookFor(books, folder)
    if (found) return found
  }
  return null
}

/** Popout must not invent lastPage 1 before vault records are loaded. */
export const subjectBookForPopout = (list: unknown, bookPath: unknown, recordsLoaded: unknown) => {
  const path = sanitizePdfPath(bookPath)
  if (!path) return null
  const stored = parseSubjectBooks(list).find((book) => book.bookPath === path)
  if (stored) return stored
  if (recordsLoaded !== true) return null
  const folder = path.replace(/\/[^/]+$/u, '')
  return {
    subjectPath: sanitizeFolderPath(folder) || folder,
    bookPath: path,
    lastPage: 1,
  }
}

export const mergeSubjectBooksPreferDisk = (memory: unknown, disk: unknown) => {
  const mem = parseSubjectBooks(memory)
  const onDisk = parseSubjectBooks(disk)
  const bySubject = new Map(mem.map((book) => [book.subjectPath, book]))
  for (const book of onDisk) {
    bySubject.set(book.subjectPath, book)
  }
  return [...bySubject.values()].slice(0, MAX_BOOKS)
}

export const patchSubjectBookPage = (
  diskList: unknown,
  record: SubjectBookRecord | null | undefined,
  page: unknown,
  pageCount?: unknown,
) => {
  const disk = parseSubjectBooks(diskList)
  const identity = sanitizeSubjectBook(record)
  if (!identity) return disk
  const onDisk = disk.find((book) => book.subjectPath === identity.subjectPath) ?? identity
  const nextPage = sanitizePage(page, pageCount)
  if (onDisk.lastPage !== identity.lastPage && nextPage === identity.lastPage) return disk
  const updated = recordSubjectBookPage(onDisk, page, pageCount)
  if (!updated) return disk
  return [...disk.filter((book) => book.subjectPath !== updated.subjectPath), updated]
}

export const subjectBookMountRecord = (input: {
  memory: unknown
  disk: unknown
  ready: unknown
  hydrating: unknown
  notePath?: unknown
  bookPath?: unknown
}) => {
  if (input.ready !== true || input.hydrating === true) return null
  const merged = mergeSubjectBooksPreferDisk(input.memory, input.disk)
  if (typeof input.bookPath === 'string' && input.bookPath) {
    return subjectBookForPopout(merged, input.bookPath, true)
  }
  return subjectBookForNote(merged, input.notePath)
}

export const attachSubjectBook = (
  list: unknown,
  input: { subjectPath: string; bookPath: string; lastPage?: number },
): { list: SubjectBookRecord[]; book: SubjectBookRecord } => {
  const book = sanitizeSubjectBook({
    subjectPath: input.subjectPath,
    bookPath: input.bookPath,
    lastPage: input.lastPage ?? 1,
  })
  if (!book) throw new Error('Das Buch konnte dem Fach nicht zugeordnet werden.')
  const others = parseSubjectBooks(list).filter((item) => item.subjectPath !== book.subjectPath)
  return { list: [...others, book].slice(0, MAX_BOOKS), book }
}

export const detachSubjectBook = (list: unknown, subjectPath: unknown) => {
  const path = sanitizeFolderPath(subjectPath)
  if (!path) return parseSubjectBooks(list)
  return parseSubjectBooks(list).filter((book) => book.subjectPath !== path)
}

export const subjectBookViewPolicy = (input: {
  hasBook: unknown
  open: unknown
  placement: unknown
}): SubjectBookViewPolicy => {
  const hasBook = input.hasBook === true
  if (!hasBook) return { controlVisible: false, paneVisible: false, placement: null }
  const placement = parseSubjectBookPlacement(input.placement)
  const open = input.open === true
  if (!open) return { controlVisible: true, paneVisible: false, placement }
  if (!placement) return { controlVisible: true, paneVisible: false, placement: null }
  return { controlVisible: true, paneVisible: true, placement }
}

export const toggleSubjectBookView = (open: unknown, placement: unknown = 'rechts') => {
  const nextPlacement = parseSubjectBookPlacement(placement) ?? 'rechts'
  if (open === true) return { open: false, placement: nextPlacement }
  return { open: true, placement: nextPlacement }
}

export const applySubjectBookPlacement = (placement: unknown) => {
  const next = parseSubjectBookPlacement(placement)
  if (!next) return { open: false, placement: null as SubjectBookPlacement | null }
  return { open: true, placement: next }
}

export const recordSubjectBookPage = (
  record: SubjectBookRecord | null | undefined,
  page: unknown,
  pageCount?: unknown,
) => {
  if (!record) return null
  const next = sanitizePage(page, pageCount)
  if (!next) return record
  return { ...record, lastPage: next }
}

export const restoreSubjectBookPage = (
  record: SubjectBookRecord | null | undefined,
  pageCount?: unknown,
) => {
  if (!record) return 1
  const page = sanitizePage(record.lastPage, pageCount)
  return page || 1
}

export const subjectBookDocumentKey = (book: SubjectBookRecord | null | undefined) => book?.bookPath ?? ''

export const subjectBookStageSlots = (policy: SubjectBookViewPolicy): Array<'book' | 'main'> => {
  if (!policy.paneVisible || !policy.placement || policy.placement === 'popout') return ['main']
  if (policy.placement === 'rechts' || policy.placement === 'unten') return ['main', 'book']
  return ['book', 'main']
}

/** Apply recorded lastPage only when the PDF identity changes. Same path → do not reopen. */
export const subjectBookOpenPageOnLoad = (
  nextPath: unknown,
  previousPath: unknown,
  recordedPage: unknown,
) => {
  const next = sanitizePdfPath(nextPath)
  if (!next) return null
  if (typeof previousPath === 'string' && previousPath === next) return null
  const page = sanitizePage(recordedPage)
  return page || 1
}

export const subjectBookCompanionPath = (bookPath: string) => companionNotePath(bookPath, '.famd')

export const persistSubjectBookNotes = (
  existingSource: string,
  input: { bookPath: string; text?: string; ink?: Record<string, unknown> | null },
) => {
  const bookPath = sanitizePdfPath(input.bookPath)
  if (!bookPath) throw new Error('Der Buchpfad ist ungültig.')
  const parsed = parseFamd(typeof existingSource === 'string' ? existingSource : '')
  const payload = {
    ...(parsed.payload || emptyFamdPayload()),
    updatedAt: new Date().toISOString(),
    ink: input.ink === undefined ? parsed.payload?.ink ?? null : input.ink,
  }
  const body = input.text === undefined ? parsed.markdown : input.text
  return serializeFamd(body, payload)
}

export const readSubjectBookNotes = (source: string) => {
  const parsed = parseFamd(typeof source === 'string' ? source : '')
  return {
    text: parsed.markdown,
    ink: parsed.payload?.ink ?? null,
    companion: true,
  }
}

export const subjectBookNotesTarget = (bookPath: unknown, otherPath: unknown) => {
  const book = sanitizePdfPath(bookPath)
  if (!book || typeof otherPath !== 'string') return false
  const other = otherPath.replace(/\\/gu, '/').replace(/^\/+/u, '').trim()
  return other === book || other === subjectBookCompanionPath(book)
}
