import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, FileText, Image as ImageIcon, LoaderCircle, Plus, Trash2, Type, X } from 'lucide-react'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { WorksheetDocument, WorksheetTextBox } from '../types'

export type WorksheetLayerHandle = {
  flush: () => Promise<void>
}

/**
 * Load PDF bytes from a vault asset source.
 * Electron returns large `data:…;base64,…` URLs — Chromium often rejects `fetch(dataUrl)`
 * with "Failed to fetch". Decode those locally; only use fetch for blob:/http(s): URLs.
 */
const loadPdfBytes = async (source: string): Promise<Uint8Array> => {
  if (!source) throw new Error('Die PDF-Datei ist leer oder fehlt im Vault.')
  if (source.startsWith('data:')) {
    const comma = source.indexOf(',')
    if (comma < 0) throw new Error('Ungültige PDF-Daten (Data-URL).')
    const header = source.slice(0, comma)
    const body = source.slice(comma + 1)
    if (/;base64/iu.test(header)) {
      const binary = atob(body)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }
    return new TextEncoder().encode(decodeURIComponent(body))
  }
  const response = await fetch(source)
  if (!response.ok) {
    throw new Error(`PDF konnte nicht geladen werden (HTTP ${response.status}).`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/** Backing-store caps: sharp on HiDPI without multi-page GPU thrash. */
const MAX_PDF_DPR = 2.25
const MAX_PDF_EDGE = 2_880
const MAX_PDF_PIXELS = 6_500_000
const RESIZE_DEBOUNCE_MS = 140
const VIEWPORT_ROOT_MARGIN = '240px 0px'

type WorksheetLayerProps = {
  document: WorksheetDocument
  inputDisabled?: boolean
  onSave: (document: WorksheetDocument) => Promise<WorksheetDocument>
  onDirtyChange?: (dirty: boolean) => void
  onPageLayoutChange?: () => void
  onRemove?: () => void | Promise<void>
}

function PdfPage({
  pdf,
  number,
  onReady,
}: {
  pdf: PDFDocumentProxy
  number: number
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
  const visibleRef = useRef(false)
  const [ratio, setRatio] = useState(297 / 210)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let alive = true
    void pdf.getPage(number).then((page) => {
      if (!alive) return
      pageRef.current = page
      const viewport = page.getViewport({ scale: 1 })
      setRatio(viewport.height / Math.max(1, viewport.width))
    }).catch((error: unknown) => {
      console.error(`PDF-Seite ${number} konnte nicht geladen werden.`, error)
    })
    return () => {
      alive = false
      renderRef.current?.cancel()
      pageRef.current?.cleanup()
      pageRef.current = null
    }
  }, [number, pdf])

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    context?.setTransform(1, 0, 0, 1, 0, 0)
    context?.clearRect(0, 0, canvas.width, canvas.height)
    canvas.width = 1
    canvas.height = 1
    lastRenderKeyRef.current = ''
  }, [])

  const render = useCallback(async () => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const page = pageRef.current
    if (!host || !canvas || !page || !visibleRef.current) return
    const cssWidth = Math.max(1, Math.round(host.clientWidth))
    if (cssWidth < 8) return
    const base = page.getViewport({ scale: 1 })
    const cssHeight = Math.max(1, Math.round(cssWidth * (base.height / Math.max(1, base.width))))

    // Device pixel ratio for true screen resolution, with hard caps for multi-page stability.
    let dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_PDF_DPR)
    let pixelWidth = Math.round(cssWidth * dpr)
    let pixelHeight = Math.round(cssHeight * dpr)
    const edge = Math.max(pixelWidth, pixelHeight)
    if (edge > MAX_PDF_EDGE) {
      const factor = MAX_PDF_EDGE / edge
      pixelWidth = Math.max(1, Math.round(pixelWidth * factor))
      pixelHeight = Math.max(1, Math.round(pixelHeight * factor))
      dpr *= factor
    }
    const pixels = pixelWidth * pixelHeight
    if (pixels > MAX_PDF_PIXELS) {
      const factor = Math.sqrt(MAX_PDF_PIXELS / pixels)
      pixelWidth = Math.max(1, Math.round(pixelWidth * factor))
      pixelHeight = Math.max(1, Math.round(pixelHeight * factor))
      dpr *= factor
    }

    const renderKey = `${cssWidth}x${cssHeight}@${pixelWidth}x${pixelHeight}`
    if (renderKey === lastRenderKeyRef.current && canvas.width === pixelWidth && canvas.height === pixelHeight) {
      return
    }

    const token = ++renderTokenRef.current
    renderRef.current?.cancel()
    const scale = pixelWidth / Math.max(1, base.width)
    const viewport = page.getViewport({ scale })
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    // Keep CSS display size at layout pixels so backing store maps 1:1 with dpr.
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, pixelWidth, pixelHeight)
    const task = page.render({
      canvas,
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
  }, [number, onReady])

  // Only paint pages near the viewport — multi-page PDFs otherwise thrash GPU/CPU.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        const next = Boolean(entry?.isIntersecting)
        visibleRef.current = next
        setVisible(next)
        if (!next) {
          renderRef.current?.cancel()
          // Free VRAM for pages far away; keep the aspect-ratio box.
          clearCanvas()
        } else {
          void render()
        }
      },
      { root: host.closest('.unified-note-view') as Element | null, rootMargin: VIEWPORT_ROOT_MARGIN, threshold: 0.01 },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [clearCanvas, render])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const schedule = () => {
      if (!visibleRef.current) return
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null
        void render()
      }, RESIZE_DEBOUNCE_MS)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    if (visible) void render()
    return () => {
      observer.disconnect()
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
    }
  }, [render, visible])

  return (
    <div
      className={`worksheet-pdf-page ${visible ? 'is-visible' : 'is-virtualized'}`}
      ref={hostRef}
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      <canvas ref={canvasRef} aria-label={`PDF-Seite ${number}`} />
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
  const [savedPulse, setSavedPulse] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [oneNoteScale, setOneNoteScale] = useState(1)
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
    void window.fanotes.readAssetDataUrl(initialDocument.sourceRelativePath)
      .then(async (dataUrl) => {
        if (!alive) return
        setSource(dataUrl)
        if (initialDocument.kind === 'image' || initialDocument.kind === 'html') {
          setLoading(false)
          return
        }
        const [{ getDocument, GlobalWorkerOptions }, bytes] = await Promise.all([
          import('pdfjs-dist'),
          loadPdfBytes(dataUrl),
        ])
        if (!alive) return
        if (!bytes.length) throw new Error('Die PDF-Datei ist leer.')
        GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const task = getDocument({
          data: bytes.slice(),
          useSystemFonts: true,
          // Prefer speed; pages still render at device resolution when visible.
          disableAutoFetch: false,
          disableStream: false,
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
      void pdfTaskRef.current?.destroy()
      pdfTaskRef.current = null
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
    if ((event.target as HTMLElement).closest('.worksheet-textbox')) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(.78, (event.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(.94, (event.clientY - rect.top) / rect.height))
    const box: WorksheetTextBox = { id: crypto.randomUUID(), page, x, y, width: .28, text: '', fontSize: 16 }
    updateDocument((current) => ({ ...current, textBoxes: [...current.textBoxes, box] }))
    setTextTool(false)
    window.setTimeout(() => globalThis.document.querySelector<HTMLTextAreaElement>(`[data-worksheet-textbox="${box.id}"]`)?.focus(), 0)
  }, [inputDisabled, textTool, updateDocument])

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
    <section className={`worksheet-layer ${textTool ? 'is-placing-text' : ''} ${inputDisabled ? 'is-disabled' : ''}`} aria-label={`Arbeitsblatt ${document.title}`}>
      <header className="worksheet-toolbar">
        <span>{document.kind === 'image' ? <ImageIcon size={15} /> : <FileText size={15} />}<strong>{document.title}</strong><small>{document.kind === 'html' ? 'OneNote · originalgetreu' : `${pageCount || '…'} ${pageCount === 1 ? 'Seite' : 'Seiten'}`}</small></span>
        <span className="worksheet-toolbar-actions">
          {savedPulse && <i><Check size={12} /> gespeichert</i>}
          <button type="button" className={textTool ? 'active' : ''} disabled={inputDisabled || loading || Boolean(error)} onClick={() => setTextTool((value) => !value)}><Type size={14} /> {textTool ? 'Auf Seite platzieren' : 'Textfeld'}</button>
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
      {loading && <div className="worksheet-loading"><LoaderCircle className="spin" size={22} /> Arbeitsblatt wird vorbereitet …</div>}
      {error && <div className="worksheet-error"><FileText size={22} /><strong>Arbeitsblatt nicht verfügbar</strong><span>{error}</span></div>}
      {!error && initialDocument.kind === 'image' && source && (
        <div className="worksheet-page" onPointerDown={(event) => addTextBox(1, event)}>
          <img src={source} alt={document.title} draggable={false} onLoad={notifyLayout} decoding="async" />
          {renderTextBoxes(1)}
        </div>
      )}
      {!error && initialDocument.kind === 'html' && source && (
        <div
          ref={oneNotePageRef}
          className="worksheet-page worksheet-onenote-page"
          style={{ aspectRatio: `${document.pageWidth ?? 900} / ${document.pageHeight ?? 1200}` }}
          onPointerDown={(event) => addTextBox(1, event)}
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
          {renderTextBoxes(1)}
        </div>
      )}
      {!error && pdf && Array.from({ length: pdf.numPages }, (_, index) => {
        const page = index + 1
        return (
          <div className="worksheet-page" key={page} onPointerDown={(event) => addTextBox(page, event)}>
            <PdfPage pdf={pdf} number={page} onReady={notifyLayout} />
            {renderTextBoxes(page)}
          </div>
        )
      })}
    </section>
  )
})

export default WorksheetLayer
