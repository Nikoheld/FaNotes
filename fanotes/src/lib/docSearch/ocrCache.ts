/**
 * Content-addressed OCR results, kept on this device (own IndexedDB, never in the vault).
 * A page is keyed by the SHA-256 of the bitmap that is handed to the OCR plus the engine id, a text
 * line the same way. A moved, renamed or copied PDF, a page repeated in another file and a header
 * line that appears on every page therefore cost one recognition in total, across restarts.
 * The cached text is exactly what the engine returned, so search results do not change.
 */
import { recognizeOriented, type OrientedResult, type PreparePage, type RecognizeLine } from './ocrOrientation'

export type CachedPage = { text: string; confidence: number; lines: number }

export type OcrCacheStore = {
  getPage: (key: string) => Promise<CachedPage | undefined>
  putPage: (key: string, value: CachedPage) => Promise<void>
  getLine: (key: string) => Promise<string | undefined>
  putLine: (key: string, text: string) => Promise<void>
  close: () => void
}

const DB_NAME = 'fanotes-ocr-cache'
const MAX_PAGES = 4000
const MAX_LINES = 60_000
/** Lines shorter than this are cheap to read again and rarely repeat. */
const MIN_CACHED_LINE_PIXELS = 24 * 24

export const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

export const sha256Pixels = async (pixels: Uint8ClampedArray, width: number, height: number) => {
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(0, width)
  new DataView(head.buffer).setUint32(4, height)
  const joined = new Uint8Array(8 + pixels.byteLength)
  joined.set(head)
  joined.set(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), 8)
  return hex(await crypto.subtle.digest('SHA-256', joined))
}

const request = <T,>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error ?? new Error('IndexedDB-Fehler'))
})

export const openOcrCache = async (factory: IDBFactory = indexedDB): Promise<OcrCacheStore> => {
  const open = factory.open(DB_NAME, 1)
  open.onupgradeneeded = () => {
    for (const name of ['pages', 'lines']) open.result.createObjectStore(name, { keyPath: 'key' }).createIndex('at', 'at')
  }
  const db = await request(open)
  const get = async <T,>(store: string, key: string) => {
    const row = await request(db.transaction(store).objectStore(store).get(key)) as ({ key: string; at: number; value: T } | undefined)
    return row?.value
  }
  const put = async (store: string, key: string, value: unknown, max: number) => {
    const tx = db.transaction(store, 'readwrite')
    const objects = tx.objectStore(store)
    objects.put({ key, at: Date.now(), value })
    const counted = await request(objects.count())
    if (counted > max) {
      // Drop the least recently written tenth.
      let drop = Math.ceil(max / 10)
      const cursor = objects.index('at').openKeyCursor()
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = () => {
          const current = cursor.result
          if (!current || drop <= 0) { resolve(); return }
          objects.delete(current.primaryKey)
          drop -= 1
          current.continue()
        }
        cursor.onerror = () => reject(cursor.error)
      })
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  return {
    getPage: (key) => get<CachedPage>('pages', key),
    putPage: (key, value) => put('pages', key, value, MAX_PAGES),
    getLine: (key) => get<string>('lines', key),
    putLine: (key, text) => put('lines', key, text, MAX_LINES),
    close: () => db.close(),
  }
}

/** Wraps a line recognizer with the line cache. Concurrent identical lines share one recognition. */
export const cachedLineRecognizer = (inner: RecognizeLine, store: OcrCacheStore | null, engine: string, beforeWork?: () => Promise<void>): RecognizeLine => {
  const inflight = new Map<string, Promise<string>>()
  return async (pixels, width, height) => {
    const work = async () => { await beforeWork?.(); return inner(pixels, width, height) }
    if (!store || width * height < MIN_CACHED_LINE_PIXELS) return work()
    const key = `${engine}|${await sha256Pixels(pixels, width, height)}`
    const running = inflight.get(key)
    if (running) return running
    const task = (async () => {
      const known = await store.getLine(key).catch(() => undefined)
      if (known !== undefined) return known
      const text = await work()
      await store.putLine(key, text).catch(() => undefined)
      return text
    })().finally(() => { inflight.delete(key) })
    inflight.set(key, task)
    return task
  }
}

export type PageOcrInput = {
  bitmap: { pixels: Uint8ClampedArray; width: number; height: number }
  recognize: RecognizeLine
  store: OcrCacheStore | null
  engine: string
  prepare: PreparePage
  concurrency?: number
  shouldStop?: () => boolean
  /** Awaited before every recognition that is not answered from the cache (user activity, battery). */
  pause?: () => Promise<void>
}

/**
 * One page through the cache: a known bitmap costs nothing, an unknown one is read line by line (known
 * lines are free) and remembered. The text is identical with and without the cache.
 */
export const recognizePageCached = async (input: PageOcrInput): Promise<OrientedResult> => {
  const { bitmap, store, engine } = input
  const shouldStop = input.shouldStop ?? (() => false)
  let pageKey = ''
  if (store) {
    pageKey = `${engine}|${await sha256Pixels(bitmap.pixels, bitmap.width, bitmap.height)}`
    const hit = await store.getPage(pageKey).catch(() => undefined)
    if (hit) return { text: hit.text, confidence: hit.confidence, lines: hit.lines, rotation: 0 }
  }
  const result = await recognizeOriented(bitmap, cachedLineRecognizer(input.recognize, store, engine, input.pause), shouldStop, 40, input.prepare, input.concurrency ?? 1)
  // A pass that was stopped half-way read only some lines; it must not be remembered as the page.
  // A blank result is not remembered either: it is cheap to repeat and must never freeze a failed read.
  if (store && !shouldStop() && result.text.trim()) await store.putPage(pageKey, { text: result.text, confidence: result.confidence, lines: result.lines }).catch(() => undefined)
  return result
}
