/**
 * Raster of the note sheet the way it is on screen: ruling, typed text, PDF
 * pages, section bands and text fields. Ink canvases are left out so the
 * caller can paint the whole stroke list, including ink that is scrolled
 * off the current slice.
 *
 * Styles are copied inline because an SVG image does not apply the page's
 * stylesheets. `bottom` and `right` are omitted when the opposite edge is
 * set: those used values, written back with `top` and `height`, shift the box.
 */

export type PaperRegion = { x?: number; y: number; width: number; height: number }

export type PaperRaster = {
  under: HTMLCanvasElement
  over: HTMLCanvasElement
}

const STYLE_PROPS = [
  'position', 'left', 'top', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'display', 'color', 'background-color', 'background-image', 'background-size',
  'background-repeat', 'background-position',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'white-space', 'overflow-wrap', 'word-break',
  'text-decoration', 'vertical-align',
  'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius',
  'box-sizing', 'box-shadow', 'opacity', 'overflow', 'transform', 'transform-origin',
  'flex-direction', 'align-items', 'justify-content', 'gap',
  'z-index',
]

const DROP_UNDER = '.lw-drawing-board, .note-text-layer, .note-link-layer, .lw-ink-section-titles, .lw-draw-notice, .lw-conversion-panel, .lw-art-studio'
const DROP_CHROME = '.cm-cursor, .cm-dropCursor, .lw-draw-notice, .lw-conversion-panel, .lw-art-studio, .lw-selection-hint'

const nextFrame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve())
})

const zoomOf = (paper: HTMLElement) => {
  const height = paper.getBoundingClientRect().height
  return height > 0 ? height / Math.max(1, paper.offsetHeight) : 1
}

const styleOf = (source: Element, clone: HTMLElement) => {
  const computed = getComputedStyle(source)
  const skip = new Set<string>()
  if (computed.getPropertyValue('top') && computed.getPropertyValue('top') !== 'auto') skip.add('bottom')
  if (computed.getPropertyValue('left') && computed.getPropertyValue('left') !== 'auto') skip.add('right')
  const parts: string[] = []
  for (const prop of STYLE_PROPS) {
    if (skip.has(prop)) continue
    const value = computed.getPropertyValue(prop)
    if (value) parts.push(`${prop}:${value}`)
  }
  clone.setAttribute('style', parts.join(';'))
}

const cloneStyled = (source: Element, drop: string): HTMLElement | null => {
  if (!(source instanceof HTMLElement) && !(source instanceof SVGElement)) return null
  if (source instanceof HTMLCanvasElement) return null
  if (source.matches(DROP_CHROME) || (drop && source.matches(drop))) return null
  let clone: HTMLElement
  if (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement) {
    clone = document.createElement(source instanceof HTMLTextAreaElement ? 'div' : 'span')
    clone.textContent = source.value || source.placeholder || ''
    styleOf(source, clone)
    if (!source.value && source.placeholder) clone.style.color = 'rgba(74, 63, 176, 0.34)'
    if (source instanceof HTMLTextAreaElement) clone.style.whiteSpace = 'pre-wrap'
    return clone
  }
  clone = source.cloneNode(false) as HTMLElement
  styleOf(source, clone)
  for (const child of source.childNodes) {
    if (child instanceof Element) {
      const next = cloneStyled(child, drop)
      if (next) clone.appendChild(next)
    } else if (child.nodeType === Node.TEXT_NODE && child.textContent) {
      clone.appendChild(document.createTextNode(child.textContent))
    }
  }
  return clone
}

const loadSvg = (svg: SVGSVGElement) => new Promise<HTMLImageElement>((resolve, reject) => {
  const xml = new XMLSerializer().serializeToString(svg)
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('snapshot'))
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
})

const rasterizeHost = async (
  host: HTMLElement,
  region: PaperRegion,
  scale: number,
) => {
  const originX = region.x ?? 0
  const crop = document.createElement('div')
  crop.setAttribute('style', `width:${region.width}px;height:${region.height}px;overflow:hidden;transform:scale(${scale});transform-origin:0 0`)
  const shift = document.createElement('div')
  shift.setAttribute('style', `position:relative;top:-${region.y}px;left:-${originX}px;margin:0;padding:0`)
  shift.appendChild(host)
  crop.appendChild(shift)
  const svgWidth = Math.max(1, Math.round(region.width * scale))
  const svgHeight = Math.max(1, Math.round(region.height * scale))
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(svgWidth))
  svg.setAttribute('height', String(svgHeight))
  const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject')
  foreign.setAttribute('width', String(svgWidth))
  foreign.setAttribute('height', String(svgHeight))
  const wrap = document.createElementNS('http://www.w3.org/1999/xhtml', 'div')
  wrap.setAttribute('style', 'margin:0;padding:0')
  wrap.appendChild(crop)
  foreign.appendChild(wrap)
  svg.appendChild(foreign)
  const canvas = document.createElement('canvas')
  canvas.width = svgWidth
  canvas.height = svgHeight
  const context = canvas.getContext('2d')
  if (!context) return canvas
  try {
    const image = await loadSvg(svg)
    context.drawImage(image, 0, 0, svgWidth, svgHeight)
  } catch {
    // A tainted or rejected picture leaves this layer blank. Ink still paints.
  }
  return canvas
}

