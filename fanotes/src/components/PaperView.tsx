import { RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
  centrePageInViewportIfFits,
  clampPaperScrollerToZoomedSheet,
  clampViewZoom,
  defaultPaperView,
  isPaperViewActive,
  normalizeRotation,
  readSharedZoomMax,
  readSharedZoomSpeed,
  sharedPaperViewStore,
  zoomFactorFromWheel,
  zoomStepFromSpeed,
  isSheetZoomWheel,
  sheetZoomStepFromDirection,
  type PaperViewSnapshot,
  type PaperViewStore,
} from '../lib/paperView'
import { SCROLL_ROOM } from '../lib/noteCanvas'
import {
  PAPER_VIEW_RESTORE_SETTLE_MS,
  PAPER_VIEW_RESTORE_WARM_FRAMES,
  cameraForPaperCentre,
  isPaperViewTakeoverKey,
  isProgrammaticScroll,
  loadPaperViewMemory,
  paperCentreFromCamera,
  paperViewFromMemory,
  paperViewMemoryKey,
  recallPaperView,
  rememberPaperView,
  savePaperViewMemory,
  scaledPaperCentre,
  scrollTopForAnchorClientY,
  shouldKeepRestoringPaperView,
  type PaperViewMemoryEntry,
} from '../lib/paperViewMemory'
import { findPaperTextAnchorProvider } from '../lib/paperTextAnchor'
import { pdfOpenCameraFromScroller } from '../lib/pdfOpenCamera'
import {
  captureGhostTextAroundLock,
  ghostTextDiagnosticFields,
  lockPaperViewportScrollStayPut,
  PAPER_EDITOR_FLING_HOLD_FRAMES,
  tickPaperViewportEditorScrollHold,
} from '../lib/paperCaretScroll'
import { buildTextMotionDiagnosticEvent, recordTextMotionDiagnostic } from '../lib/bugReport'

export type PaperViewApi = PaperViewSnapshot & {
  zoomBy: (delta: number, originClient?: { x: number; y: number }) => void
  /** Absolute camera zoom around a client point (default: the last pointer position). */
  zoomTo: (zoom: number, originClient?: { x: number; y: number }) => void
  rotateBy: (delta: number) => void
  resetView: () => void
  setView: (next: Partial<PaperViewSnapshot>) => void
  /**
   * The current note came back with a remembered camera. False on a first
   * open — memory written while the note is loading does not count.
   */
  recalled: boolean
}

/**
 * The camera's controls without its state. Identity never changes while the
 * host lives, so a consumer can hold it without re-rendering on every zoom
 * step; the current snapshot comes from `getView`, changes from `subscribe`.
 */
export type PaperViewController = Pick<PaperViewApi, 'zoomBy' | 'zoomTo' | 'rotateBy' | 'resetView' | 'setView'> & {
  getView: () => PaperViewSnapshot
  subscribe: (listener: (view: PaperViewSnapshot) => void) => () => void
}

const PaperViewContext = createContext<PaperViewApi | null>(null)
const PaperViewControllerContext = createContext<PaperViewController | null>(null)

/** Camera state and controls; re-renders the consumer on every camera change. */
export const usePaperView = () => useContext(PaperViewContext)

/**
 * Controls only. Heavy consumers (the ink board) use this so a wheel zoom
 * does not rebuild their whole tree per step; they follow the camera through
 * `subscribe` and refs instead.
 */
export const usePaperViewController = () => useContext(PaperViewControllerContext)

type PaperViewProps = {
  children: ReactNode
  className?: string
  /** Reset view when this identity changes (usually the note path). */
  viewKey?: string
  showHud?: boolean
  /** Split view: the app tracks which pane the user last touched. */
  onPointerDownCapture?: () => void
  onFocusCapture?: () => void
  /**
   * The camera this pane drives. Defaults to the shared store the main note,
   * ink board and settings use; a second pane passes its own so its zoom stays
   * its own. Must not change while the pane lives.
   */
  store?: PaperViewStore
  /**
   * Electron pinch (`zoom-changed`) and the window-wide Ctrl+/- / Ctrl+0 keys
   * land on this pane. In a split the app points them at the focused pane.
   */
  globalShortcuts?: boolean
}

