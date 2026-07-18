import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, FileText, Image as ImageIcon, LoaderCircle, Plus, Trash2, Type, X } from 'lucide-react'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { WorksheetDocument, WorksheetTextBox } from '../types'

export type WorksheetLayerHandle = {
  flush: () => Promise<void>
}

type WorksheetLayerProps = {
  document: WorksheetDocument
  inputDisabled?: boolean
  onSave: (document: WorksheetDocument) => Promise<WorksheetDocument>
  onDirtyChange?: (dirty: boolean) => void
  onPageLayoutChange?: () => void
}

function PdfPage({ pdf, number, onReady }: { pdf: PDFDocumentProxy; number: number; onReady: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pageRef = useRef<PDFPageProxy | null>(null)
  const renderRef = useRef<RenderTask | null>(null)
  const [ratio, setRatio] = useState(297 / 210)

  useEffect(() => {
    let alive = true
    void pdf.getPage(number).then((page) => {
      if (!alive) return
      pageRef.current = page
      const viewport = page.getViewport({ scale: 1 })
      setRatio(viewport.height / viewport.width)
      onReady()
    })
    return () => {
      alive = false
      renderRef.current?.cancel()
      pageRef.current?.cleanup()
      pageRef.current = null
    }
  }, [number, onReady, pdf])

  const render = useCallback(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const page = pageRef.current
    if (!host || !canvas || !page || host.clientWidth <= 0) return
    const base = page.getViewport({ scale: 1 })
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const viewport = page.getViewport({ scale: host.clientWidth / base.width * dpr })
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    renderRef.current?.cancel()
    renderRef.current = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport })
    void renderRef.current.promise.catch((error: unknown) => {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') console.error('PDF-Seite konnte nicht gerendert werden.', error)
    })
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(render)
    observer.observe(host)
    render()
    return () => observer.disconnect()
  }, [ratio, render])

  return (
    <div className="worksheet-pdf-page" ref={hostRef} style={{ aspectRatio: `1 / ${ratio}` }}>
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
}, forwardedRef) {
  const [document, setDocument] = useState(initialDocument)
  const [source, setSource] = useState('')
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [textTool, setTextTool] = useState(false)
  const [savedPulse, setSavedPulse] = useState(false)
  const [oneNoteScale, setOneNoteScale] = useState(1)
  const documentRef = useRef(document)
  const dirtyRef = useRef(false)
  const revisionRef = useRef(0)
  const saveTimerRef = useRef<number | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pdfTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const oneNotePageRef = useRef<HTMLDivElement>(null)

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
    onDirtyChange?.(dirty)
  }, [onDirtyChange])

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
        const [{ getDocument, GlobalWorkerOptions }, response] = await Promise.all([
          import('pdfjs-dist'),
          fetch(dataUrl),
        ])
        GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const bytes = new Uint8Array(await response.arrayBuffer())
        const task = getDocument({ data: bytes })
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
        onPageLayoutChange?.()
      })
      .catch((reason: unknown) => {
        if (!alive) return
        setError(reason instanceof Error ? reason.message : 'Das Arbeitsblatt konnte nicht geöffnet werden.')
        setLoading(false)
      })
    return () => {
      alive = false
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      void pdfTaskRef.current?.destroy()
      pdfTaskRef.current = null
    }
  }, [initialDocument.kind, initialDocument.sourceRelativePath, onPageLayoutChange])

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
        </span>
      </header>
      {textTool && <div className="worksheet-hint"><Plus size={14} /> Klicke an die Stelle des Arbeitsblatts, an der du tippen möchtest.</div>}
      {loading && <div className="worksheet-loading"><LoaderCircle className="spin" size={22} /> Arbeitsblatt wird vorbereitet …</div>}
      {error && <div className="worksheet-error"><FileText size={22} /><strong>Arbeitsblatt nicht verfügbar</strong><span>{error}</span></div>}
      {!error && initialDocument.kind === 'image' && source && (
        <div className="worksheet-page" onPointerDown={(event) => addTextBox(1, event)}>
          <img src={source} alt={document.title} draggable={false} onLoad={onPageLayoutChange} />
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
            onLoad={onPageLayoutChange}
          />
          {renderTextBoxes(1)}
        </div>
      )}
      {!error && pdf && Array.from({ length: pdf.numPages }, (_, index) => {
        const page = index + 1
        return <div className="worksheet-page" key={page} onPointerDown={(event) => addTextBox(page, event)}><PdfPage pdf={pdf} number={page} onReady={onPageLayoutChange ?? (() => undefined)} />{renderTextBoxes(page)}</div>
      })}
    </section>
  )
})

export default WorksheetLayer
