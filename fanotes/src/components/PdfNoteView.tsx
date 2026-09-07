import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  ListTree,
  LoaderCircle,
  Maximize2,
  PanelLeft,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import {
  DEFAULT_PDF_PAGE_RATIO,
  applyPdfTextOverlayScale,
  enqueuePdfRender,
  loadVaultPdfBytes,
  openPdfDocument,
  pdfStartPageForLoad,
} from '../lib/pdfDocument'
import { createPdfPagePainter, type PdfBasePaintInfo, type PdfPagePainter } from '../lib/pdfPagePainter'
import {
  PDF_FIT_GUTTER,
  pdfColumnCentreScrollLeft,
  pdfFitPageZoom,
  pdfFitWidthZoom,
  pdfPageTopScrollTop,
  pdfZoomModeForZoom,
  pdfZoomStep,
  type PdfZoomMode,
} from '../lib/pdfCamera'
import { pdfPageScrollIntoViewBlock } from '../lib/pdfOpenCamera'
import { PDF_INKING_CLASS, PDF_TOOLBAR_SLOT_ID } from '../lib/pdfInkHit'
import { VIEW_ZOOM_MIN, readSharedZoomMax, resolvePaperZoomScroller, watchSheetZoom } from '../lib/paperView'
import { loadPaperViewMemory, recallPaperView } from '../lib/paperViewMemory'
import { usePaperView } from './PaperView'

type PdfNoteViewProps = {
  path: string
  title: string
  inputDisabled?: boolean
  /** First open fits the page column to the viewport (camera hosts only). */
  autoFit?: boolean
  onLayoutChange?: () => void
  toolbarSlotId?: string
  initialPage?: number
  onPageChange?: (page: number, pageCount: number) => void
}

type OutlineItem = {
  title: string
  page: number | null
  items: OutlineItem[]
}

type SearchHit = {
  page: number
  index: number
  excerpt: string
}

const RESIZE_DEBOUNCE_MS = 180
/** Scroll re-plan cadence; the plan itself is a no-op while the painted window still covers the viewport. */
const SCROLL_PAINT_THROTTLE_MS = 140
const HIDE_DEBOUNCE_MS = 360
const VIEWPORT_ROOT_MARGIN = '160px 0px'
const MIN_SCALE = 0.5
const MAX_SCALE = 2.5
const SCALE_STEP = 0.1
/** `.pdf-note-page` bottom margin, part of one page's advance in the column. */
const PAGE_GAP_PX = 16

type ZoomMode = PdfZoomMode

type FitZoom = { width: number; page: number; measured: boolean }

const UNMEASURED_FIT: FitZoom = { width: 1, page: 1, measured: false }

