import TrocrWorker from './trocrWorker?worker&inline'
import { effectiveOcrThreadCount, ocrWorkerKeepAliveMilliseconds } from './resourceLimits'

type TrocrWorkerResponse = {
  id?: string
  text?: string
  candidates?: string[]
  error?: string
}

export type TrocrLineRecognition = {
  text: string
  candidates: string[]
}

type PendingRequest = {
  resolve: (result: TrocrLineRecognition) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof globalThis.setTimeout>
}

let worker: Worker | null = null
let idleTimer: ReturnType<typeof globalThis.setTimeout> | null = null
let unavailableUntil = 0
let desktopRuntimeModuleSourcePromise: Promise<string> | null = null
const pending = new Map<string, PendingRequest>()

const stopWorker = (reason?: Error) => {
  if (idleTimer !== null) globalThis.clearTimeout(idleTimer)
  idleTimer = null
  worker?.terminate()
  worker = null
  pending.forEach((request) => {
    globalThis.clearTimeout(request.timeout)
    request.reject(reason ?? new Error('Die lokale TrOCR-Laufzeit wurde beendet.'))
  })
  pending.clear()
}

const scheduleIdleShutdown = () => {
  if (idleTimer !== null) globalThis.clearTimeout(idleTimer)
  // Reclaim the decoder, encoder and WASM heaps promptly after a conversion.
  // A subsequent conversion can still recreate the lazy worker at any time.
  idleTimer = globalThis.setTimeout(() => stopWorker(), ocrWorkerKeepAliveMilliseconds())
}

const createWorker = () => {
  if (worker) return worker
  // Electron cannot reliably start an ES-module worker directly from inside
  // app.asar/file://. Vite's inline worker is still loaded only with this lazy
  // OCR module, but runs from a CSP-approved blob URL on Desktop and Web.
  const next = new TrocrWorker({
    name: 'fanotes-trocr',
  })
  next.onmessage = (event: MessageEvent<TrocrWorkerResponse>) => {
    const id = event.data?.id
    if (!id) return
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    globalThis.clearTimeout(request.timeout)
    if (typeof event.data.text === 'string') {
      const candidates = Array.isArray(event.data.candidates)
        ? event.data.candidates.filter((entry): entry is string => typeof entry === 'string').slice(0, 4)
        : []
      request.resolve({
        text: event.data.text,
        candidates: candidates.includes(event.data.text)
          ? candidates
          : [event.data.text, ...candidates].slice(0, 4),
      })
    }
    else request.reject(new Error(event.data.error || 'Das lokale TrOCR-Modell hat kein Ergebnis geliefert.'))
    scheduleIdleShutdown()
  }
  next.onerror = () => {
    unavailableUntil = Date.now() + 30_000
    stopWorker(new Error('Der lokale TrOCR-Worker konnte nicht gestartet werden.'))
  }
  worker = next
  return next
}

const recognitionAssetRoot = () => window.fanotes.platform === 'web'
  ? new URL('./ocr/', document.baseURI).href
  : 'fanotes-model://local/'

type RuntimeManifest = {
  assets?: Array<{
    file?: string
    size?: number
    sha256?: string
  }>
}

const bytesToHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (value) => (
  value.toString(16).padStart(2, '0')
)).join('')

const loadVerifiedDesktopRuntimeModule = (root: string) => {
  if (window.fanotes.platform === 'web') return Promise.resolve<string | undefined>(undefined)
  if (!desktopRuntimeModuleSourcePromise) {
    desktopRuntimeModuleSourcePromise = (async () => {
      const moduleName = 'ort-wasm-simd-threaded.mjs'
      const [manifestResponse, moduleResponse] = await Promise.all([
        fetch(new URL('trocr-runtime/manifest.json', root)),
        fetch(new URL(`trocr-runtime/${moduleName}`, root)),
      ])
      if (!manifestResponse.ok || !moduleResponse.ok) {
        throw new Error('Die lokale TrOCR-Laufzeit konnte nicht vollständig geladen werden.')
      }
      const manifest = await manifestResponse.json() as RuntimeManifest
      const asset = manifest.assets?.find((entry) => entry.file === moduleName)
      const bytes = await moduleResponse.arrayBuffer()
      if (
        !asset
        || !Number.isSafeInteger(asset.size)
        || asset.size !== bytes.byteLength
        || bytes.byteLength < 1_000
        || bytes.byteLength > 64 * 1024
        || !/^[a-f0-9]{64}$/u.test(asset.sha256 ?? '')
      ) throw new Error('Das lokale TrOCR-Laufzeitmanifest ist ungültig.')
      const actualDigest = bytesToHex(await globalThis.crypto.subtle.digest('SHA-256', bytes))
      if (actualDigest !== asset.sha256) {
        throw new Error('Die lokale TrOCR-Laufzeit hat die Integritätsprüfung nicht bestanden.')
      }
      return new TextDecoder().decode(bytes)
    })().catch((error) => {
      desktopRuntimeModuleSourcePromise = null
      throw error
    })
  }
  return desktopRuntimeModuleSourcePromise
}

export const recognizeTrocrLineCandidates = async (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  timeoutMs = 60_000,
) => {
  if (Date.now() < unavailableUntil) {
    return Promise.reject(new Error('Das lokale TrOCR-Modell befindet sich nach einem Ladefehler kurz im Fallback-Modus.'))
  }
  if (pixels.byteLength !== width * height * 4) {
    return Promise.reject(new Error('Die gerenderte TrOCR-Zeile besitzt eine ungültige Grösse.'))
  }
  const id = globalThis.crypto?.randomUUID?.() ?? `trocr-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const root = recognitionAssetRoot()
  const modelId = window.fanotes.platform === 'web' ? 'fanotes-trocr-web' : 'fanotes-trocr'
  const runtimeModuleSource = await loadVerifiedDesktopRuntimeModule(root)
  const transferable = Uint8ClampedArray.from(pixels).buffer
  return new Promise<TrocrLineRecognition>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pending.delete(id)
      unavailableUntil = Date.now() + 15_000
      stopWorker(new Error('Die lokale TrOCR-Erkennung hat das Zeitlimit überschritten.'))
      reject(new Error('Die lokale TrOCR-Erkennung hat das Zeitlimit überschritten.'))
    }, Math.max(5_000, Math.min(120_000, timeoutMs)))
    pending.set(id, { resolve, reject, timeout })
    try {
      createWorker().postMessage({
        id,
        pixels: transferable,
        width,
        height,
        modelRoot: root,
        modelId,
        runtimeWasmUrl: new URL('trocr-runtime/ort-wasm-simd-threaded.wasm', root).href,
        runtimeModuleUrl: new URL('trocr-runtime/ort-wasm-simd-threaded.mjs', root).href,
        runtimeModuleSource,
        threads: effectiveOcrThreadCount(window.fanotes.platform === 'web' ? 2 : 4),
      }, [transferable])
    } catch (error) {
      pending.delete(id)
      globalThis.clearTimeout(timeout)
      reject(error instanceof Error ? error : new Error('Der lokale TrOCR-Worker konnte nicht angesprochen werden.'))
    }
  })
}

export const recognizeTrocrLine = async (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  timeoutMs = 60_000,
) => (await recognizeTrocrLineCandidates(pixels, width, height, timeoutMs)).text

export const resetTrocrRecognitionForTests = () => {
  unavailableUntil = 0
  stopWorker()
}
