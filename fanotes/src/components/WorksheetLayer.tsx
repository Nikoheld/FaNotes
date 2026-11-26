import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Copy, FileText, ImageOff, Maximize2, Minimize2, Replace, Trash2, X } from 'lucide-react'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { WorksheetDocument, WorksheetPlacement, WorksheetTextBox } from '../types'
import { pdfJsDocumentOptions } from '../lib/pdfDocument'
import { WORKSHEET_INKING_CLASS } from '../lib/pdfInkHit'
import { clampSheetAspect, clampSheetPlacement, measurePaperFrame, sheetImageBottom, takeFreshSheetImage } from '../lib/sheetImage'
import { createPdfPagePainter, type PdfPagePainter } from '../lib/pdfPagePainter'
import { resolvePaperZoomScroller, SHEET_ZOOM_REPAINT_DEBOUNCE_MS, watchSheetZoom } from '../lib/paperView'

export type WorksheetLayerHandle = {
  flush: () => Promise<void>
}

const asUint8Array = (value: ArrayBuffer | Uint8Array | ArrayBufferView): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/** Yield so a large fallback decode does not freeze the UI for hundreds of ms. */
const yieldToUi = () => new Promise<void>((resolve) => {
  window.setTimeout(resolve, 0)
})

const decodeBase64ToBytes = async (body: string): Promise<Uint8Array> => {
  const chunkChars = 256 * 1024
  const bytes = new Uint8Array(Math.floor(body.length * 0.75) + 4)
  let offset = 0
  for (let index = 0; index < body.length; index += chunkChars) {
    const binary = atob(body.slice(index, index + chunkChars))
    for (let char = 0; char < binary.length; char += 1) bytes[offset++] = binary.charCodeAt(char)
    if (index + chunkChars < body.length) await yieldToUi()
  }
  return bytes.subarray(0, offset)
}

/**
 * Load PDF bytes from a vault asset source.
 * Prefer the binary IPC (`readAssetBytes`) so the renderer never builds a huge
 * base64 data-URL or runs `atob` on the UI thread. Data-URL / fetch remain fallbacks.
 */