function PdfPageCanvas({
  pdf,
  number,
  rotation,
  textEnabled,
  highlight,
  onRatio,
  onReady,
}: {
  pdf: PDFDocumentProxy
  number: number
  rotation: number
  textEnabled: boolean
  highlight?: string
  onRatio: (ratio: number) => void
  onReady: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const baseARef = useRef<HTMLCanvasElement>(null)
  const baseBRef = useRef<HTMLCanvasElement>(null)
  const detailARef = useRef<HTMLCanvasElement>(null)
  const detailBRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<TextLayer | null>(null)
  const painterRef = useRef<PdfPagePainter | null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const textEnabledRef = useRef(textEnabled)
  textEnabledRef.current = textEnabled
  const lastBaseRef = useRef<PdfBasePaintInfo | null>(null)

  // The selectable text layer follows the page box, not the camera: it is
  // rebuilt with the base bitmap and left alone by scroll and zoom.
  const paintTextLayer = useCallback(async (info: PdfBasePaintInfo) => {
    const { page, cssWidth, naturalWidth, rotation: used } = info
    lastBaseRef.current = info
    const textHost = textRef.current
    if (!textHost) return
    if (!(textEnabledRef.current || textHost.childElementCount > 0)) return
    try { textLayerRef.current?.cancel() } catch { /* ignore */ }
    textHost.replaceChildren()
    const overlayScale = applyPdfTextOverlayScale(textHost, cssWidth, naturalWidth)
    const layer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textHost,
      viewport: page.getViewport({ scale: overlayScale, rotation: used }),
    })
    textLayerRef.current = layer
    try {
      await layer.render()
    } catch (error: unknown) {
      if (!(error instanceof Error) || !/cancel/iu.test(error.name)) {
        console.error(`Textebene der PDF-Seite ${number} konnte nicht aufgebaut werden.`, error)
      }
    }
  }, [number])

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
      onBasePainted: paintTextLayer,
      onFirstPaint: () => onReadyRef.current(),
    })
    painterRef.current = painter
    return () => {
      painterRef.current = null
      lastBaseRef.current = null
      painter.dispose()
      try { textLayerRef.current?.cancel() } catch { /* ignore */ }
      textLayerRef.current = null
    }
  }, [number, paintTextLayer])

  // Text selection switched on after the page was painted: build the layer now.
  useEffect(() => {
    const info = lastBaseRef.current
    if (!textEnabled || !info || (textRef.current?.childElementCount ?? 0) > 0) return
    void paintTextLayer(info)
  }, [paintTextLayer, textEnabled])

  useEffect(() => {
    let alive = true
    let loaded: PDFPageProxy | null = null
    void pdf.getPage(number).then((page) => {
      if (!alive) {
        page.cleanup()
        return
      }
      loaded = page
      const viewport = page.getViewport({ scale: 1, rotation })
      onRatio(viewport.height / Math.max(1, viewport.width))
      painterRef.current?.setPage(page, rotation)
      void painterRef.current?.paint()
    }).catch((error: unknown) => {
      if (alive) console.error(`PDF-Seite ${number} konnte nicht geladen werden.`, error)
    })
    return () => {
      alive = false
      painterRef.current?.setPage(null, rotation)
      try { loaded?.cleanup() } catch { /* ignore */ }
      loaded = null
    }
  }, [number, onRatio, pdf, rotation])

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
    // Scroll: planning is cheap and only re-paints once the viewport leaves
    // the painted window, so throttle (not debounce) — a long scroll at high
    // zoom keeps receiving sharp windows instead of waiting for a pause.
    const scheduleScroll = () => {
      if (scrollTimer) return
      scrollTimer = window.setTimeout(() => {
        scrollTimer = 0
        paint()
      }, SCROLL_PAINT_THROTTLE_MS)
    }
    const observer = new ResizeObserver(scheduleLayout)
    observer.observe(host)
    const stopZoom = watchSheetZoom(host, scheduleLayout)
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
    <div className="pdf-note-canvas-host" ref={hostRef}>
      <canvas ref={baseARef} aria-label={`PDF-Seite ${number}`} />
      <canvas ref={baseBRef} aria-hidden="true" />
      <canvas ref={detailARef} aria-hidden="true" />
      <canvas ref={detailBRef} aria-hidden="true" />
      <div
        className={`pdf-note-text-layer ${highlight ? 'has-search' : ''}`}
        data-highlight={highlight || undefined}
        ref={textRef}
      />
    </div>
  )
}

function PdfPage({
  pdf,
  number,
  rotation,
  textEnabled,
  highlight,
  defaultRatio,
  active,
  onRatio,
  onReady,
  onVisible,
}: {
  pdf: PDFDocumentProxy
  number: number
  rotation: number
  textEnabled: boolean
  highlight?: string
  defaultRatio: number
  active: boolean
  onRatio: (number: number, ratio: number) => void
  onReady: () => void
  onVisible: (number: number, ratio: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<number | null>(null)
  const [mounted, setMounted] = useState(false)
  const [ratio, setRatio] = useState(defaultRatio)

  const handleRatio = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0) return
    setRatio((current) => {
      if (Math.abs(current - next) < 0.002) return current
      onRatio(number, next)
      return next
    })
  }, [number, onRatio])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new IntersectionObserver(
      (entries) => {
        const next = Boolean(entries[0]?.isIntersecting)
        const visibility = entries[0]?.intersectionRatio ?? 0
        if (next) {
          if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current)
            hideTimerRef.current = null
          }
          setMounted(true)
          if (visibility >= 0.35) onVisible(number, visibility)
          return
        }
        if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null
          setMounted(false)
        }, HIDE_DEBOUNCE_MS)
      },
      { root: host.closest('.unified-note-view') as Element | null, rootMargin: VIEWPORT_ROOT_MARGIN, threshold: [0.01, 0.35, 0.6] },
    )
    observer.observe(host)
    return () => {
      observer.disconnect()
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    }
  }, [number, onVisible])

  return (
    <article
      className={`pdf-note-page ${mounted ? 'is-visible' : 'is-virtualized'} ${active ? 'is-current' : ''}`}
      data-pdf-page={number}
      ref={hostRef}
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      <span className="pdf-note-page-label">{number}</span>
      {mounted && (
        <PdfPageCanvas
          pdf={pdf}
          number={number}
          rotation={rotation}
          textEnabled={textEnabled}
          highlight={highlight}
          onRatio={handleRatio}
          onReady={onReady}
        />
      )}
    </article>
  )
}

