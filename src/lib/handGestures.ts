/**
 * Touch hand gestures shared by the note sheet, subject books and GlyphenWerk.
 * A pen or mouse pointer never joins a gesture. Two fingers pan and pinch.
 * A twist is measured and ignored by the sheet, so hands cannot turn the
 * paper. One finger can swipe. The recogniser is pure so the thresholds can
 * be checked without a browser.
 */

export const HAND_GESTURE_CLAIM = 'fanotes-hand-gesture-claim'

export type HandGesturePhase = 'down' | 'move' | 'up' | 'cancel'

export type HandGestureSample = {
  id: number
  phase: HandGesturePhase
  pointerType: string
  x: number
  y: number
}

export type HandGestureFrame = {
  panX: number
  panY: number
  /** 1 keeps the zoom. Greater than 1 moves the fingers apart. */
  pinch: number
  rotateDeg: number
  originX: number
  originY: number
}

export type HandGestureState = {
  points: Map<number, { x: number; y: number }>
  live: boolean
  span: number
  angle: number
  cx: number
  cy: number
}

export type HandGestureUpdate = {
  state: HandGestureState
  /** This touch belongs to a two-finger gesture, including its last lift. */
  swallow: boolean
  justClaimed: boolean
  frame: HandGestureFrame | null
}

export type SwipeDirection = 'left' | 'right' | 'up' | 'down'

export type HandGestureHandlers = {
  onPan?: (dx: number, dy: number) => void
  onPinch?: (factor: number, origin: { x: number; y: number }) => void
  onRotate?: (degrees: number, origin: { x: number; y: number }) => void
  onSwipe?: (direction: SwipeDirection, origin: { x: number; y: number; target: EventTarget | null }) => void
  /**
   * The note sheet owns two-finger motion: on the ink canvas because it sets
   * `touch-action: none`, and over text or a PDF page because the sheet
   * cancels the browser's touch moves while two fingers are down. Otherwise
   * Chromium starts its own pan or pinch, cancels the pointers and the sheet
   * zoom stops part-way. GlyphenWerk leaves one- and two-finger pans to the
   * browser and only applies a pinch.
   */
  captureNavigation?: boolean
  /** The last finger of a two-finger gesture lifted (captureNavigation only). */
  onGestureEnd?: () => void
}

const TEXT_FIELD = 'input, textarea, select, [contenteditable="true"]'

export const createHandGestureState = (): HandGestureState => ({
  points: new Map(),
  live: false,
  span: 0,
  angle: 0,
  cx: 0,
  cy: 0,
})

const geometry = (points: Map<number, { x: number; y: number }>) => {
  const list = [...points.values()]
  if (!list.length) return { cx: 0, cy: 0, span: 0, angle: 0 }
  let sx = 0
  let sy = 0
  for (const point of list) {
    sx += point.x
    sy += point.y
  }
  const cx = sx / list.length
  const cy = sy / list.length
  if (list.length < 2) return { cx, cy, span: 0, angle: 0 }
  const a = list[0]
  const b = list[1]
  return {
    cx,
    cy,
    span: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  }
}

const wrapAngle = (delta: number) => {
  let next = delta
  while (next > Math.PI) next -= Math.PI * 2
  while (next < -Math.PI) next += Math.PI * 2
  return next
}

export const handGestureSample = (state: HandGestureState, sample: HandGestureSample): HandGestureUpdate => {
  if (sample.pointerType !== 'touch') {
    return { state, swallow: false, justClaimed: false, frame: null }
  }
  const points = new Map(state.points)
  if (sample.phase === 'up' || sample.phase === 'cancel') points.delete(sample.id)
  else points.set(sample.id, { x: sample.x, y: sample.y })
  return evaluateHandGesture(state, points)
}

/**
 * Every finger's latest position from one frame, sampled together. Each
 * pointermove alone moves one finger while the others wait for their own
 * event, so a straight two-finger pan read as a pinch and its reverse on
 * every frame (and a pan never looked clean enough to coast).
 */