const loadPdfBytes = async (source: string): Promise<Uint8Array> => {
  if (!source) throw new Error('Die PDF-Datei ist leer oder fehlt im Vault.')
  if (source.startsWith('data:')) {
    const comma = source.indexOf(',')
    if (comma < 0) throw new Error('Ungültige PDF-Daten (Data-URL).')
    const header = source.slice(0, comma)
    const body = source.slice(comma + 1)
    if (/;base64/iu.test(header)) return decodeBase64ToBytes(body)
    return new TextEncoder().encode(decodeURIComponent(body))
  }
  const response = await fetch(source)
  if (!response.ok) {
    throw new Error(`PDF konnte nicht geladen werden (HTTP ${response.status}).`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

const loadVaultPdfBytes = async (relativePath: string): Promise<Uint8Array> => {
  const api = window.fanotes
  if (typeof api.readAssetBytes === 'function') {
    const bytes = asUint8Array(await api.readAssetBytes(relativePath))
    if (!bytes.byteLength) throw new Error('Die PDF-Datei ist leer oder fehlt im Vault.')
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice()
  }
  return loadPdfBytes(await api.readAssetDataUrl(relativePath))
}

const RESIZE_DEBOUNCE_MS = 180
const SCROLL_PAINT_THROTTLE_MS = 140
const VIEWPORT_ROOT_MARGIN = '96px 0px'
const HIDE_DEBOUNCE_MS = 360
const DEFAULT_PAGE_RATIO = 297 / 210

type WorksheetLayerProps = {
  document: WorksheetDocument
  inputDisabled?: boolean
  onSave: (document: WorksheetDocument) => Promise<WorksheetDocument>
  onDirtyChange?: (dirty: boolean) => void
  onPageLayoutChange?: () => void
  onRemove?: () => void | Promise<void>
  /** Swaps a picture worksheet for another image file; the host keeps its place on the sheet. */
  onReplace?: (file: File) => void | Promise<void>
  onNotify?: (message: string, kind?: 'success' | 'error' | 'info') => void
}

function PdfPageCanvas({
  pdf,
  number,
  sourcePath,
  onRatio,
  onReady,
}: {
  pdf: PDFDocumentProxy
  number: number
  sourcePath: string
  onRatio: (ratio: number) => void
  onReady: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const baseARef = useRef<HTMLCanvasElement>(null)
  const baseBRef = useRef<HTMLCanvasElement>(null)
  const detailARef = useRef<HTMLCanvasElement>(null)
  const detailBRef = useRef<HTMLCanvasElement>(null)
  const painterRef = useRef<PdfPagePainter | null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    const host = hostRef.current
    const baseA = baseARef.current
    const baseB = baseBRef.current
    const detailA = detailARef.current
    const detailB = detailBRef.current
    if (!host || !baseA || !baseB || !detailA || !detailB) return
    const painter = createPdfPagePainter({
      host,
      base: [baseA, baseB],
      detail: [detailA, detailB],
      label: `PDF-Seite ${number}`,
      pdfium: () => ({ path: sourcePath, pageIndex: number - 1 }),
      onFirstPaint: () => onReadyRef.current(),
    })
    painterRef.current = painter
    return () => {
      painterRef.current = null
      painter.dispose()
    }
  }, [number, sourcePath])

  useEffect(() => {
    let alive = true
    let loaded: PDFPageProxy | null = null
    void pdf.getPage(number).then((page) => {
      if (!alive) {
        page.cleanup()
        return
      }
      loaded = page
      const viewport = page.getViewport({ scale: 1 })
      onRatio(viewport.height / Math.max(1, viewport.width))
      painterRef.current?.setPage(page, 0)
      void painterRef.current?.paint()
    }).catch((error: unknown) => {
      if (alive) console.error(`PDF-Seite ${number} konnte nicht geladen werden.`, error)
    })
    return () => {
      alive = false
      painterRef.current?.setPage(null, 0)
      try { loaded?.cleanup() } catch { /* ignore */ }
      loaded = null
    }
  }, [number, onRatio, pdf])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let layoutTimer = 0
    let scrollTimer = 0
    const paint = () => { void painterRef.current?.paint() }
    const scheduleLayout = () => {
      if (layoutTimer) window.clearTimeout(layoutTimer)
      layoutTimer = window.setTimeout(() => {
        layoutTimer = 0
        paint()
      }, RESIZE_DEBOUNCE_MS)
    }
    const scheduleScroll = () => {
      if (scrollTimer) return
      scrollTimer = window.setTimeout(() => {
        scrollTimer = 0
        paint()
      }, SCROLL_PAINT_THROTTLE_MS)
    }
    const observer = new ResizeObserver(scheduleLayout)
    observer.observe(host)
    const scheduleZoom = () => {
      if (layoutTimer) window.clearTimeout(layoutTimer)
      layoutTimer = window.setTimeout(() => {
        layoutTimer = 0
        paint()
      }, SHEET_ZOOM_REPAINT_DEBOUNCE_MS)
    }
    const stopZoom = watchSheetZoom(host, scheduleZoom)
    const scroller = resolvePaperZoomScroller(host)
    scroller?.addEventListener('scroll', scheduleScroll, { passive: true })
    return () => {
      observer.disconnect()
      stopZoom()
      scroller?.removeEventListener('scroll', scheduleScroll)
      if (layoutTimer) window.clearTimeout(layoutTimer)
      if (scrollTimer) window.clearTimeout(scrollTimer)
    }
  }, [])

  return (
    <div className="worksheet-pdf-canvas-host" ref={hostRef}>
      <canvas ref={baseARef} aria-label={`PDF-Seite ${number}`} />
      <canvas ref={baseBRef} aria-hidden="true" />
      <canvas ref={detailARef} aria-hidden="true" />
      <canvas ref={detailBRef} aria-hidden="true" />
    </div>
  )
}

function PdfPage({
  pdf,
  number,
  defaultRatio,
  sourcePath,
  onReady,
}: {
  pdf: PDFDocumentProxy
  number: number
  defaultRatio: number
  sourcePath: string
  onReady: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<number | null>(null)
  const [mounted, setMounted] = useState(false)
  const [ratio, setRatio] = useState(defaultRatio)

  const handleRatio = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0) return
    setRatio((current) => (Math.abs(current - next) < 0.002 ? current : next))
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new IntersectionObserver(
      (entries) => {
        const next = Boolean(entries[0]?.isIntersecting)
        if (next) {
          if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current)
            hideTimerRef.current = null
          }
          setMounted(true)
          return
        }
        if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null
          setMounted(false)
        }, HIDE_DEBOUNCE_MS)
      },
      { root: host.closest('.unified-note-view') as Element | null, rootMargin: VIEWPORT_ROOT_MARGIN, threshold: 0.01 },
    )
    observer.observe(host)
    return () => {
      observer.disconnect()
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    }
  }, [])

  return (
    <div
      className={`worksheet-pdf-page ${mounted ? 'is-visible' : 'is-virtualized'}`}
      ref={hostRef}
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      {mounted && <PdfPageCanvas pdf={pdf} number={number} sourcePath={sourcePath} onRatio={handleRatio} onReady={onReady} />}
    </div>
  )
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Gesture = {
  kind: 'move' | 'resize'
  corner: Corner
  pointerId: number
  startX: number
  startY: number
  start: WorksheetPlacement | null
  unit: number
  moved: boolean
}
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const DRAG_THRESHOLD_PX = 3
const NUDGE = 0.004

