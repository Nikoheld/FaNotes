/**
 * PDF text highlights under the eraser. A highlight paints whole leaf spans of
 * a page's text layer (see `spanIndexesForQuotes`), so the eraser takes off
 * exactly the highlighted spans its disk touches, the way it cuts ink.
 */

export type ClientPoint = { x: number; y: number }
export type ClientRect = { left: number; top: number; right: number; bottom: number }

/** Class the text layer gives a highlighted span. */
export const PDF_MARK_SPAN_CLASS = 'pdf-anchored-mark'

/** Leaf runs of a text layer. Marked-content wrappers are spans too; only the leaves carry glyphs. */
export const pdfTextLeafSpans = (textHost: ParentNode): HTMLElement[] => (
  [...textHost.querySelectorAll('span')].filter((span) => !span.querySelector('span'))
)

const pointToRect = (x: number, y: number, rect: ClientRect) => {
  const dx = Math.max(rect.left - x, 0, x - rect.right)
  const dy = Math.max(rect.top - y, 0, y - rect.bottom)
  return Math.hypot(dx, dy)
}

const pointToSegment = (x: number, y: number, a: ClientPoint, b: ClientPoint) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
}

const segmentsCross = (a: ClientPoint, b: ClientPoint, c: ClientPoint, d: ClientPoint) => {
  const side = (p: ClientPoint, q: ClientPoint, r: ClientPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = side(c, d, a)
  const d2 = side(c, d, b)
  const d3 = side(a, b, c)
  const d4 = side(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** True when the eraser disk of `radius`, swept along `path`, meets the rectangle. */
export const eraserPathTouchesRect = (path: readonly ClientPoint[], radius: number, rect: ClientRect) => {
  if (!path.length || !(rect.right > rect.left) || !(rect.bottom > rect.top)) return false
  const reach = Math.max(0, radius)
  if (path.length === 1) return pointToRect(path[0].x, path[0].y, rect) <= reach
  const corners: ClientPoint[] = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ]
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1]
    const b = path[index]
    if (pointToRect(a.x, a.y, rect) <= reach || pointToRect(b.x, b.y, rect) <= reach) return true
    if (corners.some((corner) => pointToSegment(corner.x, corner.y, a, b) <= reach)) return true
    for (let edge = 0; edge < 4; edge += 1) {
      if (segmentsCross(a, b, corners[edge], corners[(edge + 1) % 4])) return true
    }
  }
  return false
}

export type ErasedPdfMarkSpans = {
  page: number
  /** Text of every leaf span of the page, in text-layer order. */
  spanTexts: string[]
  /** Highlighted leaf spans the eraser touched. */
  spans: number[]
}

/** Highlighted spans under the eraser path, per PDF page, in client pixels. */
export const pdfMarkSpansUnderEraser = (
  root: ParentNode,
  path: readonly ClientPoint[],
  radius: number,
): ErasedPdfMarkSpans[] => {
  if (!path.length) return []
  const reach = Math.max(0, radius)
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const point of path) {
    left = Math.min(left, point.x - reach)
    right = Math.max(right, point.x + reach)
    top = Math.min(top, point.y - reach)
    bottom = Math.max(bottom, point.y + reach)
  }
  // Only highlighted runs are measured: a long PDF has thousands of pages and
  // the eraser asks on every move.
  const hitPages = new Map<HTMLElement, Set<HTMLElement>>()
  for (const span of root.querySelectorAll<HTMLElement>(`.${PDF_MARK_SPAN_CLASS}`)) {
    const rect = span.getBoundingClientRect()
    if (rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom) continue
    if (!eraserPathTouchesRect(path, reach, rect)) continue
    const pageNode = span.closest<HTMLElement>('[data-pdf-page]')
    if (!pageNode) continue
    const hits = hitPages.get(pageNode) ?? new Set<HTMLElement>()
    hits.add(span)
    hitPages.set(pageNode, hits)
  }
  const found: ErasedPdfMarkSpans[] = []
  for (const [pageNode, hits] of hitPages) {
    const page = Number(pageNode.getAttribute('data-pdf-page'))
    const textHost = pageNode.querySelector('.pdf-note-text-layer')
    if (!Number.isInteger(page) || page < 1 || !textHost) continue
    const leaves = pdfTextLeafSpans(textHost)
    const spans = leaves.flatMap((span, index) => (hits.has(span) ? [index] : []))
    if (spans.length) found.push({ page, spanTexts: leaves.map((span) => span.textContent ?? ''), spans })
  }
  return found
}

/**
 * The highlighted spans a text selection lies on, when every glyph run it
 * covers is highlighted. Null when any of it is plain text (then the
 * selection is to be marked, not unmarked).
 */
export const markedSpansInSelection = (selection: Selection | null): ErasedPdfMarkSpans | null => {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const anchor = range.commonAncestorContainer
  const anchorElement = anchor instanceof Element ? anchor : anchor.parentElement
  const pageNode = anchorElement?.closest<HTMLElement>('[data-pdf-page]')
  const textHost = pageNode?.querySelector('.pdf-note-text-layer')
  const page = Number(pageNode?.getAttribute('data-pdf-page'))
  if (!pageNode || !textHost || !Number.isInteger(page) || page < 1) return null
  const leaves = pdfTextLeafSpans(textHost)
  const spans: number[] = []
  let plain = false
  leaves.forEach((span, index) => {
    if (!(span.textContent ?? '').trim() || !range.intersectsNode(span)) return
    if (span.classList.contains(PDF_MARK_SPAN_CLASS)) spans.push(index)
    else plain = true
  })
  if (plain || !spans.length) return null
  return { page, spanTexts: leaves.map((span) => span.textContent ?? ''), spans }
}
