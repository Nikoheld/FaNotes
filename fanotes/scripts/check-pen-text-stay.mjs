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
  WRITE_MARGIN_X,
  WRITE_MARGIN_Y,
  growPageFromMark,
  keepMarkOnPage,
  markdownAndInkAfterMinEdgeGrow,
  markPagePosition,
  paperOriginScrollDelta,
  textOriginCssPx,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')

const runOnce = () => {
  const page = { width: PAGE_START_WIDTH, height: 1800 }
  // Live report 1788090423894: pen samples around x≈0.05 / y≈0.04 on a markdown note.
  const report = { x: 0.046, y: 0.037 }
  const text = { x: 86, y: 78 }
  const existingInk = { x: 0.2, y: 0.3 }

  const grown = growPageFromMark(page, report)
  assert.ok(grown.padY > 0, 'a write near the top must open paper above the text')
  assert.ok(grown.padX > 0, 'a write near the left must open paper beside the text')
  assert.ok(grown.height > page.height)
  assert.ok(grown.width > page.width)

  const stay = markdownAndInkAfterMinEdgeGrow(existingInk, text, page, grown)
  assert.equal(stay.origin.x, textOriginCssPx(grown.padX, grown.padY).x)
  assert.equal(stay.origin.y, textOriginCssPx(grown.padX, grown.padY).y)
  assert.match(stay.origin.x, /px$/u)
  assert.match(stay.origin.y, /px$/u)
  assert.doesNotMatch(stay.origin.x, /%/u)
  assert.doesNotMatch(stay.origin.y, /%/u)

  assert.ok(
    Math.abs(stay.visualInkX - stay.prevInkX) < 1e-6,
    `ink X must stay ${stay.prevInkX}, got visual ${stay.visualInkX}`,
  )
  assert.ok(
    Math.abs(stay.visualInkY - stay.prevInkY) < 1e-6,
    `ink Y must stay ${stay.prevInkY}, got visual ${stay.visualInkY}`,
  )
  assert.ok(
    Math.abs(stay.visualTextX - stay.prevTextX) < 1e-6,
    `typed text X must stay ${stay.prevTextX}, got visual ${stay.visualTextX}`,
  )
  assert.ok(
    Math.abs(stay.visualTextY - stay.prevTextY) < 1e-6,
    `typed text Y must stay ${stay.prevTextY}, got visual ${stay.visualTextY}`,
  )

  const percentY = (grown.padY / grown.height) * page.width
  assert.ok(
    Math.abs(percentY - grown.padY) > 20,
    'a % origin on a tall sheet would not equal the pad — that is the bug',
  )
  assert.equal(Number.parseFloat(stay.origin.y), grown.padY)

  const layoutTaller = { width: grown.width, height: grown.height + 200 }
  const laid = markdownAndInkAfterMinEdgeGrow(existingInk, text, page, grown, layoutTaller)
  assert.ok(Math.abs(laid.visualTextY - laid.visualInkY + (laid.prevInkY - laid.prevTextY)) < 1e-6)
  assert.equal(laid.scrollY, paperOriginScrollDelta(grown.padY, grown.height, layoutTaller.height))

  const kept = keepMarkOnPage(existingInk.y, page.height, grown.height, grown.padY)
  assert.ok(
    Math.abs(markPagePosition(kept, grown.height) - grown.padY - markPagePosition(existingInk.y, page.height)) < 1e-6,
  )

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const noteCanvas = readFileSync(join(root, 'src/lib/noteCanvas.ts'), 'utf8')
  assert.match(noteCanvas, /export const textOriginCssPx/)
  assert.match(noteCanvas, /export const markdownAndInkAfterMinEdgeGrow/)
  assert.match(board, /textOriginCssPx\(/)
  assert.match(board, /paperOriginScrollDelta\(/)
  assert.doesNotMatch(board, /--text-origin-y.*%/u)
  assert.doesNotMatch(board, /originY \/ height/)
  const pane = css.slice(
    css.indexOf('.unified-paper > .editor-pane {'),
    css.indexOf('.unified-paper .markdown-editor, .unified-paper .markdown-editor .cm-editor'),
  )
  assert.match(pane, /padding-top:\s*var\(--text-origin-y/)
  assert.match(pane, /margin-left:\s*var\(--text-origin-x/)
  assert.match(pane, /margin-top:\s*0/)
  assert.doesNotMatch(pane, /margin-top:\s*var\(--text-origin-y/)

  return {
    padX: grown.padX,
    padY: grown.padY,
    origin: stay.origin,
    visualTextY: stay.visualTextY,
    visualInkY: stay.visualInkY,
    slackX: WRITE_MARGIN_X,
    slackY: WRITE_MARGIN_Y,
    startH: PAGE_START_HEIGHT,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('pen-text-stay ok')
} finally {
  await server.close()
}
