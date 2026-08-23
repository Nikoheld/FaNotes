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
  PAGE_START_HEIGHT,
  PAGE_START_WIDTH,
  SCROLL_ROOM,
  WRITE_MARGIN_X,
  WRITE_MARGIN_Y,
  canvasScrollBounds,
  clampCanvasScroll,
  growPageFromMark,
  growWriteExtent,
  growWriteOrigin,
  keepMarkOnPage,
  mapClientToPage,
  markPagePosition,
  pageCanvasLayout,
  writePageLayoutSize,
  writePageSurface,
  writeSurfaceIsPage,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')

const runOnce = () => {
  assert.ok(SCROLL_ROOM > WRITE_MARGIN_Y, 'extra pan room is more than the write margin')
  assert.ok(SCROLL_ROOM < PAGE_START_HEIGHT * 2, 'extra pan room stays finite')
  assert.ok(WRITE_MARGIN_Y < PAGE_START_HEIGHT * 0.25, 'write margin is not half a page')
  assert.ok(WRITE_MARGIN_X < PAGE_START_WIDTH * 0.25)

  const page = { width: PAGE_START_WIDTH, height: PAGE_START_HEIGHT }
  const content = { minX: 0, minY: 0, maxX: page.width, maxY: page.height }
  const bounds = canvasScrollBounds(content)
  assert.equal(bounds.maxX - content.maxX, SCROLL_ROOM)
  assert.equal(content.minX - bounds.minX, SCROLL_ROOM)
  assert.equal(bounds.maxY - content.maxY, SCROLL_ROOM)
  assert.equal(content.minY - bounds.minY, SCROLL_ROOM)
  assert.ok(bounds.maxX - bounds.minX < 20_000, 'scroll span around content is finite')
  assert.ok(bounds.maxY - bounds.minY < 20_000)

  const viewport = { width: 800, height: 600 }
  const clampedFar = clampCanvasScroll({ x: 8_000_000, y: 9_000_000 }, bounds, viewport)
  assert.equal(clampedFar.x, Math.max(0, bounds.maxX - viewport.width))
  assert.equal(clampedFar.y, Math.max(0, bounds.maxY - viewport.height))
  assert.ok(clampedFar.x < 8_000_000)
  assert.ok(clampedFar.y < 9_000_000)

  const clampedNeg = clampCanvasScroll({ x: -40, y: -90 }, bounds, viewport)
  assert.equal(clampedNeg.x, 0)
  assert.equal(clampedNeg.y, 0)

  const mark = { x: 0.2, y: 0.3 }
  const farEdge = { x: 0.94, y: 0.94 }
  const first = growPageFromMark(page, farEdge)
  assert.ok(first.height > page.height, 'a write at the far edge grows the page')
  assert.ok(first.width > page.width)
  const firstScroll = canvasScrollBounds({ minX: 0, minY: 0, maxX: first.width, maxY: first.height })
  assert.ok(firstScroll.maxY > bounds.maxY, 'allowed scroll max grows with the page')
  assert.equal(firstScroll.maxY - first.height, bounds.maxY - page.height, 'extra room stays the same after grow')

  const second = growPageFromMark({ width: first.width, height: first.height }, farEdge)
  assert.ok(second.height > first.height, 'repeating a far-edge write grows again')
  assert.ok(second.width > first.width)
  const secondScroll = canvasScrollBounds({ minX: 0, minY: 0, maxX: second.width, maxY: second.height })
  assert.ok(secondScroll.maxY > firstScroll.maxY)
  assert.equal(secondScroll.maxY - second.height, firstScroll.maxY - first.height)

  const keptX = keepMarkOnPage(mark.x, page.width, first.width, first.padX)
  const keptY = keepMarkOnPage(mark.y, page.height, first.height, first.padY)
  assert.ok(
    Math.abs(markPagePosition(keptX, first.width) - first.padX - markPagePosition(mark.x, page.width)) < 1e-6,
    'a mark keeps its page position after max-edge grow',
  )
  assert.ok(
    Math.abs(markPagePosition(keptY, first.height) - first.padY - markPagePosition(mark.y, page.height)) < 1e-6,
  )

  const left = growPageFromMark(page, { x: 0.02, y: 0.5 })
  const up = growPageFromMark(page, { x: 0.5, y: 0.02 })
  assert.ok(left.padX > 0, 'writing at the left edge opens more paper')
  assert.ok(left.width > page.width)
  assert.ok(up.padY > 0, 'writing at the top edge opens more paper')
  assert.ok(up.height > page.height)
  const leftKept = keepMarkOnPage(mark.x, page.width, left.width, left.padX)
  assert.ok(
    Math.abs(markPagePosition(leftKept, left.width) - (markPagePosition(mark.x, page.width) + left.padX)) < 1e-6,
    'a mark stays put when the page grows left',
  )
  assert.equal(growWriteOrigin(0.4, PAGE_START_WIDTH, WRITE_MARGIN_X, WRITE_MARGIN_X), 0)
  assert.ok(growWriteExtent(0.94, PAGE_START_HEIGHT, WRITE_MARGIN_Y, WRITE_MARGIN_Y) > PAGE_START_HEIGHT)

  const viewportFill = { width: 1600, height: 900 }
  const sourceOnFill = { width: 900, height: 144 }
  const filled = writePageLayoutSize(sourceOnFill, viewportFill)
  assert.equal(filled.width, viewportFill.width, 'short source still fills the viewport')
  const paintedLargerThanSource = growPageFromMark(
    sourceOnFill,
    { x: 0.94, y: 0.94 },
    { width: viewportFill.width, height: viewportFill.height },
  )
  assert.ok(paintedLargerThanSource.width > sourceOnFill.width, 'far-edge write grows even when CSS offset is already wider than source')
  assert.ok(paintedLargerThanSource.height > sourceOnFill.height, 'far-edge write grows height even when CSS offset is already taller than source')
  const afterPainted = writePageLayoutSize(
    { width: paintedLargerThanSource.width, height: paintedLargerThanSource.height },
    viewportFill,
  )
  assert.ok(afterPainted.width >= paintedLargerThanSource.width)
  const grownPastViewport = growPageFromMark(
    { width: viewportFill.width, height: viewportFill.height },
    { x: 0.94, y: 0.94 },
    { width: viewportFill.width, height: viewportFill.height },
  )
  assert.ok(grownPastViewport.width > viewportFill.width, 'a write at the filled-page edge grows past the viewport')
  const laidPast = writePageLayoutSize(
    { width: grownPastViewport.width, height: grownPastViewport.height },
    viewportFill,
  )
  assert.ok(laidPast.width > viewportFill.width)
  const stayPutLayout = keepMarkOnPage(mark.x, viewportFill.width, grownPastViewport.width, grownPastViewport.padX)
  assert.ok(
    Math.abs(stayPutLayout * grownPastViewport.width - grownPastViewport.padX - mark.x * viewportFill.width) < 1e-6,
    'marks stay put when layout grows with source past the viewport',
  )

  const layout = pageCanvasLayout(page)
  assert.equal(layout.page.x, 0)
  assert.equal(layout.page.y, 0)
  assert.equal(layout.page.width, page.width)
  assert.equal(layout.scroll.width, page.width + layout.pad * 2)
  assert.equal(writeSurfaceIsPage(writePageSurface(layout.page), layout.page), true)

  const canvasBox = { left: 40, top: 20, width: page.width, height: page.height }
  const onPage = mapClientToPage(canvasBox.left + 0.22 * page.width, canvasBox.top + 0.28 * page.height, canvasBox)
  assert.ok(onPage && onPage.x > 0.2 && onPage.y > 0.2)
  const pastRight = mapClientToPage(canvasBox.left + page.width + 40, canvasBox.top + 80, canvasBox)
  assert.ok(pastRight && pastRight.x > 1, 'a sample past the current edge maps outside 0–1 so the page can grow')

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  assert.match(board, /from '\.\.\/lib\/noteCanvas'/)
  assert.match(board, /growPageFromMark/)
  assert.match(board, /keepMarkOnPage/)
  assert.match(board, /mapClientToPage/)
  assert.match(paperView, /from '\.\.\/lib\/noteCanvas'/)
  assert.match(paperView, /clampCanvasScroll/)
  assert.doesNotMatch(board, /expandSourceToOneCanvas/)
  assert.doesNotMatch(board, /textColumnOnOneCanvas/)
  const noteViewBlock = css.slice(css.indexOf('.unified-note-view {'), css.indexOf('.unified-note-view.is-pdf-note {'))
  assert.match(noteViewBlock, /background:\s*#fff/)
  assert.doesNotMatch(noteViewBlock, /background:\s*#111\b/)
  const planeBlock = css.slice(css.indexOf('.paper-sheet-plane {'), css.indexOf('.paper-view-hud {'))
  assert.match(planeBlock, /padding:\s*var\(--paper-scroll-room\)/)
  assert.doesNotMatch(planeBlock, /background-clip:\s*content-box/)
  const rulingBlock = css.slice(css.indexOf('.paper-sheet-plane > .paper-ruling {'), css.indexOf('.paper-dots .paper-sheet-plane > .paper-ruling {'))
  assert.match(rulingBlock, /inset:\s*0/)
  const planePaper = css.slice(
    css.indexOf('.paper-sheet-plane > .unified-paper {'),
    css.indexOf('.paper-sheet-plane > .unified-paper.has-ink-extent {'),
  )
  assert.doesNotMatch(planePaper, /(?:^|\n)\s*width:\s*100%/, 'plane paper must not lock width to 100%')
  assert.match(board, /--ink-page-width/)
  assert.match(css, /width:\s*max\(100%,\s*var\(--ink-page-width/)
  const extentBlock = css.slice(
    css.indexOf('.paper-sheet-plane > .unified-paper.has-ink-extent {'),
    css.indexOf('.unified-note-view.is-inking .unified-paper'),
  )
  assert.match(extentBlock, /--ink-page-width/)
  assert.match(extentBlock, /width:\s*max\(100%,\s*var\(--ink-page-width/)

  return {
    firstHeight: first.height,
    secondHeight: second.height,
    firstScrollMax: firstScroll.maxY,
    secondScrollMax: secondScroll.maxY,
    extraRoom: SCROLL_ROOM,
    clampedFarY: clampedFar.y,
    leftPad: left.padX,
    upPad: up.padY,
    keptPixelX: markPagePosition(keptX, first.width),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-canvas ok')
} finally {
  await server.close()
}
