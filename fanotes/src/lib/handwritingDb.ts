import JSZip from 'jszip'
import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  createEmptyRecognitionModel,
  createMathLayoutExamples,
  resegmentTextTokensForCorrection,
  suggestMathLayoutAssignments,
  type MathLayoutAssignment,
  type MathLayoutExample,
  type RecognitionModel,
  type RecognitionLanguage,
  type RecognitionToken,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import { isSupportedRecognitionLabel } from '../../../src/lib/orthography'
import type { CategoryId, LabelDefinition, Sample, Stroke } from '../../../src/types'
import { getUiLocale } from '../i18n'

const DB_NAME = 'fanotes-handwriting'
const LEGACY_DB_NAME = 'lernwerk-notes-handwriting'
const DB_VERSION = 1
const SAMPLE_STORE = 'samples'
const LAYOUT_STORE = 'layoutExamples'
const LABEL_STORE = 'labels'

// Imports are user-selected files, but they still must be treated as untrusted.
// The limits are deliberately generous enough for a large personal dataset while
// preventing a malformed archive from allocating unbounded renderer memory.
const MAX_ZIP_BYTES = 256 * 1024 * 1024
const MAX_ZIP_ENTRIES = 25_000
const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 300
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_LABELS_BYTES = 4 * 1024 * 1024
const MAX_LAYOUT_BYTES = 8 * 1024 * 1024
const MAX_MANIFEST_RECORDS = 12_000
const MAX_LAYOUT_RECORDS = 50_000
const MAX_LABELS = 2_048
const MAX_JSON_LINE_LENGTH = 128 * 1024
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 192 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 4_096
const MAX_IMAGE_PIXELS = 16_777_216
const MAX_STROKES_PER_SAMPLE = 64
const MAX_POINTS_PER_STROKE = 4_096
const MAX_POINTS_PER_SAMPLE = 20_000
const MAX_WARNING_COUNT = 100
const MAX_ID_LENGTH = 160
const MAX_LABEL_LENGTH = 32
const MAX_NAME_LENGTH = 160
const MAX_LATEX_LENGTH = 512
const MAX_METADATA_LENGTH = 256
const MAX_PATH_LENGTH = 1_024
const MAX_CONTEXT_SAMPLES_PER_LABEL = 16
const MAX_CONTEXT_SAMPLES_TOTAL = 600
const MAX_CONTEXT_SAMPLES_PER_PASS = 12

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const LARGE_OPERATOR_LABEL_IDS = new Set([
  'operator_sum',
  'operator_product',
  'operator_integral',
  'operator_double_integral',
  'operator_triple_integral',
  'operator_contour_integral',
  'operator_big_union',
  'operator_big_intersection',
])

const VALID_CATEGORIES = new Set<CategoryId>([
  'math',
  'digits',
  'uppercase',
  'lowercase',
  'greek',
  'german',
  'custom',
])

let cachedResources: RecognitionResources | null = null
let pendingResources: Promise<RecognitionResources> | null = null

export type GlyphenWerkImportResult = {
  importedSamples: number
  importedLayoutExamples: number
  importedLabels: number
  skippedSamples: number
  warnings: string[]
}

export type RecognitionResources = {
  model: RecognitionModel
  samples: Sample[]
  labels: LabelDefinition[]
  layoutExamples: MathLayoutExample[]
  sampleCount: number
  classCount: number
  baselineSampleCount: number
  modelClassCount: number
}

export type CorrectionLearningResult = {
  learnedSamples: number
  learnedLayouts: number
  reason?: string
}

export type ContextLearningResult = {
  learnedSamples: number
  contextualCorrections: number
  consideredTokens: number
  reason?: string
}

type ManifestRecord = Record<string, unknown>

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Der lokale Handschriftspeicher antwortet nicht.'))
})

const configureDatabase = (database: IDBDatabase) => {
  if (!database.objectStoreNames.contains(SAMPLE_STORE)) {
    const samples = database.createObjectStore(SAMPLE_STORE, { keyPath: 'id' })
    samples.createIndex('labelId', 'labelId', { unique: false })
    samples.createIndex('createdAt', 'createdAt', { unique: false })
  }
  if (!database.objectStoreNames.contains(LAYOUT_STORE)) {
    const layouts = database.createObjectStore(LAYOUT_STORE, { keyPath: 'id' })
    layouts.createIndex('anchorLabelId', 'anchorLabelId', { unique: false })
    layouts.createIndex('createdAt', 'createdAt', { unique: false })
  }
  if (!database.objectStoreNames.contains(LABEL_STORE)) {
    database.createObjectStore(LABEL_STORE, { keyPath: 'id' })
  }
}

const openNamedDatabase = (databaseName: string): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (!('indexedDB' in globalThis)) {
    reject(new Error('IndexedDB ist in dieser Umgebung nicht verfügbar.'))
    return
  }

  const request = indexedDB.open(databaseName, DB_VERSION)
  request.onupgradeneeded = () => configureDatabase(request.result)
  request.onsuccess = () => {
    request.result.onversionchange = () => request.result.close()
    resolve(request.result)
  }
  request.onerror = () => reject(request.error ?? new Error('Der lokale Handschriftspeicher konnte nicht geöffnet werden.'))
})

const databaseExists = async (databaseName: string): Promise<boolean> => {
  const factory = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }
  if (typeof factory.databases !== 'function') return true
  return (await factory.databases()).some((database) => database.name === databaseName)
}

const countStores = async (database: IDBDatabase): Promise<Record<string, number>> => {
  const storeNames = [SAMPLE_STORE, LAYOUT_STORE, LABEL_STORE]
  const transaction = database.transaction(storeNames, 'readonly')
  const counts = await Promise.all(storeNames.map((storeName) => requestResult(transaction.objectStore(storeName).count())))
  return Object.fromEntries(storeNames.map((storeName, index) => [storeName, counts[index]]))
}

const readStoreBatch = (
  database: IDBDatabase,
  storeName: string,
  afterKey?: IDBValidKey,
): Promise<{ values: unknown[]; lastKey?: IDBValidKey; complete: boolean }> => new Promise((resolve, reject) => {
  const transaction = database.transaction(storeName, 'readonly')
  const store = transaction.objectStore(storeName)
  const request = store.openCursor(afterKey === undefined ? undefined : IDBKeyRange.lowerBound(afterKey, true))
  const values: unknown[] = []
  request.onsuccess = () => {
    const cursor = request.result
    if (!cursor) {
      resolve({ values, complete: true })
      return
    }
    values.push(cursor.value)
    if (values.length >= 128) {
      resolve({ values, lastKey: cursor.primaryKey, complete: false })
      return
    }
    cursor.continue()
  }
  request.onerror = () => reject(request.error ?? new Error('Bisherige Handschriftdaten konnten nicht gelesen werden.'))
  transaction.onabort = () => reject(transaction.error ?? new Error('Bisherige Handschriftdaten konnten nicht gelesen werden.'))
})

const writeStoreBatch = (database: IDBDatabase, storeName: string, values: unknown[]): Promise<void> => new Promise((resolve, reject) => {
  const transaction = database.transaction(storeName, 'readwrite')
  const store = transaction.objectStore(storeName)
  for (const value of values) store.put(value)
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error ?? new Error('Handschriftdaten konnten nicht migriert werden.'))
  transaction.onerror = () => reject(transaction.error ?? new Error('Handschriftdaten konnten nicht migriert werden.'))
})

const copyStore = async (source: IDBDatabase, target: IDBDatabase, storeName: string) => {
  let afterKey: IDBValidKey | undefined
  let copied = 0
  for (;;) {
    const batch = await readStoreBatch(source, storeName, afterKey)
    if (batch.values.length) await writeStoreBatch(target, storeName, batch.values)
    copied += batch.values.length
    if (batch.complete) return copied
    afterKey = batch.lastKey
  }
}

const deleteLegacyDatabase = () => new Promise<void>((resolve) => {
  const request = indexedDB.deleteDatabase(LEGACY_DB_NAME)
  request.onsuccess = () => resolve()
  request.onerror = () => resolve()
  request.onblocked = () => resolve()
})

let activeDatabaseName = DB_NAME
let migrationPromise: Promise<void> | null = null

const migrateLegacyDatabase = async () => {
  if (!await databaseExists(LEGACY_DB_NAME)) return
  const source = await openNamedDatabase(LEGACY_DB_NAME)
  const target = await openNamedDatabase(DB_NAME)
  try {
    const sourceCounts = await countStores(source)
    const storeNames = [SAMPLE_STORE, LAYOUT_STORE, LABEL_STORE]
    for (const storeName of storeNames) {
      const copied = await copyStore(source, target, storeName)
      if (copied !== sourceCounts[storeName]) {
        throw new Error('Die bisherige Handschrift-Datenbank hat sich während der Übernahme verändert.')
      }
    }
    const verifiedCounts = await countStores(target)
    if (storeNames.some((storeName) => verifiedCounts[storeName] < sourceCounts[storeName])) {
      throw new Error('Die Übernahme der bisherigen Handschriftdaten ist unvollständig.')
    }
  } finally {
    source.close()
    target.close()
  }
  await deleteLegacyDatabase()
}