function Thumbnail({
  pdf,
  number,
  rotation,
  active,
  onOpen,
}: {
  pdf: PDFDocumentProxy
  number: number
  rotation: number
  active: boolean
  onOpen: (page: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    let page: PDFPageProxy | null = null
    void enqueuePdfRender(async () => {
      if (!alive || !canvasRef.current) return
      page = await pdf.getPage(number)
      if (!alive) {
        page.cleanup()
        return
      }
      const base = page.getViewport({ scale: 1, rotation })
      const cssWidth = 76
      const cssHeight = Math.max(48, Math.round(cssWidth * (base.height / Math.max(1, base.width))))
      const viewport = page.getViewport({ scale: cssWidth / Math.max(1, base.width), rotation })
      const canvas = canvasRef.current
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: context, viewport, intent: 'display' }).promise
    }).catch(() => undefined)
    return () => {
      alive = false
      try { page?.cleanup() } catch { /* ignore */ }
    }
  }, [number, pdf, rotation])

  return (
    <button
      type="button"
      className={`pdf-note-thumb ${active ? 'is-active' : ''}`}
      onClick={() => onOpen(number)}
      aria-current={active ? 'page' : undefined}
    >
      <canvas ref={canvasRef} />
      <small>{number}</small>
    </button>
  )
}

async function outlineFromPdf(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const raw = await pdf.getOutline()
  if (!raw?.length) return []

  const resolvePage = async (dest: unknown): Promise<number | null> => {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
      if (!Array.isArray(explicit) || explicit[0] == null) return null
      if (typeof explicit[0] === 'number' && Number.isInteger(explicit[0])) {
        return Math.min(pdf.numPages, Math.max(1, explicit[0] + 1))
      }
      return (await pdf.getPageIndex(explicit[0])) + 1
    } catch {
      return null
    }
  }

  const walk = async (items: Array<{ title?: string; dest?: unknown; items?: unknown }>): Promise<OutlineItem[]> => {
    const next: OutlineItem[] = []
    for (const item of items.slice(0, 200)) {
      next.push({
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Abschnitt',
        page: await resolvePage(item.dest),
        items: Array.isArray(item.items) ? await walk(item.items as Array<{ title?: string; dest?: unknown; items?: unknown }>) : [],
      })
    }
    return next
  }
  return walk(raw as Array<{ title?: string; dest?: unknown; items?: unknown }>)
}

