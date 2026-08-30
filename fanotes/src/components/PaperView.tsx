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
  VIEW_ZOOM_MIN,
  applyPaperViewToElements,
  applyPaperZoomStayPut,
  clampPaperScrollerToZoomedSheet,
  clampViewZoom,
  defaultPaperView,
  isPaperViewActive,
  normalizeRotation,
  readSharedPaperView,
  readSharedZoomMax,
  readSharedZoomSpeed,
  subscribeSharedPaperView,
  writeSharedPaperView,
  zoomFactorFromWheel,
  zoomStepFromSpeed,
  isSheetZoomWheel,
  sheetZoomStepFromDirection,
  type PaperViewSnapshot,
} from '../lib/paperView'
import { SCROLL_ROOM } from '../lib/noteCanvas'
import {
  lockPaperViewportScrollStayPut,
  PAPER_EDITOR_FLING_HOLD_FRAMES,
  tickPaperViewportEditorScrollHold,
} from '../lib/paperCaretScroll'

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
  const viewRef = useRef(readSharedPaperView())
  const lastWheelZoomAtRef = useRef(0)
  const lastZoomOriginRef = useRef<{ x: number; y: number } | null>(null)
  const [view, setViewState] = useState(readSharedPaperView)

  const paint = useCallback((next: PaperViewSnapshot) => {
    viewRef.current = next
    setViewState(next)
    const noteView = noteViewRef.current
    const paper = noteView?.querySelector<HTMLElement>('.unified-paper') ?? null
    applyPaperViewToElements(paper, noteView, next)
  }, [])

  const apply = useCallback((next: PaperViewSnapshot) => {
    writeSharedPaperView(next)
  }, [])

  useEffect(() => subscribeSharedPaperView(paint), [paint])

  useEffect(() => {
    paint(readSharedPaperView())
  }, [paint])

  useEffect(() => {
    // Reset only when the note identity changes. Toggling the HUD (pen vs
    // keyboard) must keep the same sheet zoom so ruling, ink and text stay one.
    writeSharedPaperView(defaultPaperView())
  }, [viewKey])

  useEffect(() => {
    const scroller = noteViewRef.current
    if (!scroller) return
    let flingFrames = 0
    let flingId = 0
    const holdFling = () => {
      const tick = tickPaperViewportEditorScrollHold(scroller, flingFrames)
      flingFrames = tick.remainingFrames
      flingId = flingFrames > 0 ? window.requestAnimationFrame(holdFling) : 0
    }
    const clampScroll = () => {
      lockPaperViewportScrollStayPut(scroller)
      flingFrames = PAPER_EDITOR_FLING_HOLD_FRAMES
      if (!flingId) flingId = window.requestAnimationFrame(holdFling)
      const plane = scroller.querySelector<HTMLElement>('.paper-sheet-plane')
        ?? scroller.querySelector<HTMLElement>('.unified-paper')
      clampPaperScrollerToZoomedSheet(scroller, plane)
    }
    scroller.addEventListener('scroll', clampScroll, { passive: true })
    const plane = scroller.querySelector<HTMLElement>('.paper-sheet-plane')
    const room = Number.parseFloat(plane?.style.getPropertyValue('--paper-scroll-room') || '') || SCROLL_ROOM
    if (scroller.scrollLeft === 0 && scroller.scrollTop === 0 && scroller.scrollWidth > scroller.clientWidth) {
      scroller.scrollLeft = room
      scroller.scrollTop = room
    }
    clampScroll()
    return () => {
      scroller.removeEventListener('scroll', clampScroll)
      if (flingId) window.cancelAnimationFrame(flingId)
    }
  }, [viewKey])

  const setView = useCallback((next: Partial<PaperViewSnapshot>) => {
    const current = viewRef.current
    const zoom = clampViewZoom(next.zoom ?? current.zoom)
    const rotation = normalizeRotation(next.rotation ?? current.rotation)
    if (zoom !== current.zoom) {
      const scroller = noteViewRef.current
      const sheet = scroller?.querySelector<HTMLElement>('.paper-sheet-plane')
        ?? scroller?.querySelector<HTMLElement>('.unified-paper')
        ?? null
      applyPaperZoomStayPut(
        scroller,
        sheet,
        current,
        zoom,
        lastZoomOriginRef.current ?? undefined,
        (view) => apply({ ...view, rotation, pan: { x: 0, y: 0 } }),
      )
      return
    }
    apply({ zoom, rotation, pan: { x: 0, y: 0 } })
  }, [apply])

  const zoomTo = useCallback((nextZoom: number, originClient?: { x: number; y: number }) => {
    const current = viewRef.current
    const zoom = clampViewZoom(nextZoom)
    if (zoom === current.zoom) return
    const scroller = noteViewRef.current
    const sheet = scroller?.querySelector<HTMLElement>('.paper-sheet-plane')
      ?? scroller?.querySelector<HTMLElement>('.unified-paper')
      ?? null
    const origin = originClient ?? lastZoomOriginRef.current ?? undefined
    if (origin) lastZoomOriginRef.current = origin
    applyPaperZoomStayPut(scroller, sheet, current, zoom, origin, apply)
  }, [apply])

  const zoomBy = useCallback((delta: number, originClient?: { x: number; y: number }) => {
    zoomTo(viewRef.current.zoom + delta, originClient)
  }, [zoomTo])

  const rotateBy = useCallback((delta: number) => {
    apply({ ...viewRef.current, rotation: normalizeRotation(viewRef.current.rotation + delta), pan: { x: 0, y: 0 } })
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

    // A permanent {passive:false} wheel listener on the note scroller forces
    // main-thread scrolling. Chromium then re-rasterizes markdown on every
    // subpixel frame — the text looks stretched/warped. Keep the scroller
    // compositor-owned and only intercept Ctrl/Alt (zoom/rotate).
    let pendingFactor = 1
    let pendingOrigin: { x: number; y: number } | null = null
    let zoomFrame = 0
    const flushZoom = () => {
      zoomFrame = 0
      const factor = pendingFactor
      const origin = pendingOrigin
      pendingFactor = 1
      pendingOrigin = null
      if (factor === 1) return
      zoomTo(viewRef.current.zoom * factor, origin ?? undefined)
    }
    const onInterceptWheel = (event: WheelEvent) => {
      if (isSheetZoomWheel(event)) {
        if (event.cancelable) event.preventDefault()
        event.stopPropagation()
        pendingFactor *= zoomFactorFromWheel(event.deltaY, event.deltaMode, readSharedZoomSpeed())
        pendingOrigin = { x: event.clientX, y: event.clientY }
        lastZoomOriginRef.current = pendingOrigin
        lastWheelZoomAtRef.current = performance.now()
        if (!zoomFrame) zoomFrame = window.requestAnimationFrame(flushZoom)
        return
      }
      if (event.altKey) {
        if (event.cancelable) event.preventDefault()
        event.stopPropagation()
        rotateBy(event.deltaY > 0 ? VIEW_ROTATE_STEP : -VIEW_ROTATE_STEP)
      }
    }

    let intercepting = false
    let releaseTimer = 0
    const attachIntercept = () => {
      if (releaseTimer) {
        window.clearTimeout(releaseTimer)
        releaseTimer = 0
      }
      if (intercepting) return
      intercepting = true
      root.addEventListener('wheel', onInterceptWheel, { capture: true, passive: false })
    }
    const releaseIntercept = () => {
      if (releaseTimer) {
        window.clearTimeout(releaseTimer)
        releaseTimer = 0
      }
      if (!intercepting) return
      intercepting = false
      root.removeEventListener('wheel', onInterceptWheel, { capture: true })
    }
    const scheduleRelease = () => {
      if (releaseTimer) window.clearTimeout(releaseTimer)
      releaseTimer = window.setTimeout(releaseIntercept, 200)
    }

    const onProbe = (event: WheelEvent) => {
      if (isSheetZoomWheel(event) || event.altKey) {
        const firstTick = !intercepting
        attachIntercept()
        // Newly added listeners skip this event. Always apply the first
        // pinch tick — Chromium may already have defaultPrevented a visual
        // zoom it cannot perform (limits 1–1), which used to drop zoom-in.
        if (firstTick) onInterceptWheel(event)
        return
      }
      scheduleRelease()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) attachIntercept()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) scheduleRelease()
    }

    const onPointer = (event: PointerEvent) => {
      lastZoomOriginRef.current = { x: event.clientX, y: event.clientY }
    }
    root.addEventListener('wheel', onProbe, { capture: true, passive: true })
    root.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', releaseIntercept)
    return () => {
      root.removeEventListener('wheel', onProbe, { capture: true })
      root.removeEventListener('pointermove', onPointer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', releaseIntercept)
      if (zoomFrame) window.cancelAnimationFrame(zoomFrame)
      releaseIntercept()
    }
  }, [rotateBy, zoomTo])

  useEffect(() => {
    const subscribe = window.fanotes?.onSheetZoom
    if (typeof subscribe !== 'function') return undefined
    return subscribe((direction) => {
      if (performance.now() - lastWheelZoomAtRef.current < 80) return
      zoomBy(sheetZoomStepFromDirection(direction), lastZoomOriginRef.current ?? undefined)
    })
  }, [zoomBy])

  useEffect(() => {
    if (!showHud) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
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
        zoomBy(zoomStepFromSpeed(readSharedZoomSpeed()), lastZoomOriginRef.current ?? undefined)
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomBy(-zoomStepFromSpeed(readSharedZoomSpeed()), lastZoomOriginRef.current ?? undefined)
      } else if (event.key === '0') {
        event.preventDefault()
        resetView()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [resetView, showHud, zoomBy])

  const active = isPaperViewActive(view)

  return (
    <PaperViewContext.Provider value={api}>
      <div
        ref={noteViewRef}
        className={`paper-view ${className}`}
        data-paper-zoom={view.zoom}
      >
        <div className="paper-sheet-plane">
          <div className="paper-ruling" aria-hidden="true" />
          {children}
        </div>
        {showHud && (
          <div className={`paper-view-hud ${active ? 'is-active' : ''}`} aria-label="Blattansicht">
            <button type="button" aria-label="Herauszoomen" title="Herauszoomen (Strg+- · Strg+Mausrad)" onClick={() => zoomBy(-zoomStepFromSpeed(readSharedZoomSpeed()), lastZoomOriginRef.current ?? undefined)} disabled={view.zoom <= VIEW_ZOOM_MIN}>
              <ZoomOut size={15} />
            </button>
            <button type="button" aria-label="Hineinzoomen" title="Hineinzoomen (Strg++ · Strg+Mausrad)" onClick={() => zoomBy(zoomStepFromSpeed(readSharedZoomSpeed()), lastZoomOriginRef.current ?? undefined)} disabled={view.zoom >= readSharedZoomMax()}>
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