const frameHost = (width: number, height: number) => {
  const host = document.createElement('div')
  host.setAttribute('style', `position:relative;width:${width}px;height:${height}px;margin:0;padding:0;overflow:visible;background:transparent`)
  return host
}

const placeClone = (source: HTMLElement, paper: HTMLElement, host: HTMLElement, drop: string) => {
  const clone = cloneStyled(source, drop)
  if (!clone) return
  const paperRect = paper.getBoundingClientRect()
  const rect = source.getBoundingClientRect()
  const zoom = zoomOf(paper)
  clone.style.position = 'absolute'
  clone.style.margin = '0'
  clone.style.left = `${(rect.left - paperRect.left) / zoom}px`
  clone.style.top = `${(rect.top - paperRect.top) / zoom}px`
  clone.style.width = `${rect.width / zoom}px`
  clone.style.height = `${rect.height / zoom}px`
  clone.style.right = 'auto'
  clone.style.bottom = 'auto'
  host.appendChild(clone)
}

const paperCanvases = (paper: HTMLElement) => {
  const zoom = zoomOf(paper)
  const paperRect = paper.getBoundingClientRect()
  const placed: Array<{ canvas: HTMLCanvasElement; left: number; top: number; width: number; height: number }> = []
  for (const canvas of paper.querySelectorAll('canvas')) {
    if (!(canvas instanceof HTMLCanvasElement) || canvas.classList.contains('lw-tablet-canvas')) continue
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    placed.push({
      canvas,
      left: (rect.left - paperRect.left) / zoom,
      top: (rect.top - paperRect.top) / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
    })
  }
  return placed
}

/**
 * `under` is ruling, embedded page bitmaps and typed text.
 * `over` is section chrome, text fields and note links, which sit above the ink.
 */
export async function rasterizePaperLayers(paper: HTMLElement, region: PaperRegion, scale: number): Promise<PaperRaster> {
  const paperWidth = Math.max(1, paper.offsetWidth)
  const paperHeight = Math.max(1, paper.offsetHeight)
  const plane = paper.closest('.paper-sheet-plane')
  const ruling = plane?.querySelector(':scope > .paper-ruling')
  const underHost = frameHost(paperWidth, paperHeight)
  if (ruling instanceof HTMLElement && plane instanceof HTMLElement) {
    const clone = cloneStyled(ruling, '')
    if (clone) {
      clone.style.position = 'absolute'
      clone.style.margin = '0'
      clone.style.left = `${-paper.offsetLeft}px`
      clone.style.top = `${-paper.offsetTop}px`
      clone.style.width = `${plane.offsetWidth}px`
      clone.style.height = `${plane.offsetHeight}px`
      clone.style.right = 'auto'
      clone.style.bottom = 'auto'
      underHost.appendChild(clone)
    }
  }
  const paperClone = cloneStyled(paper, DROP_UNDER)
  if (paperClone) {
    paperClone.style.position = 'absolute'
    paperClone.style.margin = '0'
    paperClone.style.left = '0'
    paperClone.style.top = '0'
    paperClone.style.width = `${paperWidth}px`
    paperClone.style.height = `${paperHeight}px`
    paperClone.style.right = 'auto'
    paperClone.style.bottom = 'auto'
    paperClone.style.background = 'transparent'
    paperClone.style.backgroundColor = 'transparent'
    paperClone.style.transform = 'none'
    underHost.appendChild(paperClone)
  }

  const overHost = frameHost(paperWidth, paperHeight)
  const board = paper.querySelector('.lw-drawing-board')
  if (board instanceof HTMLElement) placeClone(board, paper, overHost, '.lw-tablet-canvas, .lw-draw-notice, .lw-conversion-panel, .lw-art-studio')
  for (const node of paper.querySelectorAll('.lw-ink-section-titles, .note-text-layer, .note-link-layer')) {
    if (!(node instanceof HTMLElement) || node.closest('.lw-drawing-board')) continue
    placeClone(node, paper, overHost, '')
  }

  const under = await rasterizeHost(underHost, region, scale)
  const over = await rasterizeHost(overHost, region, scale)
  const context = under.getContext('2d')
  if (context) {
    const originX = region.x ?? 0
    for (const placed of paperCanvases(paper)) {
      const x = (placed.left - originX) * scale
      const y = (placed.top - region.y) * scale
      context.drawImage(placed.canvas, x, y, placed.width * scale, placed.height * scale)
    }
  }
  return { under, over }
}

export const waitForPaperPaint = async () => {
  await nextFrame()
  await nextFrame()
}

/** Scroll a layout row of the sheet to the top of the note scroller. */
export const scrollPaperTo = (paper: HTMLElement, scroller: HTMLElement, layoutY: number) => {
  const paperRect = paper.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  const zoom = zoomOf(paper)
  const paperTop = paperRect.top - scrollerRect.top + scroller.scrollTop
  scroller.scrollTop = paperTop + layoutY * zoom
}
