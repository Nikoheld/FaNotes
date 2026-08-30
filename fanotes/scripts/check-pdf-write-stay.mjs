import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  paintSizeForPage,
  pdfPaintDeviceScale,
  pdfPageColumnCssWidth,
  pdfTextOverlayScale,
  pdfTextOverlayScaleForPaper,
  PDF_PAGE_COLUMN_MAX,
} = await server.ssrLoadModule('/src/lib/pdfDocument.ts')
const {
  layoutInkWindow,
  inkWindowLayoutStyle,
  inkWindowCanvasBox,
  inkWindowSpan,
  inkMarkPaperY,
  pdfOverlayPointFromClient,
  pdfOverlayShiftedBy,
  pdfOverlaySourceHeight,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const { inkOverlayPixelSize } = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { SCROLL_ROOM } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  applyPaperZoomStayPut,
  capturePaperAnchor,
  restorePaperAnchor,
  defaultPaperView,
} = await server.ssrLoadModule('/src/lib/paperView.ts')

const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/u).filter(Boolean))
  return {
    contains: (name) => values.has(name),
    add: (...names) => { names.forEach((name) => values.add(name)) },
    remove: (...names) => { names.forEach((name) => values.delete(name)) },
    toggle: (name, force) => {
      const next = force ?? !values.has(name)
      if (next) values.add(name)
      else values.delete(name)
      return next
    },
  }
}

const tokenSet = (selector) => new Set(String(selector).split(',').map((part) => part.trim().replace(/^\./u, '')).filter(Boolean))

const makeStyle = () => {
  const props = new Map()
  return {
    get zoom() { return props.get('zoom') ?? '' },
    set zoom(value) {
      if (value === '' || value == null) props.delete('zoom')
      else props.set('zoom', String(value))
    },
    setProperty(name, value) {
      if (value === '' || value == null) props.delete(name)
      else props.set(name, String(value))
    },
    removeProperty(name) {
      props.delete(name)
      return ''
    },
    getPropertyValue(name) {
      return props.get(name) ?? ''
    },
  }
}