export function PaperView({ children, className = '', viewKey, showHud = true, onPointerDownCapture, onFocusCapture, store = sharedPaperViewStore, globalShortcuts = true }: PaperViewProps) {
  const noteViewRef = useRef<HTMLDivElement>(null)
  const storeRef = useRef(store)
  storeRef.current = store
  const viewRef = useRef(store.read())
  const lastWheelZoomAtRef = useRef(0)
  const lastZoomOriginRef = useRef<{ x: number; y: number } | null>(null)
  const [view, setViewState] = useState(store.read)
  const [recalled, setRecalled] = useState(false)

  const paint = useCallback((next: PaperViewSnapshot) => {
    viewRef.current = next
    setViewState(next)
    const noteView = noteViewRef.current
    const paper = noteView?.querySelector<HTMLElement>('.unified-paper') ?? null
    applyPaperViewToElements(paper, noteView, next)
  }, [])

  const apply = useCallback((next: PaperViewSnapshot) => {
    storeRef.current.write(next)
  }, [])

  useEffect(() => store.subscribe(paint), [paint, store])

  useEffect(() => {
    paint(store.read())
  }, [paint, store])

  // Layout effects: a note opened after an async read would otherwise paint
  // one frame at 100% / scroll 0 before the remembered camera lands.
  useLayoutEffect(() => {
    // Only when the note identity changes. Toggling the HUD (pen vs keyboard)
    // must keep the same sheet zoom so ruling, ink and text stay one. A note
    // that was open before comes back at its remembered zoom.
    const remembered = recallPaperView(loadPaperViewMemory(), paperViewMemoryKey(viewKey))
    setRecalled(remembered !== null)
    storeRef.current.write(paperViewFromMemory(remembered))
  }, [viewKey])

  useLayoutEffect(() => {
    const scroller = noteViewRef.current
    if (!scroller) return
    const memoryKey = paperViewMemoryKey(viewKey)
    const remembered = memoryKey ? recallPaperView(loadPaperViewMemory(), memoryKey) : null
    let lastProgrammatic: { scrollLeft: number; scrollTop: number } | null = null
    let userInteracted = false
    let saveTimer = 0
    let measureFrame = 0
    // Measured while this note's sheet is still in the DOM. The effect cleanup
    // runs after React swapped in the next note, so it must not measure then.
    let latestEntry: Omit<PaperViewMemoryEntry, 'at'> | null = null
    const writePage = () => (
      scroller.querySelector<HTMLElement>('.unified-paper')
      ?? scroller.querySelector<HTMLElement>('.paper-sheet-plane')
    )
    const scrollTo = (next: { scrollLeft: number; scrollTop: number }) => {
      lastProgrammatic = next
      if (Math.abs(scroller.scrollLeft - next.scrollLeft) >= 0.5) scroller.scrollLeft = next.scrollLeft
      if (Math.abs(scroller.scrollTop - next.scrollTop) >= 0.5) scroller.scrollTop = next.scrollTop
    }
    const measureEntry = () => {
      const page = writePage()
      if (!page) return null
      const pageRect = page.getBoundingClientRect()
      if (pageRect.width < 1 || pageRect.height < 1) return null
      const view = viewRef.current
      const scrollerRect = scroller.getBoundingClientRect()
      const zoom = Math.max(0.01, view.zoom)
      const centre = paperCentreFromCamera(scroller, scrollerRect, pageRect, view.zoom)
      const anchor = findPaperTextAnchorProvider(scroller)?.anchorAtClientY(scrollerRect.top) ?? null
      latestEntry = {
        zoom: view.zoom,
        rotation: view.rotation,
        ...centre,
        pageWidth: Math.round((pageRect.width / zoom) * 100) / 100,
        pageHeight: Math.round((pageRect.height / zoom) * 100) / 100,
        ...(anchor ? { anchor } : {}),
      }
      return latestEntry
    }
    const persist = (entry: Omit<PaperViewMemoryEntry, 'at'> | null) => {
      if (!memoryKey || !entry) return
      savePaperViewMemory(rememberPaperView(loadPaperViewMemory(), memoryKey, entry))
    }
    const saveNow = () => {
      if (saveTimer) {
        window.clearTimeout(saveTimer)
        saveTimer = 0
      }
      persist(measureEntry())
    }
    const scheduleSave = () => {
      if (!memoryKey) return
      if (saveTimer) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(saveNow, 220)
    }
    // Zoom listeners fire before the anchor scroll is restored; measure a frame later.
    const scheduleMeasureAndSave = () => {
      if (!memoryKey) return
      if (!measureFrame) {
        measureFrame = window.requestAnimationFrame(() => {
          measureFrame = 0
          measureEntry()
          scheduleSave()
        })
      }
    }
    // Remembered camera: put the same paper point back under the viewport
    // centre. Layout is still settling (lazy editor, PDF page ratios), so the
    // camera is re-applied on every plane resize until the user takes over.
    let restoring = false
    let restoreFrame = 0
    const restoreRemembered = () => {
      if (!remembered) return false
      const page = writePage()
      if (!page) return false
      const pageRect = page.getBoundingClientRect()
      if (pageRect.width < 1 || pageRect.height < 1) return false
      const zoom = Math.max(0.01, viewRef.current.zoom)
      const scrollerRect = scroller.getBoundingClientRect()
      const centre = scaledPaperCentre(remembered, pageRect.width / zoom, Boolean(scroller.querySelector('.pdf-note-view')))
      const camera = cameraForPaperCentre(scroller, scrollerRect, pageRect, zoom, centre)
      // Typed text: the line that was under the viewport edge wins over the
      // pixel centre — the editor's height estimate for unrendered lines is
      // still moving while it measures.
      const anchorY = remembered.anchor
        ? findPaperTextAnchorProvider(scroller)?.clientYForAnchor(remembered.anchor) ?? null
        : null
      if (anchorY !== null && Number.isFinite(anchorY)) {
        camera.scrollTop = scrollTopForAnchorClientY(scroller, scrollerRect, anchorY)
      }
      scrollTo(camera)
      return true
    }
    let flingFrames = 0
    let flingId = 0
    const holdFling = () => {
      const tick = tickPaperViewportEditorScrollHold(scroller, flingFrames)
      flingFrames = tick.remainingFrames
      flingId = flingFrames > 0 ? window.requestAnimationFrame(holdFling) : 0
    }
    const clampScroll = () => {
      const editor = scroller.querySelector<HTMLElement>('.markdown-editor, .cm-scroller')
      const captured = captureGhostTextAroundLock(scroller, editor)
      const now = Date.now()
      if (captured.slip.slip) {
        recordTextMotionDiagnostic(buildTextMotionDiagnosticEvent({
          at: now,
          ...ghostTextDiagnosticFields(captured.before, captured.slip),
        }), now)
      }
      if (captured.back.back) {
        recordTextMotionDiagnostic(buildTextMotionDiagnosticEvent({
          at: now + 1,
          ...ghostTextDiagnosticFields(captured.after, captured.back),
        }), now + 1)
      }
      flingFrames = PAPER_EDITOR_FLING_HOLD_FRAMES
      if (!flingId) flingId = window.requestAnimationFrame(holdFling)
      const plane = scroller.querySelector<HTMLElement>('.paper-sheet-plane')
        ?? scroller.querySelector<HTMLElement>('.unified-paper')
      clampPaperScrollerToZoomedSheet(scroller, plane)
      if (restoring && !userInteracted) {
        // Layout is still settling: the camera is not the user's yet, so it
        // must not overwrite the remembered one. Another scroller (browser
        // clamp, editor measure, PDF page-into-view) that moved it gets undone
        // next frame.
        if (!isProgrammaticScroll(scroller, lastProgrammatic) && !restoreFrame) {
          restoreFrame = window.requestAnimationFrame(() => {
            restoreFrame = 0
            if (restoring && !userInteracted) restoreRemembered()
          })
        }
        return
      }
      measureEntry()
      scheduleSave()
    }
    scroller.addEventListener('scroll', clampScroll, { passive: true })
    // The user takes the camera over with any input — also outside the
    // scroller: an outline jump or a search hit right after opening must not be
    // undone as a "foreign" scroll. The listeners attach after the pointerdown
    // that switched the note, so the switch itself never counts.
    const markInteraction = () => { userInteracted = true }
    const markKeyInteraction = (event: KeyboardEvent) => {
      if (isPaperViewTakeoverKey(event)) userInteracted = true
    }
    scroller.addEventListener('wheel', markInteraction, { passive: true })
    window.addEventListener('pointerdown', markInteraction, { passive: true, capture: true })
    window.addEventListener('touchstart', markInteraction, { passive: true, capture: true })
    window.addEventListener('keydown', markKeyInteraction, true)
    const applyOpenCamera = () => {
      const plane = scroller.querySelector<HTMLElement>('.paper-sheet-plane')
      const paper = scroller.querySelector<HTMLElement>('.unified-paper')
      const room = Number.parseFloat(plane?.style.getPropertyValue('--paper-scroll-room') || '') || SCROLL_ROOM
      const pageWidth = paper?.offsetWidth || Math.max(0, (plane?.offsetWidth || 0) - room * 2)
      const pageHeight = paper?.offsetHeight || Math.max(0, (plane?.offsetHeight || 0) - room * 2)
      const camera = pdfOpenCameraFromScroller({
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
        scrollWidth: scroller.scrollWidth,
        scrollHeight: scroller.scrollHeight,
        clientWidth: scroller.clientWidth,
        clientHeight: scroller.clientHeight,
        pageWidth,
        pageHeight,
        room,
      })
      if (!camera) return false
      scrollTo({ scrollLeft: camera.x, scrollTop: camera.y })
      return true
    }
    let openCameraId = 0
    let restoreObserver: ResizeObserver | null = null
    let restoreTimer = 0
    const restoreStartedAt = performance.now()
    const stopRestoring = () => {
      restoring = false
      restoreObserver?.disconnect()
      restoreObserver = null
      if (restoreTimer) {
        window.clearTimeout(restoreTimer)
        restoreTimer = 0
      }
    }
    if (remembered) {
      restoring = true
      restoreRemembered()
      // The editor measures its first line heights a frame or two after
      // mount and the ink layer resizes the sheet: re-apply on the first
      // frames regardless of whether a resize was observed.
      let warmFrames = PAPER_VIEW_RESTORE_WARM_FRAMES
      const warm = () => {
        openCameraId = 0
        if (!restoring || userInteracted) return
        restoreRemembered()
        warmFrames -= 1
        if (warmFrames > 0) openCameraId = window.requestAnimationFrame(warm)
      }
      openCameraId = window.requestAnimationFrame(warm)
      const plane = scroller.querySelector<HTMLElement>('.paper-sheet-plane')
      if (plane && typeof ResizeObserver === 'function') {
        restoreObserver = new ResizeObserver(() => {
          if (!shouldKeepRestoringPaperView({ startedAt: restoreStartedAt, now: performance.now(), userInteracted })) {
            stopRestoring()
            return
          }
          restoreRemembered()
        })
        restoreObserver.observe(plane)
      }
      restoreTimer = window.setTimeout(() => {
        stopRestoring()
        measureEntry()
      }, PAPER_VIEW_RESTORE_SETTLE_MS)
    } else if (!applyOpenCamera()) {
      openCameraId = window.requestAnimationFrame(() => {
        openCameraId = 0
        applyOpenCamera()
        clampScroll()
      })
    }
    clampScroll()
    const unsubscribeZoom = storeRef.current.subscribe(scheduleMeasureAndSave)
    window.addEventListener('pagehide', saveNow)
    return () => {
      unsubscribeZoom()
      window.removeEventListener('pagehide', saveNow)
      scroller.removeEventListener('scroll', clampScroll)
      scroller.removeEventListener('wheel', markInteraction)
      window.removeEventListener('pointerdown', markInteraction, true)
      window.removeEventListener('touchstart', markInteraction, true)
      window.removeEventListener('keydown', markKeyInteraction, true)
      if (flingId) window.cancelAnimationFrame(flingId)
      if (openCameraId) window.cancelAnimationFrame(openCameraId)
      if (restoreFrame) window.cancelAnimationFrame(restoreFrame)
      if (measureFrame) window.cancelAnimationFrame(measureFrame)
      if (saveTimer) window.clearTimeout(saveTimer)
      stopRestoring()
      // Leaving the note: remember the last camera measured on this note's sheet.
      persist(latestEntry)
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
    const current = viewRef.current
    const scroller = noteViewRef.current
    const sheet = scroller?.querySelector<HTMLElement>('.paper-sheet-plane')
      ?? scroller?.querySelector<HTMLElement>('.unified-paper')
      ?? null
    if (current.zoom !== 1) {
      // Back to 100% around the cursor, then centre a page that fits — never
      // leave the sheet half under the sidebar with camera room on the other side.
      applyPaperZoomStayPut(
        scroller,
        sheet,
        current,
        1,
        lastZoomOriginRef.current ?? undefined,
        (view) => apply({ ...view, rotation: 0, pan: { x: 0, y: 0 } }),
      )
      return
    }
    apply(defaultPaperView())
    centrePageInViewportIfFits(scroller, sheet)
  }, [apply])

  const api = useMemo<PaperViewApi>(() => ({
    ...view,
    zoomBy,
    zoomTo,
    rotateBy,
    resetView,
    setView,
    recalled,
  }), [recalled, resetView, rotateBy, setView, view, zoomBy, zoomTo])

  const controller = useMemo<PaperViewController>(() => ({
    zoomBy,
    zoomTo,
    rotateBy,
    resetView,
    setView,
    getView: () => viewRef.current,
    subscribe: store.subscribe,
  }), [resetView, rotateBy, setView, store, zoomBy, zoomTo])

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
    if (!globalShortcuts) return undefined
    const subscribe = window.fanotes?.onSheetZoom
    if (typeof subscribe !== 'function') return undefined
    return subscribe((direction) => {
      if (performance.now() - lastWheelZoomAtRef.current < 80) return
      zoomBy(sheetZoomStepFromDirection(direction), lastZoomOriginRef.current ?? undefined)
    })
  }, [globalShortcuts, zoomBy])

  useEffect(() => {
    if (!showHud || !globalShortcuts) return
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
  }, [globalShortcuts, resetView, showHud, zoomBy])

  const active = isPaperViewActive(view)

  return (
    <PaperViewContext.Provider value={api}>
      <PaperViewControllerContext.Provider value={controller}>
      <div
        ref={noteViewRef}
        className={`paper-view ${className}`}
        data-paper-zoom={view.zoom}
        onPointerDownCapture={onPointerDownCapture}
        onFocusCapture={onFocusCapture}
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
      </PaperViewControllerContext.Provider>
    </PaperViewContext.Provider>
  )
}