const isEditableTarget = (target: EventTarget | null) => (
  target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], .cm-editor'))
)

const mimeOfDataUrl = (source: string) => /^data:([^;,]+)/iu.exec(source)?.[1] ?? 'image/png'

/** Registers this layer's reach on the paper so the sheet grows to hold a floating picture. */
const syncSheetExtent = (paper: HTMLElement | null) => {
  if (!paper) return
  let extent = 0
  paper.querySelectorAll<HTMLElement>('[data-sheet-extent]').forEach((node) => {
    extent = Math.max(extent, Number(node.dataset.sheetExtent) || 0)
  })
  if (extent > 0) {
    paper.style.setProperty('--sheet-image-extent', extent.toFixed(4))
    paper.dataset.sheetImages = '1'
  } else {
    paper.style.removeProperty('--sheet-image-extent')
    delete paper.dataset.sheetImages
  }
}

export const WorksheetLayer = forwardRef<WorksheetLayerHandle, WorksheetLayerProps>(function WorksheetLayer({
  document: initialDocument,
  inputDisabled = false,
  onSave,
  onDirtyChange,
  onPageLayoutChange,
  onRemove,
  onReplace,
  onNotify,
}, forwardedRef) {
  const [document, setDocument] = useState(initialDocument)
  const [source, setSource] = useState('')
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(() => takeFreshSheetImage(initialDocument.id))
  const [draft, setDraft] = useState<WorksheetPlacement | null>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [oneNoteScale, setOneNoteScale] = useState(1)
  const [pageRatio, setPageRatio] = useState(DEFAULT_PAGE_RATIO)
  const layerRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const draftRef = useRef<WorksheetPlacement | null>(null)
  const documentRef = useRef(document)
  const dirtyRef = useRef(false)
  const revisionRef = useRef(0)
  const saveTimerRef = useRef<number | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pdfTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const oneNotePageRef = useRef<HTMLDivElement>(null)
  const layoutNotifyTimerRef = useRef<number | null>(null)
  const isImage = initialDocument.kind === 'image'

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
    onDirtyChange?.(dirty)
  }, [onDirtyChange])

  const notifyLayout = useCallback(() => {
    // Coalesce per-page ready events so the note layout is measured once, not N times.
    if (!onPageLayoutChange) return
    if (layoutNotifyTimerRef.current !== null) window.clearTimeout(layoutNotifyTimerRef.current)
    layoutNotifyTimerRef.current = window.setTimeout(() => {
      layoutNotifyTimerRef.current = null
      onPageLayoutChange()
    }, 80)
  }, [onPageLayoutChange])

  const saveNow = useCallback(async () => {
    if (!dirtyRef.current) {
      await saveQueueRef.current
      return
    }
    const revision = revisionRef.current
    const snapshot = { ...documentRef.current, updatedAt: new Date().toISOString() }
    const run = async () => {
      const saved = await onSave(snapshot)
      if (revisionRef.current === revision) {
        documentRef.current = saved
        setDocument(saved)
        setDirty(false)
      }
    }
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(run)
    await saveQueueRef.current
  }, [onSave, setDirty])

  useImperativeHandle(forwardedRef, () => ({
    flush: async () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      await saveNow()
    },
  }), [saveNow])

  const updateDocument = useCallback((update: (current: WorksheetDocument) => WorksheetDocument) => {
    const next = update(documentRef.current)
    documentRef.current = next
    revisionRef.current += 1
    setDocument(next)
    setDirty(true)
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void saveNow().catch(() => undefined)
    }, 650)
  }, [saveNow, setDirty])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setPdf(null)
    const load = initialDocument.kind === 'pdf'
      ? loadVaultPdfBytes(initialDocument.sourceRelativePath).then((bytes) => ({ kind: 'pdf' as const, bytes }))
      : initialDocument.kind === 'html'
        // Verified and policy-guarded by the main process; shown through srcdoc, which frame-src does not cover.
        ? window.fanotes.readWorksheetHtml(initialDocument.id).then((html) => ({ kind: 'asset' as const, dataUrl: html }))
        : window.fanotes.readAssetDataUrl(initialDocument.sourceRelativePath).then((dataUrl) => ({ kind: 'asset' as const, dataUrl }))
    void load
      .then(async (payload) => {
        if (!alive) return
        if (payload.kind === 'asset') {
          setSource(payload.dataUrl)
          setLoading(false)
          return
        }
        if (!payload.bytes.length) throw new Error('Die PDF-Datei ist leer.')
        const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
        if (!alive) return
        GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const copy = payload.bytes.buffer.byteLength === payload.bytes.byteLength
          ? payload.bytes
          : payload.bytes.slice()
        const task = getDocument({
          data: copy,
          disableAutoFetch: true,
          disableStream: true,
          disableRange: true,
          ...pdfJsDocumentOptions(),
        })
        pdfTaskRef.current = task
        const loaded = await task.promise
        if (!alive) {
          await task.destroy()
          return
        }
        if (loaded.numPages > 250) {
          await task.destroy()
          throw new Error('PDFs mit mehr als 250 Seiten werden nicht als Arbeitsblatt geöffnet.')
        }
        try {
          const first = await loaded.getPage(1)
          if (alive) {
            const viewport = first.getViewport({ scale: 1 })
            setPageRatio(viewport.height / Math.max(1, viewport.width))
          }
        } catch {
          // Keep the A4 fallback; visible pages measure themselves.
        }
        setPdf(loaded)
        setLoading(false)
        notifyLayout()
      })
      .catch((reason: unknown) => {
        if (!alive) return
        const message = reason instanceof Error ? reason.message : 'Das Arbeitsblatt konnte nicht geöffnet werden.'
        const friendly = /failed to fetch/iu.test(message)
          ? 'PDF konnte nicht gelesen werden. Bitte erneut importieren oder eine kleinere Datei wählen.'
          : message
        setError(friendly)
        setLoading(false)
      })
    return () => {
      alive = false
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      if (layoutNotifyTimerRef.current !== null) window.clearTimeout(layoutNotifyTimerRef.current)
      const task = pdfTaskRef.current
      pdfTaskRef.current = null
      void task?.destroy().catch(() => undefined)
    }
  }, [initialDocument.kind, initialDocument.sourceRelativePath, notifyLayout])

  useEffect(() => {
    if (initialDocument.kind !== 'html') return
    const page = oneNotePageRef.current
    if (!page) return
    const updateScale = () => setOneNoteScale(Math.max(0.05, page.clientWidth / (initialDocument.pageWidth ?? 900)))
    const observer = new ResizeObserver(updateScale)
    observer.observe(page)
    updateScale()
    return () => observer.disconnect()
  }, [initialDocument.kind, initialDocument.pageWidth, source])

  // --- Picture geometry -----------------------------------------------------------------------------------------

  const placement = draft ?? document.placement ?? null
  const floating = isImage && Boolean(placement)
  const aspect = clampSheetAspect(document.aspect ?? (natural ? natural.height / Math.max(1, natural.width) : 0.75))

  // A floating picture reserves its room on the sheet, so the paper is long enough to scroll to it.
  useLayoutEffect(() => {
    const layer = layerRef.current
    const paper = layer?.closest<HTMLElement>('.unified-paper') ?? null
    if (!layer || !paper) return
    if (floating && placement) layer.dataset.sheetExtent = String(sheetImageBottom(placement, aspect) + 0.3)
    else delete layer.dataset.sheetExtent
    syncSheetExtent(paper)
    return () => {
      delete layer.dataset.sheetExtent
      syncSheetExtent(paper)
    }
  }, [floating, placement, aspect])

  // The contextual bar sits above the picture, or below / inside it when there is no room, and never leaves the view.
  useLayoutEffect(() => {
    const bar = barRef.current
    const layer = layerRef.current
    if (!selected || !bar || !layer) return
    const paper = layer.closest<HTMLElement>('.unified-paper')
    const view = resolvePaperZoomScroller(layer)
    if (!paper || !view) return
    bar.dataset.side = 'above'
    bar.style.setProperty('--bar-shift', '0px')
    const viewRect = view.getBoundingClientRect()
    const paperRect = paper.getBoundingClientRect()
    let rect = bar.getBoundingClientRect()
    if (rect.top < viewRect.top + 4) {
      bar.dataset.side = 'below'
      rect = bar.getBoundingClientRect()
      if (rect.bottom > viewRect.bottom - 4) {
        bar.dataset.side = 'inside'
        rect = bar.getBoundingClientRect()
      }
    }
    const zoom = measurePaperFrame(paper).zoom || 1
    const left = Math.max(paperRect.left, viewRect.left) + 4
    const right = Math.min(paperRect.right, viewRect.right) - 4
    let shift = 0
    if (rect.left < left) shift = left - rect.left
    else if (rect.right > right) shift = right - rect.right
    if (shift) bar.style.setProperty('--bar-shift', `${shift / zoom}px`)
  }, [selected, placement, floating, loading])

  // The chip and remove button of a document ride along at the top of the part that is in view (never below the
  // layer's end), so a long PDF keeps them within reach. The offset is computed from the paper scroller's position
  // (rAF-throttled, only while the worksheet is hovered, focused or selected), which also holds under the zoomed plane.
  const chromeRef = useRef<HTMLDivElement>(null)
  const [chromeActive, setChromeActive] = useState(false)
  useEffect(() => {
    const layer = layerRef.current
    const chrome = chromeRef.current
    if (isImage || !layer || !chrome || (!chromeActive && !selected && !inputDisabled)) return
    const view = resolvePaperZoomScroller(layer)
    let frame = 0
    const place = () => {
      frame = 0
      const layerBox = layer.getBoundingClientRect()
      const viewBox = view?.getBoundingClientRect()
      const zoom = layer.offsetHeight > 0 ? layerBox.height / layer.offsetHeight : 1
      const wanted = ((Math.max(viewBox?.top ?? 0, 0) - layerBox.top) / (zoom || 1)) + 10
      const limit = Math.max(10, layer.offsetHeight - chrome.offsetHeight - 10)
      chrome.style.top = `${Math.min(limit, Math.max(10, wanted))}px`
    }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(place) }
    place()
    view?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      view?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [chromeActive, inputDisabled, isImage, selected, loading, pdf])

  const selectObject = useCallback(() => {
    setSelected(true)
    // Keys must reach the object, not a text caret that is still blinking in the note.
    window.setTimeout(() => frameRef.current?.focus({ preventScroll: true }), 0)
  }, [])

  // A picture that was just pasted starts selected, with the keys already on it.
  useEffect(() => {
    if (!selected) return
    const frame = frameRef.current
    if (!frame) return
    frame.focus({ preventScroll: true })
    // Bring it to the middle of the view when it landed (partly) outside; the paper scroller is the one to move.
    const view = resolvePaperZoomScroller(frame)
    const scrollToFrame = () => {
      if (!view) return
      const box = frame.getBoundingClientRect()
      const port = view.getBoundingClientRect()
      if (box.top >= port.top + 56 && box.bottom <= port.bottom - 16) return
      view.scrollTop += box.top + box.height / 2 - (port.top + port.height / 2)
    }
    window.requestAnimationFrame(scrollToFrame)
    window.setTimeout(scrollToFrame, 250)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pictures can only be picked with a mouse or a finger; with the pen layer open the layer is inert and deselects.
  useEffect(() => {
    if (inputDisabled) setSelected(false)
  }, [inputDisabled])

  useEffect(() => {
    if (!selected) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && layerRef.current?.contains(event.target)) return
      setSelected(false)
    }
    globalThis.document.addEventListener('pointerdown', onPointerDown, true)
    return () => globalThis.document.removeEventListener('pointerdown', onPointerDown, true)
  }, [selected])

  const commitPlacement = useCallback((next: WorksheetPlacement) => {
    const clamped = clampSheetPlacement(next)
    updateDocument((current) => ({ ...current, placement: clamped, aspect: clampSheetAspect(current.aspect ?? aspect) }))
  }, [aspect, updateDocument])

  /** A picture that still sits in the flow becomes a floating one where it stands now. */
  const currentPlacement = useCallback((): { placement: WorksheetPlacement; unit: number } | null => {
    const frame = frameRef.current
    const paper = layerRef.current?.closest<HTMLElement>('.unified-paper')
    if (!frame || !paper) return null
    const paperFrame = measurePaperFrame(paper)
    const rect = frame.getBoundingClientRect()
    const stored = documentRef.current.placement
    if (stored) return { placement: stored, unit: paperFrame.unit }
    return {
      unit: paperFrame.unit,
      placement: clampSheetPlacement({
        x: (rect.left - paperFrame.left) / paperFrame.unit,
        y: (rect.top - paperFrame.top) / paperFrame.unit,
        width: rect.width / paperFrame.unit,
      }),
    }
  }, [])

  const beginGesture = (kind: Gesture['kind'], corner: Corner, event: ReactPointerEvent<HTMLElement>) => {
    if (inputDisabled || event.button !== 0) return false
    const current = currentPlacement()
    if (!current) return false
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = { kind, corner, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, start: current.placement, unit: current.unit, moved: false }
    return true
  }

  const onFramePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (inputDisabled || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.sheet-image-bar, .sheet-image-handle, .worksheet-textbox, .worksheet-highlight')) return
    const wasSelected = selected
    selectObject()
    // A first touch on a picture only selects it, so it can still be scrolled past; the next touch drags.
    if (event.pointerType === 'touch' && !wasSelected) return
    beginGesture('move', 'se', event)
  }

  const onHandlePointerDown = (corner: Corner) => (event: ReactPointerEvent<HTMLElement>) => {
    beginGesture('resize', corner, event)
  }

  const moveGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !gesture.start) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    gesture.moved = true
    const start = gesture.start
    let next: WorksheetPlacement
    if (gesture.kind === 'move') {
      next = clampSheetPlacement({ ...start, x: start.x + dx / gesture.unit, y: start.y + dy / gesture.unit })
    } else {
      // Aspect-locked: the horizontal pull sets the width, the opposite corner stays where it is.
      const west = gesture.corner === 'nw' || gesture.corner === 'sw'
      const north = gesture.corner === 'nw' || gesture.corner === 'ne'
      const right = start.x + start.width
      // The opposite corner stays put, so the picture can only grow until it meets the sheet's edge.
      const width = Math.min(west ? right : 1 - start.x, Math.max(0.08, start.width + (west ? -dx : dx) / gesture.unit))
      const bottom = start.y + start.width * aspect
      next = clampSheetPlacement({
        width,
        x: west ? right - width : start.x,
        y: north ? bottom - width * aspect : start.y,
      })
    }
    draftRef.current = next
    setDraft(next)
  }

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const next = draftRef.current
    draftRef.current = null
    if (gesture.moved && next) {
      commitPlacement(next)
    }
    setDraft(null)
  }

  const cancelGesture = () => {
    gestureRef.current = null
    draftRef.current = null
    setDraft(null)
  }

  const removeObject = useCallback(() => {
    if (!onRemove) return
    setSelected(false)
    void Promise.resolve(onRemove())
  }, [onRemove])

  const toggleFit = () => {
    const current = currentPlacement()
    if (!current) return
    const frame = frameRef.current
    const paper = layerRef.current?.closest<HTMLElement>('.unified-paper')
    if (!frame || !paper || !natural) return
    const layoutUnit = frame.offsetWidth / Math.max(0.01, current.placement.width)
    const original = Math.min(1, Math.max(0.08, natural.width / Math.max(1, layoutUnit)))
    const fitted = current.placement.width < 0.98
    const width = fitted ? 1 : original
    // Grow or shrink around the picture's centre, so it does not jump out of sight.
    const centre = current.placement.x + current.placement.width / 2
    commitPlacement({ width, x: fitted ? 0 : centre - width / 2, y: current.placement.y })
  }

  const onFrameKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (inputDisabled || event.target !== event.currentTarget) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      removeObject()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setSelected(false)
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelected(true)
      return
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const direction = arrows[event.key]
    if (!direction || !selected) return
    event.preventDefault()
    event.stopPropagation()
    const current = currentPlacement()
    if (!current) return
    const step = event.shiftKey ? NUDGE * 5 : NUDGE
    commitPlacement({ ...current.placement, x: current.placement.x + direction[0] * step, y: current.placement.y + direction[1] * step })
  }

  // Delete also works when focus drifted to the page body (not into the note's own text).
  useEffect(() => {
    if (!selected || !isImage || inputDisabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (isEditableTarget(event.target) || event.target === frameRef.current) return
      if (event.target instanceof HTMLElement && event.target.closest('button, a, [role="dialog"]')) return
      event.preventDefault()
      removeObject()
    }
    globalThis.document.addEventListener('keydown', onKeyDown)
    return () => globalThis.document.removeEventListener('keydown', onKeyDown)
  }, [inputDisabled, isImage, removeObject, selected])

  const copyImage = async () => {
    try {
      const bytes = await loadPdfBytes(source)
      const blob = new Blob([bytes as BlobPart], { type: mimeOfDataUrl(source) })
      let png = blob
      if (blob.type !== 'image/png') {
        const bitmap = await createImageBitmap(blob)
        const canvas = globalThis.document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        bitmap.close()
        png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('png'))), 'image/png'))
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      onNotify?.('Bild in die Zwischenablage kopiert.', 'success')
    } catch {
      onNotify?.('Das Bild ließ sich nicht kopieren.', 'error')
    }
  }

  // --- Legacy text boxes and marks (still shown, edited and deleted; new ones come from the main toolbar) ----------

  const removeHighlight = useCallback((id: string) => {
    updateDocument((current) => ({ ...current, highlights: (current.highlights ?? []).filter((mark) => mark.id !== id) }))
  }, [updateDocument])

  const renderHighlights = (page: number) => (document.highlights ?? []).filter((mark) => mark.page === page).map((mark) => (
    <div
      className="worksheet-highlight"
      key={mark.id}
      style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%`, width: `${mark.width * 100}%`, height: `${mark.height * 100}%`, background: mark.color }}
    >
      {!inputDisabled && (
        <button type="button" aria-label="Markierung entfernen" onPointerDown={(event) => event.stopPropagation()} onClick={() => removeHighlight(mark.id)}>
          <X size={11} />
        </button>
      )}
    </div>
  ))

  const updateTextBox = useCallback((id: string, changes: Partial<WorksheetTextBox>) => {
    updateDocument((current) => ({ ...current, textBoxes: current.textBoxes.map((box) => box.id === id ? { ...box, ...changes } : box) }))
  }, [updateDocument])

  const removeTextBox = useCallback((id: string) => {
    updateDocument((current) => ({ ...current, textBoxes: current.textBoxes.filter((box) => box.id !== id) }))
  }, [updateDocument])

  const renderTextBoxes = (page: number) => document.textBoxes.filter((box) => box.page === page).map((box) => (
    <div className="worksheet-textbox" key={box.id} style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%` }}>
      <textarea
        data-worksheet-textbox={box.id}
        value={box.text}
        onChange={(event) => updateTextBox(box.id, { text: event.target.value })}
        onPointerDown={(event) => event.stopPropagation()}
        placeholder="Antwort eingeben …"
        style={{ fontSize: `${box.fontSize}px` }}
        spellCheck
        disabled={inputDisabled}
      />
      {!inputDisabled && <button type="button" aria-label="Textfeld entfernen" onPointerDown={(event) => event.stopPropagation()} onClick={() => removeTextBox(box.id)}><Trash2 size={12} /></button>}
    </div>
  ))

  // The decoded picture is built once per source; moving, resizing and zooming never touch it again.
  const imageNode = useMemo(() => (source
    ? (
      <img
        src={source}
        alt={initialDocument.title}
        draggable={false}
        decoding="async"
        onLoad={(event) => {
          const target = event.currentTarget
          if (target.naturalWidth > 0) setNatural({ width: target.naturalWidth, height: target.naturalHeight })
          onPageLayoutChange?.()
        }}
      />
    )
    : null), [initialDocument.title, onPageLayoutChange, source])

  const pageCount = initialDocument.kind === 'pdf' ? pdf?.numPages ?? 0 : 1
  const infoLabel = initialDocument.kind === 'html'
    ? 'OneNote · originalgetreu'
    : `${pageCount || '…'} ${pageCount === 1 ? 'Seite' : 'Seiten'}`
  const layerClass = [
    'worksheet-layer',
    isImage ? 'is-image' : 'is-document',
    floating ? 'is-floating' : '',
    selected ? 'is-selected' : '',
    inputDisabled ? WORKSHEET_INKING_CLASS : '',
  ].filter(Boolean).join(' ')

  const actionButton = (label: string, icon: React.ReactNode, onClick: () => void, extra = '') => (
    <button type="button" className={`sheet-image-action ${extra}`} title={label} aria-label={label} onClick={onClick}>{icon}</button>
  )

  const objectBar = isImage ? (
    <div ref={barRef} className="sheet-image-bar" role="toolbar" aria-label="Bild bearbeiten" onPointerDown={(event) => event.stopPropagation()}>
      {onReplace && actionButton('Bild ersetzen', <Replace size={15} />, () => fileInputRef.current?.click())}
      {actionButton('Bild kopieren', <Copy size={15} />, () => { void copyImage() })}
      {actionButton(
        placement && placement.width >= 0.98 ? 'Originalgröße' : 'An Seitenbreite anpassen',
        placement && placement.width >= 0.98 ? <Minimize2 size={15} /> : <Maximize2 size={15} />,
        toggleFit,
      )}
      {onRemove && <span className="sheet-image-bar-divider" aria-hidden="true" />}
      {onRemove && actionButton('Bild entfernen', <Trash2 size={15} />, removeObject, 'is-danger')}
    </div>
  ) : null

  const imageBox = isImage && !error ? (
    <div
      ref={frameRef}
      className={`worksheet-page sheet-image ${floating ? 'is-floating' : ''} ${selected ? 'is-selected' : ''} ${source ? '' : 'is-loading'} ${draft ? 'is-dragging' : ''}`}
      role="group"
      aria-label="Bild auf dem Blatt"
      tabIndex={inputDisabled ? -1 : 0}
      style={floating && placement
        ? {
            left: `calc(var(--paper-width, 900px) * ${placement.x})`,
            top: `calc(var(--paper-width, 900px) * ${placement.y})`,
            width: `calc(var(--paper-width, 900px) * ${placement.width})`,
            aspectRatio: source ? undefined : `1 / ${aspect}`,
          }
        : { aspectRatio: source ? undefined : `1 / ${aspect}` }}
      onPointerDown={onFramePointerDown}
      onPointerMove={moveGesture}
      onPointerUp={endGesture}
      onPointerCancel={cancelGesture}
      onKeyDown={onFrameKeyDown}
    >
      {imageNode}
      {renderHighlights(1)}
      {renderTextBoxes(1)}
      {selected && !inputDisabled && CORNERS.map((corner) => (
        <span
          key={corner}
          className={`sheet-image-handle is-${corner}`}
          data-handle={corner}
          aria-hidden="true"
          onPointerDown={onHandlePointerDown(corner)}
          onPointerMove={moveGesture}
          onPointerUp={endGesture}
          onPointerCancel={cancelGesture}
        />
      ))}
      {selected && !inputDisabled && source && objectBar}
    </div>
  ) : null

  const documentChrome = !isImage && !error && !loading ? (
    <div className="sheet-doc-chrome" ref={chromeRef}>
      <span className="sheet-doc-chip" title={document.title}>
        <FileText size={13} aria-hidden="true" />
        <span>{infoLabel}</span>
      </span>
      {onRemove && (
        <div className="sheet-image-bar sheet-doc-bar" role="toolbar" aria-label="Arbeitsblatt bearbeiten">
          {actionButton(initialDocument.kind === 'pdf' ? 'PDF aus der Notiz entfernen' : 'Arbeitsblatt aus der Notiz entfernen', <Trash2 size={15} />, removeObject, 'is-danger')}
        </div>
      )}
    </div>
  ) : null

  return (
    <section
      ref={layerRef}
      data-worksheet-id={document.id}
      className={layerClass}
      aria-label={`Arbeitsblatt ${document.title}`}
      onPointerEnter={isImage ? undefined : () => setChromeActive(true)}
      onPointerLeave={isImage ? undefined : () => setChromeActive(false)}
      onFocus={isImage ? undefined : () => setChromeActive(true)}
      onBlur={isImage ? undefined : () => setChromeActive(false)}
      onClick={(event) => {
        if (isImage || inputDisabled) return
        if ((event.target as HTMLElement).closest('.worksheet-textbox, .worksheet-highlight')) return
        setSelected(true)
      }}
    >
      {loading && !isImage && <div className="worksheet-skeleton" aria-busy="true" aria-label="Arbeitsblatt wird vorbereitet" />}
      {error && (
        <div className={`worksheet-error ${isImage ? 'sheet-image is-error' : ''}`} ref={isImage ? frameRef : undefined} tabIndex={isImage ? 0 : undefined} onKeyDown={isImage ? onFrameKeyDown : undefined}>
          {isImage ? <ImageOff size={22} /> : <FileText size={22} />}
          <strong>{isImage ? 'Bild nicht verfügbar' : 'Arbeitsblatt nicht verfügbar'}</strong>
          <span>{error}</span>
          {onRemove && <button type="button" className="sheet-image-action is-text" onClick={removeObject}><Trash2 size={14} /> Entfernen</button>}
        </div>
      )}
      {imageBox}
      {!error && initialDocument.kind === 'html' && source && (
        <div
          ref={oneNotePageRef}
          className="worksheet-page worksheet-onenote-page"
          style={{ aspectRatio: `${document.pageWidth ?? 900} / ${document.pageHeight ?? 1200}` }}
        >
          <iframe
            className="worksheet-onenote-frame"
            srcDoc={source}
            title={`Importierte OneNote-Seite ${document.title}`}
            sandbox=""
            referrerPolicy="no-referrer"
            style={{
              width: `${document.pageWidth ?? 900}px`,
              height: `${document.pageHeight ?? 1200}px`,
              transform: `scale(${oneNoteScale})`,
            }}
            onLoad={notifyLayout}
          />
          {renderHighlights(1)}
          {renderTextBoxes(1)}
        </div>
      )}
      {!error && pdf && Array.from({ length: pdf.numPages }, (_, index) => {
        const page = index + 1
        return (
          <div
            className="worksheet-page"
            key={page}
            style={{ containIntrinsicSize: `800px ${Math.round(800 * pageRatio)}px` }}
          >
            <PdfPage pdf={pdf} number={page} defaultRatio={pageRatio} sourcePath={initialDocument.sourceRelativePath} onReady={notifyLayout} />
            {renderHighlights(page)}
            {renderTextBoxes(page)}
          </div>
        )
      })}
      {documentChrome}
      {isImage && onReplace && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-sheet-image-file=""
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) void Promise.resolve(onReplace(file))
          }}
        />
      )}
    </section>
  )
})

export default WorksheetLayer
