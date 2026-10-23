/**
 * pdf.js lays each glyph run out as its own absolute span. In Chromium a drag
 * that crosses the empty gap between those spans expands to the end of the
 * layer, so the highlight and the copied text jump past the words under the
 * pointer. The viewer stops that by parking an `.endOfContent` marker beside
 * the span being extended. This is that limit, for the desktop PDF page.
 */

const layers = new Map<HTMLElement, HTMLElement>()
let listener: AbortController | null = null
let previousRange: Range | null = null

const isFirefox = () => /firefox/iu.test(navigator.userAgent)

const resetMarker = (layer: HTMLElement, end: HTMLElement) => {
  layer.append(end)
  end.style.width = ''
  end.style.height = ''
  end.style.userSelect = ''
  layer.classList.remove('selecting')
}

const releaseListener = () => {
  if (layers.size > 0) return
  listener?.abort()
  listener = null
  previousRange = null
}

/** Drop the selection limit for a layer that is about to be rebuilt. */
export const releasePdfTextSelection = (layer: HTMLElement | null) => {
  if (!layer) return
  layers.delete(layer)
  releaseListener()
}

const placeMarker = (selection: Selection) => {
  if (isFirefox() || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  let modifyStart = false
  if (previousRange) {
    try {
      modifyStart = range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0
        || range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0
    } catch {
      modifyStart = false
    }
  }
  let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer
  if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode
  if (!(anchor instanceof Element) || anchor.classList.contains('endOfContent')) return
  let spot = anchor
  if (!modifyStart && range.endOffset === 0) {
    let guard = 0
    do {
      guard += 1
      while (!spot.previousSibling && spot.parentElement) spot = spot.parentElement
      const previous = spot.previousSibling
      if (!(previous instanceof Element)) return
      spot = previous
    } while (guard < 32 && spot.childNodes.length === 0)
  }
  const layer = spot.closest<HTMLElement>('.pdf-note-text-layer')
  const end = layer ? layers.get(layer) : undefined
  if (!layer || !end || spot === layer || spot === end || !layer.contains(spot)) return
  end.style.width = layer.style.width
  end.style.height = layer.style.height
  end.style.userSelect = 'text'
  const parent = spot.parentNode
  if (!parent) return
  const before = modifyStart ? spot : spot.nextSibling
  if (end.parentNode !== parent || end.nextSibling !== before) parent.insertBefore(end, before)
  previousRange = range.cloneRange()
}

const onSelectionChange = () => {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0) {
    previousRange = null
    for (const [layer, end] of layers) resetMarker(layer, end)
    return
  }
  const active = new Set<HTMLElement>()
  for (let index = 0; index < selection.rangeCount; index += 1) {
    let range: Range
    try {
      range = selection.getRangeAt(index)
    } catch {
      continue
    }
    for (const layer of layers.keys()) {
      try {
        if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer)
      } catch {
        // A layer rebuilt during the event is already gone.
      }
    }
  }
  for (const [layer, end] of layers) {
    if (active.has(layer)) layer.classList.add('selecting')
    else resetMarker(layer, end)
  }
  placeMarker(selection)
}

const ensureListener = () => {
  if (listener) return
  listener = new AbortController()
  const { signal } = listener
  let pointerDown = false
  document.addEventListener('pointerdown', () => {
    pointerDown = true
  }, { signal })
  document.addEventListener('pointerup', () => {
    pointerDown = false
    previousRange = null
    for (const [layer, end] of layers) resetMarker(layer, end)
  }, { signal })
  window.addEventListener('blur', () => {
    pointerDown = false
    previousRange = null
    for (const [layer, end] of layers) resetMarker(layer, end)
  }, { signal })
  document.addEventListener('keyup', () => {
    if (pointerDown) return
    previousRange = null
    for (const [layer, end] of layers) resetMarker(layer, end)
  }, { signal })
  document.addEventListener('selectionchange', onSelectionChange, { signal })
}

/**
 * Keep a drag on the PDF text layer from running through the gaps between
 * glyph spans. Returns a release function for when the layer is rebuilt.
 */
export const bindPdfTextSelection = (layer: HTMLElement) => {
  releasePdfTextSelection(layer)
  const end = document.createElement('div')
  end.className = 'endOfContent'
  layer.append(end)
  layers.set(layer, end)
  ensureListener()
  const onMouseDown = () => {
    layer.classList.add('selecting')
  }
  layer.addEventListener('mousedown', onMouseDown)
  return () => {
    layer.removeEventListener('mousedown', onMouseDown)
    if (layers.get(layer) === end) releasePdfTextSelection(layer)
    end.remove()
  }
}