const ensureDatabaseMigration = async () => {
  migrationPromise ??= migrateLegacyDatabase().catch((error: unknown) => {
    activeDatabaseName = LEGACY_DB_NAME
    console.warn('FaNotes verwendet die bisherige Handschrift-Datenbank weiter, weil die Migration nicht abgeschlossen werden konnte.', error)
  })
  await migrationPromise
}

const openDatabase = async (): Promise<IDBDatabase> => {
  await ensureDatabaseMigration()
  return openNamedDatabase(activeDatabaseName)
}

const withStore = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(storeName, mode)
    const result = await requestResult(action(transaction.objectStore(storeName)))
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Speichervorgang wurde abgebrochen.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Speichervorgang ist fehlgeschlagen.'))
    })
    return result
  } finally {
    database.close()
  }
}

const writeTrainingBatch = async ({
  samples = [],
  labels = [],
  layouts = [],
}: {
  samples?: Sample[]
  labels?: LabelDefinition[]
  layouts?: MathLayoutExample[]
}) => {
  if (samples.length === 0 && labels.length === 0 && layouts.length === 0) return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [SAMPLE_STORE, LABEL_STORE, LAYOUT_STORE],
        'readwrite',
      )
      try {
        const sampleStore = transaction.objectStore(SAMPLE_STORE)
        const labelStore = transaction.objectStore(LABEL_STORE)
        const layoutStore = transaction.objectStore(LAYOUT_STORE)
        samples.forEach((sample) => sampleStore.put(sample))
        labels.forEach((label) => labelStore.put(label))
        layouts.forEach((layout) => layoutStore.put(layout))
      } catch (error) {
        transaction.abort()
        reject(error)
        return
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Trainingsimport wurde vollständig zurückgerollt.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Trainingsimport konnte nicht gespeichert werden.'))
    })
  } finally {
    database.close()
  }
}

const deleteSamples = async (ids: string[]) => {
  if (ids.length === 0) return
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SAMPLE_STORE, 'readwrite')
      const store = transaction.objectStore(SAMPLE_STORE)
      ids.forEach((id) => store.delete(id))
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Beschädigte Trainingsdaten konnten nicht isoliert werden.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Beschädigte Trainingsdaten konnten nicht isoliert werden.'))
    })
  } finally {
    database.close()
  }
}

const invalidateModel = () => {
  cachedResources = null
  pendingResources = null
}

const finiteNumber = (value: unknown, fallback = 0) => {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

const boundedNumber = (value: unknown, min: number, max: number, fallback = min) => (
  Math.max(min, Math.min(max, finiteNumber(value, fallback)))
)

const nonEmptyString = (value: unknown, fallback = '') => (
  typeof value === 'string' && value.trim() ? value.trim() : fallback
)

const limitedString = (value: unknown, maxLength: number, fallback = '') => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(trimmed)) {
    return fallback
  }
  return trimmed
}

const pushWarning = (warnings: string[], message: string) => {
  if (warnings.length < MAX_WARNING_COUNT) warnings.push(message)
}

const normalizeCategory = (value: unknown): CategoryId => {
  const category = nonEmptyString(value) as CategoryId
  return VALID_CATEGORIES.has(category) ? category : 'custom'
}

const normalizeStrokes = (value: unknown): Stroke[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STROKES_PER_SAMPLE) return null
  const strokes: Stroke[] = []
  let totalPoints = 0
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null
    const raw = candidate as Record<string, unknown>
    if (
      !Array.isArray(raw.points) ||
      raw.points.length === 0 ||
      raw.points.length > MAX_POINTS_PER_STROKE
    ) return null
    totalPoints += raw.points.length
    if (totalPoints > MAX_POINTS_PER_SAMPLE) return null
    const points = [] as Stroke['points']
    for (const entry of raw.points) {
      if (!entry || typeof entry !== 'object') return null
      const point = entry as Record<string, unknown>
      points.push({
        x: boundedNumber(point.x, 0, 1),
        y: boundedNumber(point.y, 0, 1),
        t: finiteNumber(point.t, 0),
        pressure: boundedNumber(point.pressure, 0, 1, 0.5),
        tiltX: boundedNumber(point.tiltX, -90, 90),
        tiltY: boundedNumber(point.tiltY, -90, 90),
        pointerType: limitedString(point.pointerType, 16, 'pen'),
      })
    }
    strokes.push({
      points,
      baseWidth: boundedNumber(raw.baseWidth, 0.25, 80, 4),
      pressureEnabled: raw.pressureEnabled !== false,
    })
  }
  return strokes
}

const parseJsonLines = (
  source: string,
  filename: string,
  warnings: string[],
  maxRecords: number,
) => {
  const records: ManifestRecord[] = []
  const lines = source.split(/\r?\n/u)
  if (lines.length > maxRecords + 1) {
    throw new Error(`${filename} enthält mehr als ${maxRecords.toLocaleString(getUiLocale())} Datensätze.`)
  }
  lines.forEach((line, index) => {
    if (!line.trim()) return
    if (line.length > MAX_JSON_LINE_LENGTH) {
      pushWarning(warnings, `${filename}, Zeile ${index + 1}: Datensatz ist zu groß.`)
      return
    }
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        records.push(value as ManifestRecord)
      } else {
        pushWarning(warnings, `${filename}, Zeile ${index + 1}: kein Objekt.`)
      }
    } catch {
      pushWarning(warnings, `${filename}, Zeile ${index + 1}: ungültiges JSON.`)
    }
  })
  return records
}

const mimeForPath = (path: string): string | null => {
  const lower = path.toLowerCase()
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  return null
}

type SizedZipObject = JSZip.JSZipObject & {
  _data?: { compressedSize?: number; uncompressedSize?: number } | Promise<unknown>
}

const zipEntrySizes = (entry: JSZip.JSZipObject) => {
  const data = (entry as SizedZipObject)._data
  // JSZip represents a genuinely empty archive member as a resolved Promise
  // instead of a CompressedObject. This is how GlyphenWerk's optional empty
  // layout_examples.jsonl is loaded. All non-empty members loaded from an
  // archive retain their central-directory sizes in the CompressedObject.
  if (data instanceof Promise) return { compressed: 0, uncompressed: 0 }
  return {
    compressed: finiteNumber(data?.compressedSize, -1),
    uncompressed: finiteNumber(data?.uncompressedSize, -1),
  }
}

const assertZipEntrySize = (entry: JSZip.JSZipObject, maxBytes: number, label: string) => {
  const { compressed, uncompressed } = zipEntrySizes(entry)
  if (uncompressed < 0 || uncompressed > maxBytes) {
    throw new Error(`${label} ist zu groß oder hat keine verlässliche Größenangabe.`)
  }
  if (
    uncompressed > 1024 * 1024 &&
    compressed >= 0 &&
    uncompressed / Math.max(1, compressed) > MAX_COMPRESSION_RATIO
  ) {
    throw new Error(`${label} hat ein verdächtiges Kompressionsverhältnis.`)
  }
}

