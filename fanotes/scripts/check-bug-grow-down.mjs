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
  PAGE_GROW_STEP_HEIGHT,
  PAGE_GROW_STEP_WIDTH,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  applyLiveHandwritingGrow,
  inkExtentStyleValues,
  neededWriteExtent,
  paperPixelY,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  const a4H = PAPER_SOURCE_HEIGHT
  const a4W = PAPER_SOURCE_WIDTH
  const bottomY = 0.94
  const nextH = neededWriteExtent(bottomY, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextH >= a4H + PAGE_GROW_STEP_HEIGHT, 'y≈0.94 on A4 must grow at least one half-page step')

  const a4Painted = inkExtentStyleValues(a4H, a4W, a4W)
  const tallPainted = inkExtentStyleValues(nextH, a4W, a4W)
  assert.ok(
    tallPainted.paintedHeightPx > a4Painted.paintedHeightPx,
    `painted/CSS height ${tallPainted.paintedHeightPx} must exceed A4 ${a4Painted.paintedHeightPx}`,
  )
  assert.ok(tallPainted.extentRatio > a4Painted.extentRatio)

  const start = { x: 0.42, y: bottomY }
  const visualY = paperPixelY(bottomY, a4Painted.paintedHeightPx)
  const grown = applyLiveHandwritingGrow(
    start,
    { sourceW: a4W, sourceH: a4H, layoutW: a4W, layoutH: a4Painted.paintedHeightPx },
    { sourceW: a4W, sourceH: nextH, layoutW: a4W, layoutH: tallPainted.paintedHeightPx },
  )
  assert.ok(Math.abs(grown.nextPixelY - visualY) <= 1, `painted Y ${grown.nextPixelY} must stay ${visualY}`)
  assert.ok(grown.y > 0.2, 'must not jump toward y≈0')
  assert.equal(grown.x, start.x, 'a height grow must not rewrite X')

  const nextW = neededWriteExtent(0.75, a4W, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH)
  const afterRight = inkExtentStyleValues(nextH, nextW, a4W * (nextW / a4W))
  assert.equal(afterRight.paintedHeightPx, tallPainted.paintedHeightPx, 'a later width grow must keep the taller height')

  const upper = neededWriteExtent(0.3, a4H, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.equal(upper, a4H, 'upper-third y≈0.30 still must not grow')

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  assert.match(css, /min-height:\s*max\([\s\S]*?calc\(var\(--paper-width\) \* var\(--ink-extent-ratio\)\)/)
  assert.match(css, /\.unified-paper\.has-ink-extent \{[\s\S]*?min-height:/)
  assert.doesNotMatch(
    css.slice(css.indexOf('.unified-paper.has-ink-extent {'), css.indexOf('.unified-paper.has-ink-width {')),
    /^\s*height:\s*max\(/m,
  )
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /inkExtentStyleValues/)

  console.log(JSON.stringify({
    bottomY,
    nextH,
    a4Painted: a4Painted.paintedHeightPx,
    tallPainted: tallPainted.paintedHeightPx,
    remappedY: grown.y,
    paintedY: grown.nextPixelY,
    afterRightHeight: afterRight.paintedHeightPx,
  }))
  console.log('bug-grow-down ok')
} finally {
  await server.close()
}
