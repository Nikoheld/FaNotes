import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, FileText, Highlighter, Image as ImageIcon, LoaderCircle, Plus, Trash2, Type, X } from 'lucide-react'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { WorksheetDocument, WorksheetHighlight, WorksheetTextBox } from '../types'
import { WORKSHEET_INKING_CLASS } from '../lib/pdfInkHit'
import { paintSizeForPage } from '../lib/pdfDocument'
import { readUsedSheetZoom, watchSheetZoom } from '../lib/paperView'

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

/** One PDF.js paint at a time — parallel page renders stall the main thread and GPU. */
let pdfRenderTail: Promise<void> = Promise.resolve()
const enqueuePdfRender = <T,>(job: () => Promise<T>): Promise<T> => {
  const run = pdfRenderTail.then(job, job)
  pdfRenderTail = run.then(() => undefined, () => undefined)
  return run
}

const RESIZE_DEBOUNCE_MS = 180
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
}

function PdfPageCanvas({
  pdf,
  number,
  onRatio,
  onReady,
}: {
  pdf: PDFDocumentProxy
  number: number
  onRatio: (ratio: number) => void
  onReady: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pageRef = useRef<PDFPageProxy | null>(null)
  const renderRef = useRef<RenderTask | null>(null)
  const renderTokenRef = useRef(0)
  const lastRenderKeyRef = useRef('')
  const readySentRef = useRef(false)
  const resizeTimerRef = useRef<number | null>(null)

  const render = useCallback(async () => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const page = pageRef.current
    if (!host || !canvas || !page) return
    const cssWidth = Math.max(1, Math.round(host.clientWidth))
    if (cssWidth < 8) return
    const base = page.getViewport({ scale: 1 })
    const cssHeight = Math.max(1, Math.round(cssWidth * (base.height / Math.max(1, base.width))))
    const viewZoom = readUsedSheetZoom(host)
    const { pixelWidth, pixelHeight } = paintSizeForPage(cssWidth, cssHeight, { viewZoom })
    const renderKey = `${cssWidth}x${cssHeight}@${pixelWidth}x${pixelHeight}@${viewZoom.toFixed(2)}`
    if (renderKey === lastRenderKeyRef.current && canvas.width === pixelWidth && canvas.height === pixelHeight) {
      return
    }

    const token = ++renderTokenRef.current
    renderRef.current?.cancel()
    await enqueuePdfRender(async () => {
      if (token !== renderTokenRef.current || !pageRef.current || !canvasRef.current || !hostRef.current) return
      const livePage = pageRef.current
      const liveCanvas = canvasRef.current
      const scale = pixelWidth / Math.max(1, base.width)
      const viewport = livePage.getViewport({ scale })
      liveCanvas.width = pixelWidth
      liveCanvas.height = pixelHeight
      liveCanvas.style.width = `${cssWidth}px`
      liveCanvas.style.height = `${cssHeight}px`
      const context = liveCanvas.getContext('2d', { alpha: false })
      if (!context) return
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, pixelWidth, pixelHeight)
      const task = livePage.render({
        canvas: liveCanvas,
        canvasContext: context,
        viewport,
        intent: 'display',
      })
      renderRef.current = task
      try {
        await task.promise
        if (token !== renderTokenRef.current) return
        lastRenderKeyRef.current = renderKey
        if (!readySentRef.current) {
          readySentRef.current = true
          onReady()
        }
      } catch (error: unknown) {
        if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') {
          console.error(`PDF-Seite ${number} konnte nicht gerendert werden.`, error)
        }
      }
    })
  }, [number, onReady])

  useEffect(() => {
    let alive = true
    void pdf.getPage(number).then((page) => {
      if (!alive) {
        page.cleanup()
        return
      }
      pageRef.current = page
      const viewport = page.getViewport({ scale: 1 })
      onRatio(viewport.height / Math.max(1, viewport.width))
      void render()
    }).catch((error: unknown) => {
      if (alive) console.error(`PDF-Seite ${number} konnte nicht geladen werden.`, error)
    })
    return () => {
      alive = false
      renderTokenRef.current += 1
      const page = pageRef.current
      pageRef.current = null
      try { renderRef.current?.cancel() } catch { /* ignore */ }
      renderRef.current = null
      try { page?.cleanup() } catch { /* ignore */ }
    }
  }, [number, onRatio, pdf, render])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const schedule = () => {
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null
        void render()
      }, RESIZE_DEBOUNCE_MS)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    const stopZoom = watchSheetZoom(host, schedule)
    return () => {
      observer.disconnect()
      stopZoom()
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
    }
  }, [render])

  return (
    <div className="worksheet-pdf-canvas-host" ref={hostRef}>
      <canvas ref={canvasRef} aria-label={`PDF-Seite ${number}`} />
    </div>
  )
}

