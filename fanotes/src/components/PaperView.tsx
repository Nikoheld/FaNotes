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
  PDF_PAGE_COLUMN_SELECTOR,
  PAPER_ZOOM_GESTURE_SETTLE_MS,
  applyPaperViewToElements,
  applyPaperZoomGestureFrame,
  applyPaperZoomStayPut,
  beginPaperZoomGesture,
  centrePageInViewportIfFits,
  clearPaperZoomGestureFrame,
  centredScrollLeftForPage,
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
  resolvePaperViewTarget,
  sheetZoomStepFromDirection,
  stepPaperZoomGesture,
  type PaperViewSnapshot,
  type PaperViewStore,
  type PaperZoomGesture,
} from '../lib/paperView'
import { bindHandGestures, shouldTakeSheetZoom } from '../../../src/lib/handGestures'
import { SCROLL_ROOM } from '../lib/noteCanvas'
import {
  PAPER_VIEW_RESTORE_SETTLE_MS,
  PAPER_VIEW_RESTORE_WARM_FRAMES,
  cameraForPaperCentre,
  isPaperViewTakeoverKey,
  isProgrammaticScroll,
  loadPaperViewMemory,
  paperCameraLanded,
  paperCentreFromCamera,
  paperGestureTakesCamera,
  paperScrollerCanReach,
  paperViewFromMemory,
  paperViewMemoryKey,
  recallPaperView,
  registerPaperViewMemoryFlush,
  rememberPaperView,
  savePaperViewMemory,
  scaledPaperCentre,
  scrollTopForAnchorClientY,
  shouldExtendPaperViewRestore,
  shouldKeepRestoringPaperView,
  type PaperViewMemoryEntry,
} from '../lib/paperViewMemory'
import { findPaperTextAnchorProvider } from '../lib/paperTextAnchor'
import { pdfOpenCameraFromScroller } from '../lib/pdfOpenCamera'
import {
  captureGhostTextAroundLock,
  ghostTextDiagnosticFields,
  lockPaperEditorScrollIfNeeded,
  lockPaperViewportScrollStayPut,
  PAPER_EDITOR_FLING_HOLD_FRAMES,
  pinPaperViewportAfterColumnResize,
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
  /** Zoom the in-flight pinch has reached. Falls back to the committed camera. */
  liveZoom: () => number
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
  /** One-finger swipe from the left or right screen edge steps through notes. */
  onEdgeSwipe?: (direction: 'back' | 'forward') => void
}

