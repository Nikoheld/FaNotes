// A PDF of the vault, drawn page by page with pdf.js. The worker is a file of this site (same origin), so the
// strict CSP (script-src and worker-src 'self') holds; the PDF's bytes never leave the page.
import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useKanti } from '../state'
import { IconButton } from './ui'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const PageCanvas = ({ document, number, zoom, width }: { document: PDFDocumentProxy; number: number; zoom: number; width: number }) => {
  const canvas = useRef<HTMLCanvasElement>(null)
  const holder = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(number <= 2)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const node = holder.current
    if (!node || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true) }, { rootMargin: '600px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!near || !canvas.current || width <= 0) return undefined
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null
    void (async () => {
      const page = await document.getPage(number)
      const base = page.getViewport({ scale: 1 })
      const scale = (width * zoom) / base.width
      const viewport = page.getViewport({ scale })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const target = canvas.current
      if (cancelled || !target) return
      target.width = Math.floor(viewport.width * ratio)
      target.height = Math.floor(viewport.height * ratio)
      target.style.width = `${Math.floor(viewport.width)}px`
      target.style.height = `${Math.floor(viewport.height)}px`
      setSize({ width: viewport.width, height: viewport.height })
      const context = target.getContext('2d')
      if (!context) return
      task = page.render({ canvas: target, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      try { await task.promise } catch { /* cancelled by a zoom change */ }
    })()
    return () => { cancelled = true; task?.cancel() }
  }, [document, number, zoom, width, near])
  return <div ref={holder} className="pdf-page" style={size ? { width: size.width, height: size.height } : { minHeight: 200 }}><canvas ref={canvas} role="img" aria-label={`${number}`} /></div>
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]

export const PdfViewer = ({ bytes }: { bytes: Uint8Array }) => {
  const { t } = useKanti()
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(0)
  const area = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    // pdf.js takes ownership of the buffer it is given: pass a copy.
    const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false })
    task.promise.then((loaded) => { if (live) setDocument(loaded) }, () => { if (live) setError(true) })
    return () => { live = false; void task.destroy() }
  }, [bytes])
  useEffect(() => {
    const node = area.current
    if (!node) return undefined
    const measure = () => setWidth(Math.max(240, node.clientWidth - 24))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [])
  const step = (direction: 1 | -1) => setZoom((current) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.findIndex((value) => value >= current - 0.001) + direction))] ?? current)
  return (
    <div className="pdf-viewer">
      <div className="pdf-tools" role="group" aria-label="Zoom">
        <IconButton icon="down" label={t.zoomOut} onClick={() => step(-1)} />
        <button type="button" className="nav-today" onClick={() => setZoom(1)} aria-label={t.zoomFit}>{Math.round(zoom * 100)}%</button>
        <IconButton icon="up" label={t.zoomIn} onClick={() => step(1)} />
        {document ? <span className="muted small">{t.pageCount(document.numPages)}</span> : null}
      </div>
      <div className="pdf-pages" ref={area}>
        {error ? <p className="field-error">{t.pdfFailed}</p> : !document ? <span className="spinner" aria-hidden="true" /> : Array.from({ length: document.numPages }, (_, index) => <PageCanvas key={index} document={document} number={index + 1} zoom={zoom} width={width} />)}
      </div>
    </div>
  )
}