const readZipText = async (entry: JSZip.JSZipObject, maxBytes: number, label: string) => {
  assertZipEntrySize(entry, maxBytes, label)
  const bytes = await entry.async('uint8array')
  if (bytes.byteLength > maxBytes) throw new Error(`${label} ist zu groß.`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} ist keine gültige UTF-8-Datei.`)
  }
}

const validateZip = (zip: JSZip) => {
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`Die ZIP enthält mehr als ${MAX_ZIP_ENTRIES.toLocaleString(getUiLocale())} Einträge.`)
  }
  let totalUncompressed = 0
  for (const entry of entries) {
    if (entry.name.length > MAX_PATH_LENGTH || entry.name.includes('\0')) {
      throw new Error('Die ZIP enthält einen ungültigen oder zu langen Dateinamen.')
    }
    if (entry.dir) continue
    const { compressed, uncompressed } = zipEntrySizes(entry)
    if (uncompressed < 0) throw new Error(`Für „${entry.name}“ fehlt eine verlässliche Größenangabe.`)
    totalUncompressed += uncompressed
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new Error('Die entpackten ZIP-Daten überschreiten das sichere Gesamtlimit.')
    }
    if (
      uncompressed > 1024 * 1024 &&
      compressed >= 0 &&
      uncompressed / Math.max(1, compressed) > MAX_COMPRESSION_RATIO
    ) {
      throw new Error(`„${entry.name}“ hat ein verdächtiges Kompressionsverhältnis.`)
    }
  }
}

const decodeBase64 = (value: string) => {
  if (!value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8 || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error('Trainingsbild enthält ungültige oder zu große Base64-Daten.')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('Trainingsbild enthält ungültige Base64-Daten.')
  }
  if (binary.length === 0 || binary.length > MAX_IMAGE_BYTES) {
    throw new Error('Trainingsbild ist leer oder zu groß.')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

const assertImageSignature = (bytes: Uint8Array, mime: string) => {
  const matches = mime === 'image/png'
    ? bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value)
    : mime === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === 'image/webp'
        ? bytes.length >= 12 &&
          String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
          String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
        : false
  if (!matches) throw new Error(`Trainingsbild entspricht nicht dem angegebenen Format ${mime}.`)
}

const decodeImageDimensions = async (bytes: Uint8Array, mime: string) => {
  const ownedBytes = new Uint8Array(bytes.byteLength)
  ownedBytes.set(bytes)
  const blob = new Blob([ownedBytes.buffer], { type: mime })
  let width = 0
  let height = 0
  if (typeof globalThis.createImageBitmap === 'function') {
    const bitmap = await globalThis.createImageBitmap(blob)
    try {
      width = bitmap.width
      height = bitmap.height
    } finally {
      bitmap.close()
    }
  } else if (typeof Image !== 'undefined') {
    const objectUrl = URL.createObjectURL(blob)
    try {
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
        image.onerror = () => reject(new Error('Trainingsbild kann nicht decodiert werden.'))
        image.src = objectUrl
      })
      width = dimensions.width
      height = dimensions.height
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } else {
    // Non-browser test environments cannot perform a codec decode. Electron and
    // Chromium always take one of the branches above; signatures are still checked.
    return { width: 0, height: 0 }
  }
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('Trainingsbild hat ungültige oder zu große Abmessungen.')
  }
  return { width, height }
}

const validatedImage = async (mime: string, bytes: Uint8Array) => {
  if (!ALLOWED_IMAGE_MIME.has(mime) || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Trainingsbild verwendet ein nicht erlaubtes Format oder ist zu groß.')
  }
  assertImageSignature(bytes, mime)
  const dimensions = await decodeImageDimensions(bytes, mime)
  return {
    imageData: `data:${mime};base64,${bytesToBase64(bytes)}`,
    byteLength: bytes.byteLength,
    ...dimensions,
  }
}

const validatedImageFromDataUrl = async (value: string) => {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]*={0,2})$/u.exec(value)
  if (!match) throw new Error('Eingebettetes Trainingsbild muss PNG, JPEG oder WebP als Base64 sein.')
  return validatedImage(match[1], decodeBase64(match[2]))
}

const safeZipPath = (value: unknown) => {
  const raw = limitedString(value, MAX_PATH_LENGTH)
  if (!raw || raw.includes('\\') || raw.startsWith('/') || /^[a-z]:/iu.test(raw)) return ''
  const normalized = raw.replace(/^\.\//u, '')
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return ''
  return segments.join('/')
}

const imageDataFromZip = async (zip: JSZip, record: ManifestRecord) => {
  const embeddedValue = record.imageData || record.image_data
  if (typeof embeddedValue === 'string' && embeddedValue.trim()) {
    if (embeddedValue.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) {
      throw new Error('Eingebettetes Trainingsbild ist zu groß.')
    }
    return validatedImageFromDataUrl(embeddedValue.trim())
  }
  const imagePath = safeZipPath(record.image)
  if (!imagePath) throw new Error('Trainingsdatensatz enthält keinen sicheren Bildpfad.')
  const mime = mimeForPath(imagePath)
  if (!mime) throw new Error('Trainingsbilder müssen PNG, JPEG oder WebP sein.')
  const file = zip.file(imagePath)
  if (!file || file.dir) throw new Error(`Trainingsbild „${imagePath}“ fehlt in der ZIP.`)
  assertZipEntrySize(file, MAX_IMAGE_BYTES, `Trainingsbild „${imagePath}“`)
  const bytes = await file.async('uint8array')
  return validatedImage(mime, bytes)
}

const sampleFromManifest = async (
  zip: JSZip,
  record: ManifestRecord,
  index: number,
): Promise<Sample | null> => {
  const strokes = normalizeStrokes(record.strokes)
  const labelId = limitedString(record.label_id || record.labelId, MAX_ID_LENGTH)
  const label = limitedString(record.unicode || record.label, MAX_LABEL_LENGTH)
  if (!labelId || !label || !isSupportedRecognitionLabel(label, labelId) || !strokes) return null
  const image = await imageDataFromZip(zip, record)

  const bboxValue = record.bbox_normalized || record.bbox
  const bboxArray = Array.isArray(bboxValue) ? bboxValue : []
  const bbox: [number, number, number, number] = [
    boundedNumber(bboxArray[0], 0, 1),
    boundedNumber(bboxArray[1], 0, 1),
    boundedNumber(bboxArray[2], 0.00001, 1, 1),
    boundedNumber(bboxArray[3], 0.00001, 1, 1),
  ]
  const sourceCanvas = record.source_canvas && typeof record.source_canvas === 'object'
    ? record.source_canvas as Record<string, unknown>
    : {}
  const derivedImage = record.derived_image && typeof record.derived_image === 'object'
    ? record.derived_image as Record<string, unknown>
    : {}
  const pointCount = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)

  return {
    id: limitedString(record.sample_id || record.id, MAX_ID_LENGTH, `import-${Date.now()}-${index}`),
    labelId,
    label,
    labelName: limitedString(record.label_name || record.labelName, MAX_NAME_LENGTH, label),
    latex: limitedString(record.latex, MAX_LATEX_LENGTH, label),
    category: normalizeCategory(record.category),
    writerId: limitedString(record.writer_id || record.writerId, MAX_METADATA_LENGTH, 'importiert'),
    sessionId: limitedString(record.session_id || record.sessionId, MAX_METADATA_LENGTH, 'glyphenwerk-import'),
    createdAt: limitedString(record.created_at || record.createdAt, 64, new Date().toISOString()),
    imageData: image.imageData,
    imageWidth: image.width || Math.round(boundedNumber(derivedImage.width || record.imageWidth, 1, MAX_IMAGE_DIMENSION, 256)),
    imageHeight: image.height || Math.round(boundedNumber(derivedImage.height || record.imageHeight, 1, MAX_IMAGE_DIMENSION, 256)),
    sourceCanvas: {
      width: boundedNumber(sourceCanvas.width, 1, 16384, 900),
      height: boundedNumber(sourceCanvas.height, 1, 16384, 560),
      devicePixelRatio: boundedNumber(sourceCanvas.devicePixelRatio, 0.5, 8, 1),
    },
    bbox,
    strokes,
    strokeCount: strokes.length,
    pointCount,
    schemaVersion: 1,
  }
}

const normalizeLabel = (value: unknown): LabelDefinition | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = limitedString(raw.id || raw.label_id, MAX_ID_LENGTH)
  const char = limitedString(raw.char || raw.unicode, MAX_LABEL_LENGTH)
  if (!id || !char || !isSupportedRecognitionLabel(char, id)) return null
  return {
    id,
    char,
    name: limitedString(raw.name || raw.label_name, MAX_NAME_LENGTH, char),
    latex: limitedString(raw.latex, MAX_LATEX_LENGTH, char),
    category: normalizeCategory(raw.category),
  }
}

const normalizeLayoutExample = (value: unknown, index: number): MathLayoutExample | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const anchorLabelId = limitedString(raw.anchorLabelId || raw.anchor_label_id, MAX_ID_LENGTH)
  const childLabelId = limitedString(raw.childLabelId || raw.child_label_id, MAX_ID_LENGTH, '*')
  const role = limitedString(raw.role, 32)
  if (!anchorLabelId || !['upper_limit', 'lower_limit', 'superscript', 'subscript'].includes(role)) return null
  return {
    id: limitedString(raw.id, MAX_ID_LENGTH, `layout-import-${Date.now()}-${index}`),
    anchorLabelId,
    childLabelId,
    role: role as MathLayoutExample['role'],
    relativeCenterX: finiteNumber(raw.relativeCenterX || raw.relative_center_x),
    relativeCenterY: finiteNumber(raw.relativeCenterY || raw.relative_center_y),
    relativeWidth: boundedNumber(raw.relativeWidth || raw.relative_width, 0.001, 20, 1),
    relativeHeight: boundedNumber(raw.relativeHeight || raw.relative_height, 0.001, 20, 1),
    createdAt: limitedString(raw.createdAt || raw.created_at, 64, new Date().toISOString()),
  }
}

const mixHash = (hash: number, value: number) => {
  let next = hash ^ (value | 0)
  next = Math.imul(next, 0x01000193)
  return next >>> 0
}

const mixHashString = (hash: number, value: string) => {
  let next = hash
  for (let index = 0; index < value.length; index += 1) next = mixHash(next, value.charCodeAt(index))
  return next
}

const sampleFingerprint = (sample: Sample) => {
  let first = mixHashString(0x811c9dc5, sample.labelId)
  let second = mixHashString(0x9e3779b9, sample.labelId)
  sample.strokes.forEach((stroke, strokeIndex) => {
    first = mixHash(first, strokeIndex)
    first = mixHash(first, Math.round(stroke.baseWidth * 1000))
    second = mixHash(second, stroke.points.length)
    stroke.points.forEach((point, pointIndex) => {
      const x = Math.round(point.x * 1_000_000)
      const y = Math.round(point.y * 1_000_000)
      const pressure = Math.round(point.pressure * 10_000)
      first = mixHash(mixHash(first, x), y)
      second = mixHash(mixHash(second, pressure), pointIndex)
    })
  })
  first = mixHash(first, sample.imageData.length)
  second = mixHash(second, sample.pointCount)
  return `${sample.labelId}:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

const layoutFingerprint = (layout: MathLayoutExample) => [
  layout.anchorLabelId,
  layout.childLabelId,
  layout.role,
  Math.round(layout.relativeCenterX * 10_000),
  Math.round(layout.relativeCenterY * 10_000),
  Math.round(layout.relativeWidth * 10_000),
  Math.round(layout.relativeHeight * 10_000),
].join(':')

const isStoredSampleSafe = (value: unknown): value is Sample => {
  if (!value || typeof value !== 'object') return false
  const sample = value as Partial<Sample>
  if (
    !limitedString(sample.id, MAX_ID_LENGTH) ||
    !limitedString(sample.labelId, MAX_ID_LENGTH) ||
    !limitedString(sample.label, MAX_LABEL_LENGTH) ||
    typeof sample.imageData !== 'string' ||
    !limitedString(sample.imageData, Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) ||
    !limitedString(sample.labelName, MAX_NAME_LENGTH) ||
    !limitedString(sample.latex, MAX_LATEX_LENGTH) ||
    !VALID_CATEGORIES.has(sample.category as CategoryId) ||
    !limitedString(sample.writerId, MAX_METADATA_LENGTH) ||
    !limitedString(sample.sessionId, MAX_METADATA_LENGTH) ||
    !limitedString(sample.createdAt, 64) ||
    !Number.isInteger(sample.imageWidth) || sample.imageWidth! <= 0 || sample.imageWidth! > MAX_IMAGE_DIMENSION ||
    !Number.isInteger(sample.imageHeight) || sample.imageHeight! <= 0 || sample.imageHeight! > MAX_IMAGE_DIMENSION ||
    !sample.sourceCanvas ||
    !Number.isFinite(sample.sourceCanvas.width) || sample.sourceCanvas.width <= 0 || sample.sourceCanvas.width > 16_384 ||
    !Number.isFinite(sample.sourceCanvas.height) || sample.sourceCanvas.height <= 0 || sample.sourceCanvas.height > 16_384 ||
    !Number.isFinite(sample.sourceCanvas.devicePixelRatio) || sample.sourceCanvas.devicePixelRatio < 0.5 || sample.sourceCanvas.devicePixelRatio > 8 ||
    !Array.isArray(sample.strokes) ||
    sample.strokes.length === 0 ||
    sample.strokes.length > MAX_STROKES_PER_SAMPLE ||
    sample.strokeCount !== sample.strokes.length ||
    typeof sample.pointCount !== 'number' ||
    !Number.isInteger(sample.pointCount) ||
    sample.pointCount <= 0 ||
    sample.pointCount > MAX_POINTS_PER_SAMPLE ||
    sample.schemaVersion !== 1 ||
    !Array.isArray(sample.bbox) ||
    sample.bbox.length !== 4
  ) return false
  const imageMatch = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]*={0,2})$/u.exec(sample.imageData)
  if (!imageMatch || imageMatch[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8) return false
  let points = 0
  for (const stroke of sample.strokes) {
    if (
      !stroke ||
      !Array.isArray(stroke.points) ||
      stroke.points.length === 0 ||
      stroke.points.length > MAX_POINTS_PER_STROKE ||
      !Number.isFinite(stroke.baseWidth) ||
      stroke.baseWidth < 0.25 ||
      stroke.baseWidth > 80 ||
      typeof stroke.pressureEnabled !== 'boolean'
    ) return false
    points += stroke.points.length
    if (points > MAX_POINTS_PER_SAMPLE) return false
    if (stroke.points.some((point) => (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 || point.x > 1 ||
      point.y < 0 || point.y > 1 ||
      !Number.isFinite(point.t) ||
      !Number.isFinite(point.pressure) ||
      point.pressure < 0 || point.pressure > 1 ||
      !Number.isFinite(point.tiltX) ||
      point.tiltX < -90 || point.tiltX > 90 ||
      !Number.isFinite(point.tiltY) ||
      point.tiltY < -90 || point.tiltY > 90 ||
      !limitedString(point.pointerType, 16)
    ))) return false
  }
  if (points !== sample.pointCount) return false
  const [x, y, width, height] = sample.bbox
  return [x, y, width, height].every((number) => Number.isFinite(number)) &&
    x >= 0 && x <= 1 && y >= 0 && y <= 1 && width > 0 && width <= 1 && height > 0 && height <= 1
}

