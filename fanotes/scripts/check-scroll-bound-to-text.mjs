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
  SCROLL_ROOM,
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
  assert.ok(WRITE_SLACK_HEIGHT < PAPER_SOURCE_HEIGHT * 0.25, 'write slack must stay a margin, not half an A4')
  assert.ok(SCROLL_ROOM > WRITE_SLACK_HEIGHT * 2, 'camera room must be reasonably far')
  assert.ok(SCROLL_ROOM < PAPER_SOURCE_HEIGHT * 2, 'camera room must not be infinite')

  const short = paperScrollBounds({ minX: 0, minY: 0, maxX: 420, maxY: 80 })
  assert.equal(short.minX, -SCROLL_ROOM)
  assert.equal(short.minY, -SCROLL_ROOM)
  assert.equal(short.maxX, 420 + SCROLL_ROOM)
  assert.equal(short.maxY, 80 + SCROLL_ROOM)
  assert.ok(short.maxY - 80 === SCROLL_ROOM)
  assert.ok(short.maxX - short.minX < 20_000, 'short notes must not unlock an infinite pan')

  const tall = paperScrollBounds({ minX: 12, minY: 0, maxX: 380, maxY: 4200 })
  assert.equal(tall.minX, 12 - SCROLL_ROOM, 'left camera room stays open')
  assert.equal(tall.maxY, 4200 + SCROLL_ROOM)
  assert.equal(tall.maxX, 380 + SCROLL_ROOM)

  const wide = paperScrollBounds({ minX: 0, minY: 8, maxX: 2400, maxY: 90 })
  assert.equal(wide.minY, 8 - SCROLL_ROOM, 'top camera room stays open')
  assert.equal(wide.maxY, 90 + SCROLL_ROOM)

  const viewport = { width: 800, height: 600 }
  const clampedFar = clampPaperScrollOffset({ x: 8000, y: 9000 }, short, viewport)
  assert.equal(clampedFar.y, Math.max(0, short.maxY - viewport.height))
  assert.equal(clampedFar.x, Math.max(0, short.maxX - viewport.width))
  assert.ok(clampedFar.y < 10_000, 'camera clamp must stop well short of infinite scroll')

  const clampedNeg = clampPaperScrollOffset({ x: -40, y: -90 }, tall, viewport)
  assert.equal(clampedNeg.x, 0)
  assert.equal(clampedNeg.y, 0)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  assert.match(css, /--paper-write-slack:\s*144px/)
  assert.match(css, /--paper-scroll-room:\s*560px/)
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
  const textOnInk = css.slice(
    css.indexOf('.unified-paper.has-ink-extent .markdown-editor .cm-content {'),
    css.indexOf('.unified-paper.has-ink-extent .markdown-editor .cm-content {') + 280,
  )
  assert.match(textOnInk, /min-height:\s*0/)
  assert.doesNotMatch(textOnInk, /ink-extent-ratio/)
  assert.match(css, /\.unified-paper > \.editor-pane \{[\s\S]*?max-width:\s*900px/)
  assert.match(css, /--text-origin-x/)

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
  assert.match(board, /neededWriteMinPad/)
  assert.match(board, /clearInkExtentStyles/)
  assert.match(paperView, /paperScrollBoundsFromVisualRect/)
  assert.match(paperView, /paper-sheet-plane/)
  assert.match(paperView, /scrollHeight/)
  assert.doesNotMatch(paperView, /paperScrollBounds\(/)
  assert.match(css, /\.paper-sheet-plane \{[\s\S]*?min-height:\s*100%/)

  const topMargin = 32
  const bottomMargin = 76
  const sheetH = 800
  const sheetW = 900
  const view = { width: 800, height: 600 }
  const marginBounds = paperScrollBoundsFromVisualRect(
    {
      left: 40 + 50,
      top: 20 + topMargin,
      right: 40 + 50 + sheetW,
      bottom: 20 + topMargin + sheetH + bottomMargin,
    },
    { left: 40, top: 20, scrollLeft: 0, scrollTop: 0 },
  )
  assert.equal(marginBounds.minY, topMargin)
  assert.equal(marginBounds.maxY, topMargin + sheetH + bottomMargin)
  assert.ok(marginBounds.minX !== 0, 'centered sheet must not assume minX=0')
  const legalBottom = marginBounds.maxY - view.height
  const sizeBased = (marginBounds.maxY - marginBounds.minY) - view.height
  const keptBottom = clampPaperScrollOffset({ x: 0, y: legalBottom }, marginBounds, view)
  assert.equal(keptBottom.y, legalBottom, 'clamp must keep maxY-viewH (paper bottom including 76px margin)')
  assert.notEqual(legalBottom, sizeBased, 'maxY-minY-viewH would yank the last 32px')
  assert.ok(keptBottom.y > sizeBased)

  const zoom = 2
  const zoomedTop = topMargin * zoom
  const zoomedBounds = paperScrollBoundsFromVisualRect(
    {
      left: 40 + 50 * zoom,
      top: 20 + zoomedTop,
      right: 40 + (50 + sheetW) * zoom,
      bottom: 20 + (topMargin + sheetH + bottomMargin) * zoom,
    },
    { left: 40, top: 20, scrollLeft: 0, scrollTop: 0 },
  )
  assert.equal(zoomedBounds.minY, 64)
  const zoomedView = { width: 800, height: 369 }
  const zoomedLegal = zoomedBounds.maxY - zoomedView.height
  const zoomedSizeBased = (zoomedBounds.maxY - zoomedBounds.minY) - zoomedView.height
  const keepZoomed = clampPaperScrollOffset({ x: 0, y: zoomedLegal }, zoomedBounds, zoomedView)
  assert.equal(keepZoomed.y, zoomedLegal, 'zoom-2 clamp must keep maxY-viewH')
  assert.notEqual(zoomedLegal, zoomedSizeBased)
  assert.ok(keepZoomed.y > zoomedSizeBased)
  assert.ok(zoomedBounds.maxY !== sheetH + WRITE_SLACK_HEIGHT, 'must not add slack on top of a sheet that already includes it')

  const removed = []
  const props = new Set(['--ink-extent-ratio', '--ink-width-extent', '--text-origin-x', '--text-origin-y'])
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
    scrollRoom: SCROLL_ROOM,
    shortMaxY: short.maxY,
    tallMaxX: tall.maxX,
    clampedFar,
    marginMinY: marginBounds.minY,
    legalBottom: keptBottom.y,
    zoomedMinY: zoomedBounds.minY,
    zoomedLegal: keepZoomed.y,
  }))
  console.log('scroll-bound-to-text ok')
} finally {
  await server.close()
}
