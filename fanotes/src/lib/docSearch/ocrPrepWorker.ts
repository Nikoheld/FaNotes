/// <reference lib="webworker" />
/**
 * OCR preparation off the main thread: turning a page bitmap, finding its text
 * lines and scoring orientations takes hundreds of milliseconds per page and
 * must not delay typing or pen input.
 */
import { preparePageSync, type Rotation } from './ocrOrientation'

type Request =
  | { id: number; op: 'prepare'; pixels: ArrayBuffer; width: number; height: number; maxLines: number }
  | { id: number; op: 'lines'; rotation: Rotation }
  | { id: number; op: 'release' }

const pages = new Map<number, ReturnType<typeof preparePageSync>>()

const sendLines = (id: number, rotation: Rotation) => {
  const page = pages.get(id)
  if (!page) { postMessage({ id, error: 'released' }); return }
  const lines = page.view(rotation).map((line) => {
    const copy = new Uint8ClampedArray(line.pixels)
    return { pixels: copy.buffer, width: line.width, height: line.height }
  })
  ;(postMessage as (message: unknown, transfer: Transferable[]) => void)({ id, rotation, lines }, lines.map((line) => line.pixels))
}

globalThis.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.op === 'prepare') {
      const page = preparePageSync({ pixels: new Uint8ClampedArray(request.pixels), width: request.width, height: request.height }, request.maxLines)
      pages.set(request.id, page)
      postMessage({ id: request.id, ranked: page.ranked })
      return
    }
    if (request.op === 'lines') { sendLines(request.id, request.rotation); return }
    pages.delete(request.id)
  } catch (error) {
    postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}