const isStoredLayoutSafe = (value: unknown): value is MathLayoutExample => {
  if (!value || typeof value !== 'object') return false
  const layout = value as Partial<MathLayoutExample>
  return Boolean(
    limitedString(layout.id, MAX_ID_LENGTH) &&
    limitedString(layout.anchorLabelId, MAX_ID_LENGTH) &&
    limitedString(layout.childLabelId, MAX_ID_LENGTH) &&
    layout.role && ['upper_limit', 'lower_limit', 'superscript', 'subscript'].includes(layout.role) &&
    Number.isFinite(layout.relativeCenterX) &&
    Number.isFinite(layout.relativeCenterY) &&
    Number.isFinite(layout.relativeWidth) && layout.relativeWidth! > 0 && layout.relativeWidth! <= 20 &&
    Number.isFinite(layout.relativeHeight) && layout.relativeHeight! > 0 && layout.relativeHeight! <= 20 &&
    limitedString(layout.createdAt, 64)
  )
}

const deduplicateSamples = (samples: Sample[], existing: Sample[]) => {
  const fingerprints = new Set(existing.filter(isStoredSampleSafe).map(sampleFingerprint))
  const occupiedIds = new Map(existing.filter(isStoredSampleSafe).map((sample) => [sample.id, sampleFingerprint(sample)]))
  const unique: Sample[] = []
  for (const sample of samples) {
    const fingerprint = sampleFingerprint(sample)
    if (fingerprints.has(fingerprint)) continue
    let id = sample.id
    if (occupiedIds.has(id) && occupiedIds.get(id) !== fingerprint) {
      const suffix = fingerprint.split(':').at(-1)!.slice(0, 12)
      id = `${id.slice(0, Math.max(1, MAX_ID_LENGTH - suffix.length - 1))}-${suffix}`
    }
    let collision = 2
    const baseId = id
    while (occupiedIds.has(id) && occupiedIds.get(id) !== fingerprint) {
      const suffix = `-${collision++}`
      id = `${baseId.slice(0, Math.max(1, MAX_ID_LENGTH - suffix.length))}${suffix}`
    }
    const candidate = id === sample.id ? sample : { ...sample, id }
    unique.push(candidate)
    fingerprints.add(fingerprint)
    occupiedIds.set(id, fingerprint)
  }
  return unique
}

const deduplicateLayouts = (layouts: MathLayoutExample[], existing: MathLayoutExample[]) => {
  const fingerprints = new Set(existing.filter(isStoredLayoutSafe).map(layoutFingerprint))
  const occupiedIds = new Set(existing.filter(isStoredLayoutSafe).map((layout) => layout.id))
  const unique: MathLayoutExample[] = []
  for (const layout of layouts) {
    const fingerprint = layoutFingerprint(layout)
    if (fingerprints.has(fingerprint)) continue
    let id = layout.id
    if (occupiedIds.has(id)) {
      const suffix = fingerprint.replace(/[^a-z\d]+/giu, '-').slice(-24) || String(unique.length + 1)
      id = `${id.slice(0, Math.max(1, MAX_ID_LENGTH - suffix.length - 1))}-${suffix}`
    }
    const candidate = id === layout.id ? layout : { ...layout, id }
    unique.push(candidate)
    fingerprints.add(fingerprint)
    occupiedIds.add(id)
  }
  return unique
}

export const getHandwritingSamples = async (): Promise<Sample[]> => {
  const samples = await withStore<Sample[]>(SAMPLE_STORE, 'readonly', (store) => store.getAll())
  return samples.sort((first, second) => (
    limitedString((second as Partial<Sample>)?.createdAt, 64)
      .localeCompare(limitedString((first as Partial<Sample>)?.createdAt, 64))
  ))
}

export const getMathLayoutExamples = async (): Promise<MathLayoutExample[]> => {
  const examples = await withStore<MathLayoutExample[]>(LAYOUT_STORE, 'readonly', (store) => store.getAll())
  return examples.sort((first, second) => (
    limitedString((second as Partial<MathLayoutExample>)?.createdAt, 64)
      .localeCompare(limitedString((first as Partial<MathLayoutExample>)?.createdAt, 64))
  ))
}

export const getImportedLabels = async (): Promise<LabelDefinition[]> => (
  withStore<LabelDefinition[]>(LABEL_STORE, 'readonly', (store) => store.getAll())
)

export const putHandwritingSamples = async (samples: Sample[]) => {
  if (samples.length > MAX_MANIFEST_RECORDS) throw new Error('Zu viele Trainingsbeispiele für einen Speichervorgang.')
  const validated: Sample[] = []
  let totalImageBytes = 0
  for (const sample of samples) {
    // Legacy sharp-S samples remain in IndexedDB for non-destructive
    // migration, but new batches never add them to FaNotes' active training.
    if (!isSupportedRecognitionLabel(sample.label, sample.labelId)) continue
    if (!isStoredSampleSafe(sample)) throw new Error('Trainingsbeispiel enthält ungültige oder zu große Stiftdaten.')
    const image = await validatedImageFromDataUrl(sample.imageData)
    totalImageBytes += image.byteLength
    if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('Trainingsbilder überschreiten das sichere Gesamtlimit.')
    validated.push(sample)
  }
  const unique = deduplicateSamples(validated, await getHandwritingSamples())
  await writeTrainingBatch({ samples: unique })
  if (unique.length) invalidateModel()
  return unique.map((sample) => sample.id)
}

