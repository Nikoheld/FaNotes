/**
 * Main-thread client for ocrPrepWorker. Falls back to the same code inline if
 * workers are unavailable, so OCR still works (only less smoothly).
 */
import type { PdfOcrLine } from '../pdfOcr'
import { preparePageLocal, type PreparePage, type Rotation } from './ocrOrientation'
import PrepWorker from './ocrPrepWorker?worker&inline'

let worker: Worker | null = null
let broken = false
let sequence = 0
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()

const ensureWorker = () => {
  if (worker || broken) return worker
  try {
    // Inline (blob) worker: Electron cannot start a module worker from file:// inside app.asar, which
    // used to leave this on the main thread (and, after a failed hand-over, with an empty first page).
    worker = new PrepWorker({ name: 'fanotes-ocr-prep' })
    worker.onmessage = (event: MessageEvent<{ id: number; rotation?: Rotation; error?: string }>) => {
      const key = event.data.rotation === undefined ? `${event.data.id}` : `${event.data.id}:${event.data.rotation}`
      const waiter = pending.get(key) ?? pending.get(`${event.data.id}`)
      if (!waiter) return
      pending.delete(key)
      if (event.data.error) waiter.reject(new Error(event.data.error))
      else waiter.resolve(event.data)
    }
    worker.onerror = () => {
      broken = true
      worker?.terminate()
      worker = null
      for (const waiter of pending.values()) waiter.reject(new Error('OCR-Vorbereitung abgebrochen'))
      pending.clear()
    }
  } catch {
    broken = true
    worker = null
  }
  return worker
}

const ask = <T,>(key: string, message: unknown, transfer: Transferable[] = []) => new Promise<T>((resolve, reject) => {
  const target = ensureWorker()
  if (!target) { reject(new Error('no worker')); return }
  pending.set(key, { resolve, reject })
  target.postMessage(message, transfer)
})

export const preparePageInWorker: PreparePage = async (input, maxLines) => {
  if (!ensureWorker()) return preparePageLocal(input, maxLines)
  const id = ++sequence
  // The worker gets its own copy (a memcpy of the page): if it fails, the inline fallback below still
  // has the page. Handing the buffer over would leave the fallback with an empty bitmap.
  const pixels = input.pixels.slice()
  let ranked: Array<[Rotation, number]>
  try {
    ranked = (await ask<{ ranked: Array<[Rotation, number]> }>(`${id}`, { id, op: 'prepare', pixels: pixels.buffer, width: input.width, height: input.height, maxLines }, [pixels.buffer])).ranked
  } catch {
    return preparePageLocal(input, maxLines)
  }
  const cache = new Map<Rotation, Promise<PdfOcrLine[]>>()
  return {
    ranked,
    lines: (rotation) => {
      let found = cache.get(rotation)
      if (!found) {
        found = ask<{ lines: Array<{ pixels: ArrayBuffer; width: number; height: number }> }>(`${id}:${rotation}`, { id, op: 'lines', rotation })
          .then((reply) => reply.lines.map((line) => ({ pixels: new Uint8ClampedArray(line.pixels), width: line.width, height: line.height })))
        cache.set(rotation, found)
      }
      return found
    },
    release: () => { worker?.postMessage({ id, op: 'release' }) },
  }
}
