/**
 * Finger input that Chromium does not provide on desktop (Electron on Windows
 * and Linux): a long press opens the context menu, and a draggable element can
 * be dragged by holding it for a moment and then moving the finger.
 *
 * It is one global, Pointer-Events based layer. Mouse and pen never take part,
 * so their behaviour is unchanged. Ink surfaces, sliders and text inputs are
 * left alone, so drawing, palm rejection and the finger draw/pan setting are
 * not touched.
 */

export const LONG_PRESS_MS = 500
export const LONG_PRESS_TOLERANCE_PX = 10
/** A finger that moves before this is scrolling; after it, a draggable item is picked up. */
export const TOUCH_DRAG_ARM_MS = 250
/** The click a finger release produces arrives right after pointerup. */
const CLICK_SWALLOW_MS = 400
/** A palm resting while a pen or mouse was just in use must not switch the layout. */
const POINTER_QUIET_MS = 2000
export const TOUCH_INPUT_CLASS = 'is-touch-input'
export const TOUCH_SCREEN_CLASS = 'has-touch-screen'

/** Set on a `contextmenu` event that a long press produced. */
export const TOUCH_CONTEXT_MENU_FLAG = 'fanotesTouchLongPress'

const IGNORED_FOR_PRESS = 'canvas, input, textarea, select, [data-touch-native]'

type PressState = {
  id: number
  startX: number
  startY: number
  x: number
  y: number
  startedAt: number
  target: Element
  source: HTMLElement | null
  timer: number
  fired: boolean
  dragging: boolean
  /** A long press selected a word of static text; the finger now extends it. */
  selecting: boolean
  transfer: DataTransfer | null
  over: Element | null
  droppable: boolean
}

export function isTouchLongPressEvent(event: Event): boolean {
  return Boolean((event as unknown as Record<string, unknown>)[TOUCH_CONTEXT_MENU_FLAG])
}

function mouseInit(x: number, y: number, view: Window): MouseEventInit {
  return { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view }
}

/**
 * A slider is only about 16 px tall. Under a coarse pointer it gets 12 px of
 * invisible padding, but Chromium only drags the thumb from the track itself,
 * so a finger that lands in the padding is followed here.
 */