export const handGestureMoveBatch = (
  state: HandGestureState,
  moves: ReadonlyMap<number, { x: number; y: number }>,
): HandGestureUpdate => {
  const points = new Map(state.points)
  for (const [id, point] of moves) if (points.has(id)) points.set(id, point)
  return evaluateHandGesture(state, points)
}

const evaluateHandGesture = (
  state: HandGestureState,
  points: Map<number, { x: number; y: number }>,
): HandGestureUpdate => {
  const live = points.size === 0 ? false : points.size >= 2 || state.live
  const justClaimed = live && !state.live
  const geom = geometry(points)
  let frame: HandGestureFrame | null = null
  // A sub-threshold delta is dropped from the frame, so the baseline must not
  // advance past it; otherwise a slow pinch or drag never accumulates and the
  // zoom stutters in steps.
  let keepSpan = false
  let keepCenter = false
  if (live && points.size >= 2 && state.span > 0 && geom.span > 0) {
    let panX = geom.cx - state.cx
    let panY = geom.cy - state.cy
    let pinch = Math.min(1.18, Math.max(0.85, geom.span / state.span))
    let rotateDeg = wrapAngle(geom.angle - state.angle) * 180 / Math.PI
    if (Math.hypot(panX, panY) < 0.35) {
      panX = 0
      panY = 0
      keepCenter = true
    }
    if (Math.abs(pinch - 1) < 0.01) {
      pinch = 1
      keepSpan = true
    }
    if (Math.abs(rotateDeg) < 0.7) rotateDeg = 0
    if (Math.abs(pinch - 1) > 0.025 && Math.abs(rotateDeg) < 3.5) rotateDeg = 0
    if (panX || panY || pinch !== 1 || rotateDeg) {
      frame = { panX, panY, pinch, rotateDeg, originX: geom.cx, originY: geom.cy }
    }
  }
  return {
    state: {
      points,
      live,
      span: points.size >= 2 ? (keepSpan ? state.span : geom.span) : 0,
      angle: points.size >= 2 ? geom.angle : 0,
      cx: keepCenter ? state.cx : geom.cx,
      cy: keepCenter ? state.cy : geom.cy,
    },
    swallow: live || state.live,
    justClaimed,
    frame,
  }
}

export const swipeDirection = (dx: number, dy: number, threshold = 56): SwipeDirection | null => {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (Math.max(ax, ay) < threshold) return null
  if (ax >= ay * 1.35) return dx < 0 ? 'left' : 'right'
  if (ay >= ax * 1.35) return dy < 0 ? 'up' : 'down'
  return null
}

/** Trackpad pinch reports a wheel delta. Touch pinch does not. */
export const pinchFactorFromWheel = (deltaY: number) => {
  const clamped = Math.max(-420, Math.min(420, deltaY))
  return Math.exp(-clamped * 0.0016)
}

let lastPoint: { x: number; y: number } | null = null
let trackerInstalled = false

export const installHandPointTracker = () => {
  if (trackerInstalled || typeof window === 'undefined') return
  trackerInstalled = true
  const remember = (event: PointerEvent) => {
    lastPoint = { x: event.clientX, y: event.clientY }
  }
  window.addEventListener('pointerdown', remember, { passive: true, capture: true })
  window.addEventListener('pointermove', remember, { passive: true, capture: true })
}

export const gestureRootAtPoint = (): Element | null => {
  if (!lastPoint || typeof document === 'undefined') return null
  const hit = document.elementFromPoint(lastPoint.x, lastPoint.y)
  if (!(hit instanceof Element)) return null
  return hit.closest('[data-hand-gesture-root]')
}

/**
 * Electron forwards one pinch for the whole window. The surface under the
 * fingers takes it. With no pointer yet, the caller decides (the focused
 * sheet, or the only surface on a pop-out).
 */
