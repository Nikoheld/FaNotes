import { RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  VIEW_ROTATE_STEP,
  VIEW_ZOOM_MAX,
  VIEW_ZOOM_MIN,
  VIEW_ZOOM_STEP,
  applyPaperViewToElements,
  clampViewZoom,
  defaultPaperView,
  isPaperViewActive,
  normalizeRotation,
  zoomAroundPoint,
  type PaperViewSnapshot,
} from '../lib/paperView'

export type PaperViewApi = PaperViewSnapshot & {
  zoomBy: (delta: number, originClient?: { x: number; y: number }) => void
  rotateBy: (delta: number) => void
  resetView: () => void
  setView: (next: Partial<PaperViewSnapshot>) => void
}

const PaperViewContext = createContext<PaperViewApi | null>(null)

export const usePaperView = () => useContext(PaperViewContext)

type PaperViewProps = {
  children: ReactNode
  className?: string
  /** Reset view when this identity changes (usually the note path). */
  viewKey?: string
  showHud?: boolean
}

export function PaperView({ children, className = '', viewKey, showHud = true }: PaperViewProps) {
  const noteViewRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef(defaultPaperView())
  const [view, setViewState] = useState(defaultPaperView)

  const apply = useCallback((next: PaperViewSnapshot) => {
    viewRef.current = next
    setViewState(next)
    const noteView = noteViewRef.current
    const paper = noteView?.querySelector<HTMLElement>('.unified-paper') ?? null
    applyPaperViewToElements(paper, noteView, next)
  }, [])

  useEffect(() => {
    apply(defaultPaperView())
  }, [apply, viewKey])

  useEffect(() => {
    apply(viewRef.current)
  }, [apply])

  const setView = useCallback((next: Partial<PaperViewSnapshot>) => {
    const current = viewRef.current
    apply({
      zoom: clampViewZoom(next.zoom ?? current.zoom),
      rotation: normalizeRotation(next.rotation ?? current.rotation),
      pan: next.pan ?? current.pan,
    })
  }, [apply])

  const zoomBy = useCallback((delta: number, originClient?: { x: number; y: number }) => {
    const current = viewRef.current
    const nextZoom = clampViewZoom(current.zoom + delta)
    if (nextZoom === current.zoom) return
    const paper = noteViewRef.current?.querySelector<HTMLElement>('.unified-paper')
    if (originClient && paper) {
      apply(zoomAroundPoint(current, nextZoom, originClient, paper.getBoundingClientRect()))
      return
    }
    apply({ ...current, zoom: nextZoom })
  }, [apply])

  const rotateBy = useCallback((delta: number) => {
    apply({ ...viewRef.current, rotation: normalizeRotation(viewRef.current.rotation + delta) })
  }, [apply])

  const resetView = useCallback(() => {
    apply(defaultPaperView())
  }, [apply])

  const api = useMemo<PaperViewApi>(() => ({
    ...view,
    zoomBy,
    rotateBy,
    resetView,
    setView,
  }), [resetView, rotateBy, setView, view, zoomBy])

  useEffect(() => {
    const root = noteViewRef.current
    if (!root) return
    const onWheel = (event: WheelEvent) => {
      const current = viewRef.current
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        zoomBy(event.deltaY > 0 ? -VIEW_ZOOM_STEP : VIEW_ZOOM_STEP, { x: event.clientX, y: event.clientY })
        return
      }
      if (event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        rotateBy(event.deltaY > 0 ? VIEW_ROTATE_STEP : -VIEW_ROTATE_STEP)
        return
      }
      if (!isPaperViewActive(current)) return
      if (Math.abs(event.deltaX) < 0.5 && Math.abs(event.deltaY) < 0.5) return
      event.preventDefault()
      event.stopPropagation()
      apply({
        ...current,
        pan: {
          x: current.pan.x - event.deltaX,
          y: current.pan.y - event.deltaY,
        },
      })
    }
    root.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => root.removeEventListener('wheel', onWheel, { capture: true })
  }, [apply, rotateBy, zoomBy])

  useEffect(() => {
    const root = noteViewRef.current
    if (!root) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        // Allow typing in fields; still honor zoom shortcuts with Ctrl/Meta.
        if (!(event.ctrlKey || event.metaKey) && (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable)) {
          return
        }
      }
      if (event.key === 'Escape' && isPaperViewActive(viewRef.current)) {
        const active = document.activeElement
        if (active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
          return
        }
        event.preventDefault()
        resetView()
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        zoomBy(VIEW_ZOOM_STEP)
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomBy(-VIEW_ZOOM_STEP)
      } else if (event.key === '0') {
        event.preventDefault()
        resetView()
      }
    }
    // Window so shortcuts work while the CodeMirror editor has focus.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [resetView, zoomBy])

  const active = isPaperViewActive(view)

  return (
    <PaperViewContext.Provider value={api}>
      <div
        ref={noteViewRef}
        className={`paper-view ${className}`}
        data-paper-zoom={view.zoom}
      >
        {children}
        {showHud && (
          <div className={`paper-view-hud ${active ? 'is-active' : ''}`} aria-label="Blattansicht">
            <button type="button" aria-label="Herauszoomen" title="Herauszoomen (Strg+- · Strg+Mausrad)" onClick={() => zoomBy(-VIEW_ZOOM_STEP)} disabled={view.zoom <= VIEW_ZOOM_MIN}>
              <ZoomOut size={15} />
            </button>
            <button type="button" aria-label="Hineinzoomen" title="Hineinzoomen (Strg++ · Strg+Mausrad)" onClick={() => zoomBy(VIEW_ZOOM_STEP)} disabled={view.zoom >= VIEW_ZOOM_MAX}>
              <ZoomIn size={15} />
            </button>
            <button type="button" aria-label="Blatt gegen den Uhrzeigersinn drehen" title="Drehen (Alt+Mausrad)" onClick={() => rotateBy(-VIEW_ROTATE_STEP)}>
              <RotateCcw size={15} />
            </button>
            <button type="button" aria-label="Blatt im Uhrzeigersinn drehen" title="Drehen (Alt+Mausrad)" onClick={() => rotateBy(VIEW_ROTATE_STEP)}>
              <RotateCw size={15} />
            </button>
            <button
              type="button"
              className="paper-view-hud-reset"
              aria-label="Ansicht zurücksetzen"
              title="Zoom und Drehung zurücksetzen (Strg+0)"
              onClick={resetView}
              disabled={!active}
            >
              {Math.round(view.zoom * 100)}%{view.rotation ? ` · ${view.rotation}°` : ''}
            </button>
          </div>
        )}
      </div>
    </PaperViewContext.Provider>
  )
}
