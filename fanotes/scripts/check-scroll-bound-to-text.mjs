import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  HAS_INK_EXTENT_CLASS,
  INK_WIDTH_ANCHOR_CLASS,
  clampPaperScrollOffset,
  clearInkExtentStyles,
  inkExtentStyleValues,
  paperScrollBounds,
  paperScrollBoundsFromVisualRect,
  paperSourceExtentFromContent,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  assert.ok(WRITE_SLACK_HEIGHT < PAPER_SOURCE_HEIGHT * 0.25, 'height slack must be modest, not half an A4')
  assert.ok(WRITE_SLACK_WIDTH < PAPER_SOURCE_HEIGHT * 0.25, 'width slack must be modest')

  const short = paperScrollBounds({ minX: 0, minY: 0, maxX: 420, maxY: 80 })
  assert.equal(short.minX, 0)
  assert.equal(short.minY, 0)
  assert.equal(short.maxX, 420 + WRITE_SLACK_WIDTH)
  assert.equal(short.maxY, 80 + WRITE_SLACK_HEIGHT)
  assert.ok(short.maxY - 80 < PAPER_SOURCE_HEIGHT * 0.25, 'short text must not open an empty A4 below')
  assert.ok(short.maxX - 420 < PAPER_SOURCE_HEIGHT * 0.25, 'short text must not open a large empty pan right')

  const tall = paperScrollBounds({ minX: 12, minY: 0, maxX: 380, maxY: 4200 })
  assert.equal(tall.minX, 0, 'unused left side must stay closed')
  assert.equal(tall.maxY, 4200 + WRITE_SLACK_HEIGHT)
  assert.ok(tall.maxX - 380 === WRITE_SLACK_WIDTH, 'a tall-only note must not open a wide empty axis')

  const wide = paperScrollBounds({ minX: 0, minY: 8, maxX: 2400, maxY: 90 })
  assert.equal(wide.minY, 0, 'unused top side must stay closed')
  assert.ok(wide.maxY - 90 === WRITE_SLACK_HEIGHT, 'a wide-only note must not open a tall empty axis')

  const viewport = { width: 800, height: 600 }
  const clampedFar = clampPaperScrollOffset({ x: 8000, y: 9000 }, short, viewport)
  assert.equal(clampedFar.y, Math.max(0, short.maxY - viewport.height))
  assert.equal(clampedFar.x, Math.max(0, short.maxX - viewport.width))
  assert.equal(clampedFar.y, 0, 'short text shorter than the viewport must not scroll down into empty space')

  const clampedNeg = clampPaperScrollOffset({ x: -40, y: -90 }, tall, viewport)
  assert.equal(clampedNeg.x, 0)
  assert.equal(clampedNeg.y, 0)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  assert.match(css, /--paper-write-slack:\s*144px/)
  const paperBlock = css.slice(css.indexOf('.unified-paper {'), css.indexOf('.unified-paper.has-ink-extent {'))
  assert.match(paperBlock, /min-height:\s*0/)
  assert.doesNotMatch(paperBlock, /min-height:\s*max\(calc\(100%/)
  assert.match(css, /\.unified-paper \.markdown-editor \.cm-content \{ min-height:\s*0/)
  assert.match(css, /padding: 78px clamp\(52px, 8vw, 86px\) var\(--paper-write-slack\)/)
  assert.doesNotMatch(css, /\.unified-paper \.markdown-editor \.cm-content \{ min-height: max\(var\(--paper-a4-height\)/)
  assert.doesNotMatch(css, /\.cm-content \{ min-height: max\(var\(--paper-a4-height\), calc\(100vh/)
  const inkExtentBlock = css.slice(css.indexOf('.unified-paper.has-ink-extent {'), css.indexOf('.unified-paper.has-ink-width {'))
  assert.match(inkExtentBlock, /min-height:\s*calc\(var\(--paper-width\) \* var\(--ink-extent-ratio\)\)/)
  assert.doesNotMatch(inkExtentBlock, /paper-a4-height/)

  const shortInk = inkExtentStyleValues(WRITE_SLACK_HEIGHT, PAPER_SOURCE_WIDTH, PAPER_SOURCE_WIDTH)
  assert.ok(
    shortInk.paintedHeightPx < PAPER_SOURCE_HEIGHT * 0.4,
    `has-ink-extent for a short source (${shortInk.paintedHeightPx}) must not open an empty A4 (${PAPER_SOURCE_HEIGHT})`,
  )
  const shortExtent = paperSourceExtentFromContent({ minX: 0, minY: 0, maxX: 200, maxY: 80 })
  assert.equal(shortExtent.height, 80 + WRITE_SLACK_HEIGHT)
  assert.ok(shortExtent.height < PAPER_SOURCE_HEIGHT * 0.4, 'content bbox + slack must not floor to A4')

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
  assert.match(board, /paperSourceExtentFromContent/)
  assert.match(board, /paperScrollBounds/)
  assert.match(board, /clearInkExtentStyles/)
  assert.match(paperView, /paperScrollBoundsFromVisualRect/)
  assert.doesNotMatch(paperView, /paperScrollBounds\(/)

  const layoutH = 800
  const zoom = 2
  const visualH = layoutH * zoom
  const zoomedViewport = { width: 800, height: 369 }
  const zoomedBounds = paperScrollBoundsFromVisualRect(
    { left: 40, top: 20, right: 40 + 900 * zoom, bottom: 20 + visualH },
    { left: 40, top: 20, scrollLeft: 0, scrollTop: 0 },
  )
  assert.equal(zoomedBounds.maxY, visualH, 'zoom-2 bounds use visual height, not layout height')
  assert.ok(zoomedBounds.maxY !== layoutH + WRITE_SLACK_HEIGHT, 'must not add slack on top of a sheet that already includes it')
  const nativeMaxY = visualH - zoomedViewport.height
  assert.equal(nativeMaxY, 1231)
  const keepNative = clampPaperScrollOffset({ x: 0, y: nativeMaxY }, zoomedBounds, zoomedViewport)
  assert.equal(keepNative.y, nativeMaxY, 'clamp must not yank a legal zoomed scroll')
  const layoutBounds = paperScrollBounds({ minX: 0, minY: 0, maxX: 900, maxY: layoutH })
  const yanked = clampPaperScrollOffset({ x: 0, y: nativeMaxY }, layoutBounds, zoomedViewport)
  assert.ok(yanked.y < nativeMaxY, 'layout-space + slack bounds would yank the zoomed camera')

  const removed = []
  const props = new Set(['--ink-extent-ratio', '--ink-width-extent'])
  clearInkExtentStyles({
    classList: { remove: (...names) => { removed.push(...names) } },
    style: { removeProperty: (name) => { props.delete(name) } },
  })
  assert.ok(removed.includes(HAS_INK_EXTENT_CLASS))
  assert.ok(removed.includes(INK_WIDTH_ANCHOR_CLASS))
  assert.equal(props.size, 0)
  clearInkExtentStyles(null)

  console.log(JSON.stringify({
    slackH: WRITE_SLACK_HEIGHT,
    slackW: WRITE_SLACK_WIDTH,
    shortMaxY: short.maxY,
    tallMaxX: tall.maxX,
    clampedFar,
    zoomedMaxY: zoomedBounds.maxY,
    keepNativeY: keepNative.y,
  }))
  console.log('scroll-bound-to-text ok')
} finally {
  await server.close()
}