export function PaperView({ children, className = '', viewKey, showHud = true, onPointerDownCapture, onFocusCapture, store = sharedPaperViewStore, globalShortcuts = true, onEdgeSwipe }: PaperViewProps) {
  const noteViewRef = useRef<HTMLDivElement>(null)
  const storeRef = useRef(store)
  storeRef.current = store
  const viewRef = useRef(store.read())
  const lastWheelZoomAtRef = useRef(0)
  const lastPanWheelAtRef = useRef(0)
  const lastZoomOriginRef = useRef<{ x: number; y: number } | null>(null)
  const zoomGestureRef = useRef<PaperZoomGesture | null>(null)
  const zoomGestureTimerRef = useRef(0)
  const zoomGestureCommitFrameRef = useRef(0)
  /** While set, scroll listeners must not measure the sheet. Stay-put already does. */
  const zoomGestureActiveRef = useRef(false)
  const zoomPlaneRef = useRef<HTMLElement | null>(null)
  const commitZoomGestureRef = useRef(() => {})
  const cancelZoomGestureRef = useRef(() => {})
  const pushZoomGestureRef = useRef<(factor: number, origin: { x: number; y: number }) => void>(() => {})
  const onEdgeSwipeRef = useRef(onEdgeSwipe)
  onEdgeSwipeRef.current = onEdgeSwipe
  // Set by a user zoom/rotate/reset immediately before the store write. PDF
  // fit calls zoomTo and must not set this — that zoom is not the user's.
  const userAdjustedRef = useRef(false)
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
    // The plane element survives a note switch. An in-flight pinch must not
    // commit its CSS zoom onto the note that just opened.
    cancelZoomGestureRef.current()
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
    let restoring = false
    let alive = true
    // Wheel, scrollbar, zoom and scroll keys. A click alone is not a pan.
    let userOwned = false
    let gaveUp = false
    let pointerHeld = false
    let scrollArm = false
    // Set for one turn by a wheel, key, click, or scrollbar. A later layout
    // scroll must not inherit it.
    let gestureArm = 0
    let gestureTimer = 0
    userAdjustedRef.current = false
    const ownCamera = () => {
      userOwned = true
      gaveUp = false
    }
    const claimUserCamera = () => {
      ownCamera()
      userInteracted = true
    }
    const armGesture = () => {
      gestureArm = 1
      if (gestureTimer) window.clearTimeout(gestureTimer)
      gestureTimer = window.setTimeout(() => {
        gestureTimer = 0
        gestureArm = 0
      }, 0)
    }
    const rememberedSpotReachable = () => (
      !remembered
      || !lastProgrammatic
      || paperCameraLanded(scroller, lastProgrammatic)
      || paperScrollerCanReach(scroller, lastProgrammatic)
    )
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
      // A sheet that is still too short to reach the saved spot, or a layout
      // scroll after open, would record the top of the page over the camera
      // the user left. Quit also remeasures a scroller that has already
      // collapsed — keep the entry captured while this sheet was on screen.
      if (gaveUp && !userOwned) return
      if (!userOwned && remembered && !paperCameraLanded(scroller, lastProgrammatic)) return
      if (!userOwned) return
      persist(latestEntry ?? measureEntry())
    }
    const scheduleSave = () => {
      if (!memoryKey || !alive) return
      if (saveTimer) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(saveNow, 220)
    }
    const cameraBody = (entry: Omit<PaperViewMemoryEntry, 'at'> & { at?: number }) => {
      const rest = { ...entry }
      delete rest.at
      return rest
    }
    // Remembered camera: put the same paper point back under the viewport
    // centre. Layout is still settling (lazy editor, PDF page ratios), so the
    // camera is re-applied on every plane resize until the user takes over
    // or the saved spot is actually on screen.
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
      // A PDF column narrower than the window stays in the middle. The saved
      // horizontal spot is the wide plane, which would leave the sheet on one side.
      const pdfColumn = scroller.querySelector<HTMLElement>(PDF_PAGE_COLUMN_SELECTOR)
      if (pdfColumn) {
        const left = centredScrollLeftForPage(scroller, scrollerRect.left, pdfColumn.getBoundingClientRect())
        if (Math.abs(left - scroller.scrollLeft) >= 0.5) scrollTo({ scrollLeft: left, scrollTop: scroller.scrollTop })
      }
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
      // A zoom preview does not scroll. Stay-put then writes scroll several
      // times; measuring the sheet on each write is the hitch at the end of
      // the gesture. Claiming the camera does not need those rectangles.
      if (zoomGestureActiveRef.current) {
        const fromGesture = userAdjustedRef.current || gestureArm > 0 || (pointerHeld && scrollArm)
        if (userAdjustedRef.current) userAdjustedRef.current = false
        if (gestureArm > 0) gestureArm = 0
        if (fromGesture) claimUserCamera()
        return
      }
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
      const fromGesture = userAdjustedRef.current || gestureArm > 0 || (pointerHeld && scrollArm)
      if (userAdjustedRef.current) userAdjustedRef.current = false
      if (gestureArm > 0) gestureArm = 0
      // Scrollbar and touch pan: the button is still down on a later frame.
      // The scroll on the pointerdown turn itself is focus or layout, unless
      // it came from the scrollbar (armed in markInteraction).
      // A short page cannot show the saved spot yet. Scrolling still has to
      // stick — the clamp is the bottom, and putting it back trapped the
      // sheet there until a pen stroke grew the page. Do not store that clamp.
      const taken = paperGestureTakesCamera({
        fromGesture,
        spotReachable: rememberedSpotReachable(),
      })
      if (taken.stopRestore) userInteracted = true
      if (taken.saveCamera) claimUserCamera()
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
      // While the PDF sheet is narrower than the window, a pan or a zoom anchor
      // must not leave white on only one side.
      centrePageInViewportIfFits(scroller, plane)
      // Layout and focus scrolls are not the user's camera — not even after
      // a real pan, or the next open would restore the jump.
      if (!fromGesture || !userOwned) return
      measureEntry()
      scheduleSave()
    }
    scroller.addEventListener('scroll', clampScroll, { passive: true })
    // The user takes the camera over with any input — also outside the
    // scroller: an outline jump or a search hit right after opening must not be
    // undone as a "foreign" scroll. The listeners attach after the pointerdown
    // that switched the note, so the switch itself never counts. A click before
    // the saved spot is on screen is not a pan and must not be stored.
    const markInteraction = (event: Event) => {
      pointerHeld = true
      scrollArm = false
      window.requestAnimationFrame(() => { scrollArm = true })
      // The scrollbar is the scroller itself. A track click scrolls once, on
      // this turn, before the arming frame — and that spot is where the user left.
      if (event.target === scroller) armGesture()
      if (!restoring || paperCameraLanded(scroller, lastProgrammatic)) userInteracted = true
    }
    const releasePointer = () => { pointerHeld = false }
    const markWheel = () => { armGesture() }
    const markClick = () => { armGesture() }
    const markKeyInteraction = (event: KeyboardEvent) => {
      if (!isPaperViewTakeoverKey(event)) return
      userInteracted = true
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === 'PageUp' || event.key === 'Home' || event.key === 'End' || event.key === ' ') {
        armGesture()
      }
    }
    scroller.addEventListener('wheel', markWheel, { passive: true })
    window.addEventListener('click', markClick, true)
    window.addEventListener('pointerdown', markInteraction, { passive: true, capture: true })
    window.addEventListener('pointerup', releasePointer, { passive: true, capture: true })
    window.addEventListener('pointercancel', releasePointer, { passive: true, capture: true })
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
    const stillRestoring = (now = performance.now()) => (
      !userInteracted && (
        shouldKeepRestoringPaperView({ startedAt: restoreStartedAt, now, userInteracted })
        || shouldExtendPaperViewRestore({
          startedAt: restoreStartedAt,
          now,
          userInteracted,
          landed: paperCameraLanded(scroller, lastProgrammatic),
        })
      )
    )
    const finishRestore = () => {
      const landed = paperCameraLanded(scroller, lastProgrammatic)
      stopRestoring()
      if (landed) measureEntry()
      else if (!userOwned) gaveUp = true
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
          if (!stillRestoring()) {
            finishRestore()
            return
          }
          restoreRemembered()
        })
        restoreObserver.observe(plane)
      }
      const considerRestored = () => {
        restoreTimer = 0
        if (!restoring) return
        if (stillRestoring() && !paperCameraLanded(scroller, lastProgrammatic)) {
          restoreRemembered()
          restoreTimer = window.setTimeout(considerRestored, 280)
          return
        }
        finishRestore()
      }
      restoreTimer = window.setTimeout(considerRestored, PAPER_VIEW_RESTORE_SETTLE_MS)
    } else {
      // The scroller element is reused. The previous note's offset is not
      // this note's camera; a non-zero scroll makes the open camera refuse,
      // and a shorter note stayed clamped to the bottom.
      if (scroller.scrollLeft !== 0 || scroller.scrollTop !== 0) {
        scrollTo({ scrollLeft: 0, scrollTop: 0 })
      }
      if (!applyOpenCamera()) {
        openCameraId = window.requestAnimationFrame(() => {
          openCameraId = 0
          applyOpenCamera()
          clampScroll()
        })
      }
    }
    clampScroll()
    let lastColumn = { width: scroller.clientWidth, height: scroller.clientHeight }
    const pinColumnStayPut = () => {
      const nextColumn = { width: scroller.clientWidth, height: scroller.clientHeight }
      if (
        Math.abs(nextColumn.width - lastColumn.width) < 0.5
        && Math.abs(nextColumn.height - lastColumn.height) < 0.5
      ) return
      lastColumn = nextColumn
      if (restoring && !userInteracted) return
      pinPaperViewportAfterColumnResize(scroller, nextColumn, {
        paperX: 0,
        paperY: 0,
        camX: scroller.scrollLeft,
        camY: scroller.scrollTop,
        width: Math.max(1, scroller.scrollWidth),
        height: Math.max(1, scroller.scrollHeight),
        originX: 0,
        originY: 0,
        editorX: 0,
        editorY: 0,
      })
      lockPaperEditorScrollIfNeeded(scroller.querySelector('.markdown-editor, .cm-scroller'))
    }
    let columnObserver: ResizeObserver | null = null
    if (typeof ResizeObserver === 'function') {
      columnObserver = new ResizeObserver(pinColumnStayPut)
      columnObserver.observe(scroller)
    }
    const unsubscribeZoom = storeRef.current.subscribe(() => {
      if (!userAdjustedRef.current) return
      userAdjustedRef.current = false
      const view = viewRef.current
      const base = latestEntry ?? remembered
      // Zoom before the saved spot fits: keep that spot and only store the
      // new zoom. Stopping the restore here would leave the short page on screen.
      if (base && !rememberedSpotReachable()) {
        latestEntry = { ...cameraBody(base), zoom: view.zoom, rotation: view.rotation }
        ownCamera()
        scheduleSave()
        return
      }
      latestEntry = base
        ? { ...cameraBody(base), zoom: view.zoom, rotation: view.rotation }
        : { zoom: view.zoom, rotation: view.rotation, centreX: 0, centreY: 0 }
      claimUserCamera()
      // The write happens before stay-put restores the anchor. Measure after
      // this stack so the centre is the one the user is actually looking at.
      queueMicrotask(() => {
        if (!alive) return
        measureEntry()
        scheduleSave()
      })
    })
    const unregisterFlush = registerPaperViewMemoryFlush(saveNow)
    window.addEventListener('pagehide', saveNow)
    return () => {
      alive = false
      unregisterFlush()
      unsubscribeZoom()
      window.removeEventListener('pagehide', saveNow)
      scroller.removeEventListener('scroll', clampScroll)
      scroller.removeEventListener('wheel', markWheel)
      window.removeEventListener('click', markClick, true)
      window.removeEventListener('pointerdown', markInteraction, true)
      window.removeEventListener('pointerup', releasePointer, true)
      window.removeEventListener('pointercancel', releasePointer, true)
      window.removeEventListener('touchstart', markInteraction, true)
      window.removeEventListener('keydown', markKeyInteraction, true)
      columnObserver?.disconnect()
      if (flingId) window.cancelAnimationFrame(flingId)
      if (openCameraId) window.cancelAnimationFrame(openCameraId)
      if (restoreFrame) window.cancelAnimationFrame(restoreFrame)
      if (saveTimer) window.clearTimeout(saveTimer)
      if (gestureTimer) window.clearTimeout(gestureTimer)
      stopRestoring()
      // Leaving the note: remember the last camera measured on this note's sheet.
      // The DOM is already the next note, so this must not measure again.
      // A visit that only restored the stored camera leaves that entry as it is.
      if (userOwned) persist(latestEntry)
    }
  }, [viewKey])

  const clearZoomGestureClock = () => {
    if (zoomGestureTimerRef.current) {
      window.clearTimeout(zoomGestureTimerRef.current)
      zoomGestureTimerRef.current = 0
    }
    if (zoomGestureCommitFrameRef.current) {
      window.cancelAnimationFrame(zoomGestureCommitFrameRef.current)
      zoomGestureCommitFrameRef.current = 0
    }
  }

  const liveZoom = useCallback(() => (
    zoomGestureRef.current?.zoom ?? viewRef.current.zoom
  ), [])

  const setView = useCallback((next: Partial<PaperViewSnapshot>) => {
    commitZoomGestureRef.current()
    userAdjustedRef.current = true
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
    commitZoomGestureRef.current()
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
    const live = zoomGestureRef.current?.zoom ?? viewRef.current.zoom
    const next = clampViewZoom(live + delta)
    if (Math.abs(next - live) < 0.0005) return
    userAdjustedRef.current = true
    let origin = originClient ?? lastZoomOriginRef.current
    if (!origin) {
      const scroller = noteViewRef.current
      const box = scroller?.getBoundingClientRect()
      origin = box
        ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        : { x: 0, y: 0 }
    }
    pushZoomGestureRef.current(next / Math.max(0.01, live), origin)
  }, [])

  cancelZoomGestureRef.current = () => {
    clearZoomGestureClock()
    const plane = zoomPlaneRef.current
    zoomGestureRef.current = null
    zoomGestureActiveRef.current = false
    zoomPlaneRef.current = null
    if (plane) clearPaperZoomGestureFrame(plane, 0)
  }

  commitZoomGestureRef.current = () => {
    clearZoomGestureClock()
    const gesture = zoomGestureRef.current
    const plane = zoomPlaneRef.current
    zoomGestureRef.current = null
    zoomPlaneRef.current = null
    if (!gesture) {
      zoomGestureActiveRef.current = false
      return
    }
    const scroller = noteViewRef.current
    const sheet = plane
      ?? scroller?.querySelector<HTMLElement>('.paper-sheet-plane')
      ?? scroller?.querySelector<HTMLElement>('.unified-paper')
      ?? null
    clearPaperZoomGestureFrame(plane ?? resolvePaperViewTarget(sheet, scroller), gesture.rotation)
    if (Math.abs(gesture.zoom - gesture.baseZoom) < 0.0005) {
      zoomGestureActiveRef.current = false
      return
    }
    userAdjustedRef.current = true
    lastWheelZoomAtRef.current = performance.now()
    lastZoomOriginRef.current = gesture.origin
    // Stay-put scrolls. Keep the scroll listener from measuring on each write.
    zoomGestureActiveRef.current = true
    applyPaperZoomStayPut(
      scroller,
      sheet,
      { zoom: gesture.baseZoom, rotation: gesture.rotation, pan: { x: 0, y: 0 } },
      gesture.zoom,
      gesture.origin,
      apply,
    )
    zoomGestureActiveRef.current = false
  }
  pushZoomGestureRef.current = (factor, origin) => {
    if (!(factor > 0) || Math.abs(factor - 1) < 1e-8) return
    const scroller = noteViewRef.current
    if (!scroller) return
    lastZoomOriginRef.current = origin
    lastWheelZoomAtRef.current = performance.now()
    const current = zoomGestureRef.current
    if ((current?.rotation ?? viewRef.current.rotation) !== 0) {
      if (current) commitZoomGestureRef.current()
      userAdjustedRef.current = true
      zoomTo((current?.zoom ?? viewRef.current.zoom) * factor, origin)
      return
    }
    if (!current) {
      const sheet = scroller.querySelector<HTMLElement>('.paper-sheet-plane')
        ?? scroller.querySelector<HTMLElement>('.unified-paper')
      zoomPlaneRef.current = resolvePaperViewTarget(sheet, scroller)
      zoomGestureActiveRef.current = true
      zoomGestureRef.current = beginPaperZoomGesture(scroller, sheet, viewRef.current, origin)
    }
    const gesture = stepPaperZoomGesture(zoomGestureRef.current!, factor)
    zoomGestureRef.current = gesture
    const plane = zoomPlaneRef.current
    if (!applyPaperZoomGestureFrame(plane, gesture)) {
      zoomGestureRef.current = null
      zoomPlaneRef.current = null
      clearPaperZoomGestureFrame(plane, gesture.rotation)
      userAdjustedRef.current = true
      zoomTo(gesture.zoom, gesture.origin)
      zoomGestureActiveRef.current = false
      return
    }
    clearZoomGestureClock()
    zoomGestureTimerRef.current = window.setTimeout(() => {
      zoomGestureTimerRef.current = 0
      zoomGestureCommitFrameRef.current = window.requestAnimationFrame(() => {
        zoomGestureCommitFrameRef.current = 0
        commitZoomGestureRef.current()
      })
    }, PAPER_ZOOM_GESTURE_SETTLE_MS)
  }

  const rotateBy = useCallback((delta: number) => {
    commitZoomGestureRef.current()
    userAdjustedRef.current = true
    apply({ ...viewRef.current, rotation: normalizeRotation(viewRef.current.rotation + delta), pan: { x: 0, y: 0 } })
  }, [apply])

  const resetView = useCallback(() => {
    commitZoomGestureRef.current()
    userAdjustedRef.current = true
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
    liveZoom,
    recalled,
  }), [liveZoom, recalled, resetView, rotateBy, setView, view, zoomBy, zoomTo])

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
      if (factor === 1 || !origin) return
      // Scale on the compositor for this frame. CSS zoom, which reflows the
      // sheet and resizes the ink bitmap, runs once the burst has paused.
      pushZoomGestureRef.current(factor, origin)
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
      lastPanWheelAtRef.current = performance.now()
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
      commitZoomGestureRef.current()
    }
  }, [rotateBy, zoomTo])

  useEffect(() => {
    if (!globalShortcuts) return undefined
    const subscribe = window.fanotes?.onSheetZoom
    if (typeof subscribe !== 'function') return undefined
    return subscribe((direction) => {
      if (performance.now() - lastWheelZoomAtRef.current < 80) return
      const root = noteViewRef.current
      if (!root || !shouldTakeSheetZoom(root, true)) return
      const box = root.getBoundingClientRect()
      const origin = lastZoomOriginRef.current ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      const base = zoomGestureRef.current?.zoom ?? viewRef.current.zoom
      const step = sheetZoomStepFromDirection(direction)
      if (!(base > 0)) return
      pushZoomGestureRef.current((base + step) / base, origin)
    })
  }, [globalShortcuts])

  useEffect(() => {
    const root = noteViewRef.current
    if (!root) return undefined
    let pendingFactor = 1
    let pendingOrigin: { x: number; y: number } | null = null
    let zoomFrame = 0
    const flushZoom = () => {
      zoomFrame = 0
      const factor = pendingFactor
      const origin = pendingOrigin
      pendingFactor = 1
      pendingOrigin = null
      if (factor === 1 || !origin) return
      pushZoomGestureRef.current(factor, origin)
    }
    const unbind = bindHandGestures(root, {
      captureNavigation: true,
      onPan: (dx, dy) => {
        if (performance.now() - lastPanWheelAtRef.current < 48) return
        userAdjustedRef.current = true
        root.scrollLeft -= dx
        root.scrollTop -= dy
      },
      onPinch: (factor, origin) => {
        pendingFactor *= factor
        pendingOrigin = origin
        if (!zoomFrame) zoomFrame = window.requestAnimationFrame(flushZoom)
      },
      onSwipe: (direction, origin) => {
        if (origin.target instanceof Element && getComputedStyle(origin.target).touchAction.split(/\s+/u).includes('none')) return
        const box = root.getBoundingClientRect()
        const x = origin.x - box.left
        if (direction === 'right' && x <= 36) onEdgeSwipeRef.current?.('back')
        else if (direction === 'left' && x >= root.clientWidth - 36) onEdgeSwipeRef.current?.('forward')
      },
    })
    return () => {
      if (zoomFrame) window.cancelAnimationFrame(zoomFrame)
      unbind()
      commitZoomGestureRef.current()
    }
  }, [zoomTo])

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
        data-hand-gesture-root=""
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