export const removeHandwritingSamples = async (ids: string[]) => {
  if (ids.length > MAX_MANIFEST_RECORDS) throw new Error('Zu viele Trainingsbeispiele für einen Löschvorgang.')
  const validatedIds = [...new Set(ids.map((id) => limitedString(id, MAX_ID_LENGTH)).filter(Boolean))]
  if (validatedIds.length !== ids.length) throw new Error('Ungültige Trainingsbeispiel-ID.')
  await deleteSamples(validatedIds)
  if (validatedIds.length) invalidateModel()
}

export const putHandwritingLabels = async (labels: LabelDefinition[]) => {
  if (labels.length > MAX_LABELS) throw new Error('Zu viele benutzerdefinierte Symbolklassen.')
  const baseIds = new Set(BASE_CATALOG.map((label) => label.id))
  const normalized = labels
    .map(normalizeLabel)
    .filter((label): label is LabelDefinition => label !== null && !baseIds.has(label.id))
  if (normalized.length !== labels.length) throw new Error('Symbolklasse enthält ungültige Daten.')
  const unique = [...new Map(normalized.map((label) => [label.id, label])).values()]
  await writeTrainingBatch({ labels: unique })
  if (unique.length) invalidateModel()
  return unique.map((label) => label.id)
}

export const putMathLayoutExamples = async (examples: MathLayoutExample[]) => {
  if (examples.length > MAX_LAYOUT_RECORDS) throw new Error('Zu viele Layout-Beispiele für einen Speichervorgang.')
  const normalized = examples
    .map((example, index) => normalizeLayoutExample(example, index))
    .filter((example): example is MathLayoutExample => example !== null)
  if (normalized.length !== examples.length) throw new Error('Layout-Beispiel enthält ungültige Daten.')
  const unique = deduplicateLayouts(normalized, await getMathLayoutExamples())
  await writeTrainingBatch({ layouts: unique })
  if (unique.length) invalidateModel()
}

export const replaceManagedMathLayoutExamples = async (
  examples: MathLayoutExample[],
  previousIds: string[],
) => {
  if (examples.length > MAX_LAYOUT_RECORDS || previousIds.length > MAX_LAYOUT_RECORDS) {
    throw new Error('Zu viele Layout-Beispiele für einen Speichervorgang.')
  }
  const validatedPreviousIds = [...new Set(
    previousIds.map((id) => limitedString(id, MAX_ID_LENGTH)).filter(Boolean),
  )]
  if (validatedPreviousIds.length !== previousIds.length) throw new Error('Ungültige Layout-Beispiel-ID.')
  const normalized = examples
    .map((example, index) => normalizeLayoutExample(example, index))
    .filter((example): example is MathLayoutExample => example !== null)
  if (normalized.length !== examples.length) throw new Error('Layout-Beispiel enthält ungültige Daten.')

  const previousIdSet = new Set(validatedPreviousIds)
  const existing = (await getMathLayoutExamples()).filter((layout) => !previousIdSet.has(layout.id))
  const unique = deduplicateLayouts(normalized, existing)
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(LAYOUT_STORE, 'readwrite')
      const store = transaction.objectStore(LAYOUT_STORE)
      validatedPreviousIds.forEach((id) => store.delete(id))
      unique.forEach((layout) => store.put(layout))
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('GlyphenWerk-Layouts konnten nicht synchronisiert werden.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('GlyphenWerk-Layouts konnten nicht synchronisiert werden.'))
    })
  } finally {
    database.close()
  }
  if (validatedPreviousIds.length || unique.length) invalidateModel()
  return unique.map((layout) => layout.id)
}

export const clearHandwritingTraining = async () => {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([SAMPLE_STORE, LAYOUT_STORE, LABEL_STORE], 'readwrite')
      transaction.objectStore(SAMPLE_STORE).clear()
      transaction.objectStore(LAYOUT_STORE).clear()
      transaction.objectStore(LABEL_STORE).clear()
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Trainingsdaten konnten nicht gelöscht werden.'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Trainingsdaten konnten nicht gelöscht werden.'))
    })
  } finally {
    database.close()
  }
  invalidateModel()
}

