/**
 * Entry of the hidden OCR host window (see electron/ocr-host.cjs): reads text lines with the local
 * TrOCR model in a small pool of workers. It has no UI and no access to the vault.
 */
import { recognizeTrocrLine, setTrocrMaxWorkers } from '../lib/trocrClient'

type Bridge = {
  workers: number
  onLine: (callback: (id: number, payload: { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number }) => void) => void
  result: (id: number, payload: { text: string } | { error: string }) => void
  ready: () => void
}

const bridge = (window as unknown as { fanotesOcrHost?: Bridge }).fanotesOcrHost
if (bridge) {
  setTrocrMaxWorkers(bridge.workers)
  bridge.onLine((id, payload) => {
    const pixels = new Uint8ClampedArray(payload.pixels.buffer, payload.pixels.byteOffset, payload.pixels.byteLength)
    recognizeTrocrLine(pixels, payload.width, payload.height)
      .then((text) => bridge.result(id, { text }))
      .catch((error) => bridge.result(id, { error: error instanceof Error ? error.message : 'OCR fehlgeschlagen' }))
  })
  bridge.ready()
}
