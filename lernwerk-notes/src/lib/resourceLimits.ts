import type { AppSettings } from '../types'

const clampInteger = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback
}

/**
 * Stores tiny resource preferences on the document root. The OCR modules stay
 * lazy: reading two data attributes when a conversion actually starts avoids
 * importing ONNX/TrOCR code during application startup.
 */
export const applyRendererResourceLimits = (
  settings: Pick<AppSettings, 'ocrThreadLimit' | 'desktopOcrModel' | 'ocrModelKeepAliveSeconds'>,
) => {
  const root = document.documentElement
  root.dataset.fanotesOcrThreads = String(clampInteger(settings.ocrThreadLimit, 0, 4, 0))
  root.dataset.fanotesOcrKeepAliveSeconds = String(
    clampInteger(settings.ocrModelKeepAliveSeconds, 0, 600, 120),
  )
  root.dataset.fanotesDesktopOcrModel = settings.desktopOcrModel === 'compact' ? 'compact' : 'extended'
}

export const useExtendedDesktopOcrModel = () => (
  window.lernwerk.platform !== 'web'
  && document.documentElement.dataset.fanotesDesktopOcrModel !== 'compact'
)

export const effectiveOcrThreadCount = (maximum = 4) => {
  const hardware = Math.max(1, Math.floor(navigator.hardwareConcurrency || 2))
  const safeMaximum = Math.max(1, Math.min(4, Math.floor(maximum)))
  const configured = clampInteger(
    document.documentElement.dataset.fanotesOcrThreads,
    0,
    4,
    0,
  )
  if (configured > 0) return Math.max(1, Math.min(configured, hardware, safeMaximum))
  return Math.max(1, Math.min(safeMaximum, Math.floor(hardware / 2)))
}

export const ocrWorkerKeepAliveMilliseconds = () => {
  const seconds = clampInteger(
    document.documentElement.dataset.fanotesOcrKeepAliveSeconds,
    0,
    600,
    120,
  )
  // A one-millisecond timer still lets all awaited word/line microtasks reuse
  // the worker, then releases the large model immediately after conversion.
  return seconds === 0 ? 1 : seconds * 1_000
}
