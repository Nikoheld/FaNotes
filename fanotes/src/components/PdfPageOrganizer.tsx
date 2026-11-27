import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, LoaderCircle, RotateCcw, Trash2, X } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { enqueuePdfRender, loadVaultPdfBytes } from '../lib/pdfDocument'
import { buildPdfWithPages, movePage } from '../lib/pdfPageOrder'

const TILE_WIDTH = 110

function PageTile({ pdf, number }: { pdf: PDFDocumentProxy; number: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let alive = true
    void enqueuePdfRender(async () => {
      if (!alive || !canvasRef.current) return
      const page = await pdf.getPage(number)
      try {
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: (TILE_WIDTH * 2) / Math.max(1, base.width) })
        const canvas = canvasRef.current
        if (!alive || !canvas) return
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) return
        context.fillStyle = '#fff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvas, canvasContext: context, viewport, intent: 'display' }).promise
      } finally {
        page.cleanup()
      }
    }, 'thumbnail').catch(() => undefined)
    return () => { alive = false }
  }, [number, pdf])
  return <canvas ref={canvasRef} style={{ width: TILE_WIDTH }} />
}

/**
 * Delete and rearrange the pages of a PDF note. The result is saved as a new
 * PDF note; the original (and its ink) stays untouched.
 */
export function PdfPageOrganizer({
  pdf,
  path,
  title,
  onClose,
  onCreated,
}: {
  pdf: PDFDocumentProxy
  path: string
  title: string
  onClose: () => void
  onCreated: (relativePath: string) => void
}) {
  const initial = useMemo(() => Array.from({ length: pdf.numPages }, (_, index) => index + 1), [pdf])
  const [order, setOrder] = useState<number[]>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const changed = order.length !== initial.length || order.some((page, index) => page !== initial[index])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const save = async () => {
    const create = window.fanotes.createPdfNoteFromBytes
    if (!create || !order.length) return
    setBusy(true)
    setError('')
    try {
      const bytes = await buildPdfWithPages(await loadVaultPdfBytes(path), order)
      const slash = path.lastIndexOf('/')
      const base = path.slice(slash + 1).replace(/\.pdf$/iu, '')
      const result = await create({ bytes, name: `${base} (bearbeitet).pdf`, parentPath: slash > 0 ? path.slice(0, slash) : '' })
      onCreated(result.relativePath)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Die Seiten konnten nicht gespeichert werden.')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop confirm-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="confirm-dialog pdf-organizer" role="dialog" aria-modal="true" aria-label="Seiten verwalten" onPointerDown={(event) => event.stopPropagation()}>
        <header className="confirm-dialog-header">
          <div>
            <p className="eyebrow">PDF</p>
            <h3 data-i18n-ignore>{title}</h3>
          </div>
          <button type="button" className="icon-button" aria-label="Schließen" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>
        <p className="pdf-organizer__hint">Seiten löschen oder per Ziehen bzw. Pfeil neu anordnen. Das Ergebnis wird als neue PDF-Notiz gespeichert; das Original bleibt unverändert.</p>
        <div className="pdf-organizer__grid">
          {order.map((page, index) => (
            <div
              key={page}
              className={`pdf-organizer__tile ${dragIndex === index ? 'is-dragging' : ''}`}
              draggable={!busy}
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                if (dragIndex !== null) setOrder((current) => movePage(current, dragIndex, index))
                setDragIndex(null)
              }}
            >
              <PageTile pdf={pdf} number={page} />
              <small>{index + 1}{page !== index + 1 ? ` (alt ${page})` : ''}</small>
              <span className="pdf-organizer__actions">
                <button type="button" aria-label="Nach vorn" disabled={busy || index === 0} onClick={() => setOrder((current) => movePage(current, index, index - 1))}><ArrowLeft size={13} /></button>
                <button type="button" aria-label="Seite löschen" disabled={busy || order.length <= 1} onClick={() => setOrder((current) => current.filter((_, at) => at !== index))}><Trash2 size={13} /></button>
                <button type="button" aria-label="Nach hinten" disabled={busy || index === order.length - 1} onClick={() => setOrder((current) => movePage(current, index, index + 1))}><ArrowRight size={13} /></button>
              </span>
            </div>
          ))}
        </div>
        {error ? <p className="pdf-organizer__error" role="alert">{error}</p> : null}
        <footer className="pdf-organizer__footer">
          <button type="button" className="secondary-button" disabled={busy || !changed} onClick={() => setOrder(initial)}><RotateCcw size={14} /> Zurücksetzen</button>
          <button type="button" className="primary-button" disabled={busy || !changed} onClick={() => void save()}>
            {busy ? <LoaderCircle className="spin" size={14} /> : null} Als neue PDF-Notiz speichern
          </button>
        </footer>
      </section>
    </div>
  )
}