const makeNode = (className, extras = {}) => {
  const node = {
    className,
    classList: makeClassList(className),
    style: makeStyle(),
    parentElement: extras.parentElement ?? null,
    children: [],
    layoutWidth: extras.layoutWidth ?? 200,
    layoutHeight: extras.layoutHeight ?? 200,
    contentLeft: extras.contentLeft ?? 0,
    contentTop: extras.contentTop ?? 0,
    scrollLeft: extras.scrollLeft ?? 0,
    scrollTop: extras.scrollTop ?? 0,
    clientWidth: extras.clientWidth ?? extras.layoutWidth ?? 200,
    clientHeight: extras.clientHeight ?? extras.layoutHeight ?? 200,
    matches(selector) {
      return [...tokenSet(selector)].some((name) => this.classList.contains(name))
    },
    closest(selector) {
      let current = this
      while (current) {
        if (current.matches(selector)) return current
        current = current.parentElement
      }
      return null
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    querySelectorAll(selector) {
      const wanted = tokenSet(selector)
      const found = []
      const visit = (item) => {
        if ([...wanted].some((name) => item.classList.contains(name))) found.push(item)
        item.children.forEach(visit)
      }
      this.children.forEach(visit)
      return found
    },
    getBoundingClientRect() {
      const scroller = this.closest('.paper-view') ?? this
      const plane = this.closest('.paper-sheet-plane') ?? this
      const zoom = plane.classList.contains('paper-view') ? 1 : Number.parseFloat(plane.style.zoom || plane.style.getPropertyValue('--view-zoom') || '1') || 1
      const planeLeft = plane.contentLeft - (scroller.scrollLeft ?? 0)
      const planeTop = plane.contentTop - (scroller.scrollTop ?? 0)
      if (this === scroller) {
        return {
          left: 0,
          top: 0,
          width: this.clientWidth,
          height: this.clientHeight,
          right: this.clientWidth,
          bottom: this.clientHeight,
        }
      }
      const left = planeLeft + (this.contentLeft - plane.contentLeft) * zoom
      const top = planeTop + (this.contentTop - plane.contentTop) * zoom
      const width = this.layoutWidth * zoom
      const height = this.layoutHeight * zoom
      return { left, top, width, height, right: left + width, bottom: top + height }
    },
    get offsetWidth() { return this.layoutWidth },
    get offsetHeight() { return this.layoutHeight },
    get scrollWidth() {
      return Math.max(this.clientWidth, this.layoutWidth)
    },
    get scrollHeight() {
      return Math.max(this.clientHeight, this.layoutHeight)
    },
  }
  return node
}

const append = (parent, child) => {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

const A4 = { width: 900, height: 1273 }

const runOnce = () => {
  const hidpi = paintSizeForPage(A4.width, A4.height, { dpr: 2, viewZoom: 1 })
  assert.ok(hidpi.pixelWidth >= A4.width * 2 * 0.92, `DPR-2 A4 backing ${hidpi.pixelWidth}`)
  const zoomed = paintSizeForPage(A4.width, A4.height, { dpr: 2, viewZoom: 2 })
  assert.ok(zoomed.pixelWidth > hidpi.pixelWidth, 'viewZoom 2 must grow backing width')
  assert.ok(zoomed.pixelWidth >= A4.width * pdfPaintDeviceScale(2, 2) * 0.92, `zoomed backing ${zoomed.pixelWidth}`)
  assert.ok(Math.abs(zoomed.pixelWidth / zoomed.pixelHeight - A4.width / A4.height) < 0.01)

  const overlay = { left: 40, top: 80, width: 800, height: 2000 }
  const pages = [
    { top: 80, height: 1000 },
    { top: 1080, height: 1000 },
  ]
  const clientX = overlay.left + 400
  const clientY = pages[1].top + 500
  const before = pdfOverlayPointFromClient(clientX, clientY, overlay, pages)
  assert.ok(before)
  assert.equal(before.page, 2)
  const dy = -420
  const shifted = pdfOverlayShiftedBy(overlay, pages, 0, dy)
  const after = pdfOverlayPointFromClient(clientX, clientY + dy, shifted.overlay, shifted.pages)
  assert.ok(after)
  assert.equal(after.page, before.page)
  assert.equal(after.x, before.x)
  assert.equal(after.y, before.y)

  const topWindow = layoutInkWindow({ paperHeight: 4000, viewHeight: 800, scrollTop: 0, viewZoom: 1 })
  const scrolledWindow = layoutInkWindow({ paperHeight: 4000, viewHeight: 800, scrollTop: 2400, viewZoom: 1 })
  assert.ok(topWindow.y1 > 0.2)
  assert.ok(scrolledWindow.y0 > topWindow.y0, 'layout window must follow scrollTop, not a lagged visual rect')
  assert.ok(scrolledWindow.y1 > topWindow.y1, 'layout window bottom must move with scrollTop')
  const samePaperY = 0.18
  assert.ok(samePaperY >= topWindow.y0 && samePaperY <= topWindow.y1)
  const laterY = 0.7
  assert.ok(laterY >= scrolledWindow.y0 && laterY <= scrolledWindow.y1)
  const paperSize = { width: 900, height: 1800 }
  const boardSize = {
    width: paperSize.width + 2 * SCROLL_ROOM,
    height: paperSize.height + 2 * SCROLL_ROOM,
  }
  const fullBox = inkWindowCanvasBox({ y0: 0, y1: 1 }, boardSize, SCROLL_ROOM)
  assert.equal(fullBox.left, SCROLL_ROOM)
  assert.equal(fullBox.top, SCROLL_ROOM)
  assert.equal(fullBox.width, paperSize.width)
  assert.equal(fullBox.height, paperSize.height)
  assert.equal(boardSize.width - 2 * SCROLL_ROOM, paperSize.width, 'board − 2·pad must be the paper')
  assert.equal(boardSize.height - 2 * SCROLL_ROOM, paperSize.height)
  assert.equal(fullBox.paperWidth, paperSize.width)
  assert.equal(fullBox.paperHeight, paperSize.height)
  const windowed = { y0: 0.1, y1: 0.5 }
  const box = inkWindowCanvasBox(windowed, boardSize, SCROLL_ROOM)
  assert.equal(box.left, SCROLL_ROOM)
  assert.ok(Math.abs(box.top - (SCROLL_ROOM + windowed.y0 * paperSize.height)) < 1e-6)
  assert.ok(Math.abs(box.height - inkWindowSpan(windowed) * paperSize.height) < 1e-6)
  const markY = 0.18
  const stayed = inkMarkPaperY(markY, windowed, boardSize, SCROLL_ROOM)
  assert.ok(Math.abs(stayed - markY) < 1e-6, `windowed mark must stay on paper 0–1, got ${stayed}`)
  const style = inkWindowLayoutStyle(windowed)
  assert.match(style.top, /paper-scroll-room/)
  assert.match(style.height, /paper-scroll-room/)
  assert.match(style.left, /paper-scroll-room/)
  const afterScroll = inkMarkPaperY(markY, layoutInkWindow({
    paperHeight: paperSize.height * 2,
    viewHeight: 800,
    scrollTop: 0,
    viewZoom: 1,
  }), boardSize, SCROLL_ROOM)
  assert.ok(Math.abs(afterScroll - markY) < 0.02, 'top-of-page window must keep the written paper y')

  const pageWidth = 595.28
  const column = pdfPageColumnCssWidth(2020)
  assert.equal(column, PDF_PAGE_COLUMN_MAX)
  const overlayScale = pdfTextOverlayScaleForPaper(2020, pageWidth)
  assert.equal(overlayScale, pdfTextOverlayScale(PDF_PAGE_COLUMN_MAX, pageWidth))
  assert.notEqual(overlayScale, pdfTextOverlayScale(2020, pageWidth), 'glyphs must not follow the grown plane')
  assert.notEqual(overlayScale, zoomed.pixelWidth / pageWidth, 'glyphs must not follow the bitmap')
  const overlayH = pdfOverlaySourceHeight(900, 900, 2200)
  assert.ok(overlayH > 2000, `two-page overlay source ${overlayH} must stay taller than one page`)
  const inkPixels = inkOverlayPixelSize(900, 2_200, 2, true, 2)
  assert.ok(inkPixels.width >= 900 * 2 * 0.85, `ink overlay at zoom 2 must stay HiDPI, got ${inkPixels.width}`)

  const scroller = makeNode('paper-view unified-note-view', {
    clientWidth: 400,
    clientHeight: 300,
    layoutWidth: 400,
    layoutHeight: 300,
  })
  const plane = append(scroller, makeNode('paper-sheet-plane', {
    layoutWidth: 900,
    layoutHeight: 1800,
    contentLeft: 0,
    contentTop: 0,
  }))
  const paper = append(plane, makeNode('unified-paper is-pdf-note', {
    layoutWidth: 900,
    layoutHeight: 1800,
    contentLeft: 0,
    contentTop: 0,
  }))
  const mark = append(paper, makeNode('written-mark', {
    layoutWidth: 8,
    layoutHeight: 8,
    contentLeft: 160,
    contentTop: 240,
  }))
  const start = mark.getBoundingClientRect()
  const origin = { x: start.left + start.width / 2, y: start.top + start.height / 2 }
  const view = defaultPaperView()
  const result = applyPaperZoomStayPut(scroller, plane, view, 2, origin)
  assert.equal(result.view.zoom, 2)
  if (result.anchor) restorePaperAnchor(scroller, plane, result.anchor)
  const now = mark.getBoundingClientRect()
  const mappedX = now.left + now.width / 2
  const mappedY = now.top + now.height / 2
  assert.ok(Number.isFinite(mappedX) && Number.isFinite(mappedY), 'stay-put mapping must be finite')
  assert.ok(Math.abs(mappedX - origin.x) <= 1, `zoom stay-put X ${mappedX} vs ${origin.x}`)
  assert.ok(Math.abs(mappedY - origin.y) <= 1, `zoom stay-put Y ${mappedY} vs ${origin.y}`)
  const anchor = capturePaperAnchor(scroller, plane, origin)
  const used = result.view.zoom
  assert.ok(Math.abs(anchor.localX * used - (origin.x - plane.getBoundingClientRect().left)) <= 2, 'anchor local×zoom matches the cursor')

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const pdf = readFileSync(join(root, 'src/components/PdfNoteView.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src/lib/paperView.ts'), 'utf8')
  const inkHit = readFileSync(join(root, 'src/lib/pdfInkHit.ts'), 'utf8')
  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  assert.match(inkHit, /export const layoutInkWindow/)
  assert.match(inkHit, /export const pdfOverlayShiftedBy/)
  assert.match(inkHit, /export const inkWindowLayoutStyle/)
  assert.match(inkHit, /export const inkWindowCanvasBox/)
  assert.match(inkHit, /export const inkMarkPaperY/)
  assert.match(board, /layoutInkWindow\(/)
  assert.match(board, /inkWindowLayoutStyle\(/)
  assert.match(board, /pdfOverlayPointFromClient\(/)
  assert.match(board, /INK_WINDOW_IDLE_MS/)
  assert.match(board, /scrollend/)
  assert.match(board, /onScrollEnd/)
  assert.match(board, /applyPaperZoomStayPut/)
  assert.doesNotMatch(board, /sheet\.getBoundingClientRect\(\)/)
  assert.match(board, /Do not syncInkWindow here/)
  assert.match(pdf, /paintSizeForPage\(cssWidth, cssHeight, \{ viewZoom \}\)/)
  assert.match(pdf, /liveCanvas\.style\.width = `\$\{cssWidth\}px`/)
  assert.match(pdf, /liveCanvas\.style\.height = `\$\{cssHeight\}px`/)
  assert.doesNotMatch(css, /\.pdf-note-page\.is-virtualized \{[^}]*contain:\s*strict/)
  assert.doesNotMatch(css, /contain-intrinsic-size:\s*800px 1100px/)
  assert.match(css, /\.pdf-note-page canvas \{[\s\S]*?width:\s*auto/)
  assert.match(paperView, /applyPaperZoomStayPut/)
  assert.match(paperView, /\.pdf-note-text-layer/)
  assert.match(paperView, /\.pdf-note-canvas-host/)

  return {
    hidpiWidth: hidpi.pixelWidth,
    zoomedWidth: zoomed.pixelWidth,
    page: after.page,
    overlayY: after.y,
    overlayScale,
    stayPut: { mappedX, mappedY, origin },
    topWindow,
    scrolledWindow,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.equal(first.hidpiWidth, second.hidpiWidth)
  assert.equal(first.zoomedWidth, second.zoomedWidth)
  assert.equal(first.page, second.page)
  assert.equal(first.overlayY, second.overlayY)
  assert.equal(first.overlayScale, second.overlayScale)
  assert.deepEqual(first.stayPut.origin, second.stayPut.origin)
  console.log(JSON.stringify({
    hidpiWidth: first.hidpiWidth,
    zoomedWidth: first.zoomedWidth,
    page: first.page,
    overlayY: first.overlayY,
    overlayScale: first.overlayScale,
  }))
  console.log('pdf-write-stay ok')
} finally {
  await server.close()
}
