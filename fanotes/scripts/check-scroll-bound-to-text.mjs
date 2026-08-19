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
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  clampPaperScrollOffset,
  paperScrollBounds,
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

  console.log(JSON.stringify({
    slackH: WRITE_SLACK_HEIGHT,
    slackW: WRITE_SLACK_WIDTH,
    shortMaxY: short.maxY,
    tallMaxX: tall.maxX,
    clampedFar,
  }))
  console.log('scroll-bound-to-text ok')
} finally {
  await server.close()
}
