/**
 * Handwriting dot.
 *
 * A CSS cursor image is handed to the window system as a small bitmap. On
 * X11/Hyprland that bitmap is scaled with nearest-neighbour, so the pen dot
 * looks pixelated. The same circles painted in the page stay sharp at any
 * device pixel ratio.
 */

const PEN_SURFACE = '.lw-canvas-surface'

export const penPointerMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" shape-rendering="geometricPrecision"><circle cx="12" cy="12" r="4.2" fill="#fff"/><circle cx="12" cy="12" r="2.35" fill="#161616"/><circle cx="12" cy="12" r="0.75" fill="#fff"/></svg>`

/** Snap a viewport coordinate onto a device pixel so the dot does not shimmer. */
export const snapPointerCss = (client: number, devicePixelRatio: number) => {
  const ratio = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
  return Math.round(client * ratio) / ratio
}

const surfaceWantsPenPointer = (surface: Element) => (
  surface.classList.contains('tool-pen') || surface.classList.contains('tool-art')
)

/**
 * The dot replaces the cursor only where the sheet itself is showing it.
 * A drafting grip or selection handle sets its own cursor and keeps that.
 */
export const eventShowsPenPointer = (target: EventTarget | null, board: HTMLElement | null) => {
  if (!(target instanceof Element) || !board || !board.contains(target)) return false
  const surface = target.closest(PEN_SURFACE)
  if (!surface || !board.contains(surface) || !surfaceWantsPenPointer(surface)) return false
  return getComputedStyle(target).cursor === 'none'
}

/** Follow the pointer with a vector dot. Returns a cleanup function. */
export const mountPenPointer = (board: () => HTMLElement | null) => {
  const node = document.createElement('div')
  node.className = 'lw-pen-pointer'
  node.setAttribute('aria-hidden', 'true')
  node.innerHTML = penPointerMarkup
  document.body.appendChild(node)

  let lastTarget: EventTarget | null = null
  let lastTool = ''
  let lastShow = false
  const place = (event: Event) => {
    if (!(event instanceof PointerEvent)) return
    const target = event.target
    const boardNode = board()
    const surface = target instanceof Element ? target.closest(PEN_SURFACE) : null
    const tool = !surface || !boardNode || !boardNode.contains(surface)
      ? ''
      : surface.classList.contains('tool-pen')
        ? 'pen'
        : surface.classList.contains('tool-art')
          ? 'art'
          : ''
    // Cursor style is read only when the hit element or the tool changes.
    // Reading it on every pen sample would flush layout during a stroke.
    if (target !== lastTarget || tool !== lastTool) {
      lastTarget = target
      lastTool = tool
      lastShow = eventShowsPenPointer(target, boardNode)
    }
    if (!lastShow) {
      node.style.opacity = '0'
      return
    }
    const ratio = window.devicePixelRatio || 1
    const x = snapPointerCss(event.clientX, ratio)
    const y = snapPointerCss(event.clientY, ratio)
    node.style.opacity = '1'
    node.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
  }
  const hide = () => {
    lastTarget = null
    lastTool = ''
    lastShow = false
    node.style.opacity = '0'
  }
  const onOut = (event: PointerEvent) => {
    if (!event.relatedTarget) hide()
  }

  window.addEventListener('pointermove', place, { passive: true })
  window.addEventListener('pointerrawupdate', place, { passive: true })
  window.addEventListener('pointerout', onOut, { passive: true })
  window.addEventListener('blur', hide)
  return () => {
    window.removeEventListener('pointermove', place)
    window.removeEventListener('pointerrawupdate', place)
    window.removeEventListener('pointerout', onOut)
    window.removeEventListener('blur', hide)
    node.remove()
  }
}