function PdfPage({
  pdf,
  number,
  defaultRatio,
  onReady,
}: {
  pdf: PDFDocumentProxy
  number: number
  defaultRatio: number
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
      {mounted && <PdfPageCanvas pdf={pdf} number={number} onRatio={handleRatio} onReady={onReady} />}
    </div>
  )
}

export const WorksheetLayer = forwardRef<WorksheetLayerHandle, WorksheetLayerProps>(function WorksheetLayer({
  document: initialDocument,
  inputDisabled = false,
  onSave,
  onDirtyChange,
  onPageLayoutChange,
  onRemove,
}, forwardedRef) {
  const [document, setDocument] = useState(initialDocument)
  const [source, setSource] = useState('')
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [textTool, setTextTool] = useState(false)
  const [highlightTool, setHighlightTool] = useState(false)
  const [draftHighlight, setDraftHighlight] = useState<{ page: number; x: number; y: number; width: number; height: number } | null>(null)
  const highlightOriginRef = useRef<{ page: number; x: number; y: number } | null>(null)
  const [savedPulse, setSavedPulse] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [oneNoteScale, setOneNoteScale] = useState(1)
  const [pageRatio, setPageRatio] = useState(DEFAULT_PAGE_RATIO)
  const documentRef = useRef(document)
  const dirtyRef = useRef(false)
  const revisionRef = useRef(0)
  const saveTimerRef = useRef<number | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pdfTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const oneNotePageRef = useRef<HTMLDivElement>(null)
  const layoutNotifyTimerRef = useRef<number | null>(null)

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
        setSavedPulse(true)
        window.setTimeout(() => setSavedPulse(false), 1100)
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
          useSystemFonts: true,
          disableAutoFetch: true,
          disableStream: true,
          disableRange: true,
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

  const addTextBox = useCallback((page: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (inputDisabled || !textTool || event.button !== 0) return
    if ((event.target as HTMLElement).closest('.worksheet-textbox, .worksheet-highlight')) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(.78, (event.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(.94, (event.clientY - rect.top) / rect.height))
    const box: WorksheetTextBox = { id: crypto.randomUUID(), page, x, y, width: .28, text: '', fontSize: 16 }
    updateDocument((current) => ({ ...current, textBoxes: [...current.textBoxes, box] }))
    setTextTool(false)
    window.setTimeout(() => globalThis.document.querySelector<HTMLTextAreaElement>(`[data-worksheet-textbox="${box.id}"]`)?.focus(), 0)
  }, [inputDisabled, textTool, updateDocument])

  const highlightRectFromEvent = (origin: { x: number; y: number }, event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const endX = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
    const endY = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))
    return {
      x: Math.min(origin.x, endX),
      y: Math.min(origin.y, endY),
      width: Math.max(0.008, Math.abs(endX - origin.x)),
      height: Math.max(0.008, Math.abs(endY - origin.y)),
    }
  }

  const beginHighlight = useCallback((page: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (inputDisabled || !highlightTool || event.button !== 0) return
    if ((event.target as HTMLElement).closest('.worksheet-textbox')) return
    const box = event.currentTarget.getBoundingClientRect()
    const origin = {
      page,
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    }
    highlightOriginRef.current = origin
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraftHighlight({ ...origin, width: 0.01, height: 0.01 })
  }, [highlightTool, inputDisabled])

  const moveHighlight = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = highlightOriginRef.current
    if (!origin) return
    setDraftHighlight({ page: origin.page, ...highlightRectFromEvent(origin, event) })
  }, [])

  const endHighlight = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = highlightOriginRef.current
    highlightOriginRef.current = null
    if (!origin) return
    const next = highlightRectFromEvent(origin, event)
    setDraftHighlight(null)
    if (next.width < 0.012 || next.height < 0.008) return
    const mark: WorksheetHighlight = { id: crypto.randomUUID(), page: origin.page, ...next, color: '#ffe566' }
    updateDocument((current) => ({ ...current, highlights: [...(current.highlights ?? []), mark] }))
  }, [updateDocument])

  const removeHighlight = useCallback((id: string) => {
    updateDocument((current) => ({ ...current, highlights: (current.highlights ?? []).filter((mark) => mark.id !== id) }))
  }, [updateDocument])

  const handlePagePointerDown = useCallback((page: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (highlightTool) beginHighlight(page, event)
    else addTextBox(page, event)
  }, [addTextBox, beginHighlight, highlightTool])

  const renderHighlights = (page: number) => (
    <>
      {(document.highlights ?? []).filter((mark) => mark.page === page).map((mark) => (
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
      ))}
      {draftHighlight?.page === page && (
        <div
          className="worksheet-highlight is-draft"
          style={{ left: `${draftHighlight.x * 100}%`, top: `${draftHighlight.y * 100}%`, width: `${draftHighlight.width * 100}%`, height: `${draftHighlight.height * 100}%` }}
        />
      )}
    </>
  )

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

  const pageCount = initialDocument.kind === 'pdf' ? pdf?.numPages ?? 0 : 1

  return (
    <section className={`worksheet-layer ${textTool ? 'is-placing-text' : ''} ${highlightTool ? 'is-highlighting' : ''} ${inputDisabled ? WORKSHEET_INKING_CLASS : ''}`} aria-label={`Arbeitsblatt ${document.title}`}>
      <header className="worksheet-toolbar">
        <span>{document.kind === 'image' ? <ImageIcon size={15} /> : <FileText size={15} />}<strong>{document.title}</strong><small>{document.kind === 'html' ? 'OneNote · originalgetreu' : `${pageCount || '…'} ${pageCount === 1 ? 'Seite' : 'Seiten'}`}</small></span>
        <span className="worksheet-toolbar-actions">
          {savedPulse && <i><Check size={12} /> gespeichert</i>}
          <button type="button" className={textTool ? 'active' : ''} disabled={inputDisabled || loading || Boolean(error)} onClick={() => { setHighlightTool(false); setTextTool((value) => !value) }}><Type size={14} /> {textTool ? 'Auf Seite platzieren' : 'Textfeld'}</button>
          <button type="button" className={highlightTool ? 'active' : ''} disabled={inputDisabled || loading || Boolean(error)} onClick={() => { setTextTool(false); setHighlightTool((value) => !value) }} title="Text oder Stellen auf dem Arbeitsblatt markieren"><Highlighter size={14} /> Markieren</button>
          {textTool && <button type="button" aria-label="Textfeldmodus abbrechen" onClick={() => setTextTool(false)}><X size={14} /></button>}
          {onRemove && (
            <button
              type="button"
              className="worksheet-remove"
              disabled={removing}
              title="PDF oder Bild aus dieser Notiz entfernen"
              aria-label={`${document.kind === 'pdf' ? 'PDF' : 'Arbeitsblatt'} aus der Notiz entfernen`}
              onClick={() => {
                if (removing) return
                setRemoving(true)
                void Promise.resolve(onRemove()).finally(() => setRemoving(false))
              }}
            >
              <Trash2 size={14} /> {removing ? 'Entfernt …' : 'Entfernen'}
            </button>
          )}
        </span>
      </header>
      {textTool && <div className="worksheet-hint"><Plus size={14} /> Klicke an die Stelle des Arbeitsblatts, an der du tippen möchtest.</div>}
      {highlightTool && <div className="worksheet-hint"><Highlighter size={14} /> Ziehe einen Rahmen über den Text, den du markieren möchtest.</div>}
      {loading && <div className="worksheet-loading"><LoaderCircle className="spin" size={22} /> Arbeitsblatt wird vorbereitet …</div>}
      {error && <div className="worksheet-error"><FileText size={22} /><strong>Arbeitsblatt nicht verfügbar</strong><span>{error}</span></div>}
      {!error && initialDocument.kind === 'image' && source && (
        <div className="worksheet-page" onPointerDown={(event) => handlePagePointerDown(1, event)} onPointerMove={moveHighlight} onPointerUp={endHighlight} onPointerCancel={() => { highlightOriginRef.current = null; setDraftHighlight(null) }}>
          <img src={source} alt={document.title} draggable={false} onLoad={notifyLayout} decoding="async" />
          {renderHighlights(1)}
          {renderTextBoxes(1)}
        </div>
      )}
      {!error && initialDocument.kind === 'html' && source && (
        <div
          ref={oneNotePageRef}
          className="worksheet-page worksheet-onenote-page"
          style={{ aspectRatio: `${document.pageWidth ?? 900} / ${document.pageHeight ?? 1200}` }}
          onPointerDown={(event) => handlePagePointerDown(1, event)}
          onPointerMove={moveHighlight}
          onPointerUp={endHighlight}
          onPointerCancel={() => { highlightOriginRef.current = null; setDraftHighlight(null) }}
        >
          <iframe
            className="worksheet-onenote-frame"
            src={source}
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
            onPointerDown={(event) => handlePagePointerDown(page, event)}
            onPointerMove={moveHighlight}
            onPointerUp={endHighlight}
            onPointerCancel={() => { highlightOriginRef.current = null; setDraftHighlight(null) }}
          >
            <PdfPage pdf={pdf} number={page} defaultRatio={pageRatio} onReady={notifyLayout} />
            {renderHighlights(page)}
            {renderTextBoxes(page)}
          </div>
        )
      })}
    </section>
  )
})

export default WorksheetLayer
