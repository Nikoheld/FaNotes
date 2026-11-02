/**
 * Local storage for ink-recognizer personalization: confirmed handwriting lines, the fitted
 * writer profile and an optional fine-tuned personal model. A separate IndexedDB database keeps
 * the GlyphenWerk glyph store (`fanotes-handwriting`) and its migrations untouched.
 */
import type { Stroke } from '../../../src/types'
import type { InkLanguage, InkStyle } from './inkRecognition'

const DB_NAME = 'fanotes-ink-personal'
const DB_VERSION = 1
const LINE_STORE = 'lines'
const META_STORE = 'meta'
export const MAX_INK_LINE_SAMPLES = 2_000
const MAX_STROKES_PER_LINE = 600
const MAX_POINTS_PER_LINE = 40_000
const MAX_TEXT_LENGTH = 400

export type InkLineOrigin = 'correction' | 'confirmed' | 'prompt' | 'import'

export type InkLineSample = {
  id: string
  text: string
  language: InkLanguage
  /** Normalized to `sourceWidth × sourceHeight`, like note ink. */
  strokes: Stroke[]
  sourceWidth: number
  sourceHeight: number
  /** Typical line height of the page it came from, in source pixels (0 when unknown). */
  referenceHeight: number
  origin: InkLineOrigin
  createdAt: string
}

export type InkPersonalProfile = {
  key: 'profile'
  /** Shipped model version the style was fitted on. */
  modelVersion: string
  enabled: boolean
  style: InkStyle | null
  vocabulary: Record<InkLanguage, string[]>
  fittedOn: number
  fittedAt: string
  /** Character error rate (%) of held-out personal lines before and after personalization. */
  errorBefore: number | null
  errorAfter: number | null
}

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Der lokale Trainingsspeicher antwortet nicht.'))
})

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (!('indexedDB' in globalThis)) {
    reject(new Error('IndexedDB ist in dieser Umgebung nicht verfügbar.'))
    return
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(LINE_STORE)) {
      database.createObjectStore(LINE_STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt', { unique: false })
    }
    if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' })
  }
  request.onsuccess = () => {
    request.result.onversionchange = () => request.result.close()
    resolve(request.result)
  }
  request.onerror = () => reject(request.error ?? new Error('Der lokale Trainingsspeicher konnte nicht geöffnet werden.'))
})

const transact = async <T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> => {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(stores, mode)
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Speichervorgang wurde abgebrochen.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Speichervorgang ist fehlgeschlagen.'))
    })
    const result = await action(transaction)
    await done
    return result
  } finally {
    database.close()
  }
}

const finite = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

/** Validates an untrusted line sample (import, GlyphenWerk message) or returns `null`. */
export const sanitizeInkLineSample = (value: unknown, origin?: InkLineOrigin): InkLineSample | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const text = typeof raw.text === 'string' ? raw.text.normalize('NFC').replace(/\s+/gu, ' ').trim() : ''
  if (!text || text.length > MAX_TEXT_LENGTH || /[\0-\u001f\u007f]/u.test(text)) return null
  if (!Array.isArray(raw.strokes) || !raw.strokes.length || raw.strokes.length > MAX_STROKES_PER_LINE) return null
  let points = 0
  const strokes: Stroke[] = []
  for (const candidate of raw.strokes) {
    if (!candidate || typeof candidate !== 'object') return null
    const stroke = candidate as Record<string, unknown>
    if (!Array.isArray(stroke.points) || !stroke.points.length) return null
    points += stroke.points.length
    if (points > MAX_POINTS_PER_LINE) return null
    strokes.push({
      baseWidth: finite(stroke.baseWidth, 0.25, 80, 3.5),
      pressureEnabled: stroke.pressureEnabled !== false,
      points: stroke.points.map((entry) => {
        const point = (entry ?? {}) as Record<string, unknown>
        return {
          x: finite(point.x, -0.1, 1.1, 0),
          y: finite(point.y, -0.1, 1.1, 0),
          t: finite(point.t, -1e13, 1e13, 0),
          pressure: finite(point.pressure, 0, 1, 0.5),
          tiltX: finite(point.tiltX, -90, 90, 0),
          tiltY: finite(point.tiltY, -90, 90, 0),
          pointerType: typeof point.pointerType === 'string' ? point.pointerType.slice(0, 16) : 'pen',
        }
      }),
    })
  }
  const language = raw.language === 'en' ? 'en' : 'de'
  const id = typeof raw.id === 'string' && /^[\w:.-]{6,120}$/u.test(raw.id)
    ? raw.id
    : `ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const allowedOrigins: InkLineOrigin[] = ['correction', 'confirmed', 'prompt', 'import']
  return {
    id,
    text,
    language,
    strokes,
    sourceWidth: finite(raw.sourceWidth, 16, 40_000, 900),
    sourceHeight: finite(raw.sourceHeight, 16, 80_000, 1_273),
    referenceHeight: finite(raw.referenceHeight, 0, 4_000, 0),
    origin: origin ?? (allowedOrigins.includes(raw.origin as InkLineOrigin) ? raw.origin as InkLineOrigin : 'import'),
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt.length <= 40 ? raw.createdAt : new Date().toISOString(),
  }
}

export const listInkLineSamples = async () => {
  const rows = await transact([LINE_STORE], 'readonly', (transaction) => (
    requestResult(transaction.objectStore(LINE_STORE).getAll() as IDBRequest<InkLineSample[]>)
  ))
  return rows.sort((first, second) => first.createdAt.localeCompare(second.createdAt))
}

export const countInkLineSamples = async () => transact([LINE_STORE], 'readonly', (transaction) => (
  requestResult(transaction.objectStore(LINE_STORE).count())
))

/** Stores samples; the oldest beyond `MAX_INK_LINE_SAMPLES` are dropped. */
export const putInkLineSamples = async (samples: InkLineSample[]) => {
  if (!samples.length) return
  const existing = await listInkLineSamples()
  const overflow = Math.max(0, existing.length + samples.length - MAX_INK_LINE_SAMPLES)
  await transact([LINE_STORE], 'readwrite', (transaction) => {
    const store = transaction.objectStore(LINE_STORE)
    existing.slice(0, overflow).forEach((sample) => store.delete(sample.id))
    samples.forEach((sample) => store.put(sample))
  })
}

export const deleteInkLineSamples = async (ids: string[]) => {
  if (!ids.length) return
  await transact([LINE_STORE], 'readwrite', (transaction) => {
    const store = transaction.objectStore(LINE_STORE)
    ids.forEach((id) => store.delete(id))
  })
}

export const getInkPersonalProfile = async () => transact([META_STORE], 'readonly', (transaction) => (
  requestResult(transaction.objectStore(META_STORE).get('profile') as IDBRequest<InkPersonalProfile | undefined>)
)).then((profile) => profile ?? null)

export const putInkPersonalProfile = async (profile: InkPersonalProfile) => {
  await transact([META_STORE], 'readwrite', (transaction) => {
    transaction.objectStore(META_STORE).put(profile)
  })
}

export const clearInkPersonalData = async () => {
  await transact([LINE_STORE, META_STORE], 'readwrite', (transaction) => {
    transaction.objectStore(LINE_STORE).clear()
    transaction.objectStore(META_STORE).clear()
  })
}