export const importGlyphenWerkZip = async (
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<GlyphenWerkImportResult> => {
  const inputSize = input instanceof Blob ? input.size : input.byteLength
  if (inputSize <= 0) throw new Error('Die Trainings-ZIP ist leer.')
  if (inputSize > MAX_ZIP_BYTES) {
    throw new Error(`Die Trainings-ZIP darf höchstens ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB groß sein.`)
  }

  const zip = await JSZip.loadAsync(input)
  validateZip(zip)
  const manifestFiles = zip.file(/(^|\/)manifest\.jsonl$/iu)
  if (manifestFiles.length === 0) throw new Error('Die ZIP enthält keine manifest.jsonl von GlyphenWerk.')
  if (manifestFiles.length > 1) throw new Error('Die ZIP enthält mehrere manifest.jsonl-Dateien und ist nicht eindeutig.')

  const warnings: string[] = []
  const manifest = parseJsonLines(
    await readZipText(manifestFiles[0], MAX_MANIFEST_BYTES, 'manifest.jsonl'),
    'manifest.jsonl',
    warnings,
    MAX_MANIFEST_RECORDS,
  )
  const parsedSamples: Sample[] = []
  let totalImageBytes = 0
  for (let index = 0; index < manifest.length; index += 1) {
    try {
      const sample = await sampleFromManifest(zip, manifest[index], index)
      if (!sample) {
        pushWarning(warnings, `manifest.jsonl, Datensatz ${index + 1}: Zeichen, Label oder Stiftpunkte sind ungültig.`)
        continue
      }
      const encodedLength = Math.max(0, sample.imageData.length - sample.imageData.indexOf(',') - 1)
      totalImageBytes += Math.floor(encodedLength * 3 / 4)
      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error('Die Trainingsbilder überschreiten das sichere Gesamtlimit.')
      }
      parsedSamples.push(sample)
    } catch (error) {
      if (error instanceof Error && error.message.includes('Gesamtlimit')) throw error
      pushWarning(
        warnings,
        `manifest.jsonl, Datensatz ${index + 1}: ${error instanceof Error ? error.message : 'konnte nicht gelesen werden.'}`,
      )
    }
    if ((index + 1) % 32 === 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
    }
  }

  const labelFiles = zip.file(/(^|\/)labels\.json$/iu)
  if (labelFiles.length > 1) throw new Error('Die ZIP enthält mehrere labels.json-Dateien und ist nicht eindeutig.')
  const parsedLabels: LabelDefinition[] = []
  if (labelFiles[0]) {
    try {
      const raw: unknown = JSON.parse(await readZipText(labelFiles[0], MAX_LABELS_BYTES, 'labels.json'))
      if (!Array.isArray(raw)) throw new Error('labels.json muss eine Liste enthalten.')
      if (raw.length > MAX_LABELS) {
        throw new Error(`labels.json enthält mehr als ${MAX_LABELS.toLocaleString(getUiLocale())} Zeichenklassen.`)
      }
      raw.forEach((entry, index) => {
        const label = normalizeLabel(entry)
        if (label) parsedLabels.push(label)
        else pushWarning(warnings, `labels.json, Eintrag ${index + 1}: ungültige Zeichenklasse.`)
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('Zeichenklassen')) throw error
      pushWarning(warnings, 'labels.json ist ungültig; Zeichen werden aus dem Manifest rekonstruiert.')
    }
  }

  let layoutExamples: MathLayoutExample[] = []
  const layoutFiles = zip.file(/(^|\/)layout_examples\.jsonl$/iu)
  if (layoutFiles.length > 1) throw new Error('Die ZIP enthält mehrere layout_examples.jsonl-Dateien und ist nicht eindeutig.')
  if (layoutFiles[0]) {
    layoutExamples = parseJsonLines(
      await readZipText(layoutFiles[0], MAX_LAYOUT_BYTES, 'layout_examples.jsonl'),
      'layout_examples.jsonl',
      warnings,
      MAX_LAYOUT_RECORDS,
    )
      .map((entry, index) => normalizeLayoutExample(entry, index))
      .filter((example): example is MathLayoutExample => example !== null)
  }

  const [existingSamples, existingLabelsRaw, existingLayouts] = await Promise.all([
    getHandwritingSamples(),
    getImportedLabels(),
    getMathLayoutExamples(),
  ])
  const baseIds = new Set(BASE_CATALOG.map((label) => label.id))
  const canonicalLabels = new Map(BASE_CATALOG.map((label) => [label.id, label]))
  existingLabelsRaw
    .map(normalizeLabel)
    .filter((label): label is LabelDefinition => label !== null && !baseIds.has(label.id))
    .forEach((label) => canonicalLabels.set(label.id, label))

  const labelsToStore: LabelDefinition[] = []
  parsedLabels.forEach((label) => {
    const existing = canonicalLabels.get(label.id)
    if (existing) {
      if (existing.char !== label.char || existing.latex !== label.latex) {
        pushWarning(warnings, `Zeichenklasse „${label.id}“ existiert bereits und wurde nicht überschrieben.`)
      }
      return
    }
    if (canonicalLabels.size - BASE_CATALOG.length >= MAX_LABELS) return
    canonicalLabels.set(label.id, label)
    labelsToStore.push(label)
  })

  parsedSamples.forEach((sample) => {
    if (canonicalLabels.has(sample.labelId)) return
    if (canonicalLabels.size - BASE_CATALOG.length >= MAX_LABELS) return
    const label = normalizeLabel({
      id: sample.labelId,
      char: sample.label,
      name: sample.labelName,
      latex: sample.latex,
      category: sample.category,
    })
    if (!label) return
    canonicalLabels.set(label.id, label)
    labelsToStore.push(label)
  })

  const canonicalSamples = parsedSamples.flatMap((sample) => {
    const label = canonicalLabels.get(sample.labelId)
    if (!label) {
      pushWarning(warnings, `Datensatz „${sample.id}“ wurde wegen zu vieler unbekannter Zeichenklassen übersprungen.`)
      return []
    }
    return [{
      ...sample,
      label: label.char,
      labelName: label.name,
      latex: label.latex,
      category: label.category,
    }]
  })
  const samples = deduplicateSamples(canonicalSamples, existingSamples)

  layoutExamples = layoutExamples.filter((example) => {
    const valid = canonicalLabels.has(example.anchorLabelId) && (
      example.childLabelId === '*' || canonicalLabels.has(example.childLabelId)
    )
    if (!valid) pushWarning(warnings, `Layout-Beispiel „${example.id}“ verweist auf eine unbekannte Zeichenklasse.`)
    return valid
  })
  const layouts = deduplicateLayouts(layoutExamples, existingLayouts)

  await writeTrainingBatch({ samples, labels: labelsToStore, layouts })
  if (samples.length || labelsToStore.length || layouts.length) invalidateModel()

  return {
    importedSamples: samples.length,
    importedLayoutExamples: layouts.length,
    importedLabels: labelsToStore.length,
    skippedSamples: manifest.length - samples.length,
    warnings: warnings.slice(0, 20),
  }
}

const mergedLabels = (imported: LabelDefinition[]) => {
  const result = new Map(
    imported
      .map(normalizeLabel)
      .filter((label): label is LabelDefinition => label !== null)
      .map((label) => [label.id, label]),
  )
  BASE_CATALOG.forEach((label) => result.set(label.id, label))
  return [...result.values()]
}

const buildModelWithIsolation = async (samples: Sample[]) => {
  if (samples.length === 0) {
    return { model: createEmptyRecognitionModel(), samples: [] as Sample[], rejectedIds: [] as string[] }
  }

  const accepted: Sample[] = []
  const rejectedIds: string[] = []
  let model = createEmptyRecognitionModel()
  const addGroup = async (group: Sample[]): Promise<void> => {
    if (group.length === 0) return
    try {
      const candidateModel = await buildRecognitionModel([...accepted, ...group])
      accepted.push(...group)
      model = candidateModel
    } catch {
      if (group.length === 1) {
        rejectedIds.push(group[0].id)
        return
      }
      const middle = Math.ceil(group.length / 2)
      await addGroup(group.slice(0, middle))
      await addGroup(group.slice(middle))
    }
  }
  await addGroup(samples)
  return { model, samples: accepted, rejectedIds }
}

export const loadRecognitionResources = async (force = false): Promise<RecognitionResources> => {
  if (force) invalidateModel()
  if (cachedResources) return cachedResources
  if (pendingResources) return pendingResources

  pendingResources = (async () => {
    const [storedSamples, importedLabels, storedLayoutExamples] = await Promise.all([
      getHandwritingSamples(),
      getImportedLabels(),
      getMathLayoutExamples(),
    ])
    const labels = mergedLabels(importedLabels)
    const structurallyRejectedIds: string[] = []
    const fingerprints = new Set<string>()
    const structurallyValidSamples: Sample[] = []
    for (let index = 0; index < storedSamples.length; index += 1) {
      const sample = storedSamples[index]
      if (!isSupportedRecognitionLabel(sample.label, sample.labelId)) continue
      if (!isStoredSampleSafe(sample)) {
        if (typeof (sample as Partial<Sample>)?.id === 'string') {
          structurallyRejectedIds.push((sample as Partial<Sample>).id!)
        }
        continue
      }
      const fingerprint = sampleFingerprint(sample)
      if (fingerprints.has(fingerprint)) {
        structurallyRejectedIds.push(sample.id)
        continue
      }
      try {
        await validatedImageFromDataUrl(sample.imageData)
        fingerprints.add(fingerprint)
        structurallyValidSamples.push(sample)
      } catch {
        structurallyRejectedIds.push(sample.id)
      }
      if ((index + 1) % 32 === 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
      }
    }
    const supportedLabelIds = new Set(labels.map((label) => label.id))
    const layoutExamples = storedLayoutExamples
      .map((entry, index) => normalizeLayoutExample(entry, index))
      .filter((entry): entry is MathLayoutExample => entry !== null)
      .filter((entry) => supportedLabelIds.has(entry.anchorLabelId) && (
        entry.childLabelId === '*' || supportedLabelIds.has(entry.childLabelId)
      ))
    const isolated = await buildModelWithIsolation(structurallyValidSamples)
    const rejectedIds = [...new Set([...structurallyRejectedIds, ...isolated.rejectedIds])]
    if (rejectedIds.length) {
      await deleteSamples(rejectedIds).catch((error) => {
        console.warn('Beschädigte Handschriftbeispiele wurden ignoriert, konnten aber nicht gelöscht werden.', error)
      })
    }
    const samples = isolated.samples
    const baselineSamples = await createStandardRecognitionSamples(BASE_CATALOG)
    const model = await buildRecognitionModel([...samples, ...baselineSamples])
    const resources = {
      model,
      samples,
      labels,
      layoutExamples,
      sampleCount: samples.length,
      classCount: new Set(samples.map((sample) => sample.labelId)).size,
      baselineSampleCount: baselineSamples.length,
      modelClassCount: new Set(model.map((entry) => entry.labelId)).size,
    }
    cachedResources = resources
    pendingResources = null
    return resources
  })().catch((error) => {
    pendingResources = null
    throw error
  })

  return pendingResources
}

type FractionGlyphRole = 'numerator' | 'denominator'

type CorrectionGlyph = {
  label: LabelDefinition
  fractionRole?: FractionGlyphRole
  relation?: {
    anchorIndex: number
    role: MathLayoutAssignment['role']
  }
}

type MathCorrectionPlan = {
  glyphs: CorrectionGlyph[]
  fractionCount: number
  unmatched: string[]
}

const createLabelLookup = (labels: LabelDefinition[]) => {
  const lookup = new Map<string, LabelDefinition>()
  labels.forEach((label) => {
    const keys = [label.char, label.latex, label.latex.replace(/\{\}$/u, '')]
    keys.filter(Boolean).forEach((key) => {
      if (!lookup.has(key)) lookup.set(key, label)
    })
  })
  return lookup
}

const parseMathCorrection = (
  correction: string,
  labels: LabelDefinition[],
): MathCorrectionPlan => {
  const source = correction.trim().replace(/^\$+|\$+$/gu, '')
  const lookup = createLabelLookup(labels)
  const glyphs: CorrectionGlyph[] = []
  const unmatched: string[] = []
  let cursor = 0
  let fractionCount = 0

  const addGlyph = (label: LabelDefinition, fractionRole?: FractionGlyphRole) => {
    const index = glyphs.length
    glyphs.push({ label, fractionRole })
    return index
  }
  const skipWhitespace = () => {
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
  }
  const readCommand = () => {
    const start = cursor
    cursor += 1
    if (cursor >= source.length) return source.slice(start, cursor)
    if (/[a-z]/iu.test(source[cursor])) {
      while (cursor < source.length && /[a-z]/iu.test(source[cursor])) cursor += 1
    } else {
      cursor += 1
    }
    return source.slice(start, cursor)
  }

  let parseSequence: (stop: string | null, fractionRole?: FractionGlyphRole) => void
  let parseArgument: (fractionRole?: FractionGlyphRole) => { start: number; end: number }

  const markRelation = (
    start: number,
    end: number,
    anchorIndex: number | null,
    role: MathLayoutAssignment['role'],
  ) => {
    if (anchorIndex === null || start === end) return
    for (let index = start; index < end; index += 1) {
      if (!glyphs[index].relation) glyphs[index].relation = { anchorIndex, role }
    }
  }

  const parseAtom = (fractionRole?: FractionGlyphRole): number | null => {
    skipWhitespace()
    if (cursor >= source.length) return null
    if (source[cursor] === '{') {
      cursor += 1
      const start = glyphs.length
      parseSequence('}', fractionRole)
      return start < glyphs.length ? start : null
    }
    if (source[cursor] === '\\') {
      const command = readCommand()
      if ([
        '\\left', '\\right', '\\limits', '\\displaystyle', '\\textstyle',
        '\\scriptstyle', '\\scriptscriptstyle', '\\quad', '\\qquad', '\\enspace',
        '\\thinspace', '\\,', '\\;', '\\:', '\\!', '\\ ',
      ].includes(command)) {
        return null
      }
      if (['\\mathrm', '\\mathbf', '\\mathit', '\\mathsf', '\\mathtt', '\\text', '\\operatorname'].includes(command)) {
        const range = parseArgument(fractionRole)
        return range.start < range.end ? range.start : null
      }
      if (command === '\\frac' || command === '\\dfrac' || command === '\\tfrac') {
        fractionCount += 1
        const numerator = parseArgument('numerator')
        const denominator = parseArgument('denominator')
        return numerator.start < numerator.end
          ? numerator.start
          : denominator.start < denominator.end ? denominator.start : null
      }
      if (command === '\\sqrt') {
        const root = lookup.get('\\sqrt') ?? lookup.get('\\sqrt{}') ?? lookup.get('√')
        const anchorIndex = root ? addGlyph(root, fractionRole) : null
        if (!root) unmatched.push(command)
        skipWhitespace()
        if (source[cursor] === '[') {
          cursor += 1
          const start = glyphs.length
          parseSequence(']', fractionRole)
          markRelation(start, glyphs.length, anchorIndex, 'superscript')
        }
        parseArgument(fractionRole)
        return anchorIndex
      }
      const label = lookup.get(command)
      if (label) return addGlyph(label, fractionRole)
      if (/^\\(?:sin|cos|tan|cot|log|ln|lim|max|min)$/u.test(command)) {
        const start = glyphs.length
        for (const character of command.slice(1)) {
          const characterLabel = lookup.get(character)
          if (characterLabel) addGlyph(characterLabel, fractionRole)
          else unmatched.push(character)
        }
        return start < glyphs.length ? start : null
      }
      unmatched.push(command)
      return null
    }
    if (['}', ']', '_', '^'].includes(source[cursor])) return null
    const character = source[cursor]
    cursor += 1
    const label = lookup.get(character)
    if (label) return addGlyph(label, fractionRole)
    unmatched.push(character)
    return null
  }

  parseArgument = (fractionRole) => {
    skipWhitespace()
    const start = glyphs.length
    if (source[cursor] === '{') {
      cursor += 1
      parseSequence('}', fractionRole)
    } else {
      const before = cursor
      parseAtom(fractionRole)
      if (cursor === before && cursor < source.length) {
        unmatched.push(source[cursor])
        cursor += 1
      }
    }
    return { start, end: glyphs.length }
  }

  parseSequence = (stop, fractionRole) => {
    while (cursor < source.length) {
      skipWhitespace()
      if (stop && source[cursor] === stop) {
        cursor += 1
        return
      }
      const before = cursor
      const anchorIndex = parseAtom(fractionRole)
      if (cursor === before) {
        unmatched.push(source[cursor])
        cursor += 1
        continue
      }
      while (cursor < source.length) {
        skipWhitespace()
        if (source.startsWith('\\limits', cursor)) {
          cursor += '\\limits'.length
          continue
        }
        const marker = source[cursor]
        if (marker !== '_' && marker !== '^') break
        cursor += 1
        const range = parseArgument(fractionRole)
        const anchorLabelId = anchorIndex === null ? '' : glyphs[anchorIndex]?.label.id
        const role: MathLayoutAssignment['role'] = marker === '^'
          ? LARGE_OPERATOR_LABEL_IDS.has(anchorLabelId) ? 'upper_limit' : 'superscript'
          : LARGE_OPERATOR_LABEL_IDS.has(anchorLabelId) ? 'lower_limit' : 'subscript'
        markRelation(range.start, range.end, anchorIndex, role)
      }
    }
    if (stop) unmatched.push(`fehlendes ${stop}`)
  }

  if (source.length > MAX_LATEX_LENGTH) unmatched.push('Korrektur ist zu lang')
  else parseSequence(null)
  return { glyphs, fractionCount, unmatched }
}

type TextCorrectionPlan = {
  targets: LabelDefinition[]
  wordLengths: number[]
}

const textCorrectionTargets = (
  correction: string,
  labels: LabelDefinition[],
): TextCorrectionPlan | null => {
  const lookup = createLabelLookup(labels)
  const targets: LabelDefinition[] = []
  const wordLengths: number[] = []
  for (const word of correction.trim().split(/\s+/u).filter(Boolean)) {
    let wordLength = 0
    for (const character of Array.from(word)) {
      const label = lookup.get(character)
      if (!label) return null
      targets.push(label)
      wordLength += 1
    }
    if (wordLength) wordLengths.push(wordLength)
  }
  return targets.length ? { targets, wordLengths } : null
}

const centerOf = (token: RecognitionToken) => ({
  x: token.bbox[0] + token.bbox[2] / 2,
  y: token.bbox[1] + token.bbox[3] / 2,
})

const likelyFractionBar = (token: RecognitionToken) => {
  const aspect = token.bbox[2] / Math.max(0.001, token.bbox[3])
  return token.layout?.role === 'bar' || (
    aspect >= 3 && (token.labelId === 'operator_minus' || token.bbox[3] <= 0.055)
  )
}

const alignCorrectionGlyphs = (
  tokens: RecognitionToken[],
  plan: MathCorrectionPlan,
): RecognitionToken[] | null => {
  let candidates = tokens.filter((token) => !token.isLayout)
  const excess = candidates.length - plan.glyphs.length
  if (excess > 0 && excess <= plan.fractionCount) {
    const bars = candidates
      .filter(likelyFractionBar)
      .sort((first, second) => (
        second.bbox[2] / Math.max(0.001, second.bbox[3]) -
        first.bbox[2] / Math.max(0.001, first.bbox[3])
      ))
      .slice(0, excess)
    const barIds = new Set(bars.map((token) => token.id))
    candidates = candidates.filter((token) => !barIds.has(token.id))
  }
  if (candidates.length !== plan.glyphs.length) return null

  const sortedTokenIds = [...candidates]
    .sort((first, second) => first.bbox[0] - second.bbox[0] || first.bbox[1] - second.bbox[1])
    .map((token) => token.id)
  const tokenRank = new Map(sortedTokenIds.map((id, index) => [id, index]))
  const mapping: Array<RecognitionToken | undefined> = new Array(plan.glyphs.length)
  const used = new Set<string>()

  const score = (glyphIndex: number, token: RecognitionToken) => {
    const glyph = plan.glyphs[glyphIndex]
    const tokenCenter = centerOf(token)
    const rankScale = Math.max(1, candidates.length - 1)
    let value = Math.abs(glyphIndex / rankScale - (tokenRank.get(token.id) ?? 0) / rankScale) * 0.8
    if (token.labelId === glyph.label.id) value -= 7
    else if (token.char === glyph.label.char) value -= 3
    else if (token.latex === glyph.label.latex) value -= 1.5

    if (glyph.fractionRole) {
      if (token.layout?.role === glyph.fractionRole) value -= 7
      else if (token.layout?.type === 'fraction') value += 7
      value += glyph.fractionRole === 'numerator' ? tokenCenter.y * 3 : (1 - tokenCenter.y) * 3
    }
    if (LARGE_OPERATOR_LABEL_IDS.has(glyph.label.id)) value -= token.bbox[3] * 8
    if (glyph.label.id === 'operator_sqrt') value -= token.bbox[2] * 5 + token.bbox[3] * 2

    if (glyph.relation) {
      const anchor = mapping[glyph.relation.anchorIndex]
      if (anchor) {
        const anchorCenter = centerOf(anchor)
        const above = tokenCenter.y < anchorCenter.y
        const expectsAbove = glyph.relation.role === 'upper_limit' || glyph.relation.role === 'superscript'
        value += above === expectsAbove ? -4 : 9
        const isLimit = glyph.relation.role === 'upper_limit' || glyph.relation.role === 'lower_limit'
        if (isLimit) value += Math.abs(tokenCenter.x - anchorCenter.x) * 4
        else {
          value += tokenCenter.x >= anchorCenter.x - anchor.bbox[2] * 0.15 ? -1 : 4
          value += Math.abs(tokenCenter.x - (anchor.bbox[0] + anchor.bbox[2])) * 1.5
        }
      }
    }
    return value
  }

  const referencedAnchors = new Set(
    plan.glyphs.flatMap((glyph) => glyph.relation ? [glyph.relation.anchorIndex] : []),
  )
  const order = plan.glyphs
    .map((glyph, index) => ({ glyph, index }))
    .sort((first, second) => {
      const firstPriority = first.glyph.relation ? 2 : referencedAnchors.has(first.index) ? 0 : 1
      const secondPriority = second.glyph.relation ? 2 : referencedAnchors.has(second.index) ? 0 : 1
      return firstPriority - secondPriority || first.index - second.index
    })
  order.forEach(({ index }) => {
    const best = candidates
      .filter((token) => !used.has(token.id))
      .map((token) => ({ token, score: score(index, token) }))
      .sort((first, second) => first.score - second.score)[0]?.token
    if (best) {
      mapping[index] = best
      used.add(best.id)
    }
  })
  return mapping.every(Boolean) ? mapping as RecognitionToken[] : null
}

export const learnFromRecognitionCorrection = async (
  tokens: RecognitionToken[],
  correction: string,
  mode: 'math' | 'text',
  labels: LabelDefinition[],
  existingLayoutExamples: MathLayoutExample[] = [],
): Promise<CorrectionLearningResult> => {
  const mathPlan = mode === 'math' ? parseMathCorrection(correction, labels) : null
  const textPlan = mode === 'text' ? textCorrectionTargets(correction, labels) : null
  if (mathPlan?.unmatched.length || (mode === 'text' && !textPlan)) {
    return {
      learnedSamples: 0,
      learnedLayouts: 0,
      reason: 'Die Korrektur enthält Zeichen oder LaTeX-Befehle, die keiner trainierbaren Zeichenklasse entsprechen.',
    }
  }
  const mappedTokens = mathPlan
    ? alignCorrectionGlyphs(tokens, mathPlan)
    : resegmentTextTokensForCorrection(tokens, textPlan?.wordLengths ?? [])
  const targets = mathPlan?.glyphs.map((glyph) => glyph.label) ?? textPlan?.targets ?? []
  if (!mappedTokens || mappedTokens.length === 0 || targets.length !== mappedTokens.length) {
    return {
      learnedSamples: 0,
      learnedLayouts: 0,
      reason: 'Die Korrektur konnte nicht eindeutig auf einzelne handgeschriebene Zeichen aufgeteilt werden.',
    }
  }

  const now = new Date().toISOString()
  const sampleCandidates: Sample[] = []
  for (let index = 0; index < mappedTokens.length; index += 1) {
    const token = mappedTokens[index]
    const target = targets[index]
    const strokes = normalizeStrokes(token.strokes)
    if (!target || !token.imageData || !strokes) continue
    let image: Awaited<ReturnType<typeof validatedImageFromDataUrl>>
    try {
      image = await validatedImageFromDataUrl(token.imageData)
    } catch {
      continue
    }
    const sample: Sample = {
      id: `fanotes-correction-${Date.now()}-${index}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)}`,
      labelId: target.id,
      label: target.char,
      labelName: target.name,
      latex: target.latex,
      category: target.category,
      writerId: 'fanotes-user',
      sessionId: 'recognized-corrections',
      createdAt: now,
      imageData: token.imageData,
      imageWidth: image.width || 256,
      imageHeight: image.height || 256,
      sourceCanvas: {
        width: 900,
        height: 560,
        devicePixelRatio: Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 3),
      },
      bbox: token.bbox.map((value) => boundedNumber(value, 0, 1)) as Sample['bbox'],
      strokes,
      strokeCount: strokes.length,
      pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
      schemaVersion: 1,
    }
    if (isStoredSampleSafe(sample)) sampleCandidates.push(sample)
  }

  const targetByTokenId = new Map(mappedTokens.map((token, index) => [token.id, targets[index]]))
  const correctedTokens = tokens.map((token) => {
    const target = targetByTokenId.get(token.id)
    return target ? {
      ...token,
      labelId: target.id,
      char: target.char,
      name: target.name,
      latex: target.latex,
    } : token
  })
  const explicitAssignments: MathLayoutAssignment[] = mathPlan
    ? mathPlan.glyphs.flatMap((glyph, index) => {
      if (!glyph.relation) return []
      const child = mappedTokens[index]
      const anchor = mappedTokens[glyph.relation.anchorIndex]
      return child && anchor ? [{
        tokenId: child.id,
        anchorId: anchor.id,
        role: glyph.relation.role,
      }] : []
    })
    : []
  const explicitlyAssigned = new Set(explicitAssignments.map((assignment) => assignment.tokenId))
  const fractionTokenIds = new Set(
    mathPlan?.glyphs.flatMap((glyph, index) => glyph.fractionRole ? [mappedTokens[index].id] : []) ?? [],
  )
  const suggestedAssignments = mode === 'math'
    ? suggestMathLayoutAssignments(correctedTokens, existingLayoutExamples).filter((assignment) => (
      !explicitlyAssigned.has(assignment.tokenId) && !fractionTokenIds.has(assignment.tokenId)
    ))
    : []
  const assignments = [...explicitAssignments, ...suggestedAssignments]
  const layoutCandidates = mode === 'math' ? createMathLayoutExamples(correctedTokens, assignments) : []
  const [existingSamples, storedLayouts] = await Promise.all([
    getHandwritingSamples(),
    getMathLayoutExamples(),
  ])
  const samples = deduplicateSamples(sampleCandidates, existingSamples)
  const layouts = deduplicateLayouts(layoutCandidates, [...existingLayoutExamples, ...storedLayouts])
  await writeTrainingBatch({ samples, layouts })
  if (samples.length || layouts.length) invalidateModel()
  return {
    learnedSamples: samples.length,
    learnedLayouts: layouts.length,
    ...(samples.length || layouts.length
      ? {}
      : { reason: 'Diese Korrektur ist bereits im lokalen Training enthalten oder enthält keine wiederverwendbaren Striche.' }),
  }
}