export function PdfNoteView({
  path,
  title,
  inputDisabled = false,
  onLayoutChange,
  toolbarSlotId = PDF_TOOLBAR_SLOT_ID,
  autoFit = true,
  initialPage,
  onPageChange,
}: PdfNoteViewProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [passwordDraft, setPasswordDraft] = useState('')
  const [password, setPassword] = useState('')
  const [needsPassword, setNeedsPassword] = useState(false)
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setToolbarHost(document.getElementById(toolbarSlotId))
  }, [toolbarSlotId])
  const [pageDraft, setPageDraft] = useState('1')
  const [rotation, setRotation] = useState(0)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width')
  const [scale, setScale] = useState(1)
  const [sidebar, setSidebar] = useState<'none' | 'thumbs' | 'outline'>('none')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchIndex, setSearchIndex] = useState(0)
  const [searching, setSearching] = useState(false)
  const [pageRatio, setPageRatio] = useState(DEFAULT_PDF_PAGE_RATIO)
  const [fitPageScale, setFitPageScale] = useState(1)
  const pagesRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const layoutTimerRef = useRef<number | null>(null)
  const searchTokenRef = useRef(0)
  const pdfTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const loadedPathRef = useRef('')

  // Inside a PaperView the toolbar zoom is the sheet camera: the page column
  // keeps its layout width (ink is 0–1 of the paper) and the camera scales it.
  // Without a camera host (subject book pane) the column width is scaled.
  const camera = usePaperView()
  const cameraHosted = camera !== null
  const cameraZoom = camera?.zoom ?? 1
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const [fit, setFit] = useState<FitZoom>(UNMEASURED_FIT)
  const [cameraMode, setCameraModeState] = useState<ZoomMode>('custom')
  const cameraModeRef = useRef<ZoomMode>('custom')
  const setCameraMode = useCallback((mode: ZoomMode) => {
    cameraModeRef.current = mode
    setCameraModeState(mode)
  }, [])
  /** Zoom this view asked the camera for; anything else is the user's own zoom. */
  const expectedZoomRef = useRef<number | null>(null)
  const currentPageRef = useRef(1)

  const measureFit = useCallback((): FitZoom | null => {
    const pages = pagesRef.current
    const scroller = resolvePaperZoomScroller(pages)
    if (!pages || !scroller || !(pages.offsetWidth > 8) || !(scroller.clientWidth > 8)) return null
    const firstPage = pages.querySelector<HTMLElement>('.pdf-note-page')
    const input = {
      viewWidth: scroller.clientWidth,
      viewHeight: scroller.clientHeight,
      columnWidth: pages.offsetWidth,
      pageHeight: firstPage ? firstPage.offsetHeight + PAGE_GAP_PX : 0,
      min: VIEW_ZOOM_MIN,
      max: readSharedZoomMax(),
    }
    return { width: pdfFitWidthZoom(input), page: pdfFitPageZoom(input), measured: true }
  }, [])

  const applyCameraZoom = useCallback((zoom: number, mode: ZoomMode, options: { pageTop?: number } = {}) => {
    const cam = cameraRef.current
    const pages = pagesRef.current
    const scroller = resolvePaperZoomScroller(pages)
    if (!cam || !pages || !scroller) return
    setCameraMode(mode)
    expectedZoomRef.current = zoom
    const viewRect = scroller.getBoundingClientRect()
    // Client box, not the border box: the scrollbar is not part of the viewport.
    cam.zoomTo(zoom, { x: viewRect.left + scroller.clientWidth / 2, y: viewRect.top + scroller.clientHeight / 2 })
    // Fit modes centre the column like every PDF viewer; ± steps keep the
    // point under the viewport centre, which is already centred then.
    if (mode !== 'custom') {
      scroller.scrollLeft = pdfColumnCentreScrollLeft(scroller, viewRect.left, pages.getBoundingClientRect())
    }
    if (options.pageTop) {
      const node = pages.querySelector<HTMLElement>(`[data-pdf-page="${options.pageTop}"]`)
      if (node) scroller.scrollTop = pdfPageTopScrollTop(scroller, viewRect.top, node.getBoundingClientRect())
    }
  }, [setCameraMode])

  const notifyLayout = useCallback(() => {
    if (!onLayoutChange) return
    if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current)
    layoutTimerRef.current = window.setTimeout(() => {
      layoutTimerRef.current = null
      onLayoutChange()
    }, 80)
  }, [onLayoutChange])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setNeedsPassword(false)
    setPasswordDraft('')
    setPdf(null)
    setOutline([])
    setSearchHits([])
    setSearchQuery('')
    setSearchOpen(false)
    setSidebar('none')
    setRotation(0)
    setZoomMode('fit-width')
    setScale(1)
    // Decided once the document is in the DOM (see the layout effect below):
    // a remembered camera is the user's, a first open fits the column.
    setCameraMode('custom')
    expectedZoomRef.current = null
    setFit(UNMEASURED_FIT)
    void loadVaultPdfBytes(path)
      .then(async (bytes) => {
        if (!alive) return
        if (!bytes.length) throw new Error('Die PDF-Datei ist leer.')
        try {
          const { pdf: loaded, task } = await openPdfDocument(bytes, password || undefined)
          if (!alive) {
            await task.destroy()
            return
          }
          pdfTaskRef.current = task
          setPdf(loaded)
          setPageCount(loaded.numPages)
          const restored = pdfStartPageForLoad(path, loadedPathRef.current, initialPage)
          loadedPathRef.current = path
          const start = Math.max(1, Math.min(loaded.numPages, restored ?? 1))
          setCurrentPage(start)
          setPageDraft(String(start))
          try {
            const first = await loaded.getPage(1)
            if (alive) {
              const viewport = first.getViewport({ scale: 1, rotation })
              setPageRatio(viewport.height / Math.max(1, viewport.width))
            }
          } catch {
            // Keep the A4 fallback.
          }
          void outlineFromPdf(loaded).then((items) => { if (alive) setOutline(items) })
          setLoading(false)
          notifyLayout()
        } catch (reason: unknown) {
          const name = reason && typeof reason === 'object' && 'name' in reason ? String(reason.name) : ''
          if (name === 'PasswordException') {
            setNeedsPassword(true)
            setLoading(false)
            setError(null)
            return
          }
          throw reason
        }
      })
      .catch((reason: unknown) => {
        if (!alive) return
        const message = reason instanceof Error ? reason.message : 'Das PDF konnte nicht geöffnet werden.'
        setError(/failed to fetch/iu.test(message)
          ? 'PDF konnte nicht gelesen werden. Bitte erneut importieren oder eine kleinere Datei wählen.'
          : message)
        setLoading(false)
      })
    return () => {
      alive = false
      if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current)
      const task = pdfTaskRef.current
      pdfTaskRef.current = null
      void task?.destroy().catch(() => undefined)
    }
  }, [notifyLayout, password, path, setCameraMode])

  useEffect(() => {
    if (!onPageChange || pageCount < 1) return
    onPageChange(currentPage, pageCount)
  }, [currentPage, onPageChange, pageCount])

  useEffect(() => {
    const stage = pagesRef.current?.closest('.unified-note-view') as HTMLElement | null
    if (!stage) return
    const update = () => {
      const width = Math.max(1, stage.clientWidth - 48)
      const height = Math.max(1, stage.clientHeight - 96)
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (height / Math.max(1, width * pageRatio))))
      setFitPageScale(Number.isFinite(next) ? next : 1)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [pageRatio])

  const appliedScale = zoomMode === 'fit-page' ? fitPageScale : scale
  currentPageRef.current = currentPage

  useLayoutEffect(() => {
    if (!pdf) return
    const cam = cameraRef.current
    // A remembered camera (PaperView) reopens the exact spot; page-into-view
    // would yank it to the page centre and a fit would overrule the user.
    if (cam ? cam.recalled : recallPaperView(loadPaperViewMemory(), path)) {
      if (cam) setCameraMode('custom')
      return
    }
    if (cam && autoFit) {
      // First open: the page column fills the viewport width, the start page
      // sits at the top — no empty stage beside a 900px column on a wide window.
      const measured = measureFit()
      if (measured) {
        setFit(measured)
        applyCameraZoom(measured.width, 'fit-width', { pageTop: currentPageRef.current })
      } else {
        setCameraMode('fit-width')
      }
      return
    }
    const node = pagesRef.current?.querySelector(`[data-pdf-page="${currentPageRef.current}"]`)
    node?.scrollIntoView({ block: pdfPageScrollIntoViewBlock('center'), behavior: 'auto' })
  }, [applyCameraZoom, autoFit, measureFit, pdf, path, setCameraMode])

  // Fit factors follow the viewport and the page boxes (ratios arrive per page).
  useEffect(() => {
    if (!cameraHosted || !pdf) return
    const pages = pagesRef.current
    const scroller = resolvePaperZoomScroller(pages)
    if (!pages || !scroller) return
    let frame = 0
    const update = () => {
      frame = 0
      const measured = measureFit()
      if (!measured) return
      setFit((current) => (
        current.measured && Math.abs(current.width - measured.width) < 0.001 && Math.abs(current.page - measured.page) < 0.001
          ? current
          : measured
      ))
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    observer.observe(pages)
    const firstPage = pages.querySelector<HTMLElement>('.pdf-note-page')
    if (firstPage) observer.observe(firstPage)
    schedule()
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [cameraHosted, measureFit, pdf, pageRatio])

  // The user zoomed the sheet themselves (wheel, pinch, HUD): the toolbar
  // shows that zoom and stops re-fitting on resize.
  useEffect(() => {
    if (!cameraHosted || !fit.measured) return
    const expected = expectedZoomRef.current
    if (expected !== null && Math.abs(cameraZoom - expected) <= 0.006) return
    expectedZoomRef.current = null
    const derived = pdfZoomModeForZoom(cameraZoom, fit)
    if (derived !== cameraModeRef.current) setCameraMode(derived)
  }, [cameraHosted, cameraZoom, fit, setCameraMode])

  // Viewport or page boxes changed while a fit mode is active: keep the fit.
  useEffect(() => {
    if (!cameraHosted || !pdf || !fit.measured) return
    const mode = cameraModeRef.current
    if (mode === 'fit-width') applyCameraZoom(fit.width, 'fit-width')
    else if (mode === 'fit-page') applyCameraZoom(fit.page, 'fit-page')
  }, [applyCameraZoom, cameraHosted, fit, pdf])

  const scrollToPage = useCallback((page: number) => {
    const target = Math.max(1, Math.min(pageCount || 1, Math.round(page)))
    const node = pagesRef.current?.querySelector(`[data-pdf-page="${target}"]`)
    node?.scrollIntoView({ block: pdfPageScrollIntoViewBlock('center'), behavior: 'smooth' })
    setCurrentPage(target)
    setPageDraft(String(target))
  }, [pageCount])

  const handleVisible = useCallback((page: number, ratio: number) => {
    if (ratio < 0.35) return
    setCurrentPage((current) => current === page ? current : page)
    setPageDraft((current) => current === String(page) ? current : String(page))
  }, [])

  const handlePageRatio = useCallback((page: number, ratio: number) => {
    if (page === 1) setPageRatio(ratio)
  }, [])

  const changeScale = useCallback((next: number, mode: ZoomMode = 'custom') => {
    setZoomMode(mode)
    setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(next * 100) / 100)))
    notifyLayout()
  }, [notifyLayout])

  const runSearch = useCallback(async (query: string) => {
    const needle = query.trim()
    if (!pdf || !needle) {
      setSearchHits([])
      setSearchIndex(0)
      return
    }
    const token = ++searchTokenRef.current
    setSearching(true)
    const hits: SearchHit[] = []
    const lower = needle.toLocaleLowerCase('de-DE')
    for (let page = 1; page <= pdf.numPages; page += 1) {
      if (token !== searchTokenRef.current) return
      try {
        const pdfPage = await pdf.getPage(page)
        const content = await pdfPage.getTextContent()
        const text = content.items
          .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
          .join(' ')
        const haystack = text.toLocaleLowerCase('de-DE')
        let cursor = 0
        let local = 0
        while (cursor < haystack.length && hits.length < 400) {
          const index = haystack.indexOf(lower, cursor)
          if (index < 0) break
          hits.push({
            page,
            index: local,
            excerpt: text.slice(Math.max(0, index - 28), Math.min(text.length, index + needle.length + 42)).replace(/\s+/gu, ' ').trim(),
          })
          local += 1
          cursor = index + Math.max(needle.length, 1)
        }
      } catch {
        // A damaged page must not abort in-document search.
      }
    }
    if (token !== searchTokenRef.current) return
    setSearchHits(hits)
    setSearchIndex(0)
    setSearching(false)
    if (hits[0]) scrollToPage(hits[0].page)
  }, [pdf, scrollToPage])

  useEffect(() => {
    if (!searchOpen) return
    const timer = window.setTimeout(() => { void runSearch(searchQuery) }, 180)
    return () => window.clearTimeout(timer)
  }, [runSearch, searchOpen, searchQuery])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const jumpSearch = useCallback((direction: 1 | -1) => {
    if (!searchHits.length) return
    const next = (searchIndex + direction + searchHits.length) % searchHits.length
    setSearchIndex(next)
    scrollToPage(searchHits[next].page)
  }, [scrollToPage, searchHits, searchIndex])

  const handleChromeKey = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (inputDisabled) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea')) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      setSearchOpen(true)
      return
    }
    if (event.key === 'PageDown' || event.key === 'ArrowDown') {
      event.preventDefault()
      scrollToPage(currentPage + 1)
    } else if (event.key === 'PageUp' || event.key === 'ArrowUp') {
      event.preventDefault()
      scrollToPage(currentPage - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      scrollToPage(1)
    } else if (event.key === 'End') {
      event.preventDefault()
      scrollToPage(pageCount)
    }
  }, [currentPage, inputDisabled, pageCount, scrollToPage])

  const renderOutline = (items: OutlineItem[], depth = 0) => items.map((item, index) => (
    <li key={`${depth}-${index}-${item.title}`}>
      <button
        type="button"
        disabled={!item.page}
        onClick={() => item.page && scrollToPage(item.page)}
      >
        <span>{item.title}</span>
        {item.page ? <small>{item.page}</small> : null}
      </button>
      {item.items.length > 0 && <ul>{renderOutline(item.items, depth + 1)}</ul>}
    </li>
  ))

  const activeHighlight = searchHits[searchIndex]?.page === currentPage ? searchQuery.trim() : ''
  const shownMode: ZoomMode = cameraHosted ? cameraMode : zoomMode
  const zoomLabel = cameraHosted
    ? `${Math.round(cameraZoom * 100)} %`
    : zoomMode === 'fit-width' ? 'Breite' : zoomMode === 'fit-page' ? 'Seite' : `${Math.round(appliedScale * 100)} %`
  const zoomOutDisabled = cameraHosted ? cameraZoom <= VIEW_ZOOM_MIN + 1e-6 : appliedScale <= MIN_SCALE
  const zoomInDisabled = cameraHosted ? cameraZoom >= readSharedZoomMax() - 1e-6 : appliedScale >= MAX_SCALE
  const zoomOut = () => {
    if (cameraHosted) applyCameraZoom(pdfZoomStep(cameraZoom, -1, VIEW_ZOOM_MIN, readSharedZoomMax()), 'custom')
    else changeScale(appliedScale - SCALE_STEP)
  }
  const zoomIn = () => {
    if (cameraHosted) applyCameraZoom(pdfZoomStep(cameraZoom, 1, VIEW_ZOOM_MIN, readSharedZoomMax()), 'custom')
    else changeScale(appliedScale + SCALE_STEP)
  }
  const fitWidth = () => {
    if (cameraHosted) {
      const measured = measureFit()
      if (measured) setFit(measured)
      applyCameraZoom((measured ?? fit).width, 'fit-width')
      return
    }
    setZoomMode('fit-width')
    setScale(1)
    notifyLayout()
  }
  const fitPage = () => {
    if (cameraHosted) {
      const measured = measureFit()
      if (measured) setFit(measured)
      applyCameraZoom((measured ?? fit).page, 'fit-page', { pageTop: currentPage })
      return
    }
    setZoomMode('fit-page')
  }
  const thumbs = useMemo(() => (pdf ? Array.from({ length: Math.min(pdf.numPages, 80) }, (_, index) => index + 1) : []), [pdf])

  const chrome = (
    <>
      <header className="pdf-note-toolbar">
        <span className="pdf-note-identity">
          <FileText size={15} />
          <strong>{title}</strong>
          <small>{pageCount ? `${pageCount} ${pageCount === 1 ? 'Seite' : 'Seiten'}` : '…'}</small>
        </span>
        <span className="pdf-note-pager">
          <button type="button" aria-label="Vorherige Seite" disabled={!pdf || currentPage <= 1} onClick={() => scrollToPage(currentPage - 1)}><ChevronUp size={14} /></button>
          <form onSubmit={(event) => { event.preventDefault(); scrollToPage(Number(pageDraft) || 1) }}>
            <input
              value={pageDraft}
              onChange={(event) => setPageDraft(event.target.value.replace(/[^\d]/gu, ''))}
              aria-label="Seitennummer"
              inputMode="numeric"
              disabled={!pdf}
            />
          </form>
          <span>/ {pageCount || '…'}</span>
          <button type="button" aria-label="Nächste Seite" disabled={!pdf || currentPage >= pageCount} onClick={() => scrollToPage(currentPage + 1)}><ChevronDown size={14} /></button>
        </span>
        <span className="pdf-note-zoom">
          <button type="button" aria-label="Verkleinern" disabled={!pdf || zoomOutDisabled} onClick={zoomOut}><ZoomOut size={14} /></button>
          <button type="button" className={shownMode === 'custom' ? 'is-active' : ''} title="Zoom zurücksetzen" disabled={!pdf} onClick={fitWidth}>{zoomLabel}</button>
          <button type="button" aria-label="Vergrößern" disabled={!pdf || zoomInDisabled} onClick={zoomIn}><ZoomIn size={14} /></button>
          <button type="button" className={shownMode === 'fit-width' ? 'is-active' : ''} title="An Breite anpassen" disabled={!pdf} onClick={fitWidth}>Breite</button>
          <button type="button" className={shownMode === 'fit-page' ? 'is-active' : ''} title="Ganze Seite" aria-label="Ganze Seite" disabled={!pdf} onClick={fitPage}><Maximize2 size={14} /></button>
        </span>
        <span className="pdf-note-tools">
          <button type="button" className={searchOpen ? 'is-active' : ''} title="Im PDF suchen (Strg+F)" aria-label="Im PDF suchen" onClick={() => setSearchOpen((value) => !value)}><Search size={14} /></button>
          <button type="button" className={sidebar === 'thumbs' ? 'is-active' : ''} title="Miniaturen" aria-label="Miniaturen" onClick={() => setSidebar((value) => value === 'thumbs' ? 'none' : 'thumbs')}><PanelLeft size={14} /></button>
          <button type="button" className={sidebar === 'outline' ? 'is-active' : ''} title="Gliederung" aria-label="PDF-Gliederung" disabled={!outline.length} onClick={() => setSidebar((value) => value === 'outline' ? 'none' : 'outline')}><ListTree size={14} /></button>
          <button type="button" title="Drehen" aria-label="Seite drehen" onClick={() => setRotation((value) => (value + 90) % 360)}><RotateCw size={14} /></button>
        </span>
      </header>

      {searchOpen && (
        <div className="pdf-note-search">
          <Search size={13} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Im PDF suchen …"
            aria-label="PDF durchsuchen"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                jumpSearch(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') setSearchOpen(false)
            }}
          />
          <small>{searching ? 'Sucht …' : searchHits.length ? `${searchIndex + 1} / ${searchHits.length}` : searchQuery.trim() ? 'Keine Treffer' : ''}</small>
          <button type="button" aria-label="Vorheriger Treffer" disabled={!searchHits.length} onClick={() => jumpSearch(-1)}><ChevronLeft size={13} /></button>
          <button type="button" aria-label="Nächster Treffer" disabled={!searchHits.length} onClick={() => jumpSearch(1)}><ChevronRight size={13} /></button>
          <button type="button" aria-label="Suche schließen" onClick={() => setSearchOpen(false)}><X size={13} /></button>
        </div>
      )}
    </>
  )

  return (
    <section
      className={`pdf-note-view ${inputDisabled ? PDF_INKING_CLASS : ''} ${sidebar !== 'none' ? 'has-sidebar' : ''}`}
      aria-label={`PDF ${title}`}
      tabIndex={inputDisabled ? -1 : 0}
      onKeyDown={handleChromeKey}
    >
      {toolbarHost && !inputDisabled ? createPortal(chrome, toolbarHost) : null}
      {/* Only until the document exists: kept in flow above the pages, the 220px
          placeholder shifts the column (and any camera measured against it)
          when `loading` clears a tick after `pdf` is set. */}
      {loading && !pdf && <div className="pdf-note-status"><LoaderCircle className="spin" size={20} /> PDF wird vorbereitet …</div>}
      {needsPassword && !pdf && (
        <form className="pdf-note-password" onSubmit={(event) => { event.preventDefault(); setPassword(passwordDraft) }}>
          <strong>Dieses PDF ist geschützt</strong>
          <input
            type="password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            placeholder="Passwort"
            aria-label="PDF-Passwort"
            autoFocus
          />
          <button type="submit" className="primary-button">Öffnen</button>
        </form>
      )}
      {error && <div className="pdf-note-error"><FileText size={22} /><strong>PDF nicht verfügbar</strong><span>{error}</span></div>}

      {!error && pdf && (
        <div className="pdf-note-body">
          {sidebar === 'thumbs' && (
            <aside className="pdf-note-sidebar" aria-label="Miniaturseiten">
              {thumbs.map((page) => (
                <Thumbnail key={page} pdf={pdf} number={page} rotation={rotation} active={page === currentPage} onOpen={scrollToPage} />
              ))}
              {pdf.numPages > thumbs.length && <small>Erste {thumbs.length} Seiten</small>}
            </aside>
          )}
          {sidebar === 'outline' && (
            <aside className="pdf-note-sidebar pdf-note-outline" aria-label="PDF-Gliederung">
              {outline.length ? <ul>{renderOutline(outline)}</ul> : <p>Keine Gliederung vorhanden.</p>}
            </aside>
          )}
          <div
            className="pdf-note-pages"
            ref={pagesRef}
            style={{ width: cameraHosted ? '100%' : `${Math.round(appliedScale * 100)}%` }}
          >
            {Array.from({ length: pdf.numPages }, (_, index) => {
              const page = index + 1
              return (
                <PdfPage
                  key={`${page}-${rotation}`}
                  pdf={pdf}
                  number={page}
                  rotation={rotation}
                  textEnabled
                  highlight={searchHits.some((hit) => hit.page === page) ? searchQuery.trim() : activeHighlight}
                  defaultRatio={pageRatio}
                  active={page === currentPage}
                  onRatio={handlePageRatio}
                  onReady={notifyLayout}
                  onVisible={handleVisible}
                />
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

export default PdfNoteView