export const shouldTakeSheetZoom = (element: HTMLElement, preferWhenUntracked: boolean) => {
  const owner = gestureRootAtPoint()
  if (!owner) return preferWhenUntracked
  if (owner === element) return true
  // Split view: the trackpad pinch stays on the pane that was touched last.
  // A book or GlyphenWerk under the fingers is a different surface and wins.
  if (owner.classList.contains('paper-view') && element.classList.contains('paper-view')) return preferWhenUntracked
  return false
}

export const penContactHot = (element: HTMLElement) => (
  element.matches('[data-pen-contact]') || Boolean(element.querySelector('[data-pen-contact]'))
)

const touchActionNone = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false
  return getComputedStyle(target).touchAction.split(/\s+/u).includes('none')
}

export const bindHandGestures = (element: HTMLElement, handlers: HandGestureHandlers) => {
  installHandPointTracker()
  let state = createHandGestureState()
  let swipeStart: { id: number; x: number; y: number; target: EventTarget | null } | null = null
  let suppressClick = false
  let suppressTimer = 0
  /** This touch sequence has had two fingers down on a navigating sheet. */
  let multiTouch = false
  // A navigating sheet samples a live gesture once per frame (see
  // handGestureMoveBatch). Chromium already delivers touch moves aligned to
  // animation frames, so this adds no latency.
  const pendingMoves = new Map<number, { x: number; y: number }>()
  let pendingTarget: EventTarget | null = null
  let moveFrame = 0
  const emitFrame = (frame: HandGestureFrame | null, ownsTouch: boolean) => {
    // Pinch before pan: the camera marks the zoom preview before the pan
    // writes scroll, so that scroll does not measure the sheet.
    if (frame && frame.pinch !== 1) handlers.onPinch?.(frame.pinch, { x: frame.originX, y: frame.originY })
    if (frame && ownsTouch && (frame.panX || frame.panY)) handlers.onPan?.(frame.panX, frame.panY)
    if (frame && frame.rotateDeg) handlers.onRotate?.(frame.rotateDeg, { x: frame.originX, y: frame.originY })
  }
  const flushMoves = () => {
    if (moveFrame) window.cancelAnimationFrame(moveFrame)
    moveFrame = 0
    if (!pendingMoves.size) return
    const update = handGestureMoveBatch(state, pendingMoves)
    pendingMoves.clear()
    state = update.state
    if (penContactHot(element)) return
    emitFrame(update.frame, multiTouch || touchActionNone(pendingTarget))
  }
  const onPointer = (event: PointerEvent) => {
    lastPoint = { x: event.clientX, y: event.clientY }
    if (event.pointerType !== 'touch') return
    if (
      handlers.captureNavigation
      && event.type === 'pointermove'
      && state.live
      && state.points.size >= 2
      && state.points.has(event.pointerId)
    ) {
      pendingMoves.set(event.pointerId, { x: event.clientX, y: event.clientY })
      pendingTarget = event.target
      if (event.cancelable) event.preventDefault()
      event.stopPropagation()
      if (!moveFrame) moveFrame = window.requestAnimationFrame(flushMoves)
      return
    }
    // A finger down or up changes the set: apply this frame's moves first.
    flushMoves()
    const phase: HandGesturePhase = event.type === 'pointerdown'
      ? 'down'
      : event.type === 'pointermove'
        ? 'move'
        : event.type === 'pointercancel'
          ? 'cancel'
          : 'up'
    const textField = event.target instanceof Element && Boolean(event.target.closest(TEXT_FIELD))
    if (phase === 'down' && !state.live) {
      swipeStart = textField ? null : { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target }
      if (textField && !handlers.captureNavigation) return
    }
    const update = handGestureSample(state, {
      id: event.pointerId,
      phase,
      pointerType: 'touch',
      x: event.clientX,
      y: event.clientY,
    })
    state = update.state
    if (penContactHot(element)) {
      if (update.swallow) {
        if (event.cancelable) event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (update.justClaimed) {
      swipeStart = null
      element.dispatchEvent(new CustomEvent(HAND_GESTURE_CLAIM, { bubbles: true, detail: { root: element } }))
    }
    if (handlers.captureNavigation && update.swallow) {
      // `multiTouch` is set by the touch listener below when it cancels the
      // browser's gesture, so the pan is ours wherever the fingers are.
      const ownsTouch = multiTouch || touchActionNone(event.target)
      const frame = update.frame
      const manipulating = Boolean(frame && (frame.pinch !== 1 || frame.rotateDeg))
      if (ownsTouch || manipulating || update.justClaimed) {
        if (event.cancelable) event.preventDefault()
        event.stopPropagation()
      }
      emitFrame(frame, ownsTouch)
      if (!update.state.live) handlers.onGestureEnd?.()
      return
    }
    if (!handlers.captureNavigation && update.frame && update.frame.pinch !== 1 && handlers.onPinch) {
      if (event.cancelable) event.preventDefault()
      handlers.onPinch(update.frame.pinch, { x: update.frame.originX, y: update.frame.originY })
    }
    if (
      phase === 'up'
      && swipeStart
      && swipeStart.id === event.pointerId
      && !update.swallow
      && handlers.onSwipe
    ) {
      const direction = swipeDirection(event.clientX - swipeStart.x, event.clientY - swipeStart.y)
      const origin = { x: swipeStart.x, y: swipeStart.y, target: swipeStart.target }
      swipeStart = null
      if (direction) {
        if (event.cancelable) event.preventDefault()
        event.stopPropagation()
        suppressClick = true
        if (suppressTimer) window.clearTimeout(suppressTimer)
        suppressTimer = window.setTimeout(() => { suppressClick = false }, 450)
        handlers.onSwipe(direction, origin)
      }
      return
    }
    if ((phase === 'up' || phase === 'cancel') && swipeStart?.id === event.pointerId) swipeStart = null
  }
  // Two or more fingers on a navigating sheet: keep Chromium from starting a
  // pan or pinch of its own. One finger is left alone (text scroll stays
  // native), and a palm next to a pen keeps its old handling.
  const onTouch = (event: TouchEvent) => {
    if (event.touches.length === 0) {
      multiTouch = false
      return
    }
    if (event.touches.length >= 2 && !penContactHot(element)) multiTouch = true
    if (multiTouch && event.type === 'touchmove' && event.cancelable) event.preventDefault()
  }
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return
    suppressClick = false
    if (suppressTimer) window.clearTimeout(suppressTimer)
    event.preventDefault()
    event.stopPropagation()
  }
  const listen = { capture: true, passive: false } as const
  element.addEventListener('pointerdown', onPointer, listen)
  element.addEventListener('pointermove', onPointer, listen)
  element.addEventListener('pointerup', onPointer, listen)
  element.addEventListener('pointercancel', onPointer, listen)
  element.addEventListener('click', onClick, true)
  const touchListen = { capture: true, passive: false } as const
  if (handlers.captureNavigation) {
    element.addEventListener('touchstart', onTouch, { capture: true, passive: true })
    element.addEventListener('touchmove', onTouch, touchListen)
    element.addEventListener('touchend', onTouch, { capture: true, passive: true })
    element.addEventListener('touchcancel', onTouch, { capture: true, passive: true })
  }
  return () => {
    if (moveFrame) window.cancelAnimationFrame(moveFrame)
    if (handlers.captureNavigation) {
      element.removeEventListener('touchstart', onTouch, { capture: true })
      element.removeEventListener('touchmove', onTouch, touchListen)
      element.removeEventListener('touchend', onTouch, { capture: true })
      element.removeEventListener('touchcancel', onTouch, { capture: true })
    }
    if (suppressTimer) window.clearTimeout(suppressTimer)
    element.removeEventListener('pointerdown', onPointer, listen)
    element.removeEventListener('pointermove', onPointer, listen)
    element.removeEventListener('pointerup', onPointer, listen)
    element.removeEventListener('pointercancel', onPointer, listen)
    element.removeEventListener('click', onClick, true)
  }
}