/**
 * Learns only pseudo labels for which the visual recognizer and an exact local
 * dictionary word provide independent evidence. Context samples are capped per
 * class and globally; explicit GlyphenWerk and user-corrected examples remain
 * the dominant training source in buildRecognitionModel.
 */
export const learnFromContextualRecognition = async (
  tokens: RecognitionToken[],
  language: RecognitionLanguage,
  labels: LabelDefinition[],
): Promise<ContextLearningResult> => {
  const eligible = tokens
    .filter((token) => !token.isLayout && token.context?.autoLearn && token.context.knownWord)
    .sort((first, second) => (
      Number(Boolean(second.context?.changed)) - Number(Boolean(first.context?.changed)) ||
      (second.visualConfidence ?? second.confidence) - (first.visualConfidence ?? first.confidence)
    ))
  if (eligible.length === 0) {
    return {
      learnedSamples: 0,
      contextualCorrections: 0,
      consideredTokens: 0,
      reason: 'Keine ausreichend sichere Wortkontext-Entscheidung vorhanden.',
    }
  }

  const existingSamples = await getHandwritingSamples()
  const contextSamples = existingSamples.filter((sample) => sample.sessionId.startsWith('fanotes-context-'))
  const remainingTotal = Math.max(0, MAX_CONTEXT_SAMPLES_TOTAL - contextSamples.length)
  if (remainingTotal === 0) {
    return {
      learnedSamples: 0,
      contextualCorrections: 0,
      consideredTokens: eligible.length,
      reason: 'Das sichere Kontingent für automatische Kontextbeispiele ist gefüllt.',
    }
  }

  const labelMap = new Map(labels.map((label) => [label.id, label]))
  const contextCounts = new Map<string, number>()
  contextSamples.forEach((sample) => {
    contextCounts.set(sample.labelId, (contextCounts.get(sample.labelId) ?? 0) + 1)
  })
  const selected = eligible
    .filter((token) => {
      const count = contextCounts.get(token.labelId) ?? 0
      if (count >= MAX_CONTEXT_SAMPLES_PER_LABEL) return false
      contextCounts.set(token.labelId, count + 1)
      return true
    })
    .slice(0, Math.min(MAX_CONTEXT_SAMPLES_PER_PASS, remainingTotal))

  const now = new Date().toISOString()
  const candidates: Array<{ sample: Sample; changed: boolean }> = []
  for (let index = 0; index < selected.length; index += 1) {
    const token = selected[index]
    const target = labelMap.get(token.labelId)
    const strokes = normalizeStrokes(token.strokes)
    if (!target || !token.imageData || !strokes) continue
    let image: Awaited<ReturnType<typeof validatedImageFromDataUrl>>
    try {
      image = await validatedImageFromDataUrl(token.imageData)
    } catch {
      continue
    }
    const sample: Sample = {
      id: `fanotes-context-${Date.now()}-${index}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)}`,
      labelId: target.id,
      label: target.char,
      labelName: target.name,
      latex: target.latex,
      category: target.category,
      writerId: 'fanotes-local-context',
      sessionId: `fanotes-context-${language}`,
      createdAt: now,
      imageData: token.imageData,
      imageWidth: image.width || 256,
      imageHeight: image.height || 256,
      sourceCanvas: {
        width: 900,
        height: 560,
        devicePixelRatio: Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 3),
      },
      bbox: token.bbox.map((value) => boundedNumber(value, 0, 1)) as Sample['bbox'],
      strokes,
      strokeCount: strokes.length,
      pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
      schemaVersion: 1,
    }
    if (isStoredSampleSafe(sample)) {
      candidates.push({ sample, changed: Boolean(token.context?.changed) })
    }
  }

  const samples = deduplicateSamples(candidates.map((candidate) => candidate.sample), existingSamples)
  const learnedFingerprints = new Set(samples.map(sampleFingerprint))
  const contextualCorrections = candidates.filter((candidate) => (
    candidate.changed && learnedFingerprints.has(sampleFingerprint(candidate.sample))
  )).length
  await writeTrainingBatch({ samples })
  if (samples.length) invalidateModel()
  return {
    learnedSamples: samples.length,
    contextualCorrections,
    consideredTokens: eligible.length,
    ...(samples.length ? {} : { reason: 'Diese sicheren Zeichenformen sind bereits im lokalen Training enthalten.' }),
  }
}