function followRangeFinger(event: PointerEvent): boolean {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'range' || input.disabled) return false
  const box = input.getBoundingClientRect()
  const style = getComputedStyle(input)
  const top = box.top + (Number.parseFloat(style.paddingTop) || 0)
  const bottom = box.bottom - (Number.parseFloat(style.paddingBottom) || 0)
  if (event.clientY >= top && event.clientY <= bottom) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) return false
  const apply = (clientX: number): void => {
    const thumb = 16
    const ratio = Math.min(1, Math.max(0, (clientX - box.left - thumb / 2) / Math.max(1, box.width - thumb)))
    const min = Number.parseFloat(input.min || '0')
    const max = Number.parseFloat(input.max || '100')
    const before = input.value
    setter.call(input, String(min + (max - min) * ratio))
    if (input.value !== before) input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  input.setPointerCapture(event.pointerId)
  apply(event.clientX)
  const move = (moveEvent: PointerEvent): void => { if (moveEvent.pointerId === event.pointerId) apply(moveEvent.clientX) }
  const finish = (endEvent: PointerEvent): void => {
    if (endEvent.pointerId !== event.pointerId) return
    input.removeEventListener('pointermove', move)
    input.removeEventListener('pointerup', finish)
    input.removeEventListener('pointercancel', finish)
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  input.addEventListener('pointermove', move)
  input.addEventListener('pointerup', finish)
  input.addEventListener('pointercancel', finish)
  return true
}

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const position = (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = doc.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/**
 * Static text (PDF text layer, rendered Markdown, settings copy) has no touch
 * selection on desktop Chromium. A long press that opened no menu selects the
 * word under the finger, so it can be copied or marked.
 */
function selectWordAt(doc: Document, x: number, y: number): boolean {
  const target = doc.elementFromPoint(x, y)
  if (!target || target.closest('input, textarea, select, button, canvas, [contenteditable="true"], [data-touch-native]')) return false
  const caret = caretAt(doc, x, y)
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return false
  const owner = caret.node.parentElement
  if (!owner || getComputedStyle(owner).userSelect === 'none') return false
  const selection = doc.defaultView?.getSelection()
  if (!selection) return false
  selection.setBaseAndExtent(caret.node, caret.offset, caret.node, caret.offset)
  selection.modify('move', 'backward', 'word')
  selection.modify('extend', 'forward', 'word')
  return !selection.isCollapsed
}

export function installTouchInput(doc: Document = document): () => void {
  const view = doc.defaultView
  if (!view || typeof view.PointerEvent === 'undefined') return () => undefined
  let press: PressState | null = null
  let swallowClickUntil = 0
  const coarse = view.matchMedia('(any-pointer: coarse)')
  const syncTouchScreen = (): void => { doc.documentElement.classList.toggle(TOUCH_SCREEN_CLASS, coarse.matches) }
  syncTouchScreen()
  coarse.addEventListener('change', syncTouchScreen)
  let finePointerAt = -Infinity
  let touchModeTimer = 0

  /**
   * The note chrome is dense. While a finger is the active input it gets
   * roomier controls (`html.is-touch-input`); mouse and pen put it back. The
   * switch happens after the tap has been delivered so the tapped control does
   * not move away from under the finger.
   */
  const noteFinePointer = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    finePointerAt = performance.now()
    view.clearTimeout(touchModeTimer)
    doc.documentElement.classList.remove(TOUCH_INPUT_CLASS)
  }
  const noteTouchUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return
    if (performance.now() - finePointerAt < POINTER_QUIET_MS) return
    view.clearTimeout(touchModeTimer)
    touchModeTimer = view.setTimeout(() => doc.documentElement.classList.add(TOUCH_INPUT_CLASS), 0)
  }

  const clear = (): void => {
    if (press) view.clearTimeout(press.timer)
    press = null
  }

  const fireContextMenu = (state: PressState): void => {
    if (press !== state || state.fired || state.dragging) return
    state.fired = true
    const target = doc.elementFromPoint(state.x, state.y) ?? state.target
    const event = new MouseEvent('contextmenu', { ...mouseInit(state.x, state.y, view), button: 2, buttons: 0 })
    ;(event as unknown as Record<string, unknown>)[TOUCH_CONTEXT_MENU_FLAG] = true
    target.dispatchEvent(event)
    if (event.defaultPrevented) swallowClickUntil = Number.POSITIVE_INFINITY
    else if (selectWordAt(doc, state.x, state.y)) {
      state.selecting = true
      swallowClickUntil = Number.POSITIVE_INFINITY
    }
  }

  const onDown = (event: PointerEvent): void => {
    // A release that never arrived (cancelled touch) must not swallow later taps.
    if (swallowClickUntil === Number.POSITIVE_INFINITY) swallowClickUntil = performance.now() + CLICK_SWALLOW_MS
    noteFinePointer(event)
    if (event.pointerType !== 'touch') return
    if (followRangeFinger(event)) return
    if (press) { clear(); return }
    if (!(event.target instanceof Element)) return
    const target = event.target
    const source = target.closest<HTMLElement>('[draggable="true"]')
    const ignored = target.closest(IGNORED_FOR_PRESS)
    if (ignored && !source) return
    const state: PressState = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      target,
      source,
      timer: 0,
      fired: false,
      dragging: false,
      selecting: false,
      transfer: null,
      over: null,
      droppable: false,
    }
    state.timer = view.setTimeout(() => fireContextMenu(state), LONG_PRESS_MS)
    press = state
  }

  const dispatchDrag = (type: string, target: Element, state: PressState): boolean => {
    const event = new DragEvent(type, { ...mouseInit(state.x, state.y, view), dataTransfer: state.transfer })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }

  const beginDrag = (state: PressState): void => {
    if (!state.source) return
    state.transfer = new DataTransfer()
    if (dispatchDrag('dragstart', state.source, state)) { clear(); return }
    state.dragging = true
    view.clearTimeout(state.timer)
    doc.documentElement.classList.add('is-touch-dragging')
  }

  const endDrag = (state: PressState, drop: boolean): void => {
    doc.documentElement.classList.remove('is-touch-dragging')
    const target = doc.elementFromPoint(state.x, state.y)
    if (drop && target && state.droppable) dispatchDrag('drop', target, state)
    else if (state.over) dispatchDrag('dragleave', state.over, state)
    if (state.source?.isConnected) dispatchDrag('dragend', state.source, state)
    swallowClickUntil = performance.now() + CLICK_SWALLOW_MS
  }

  const onMove = (event: PointerEvent): void => {
    noteFinePointer(event)
    const state = press
    if (!state || event.pointerId !== state.id) return
    state.x = event.clientX
    state.y = event.clientY
    if (state.selecting) {
      const caret = caretAt(doc, state.x, state.y)
      if (caret) doc.defaultView?.getSelection()?.extend(caret.node, caret.offset)
      return
    }
    if (!state.dragging) {
      if (state.fired) return
      if (Math.hypot(state.x - state.startX, state.y - state.startY) <= LONG_PRESS_TOLERANCE_PX) return
      if (state.source && performance.now() - state.startedAt >= TOUCH_DRAG_ARM_MS) beginDrag(state)
      else clear()
      if (!state.dragging) return
    }
    const target = doc.elementFromPoint(state.x, state.y)
    if (!target) return
    if (target !== state.over) {
      if (state.over) dispatchDrag('dragleave', state.over, state)
      dispatchDrag('dragenter', target, state)
      state.over = target
    }
    state.droppable = dispatchDrag('dragover', target, state)
  }

  const onEnd = (event: PointerEvent): void => {
    noteTouchUp(event)
    const state = press
    if (!state || event.pointerId !== state.id) return
    if (state.dragging) endDrag(state, event.type === 'pointerup')
    if (state.fired || state.dragging || state.selecting) swallowClickUntil = performance.now() + CLICK_SWALLOW_MS
    clear()
  }

  /** Once an item is picked up, the page must not start scrolling under the finger. */
  const onTouchMove = (event: TouchEvent): void => {
    if ((press?.dragging || press?.selecting) && event.cancelable) event.preventDefault()
  }

  const onClick = (event: MouseEvent): void => {
    if (performance.now() >= swallowClickUntil) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  /** Chromium on some platforms raises its own long-press menu; keep exactly one. */
  const onNativeContextMenu = (event: MouseEvent): void => {
    if (!event.isTrusted || isTouchLongPressEvent(event)) return
    if (press && !press.dragging) {
      if (press.fired) { event.stopImmediatePropagation(); event.preventDefault(); return }
      view.clearTimeout(press.timer)
      press.fired = true
      swallowClickUntil = Number.POSITIVE_INFINITY
    } else if (performance.now() < swallowClickUntil) {
      event.stopImmediatePropagation()
      event.preventDefault()
    }
  }

  doc.addEventListener('pointerdown', onDown, true)
  doc.addEventListener('pointermove', onMove, true)
  doc.addEventListener('pointerup', onEnd, true)
  doc.addEventListener('pointercancel', onEnd, true)
  doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('contextmenu', onNativeContextMenu, true)
  return () => {
    clear()
    view.clearTimeout(touchModeTimer)
    coarse.removeEventListener('change', syncTouchScreen)
    doc.documentElement.classList.remove(TOUCH_INPUT_CLASS, TOUCH_SCREEN_CLASS)
    doc.removeEventListener('pointerdown', onDown, true)
    doc.removeEventListener('pointermove', onMove, true)
    doc.removeEventListener('pointerup', onEnd, true)
    doc.removeEventListener('pointercancel', onEnd, true)
    doc.removeEventListener('touchmove', onTouchMove, true)
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('contextmenu', onNativeContextMenu, true)
  }
}
