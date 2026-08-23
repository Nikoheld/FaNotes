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
  INK_WIDTH_ANCHOR_CLASS,
  PAPER_SOURCE_HEIGHT,
  PAPER_SOURCE_WIDTH,
  PAGE_GROW_STEP_HEIGHT,
  WRITE_SLACK_HEIGHT,
  a4ColumnOriginLeftPx,
  applyLiveHandwritingGrow,
  inkExtentOriginLeftPx,
  inkExtentStyleValues,
  inkWidthNeedsAnchor,
  neededWriteExtent,
  paperPixelY,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const a4 = inkExtentStyleValues(a4H, a4W, a4W)
  assert.equal(a4.widthExtent, 1, 'A4 write-width must stay 1')
  assert.equal(inkWidthNeedsAnchor(a4.widthExtent), false)

  for (const container of [640, 900, 1200, 1600]) {
    const before = a4ColumnOriginLeftPx(container, a4W)
    const after = inkExtentOriginLeftPx(container, a4W, a4.widthExtent)
    assert.ok(Math.abs(after - before) <= 1, `ink-on A4 origin ${after} must stay ${before} in ${container}px`)
  }

  const grown = inkExtentStyleValues(a4H, neededWriteExtent(0.75, a4W, 360, 450), a4W * 1.5)
  assert.equal(inkWidthNeedsAnchor(grown.widthExtent), true)

  assert.equal(neededWriteExtent(0.015, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)
  assert.equal(neededWriteExtent(0.3, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT), a4H)

  const reportY = 0.015
  const visualY = paperPixelY(reportY, a4H)
  const zeroBox = applyLiveHandwritingGrow(
    { x: 0.2, y: reportY },
    { sourceW: a4W, sourceH: a4H, layoutW: 0, layoutH: 0 },
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4H },
  )
  assert.equal(zeroBox.remapped, false)
  assert.equal(zeroBox.y, reportY)
  assert.ok(Math.abs(zeroBox.nextPixelY - visualY) <= 1)
  assert.ok(zeroBox.y < 0.05)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const extentBlock = css.slice(css.indexOf('.unified-paper.has-ink-extent {'), css.indexOf('.unified-paper.has-ink-width {'))
  assert.ok(extentBlock.includes('min-height'))
  assert.equal(/\nmargin-left:/u.test(extentBlock), false, 'A4 ink-extent must not rewrite margin-left')
  assert.match(css, /\.unified-paper\.has-ink-width \{[\s\S]*?margin-left:\s*0/)
  assert.match(css, /\.unified-paper > \.editor-pane \{[\s\S]*?max-width:\s*900px/)
  assert.match(css, /--text-origin-x/)
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.equal(INK_WIDTH_ANCHOR_CLASS, 'has-ink-width')
  assert.match(board, /INK_WIDTH_ANCHOR_CLASS/)
  assert.match(board, /inkWidthNeedsAnchor/)

  console.log(JSON.stringify({
    a4Origin640: inkExtentOriginLeftPx(640, a4W, 1),
    a4Origin1200: inkExtentOriginLeftPx(1200, a4W, 1),
    auto1200: a4ColumnOriginLeftPx(1200, a4W),
    topY: reportY,
    extent: a4H,
  }))
  console.log('bug-text-shift ok')
} finally {
  await server.close()
}
