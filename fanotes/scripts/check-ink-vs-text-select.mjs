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
  inkBlockedMarkdownSelectors,
  inkOverlayHitSelector,
  inkUserSelectNoneSelectors,
  pointerEventsForInkLayer,
  userSelectForInkLayer,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')

const runOnce = () => {
  assert.equal(pointerEventsForInkLayer('pdf-text', true), 'none')
  assert.equal(pointerEventsForInkLayer('markdown', true), 'none')
  assert.equal(pointerEventsForInkLayer('worksheet-page', true), 'none')
  assert.equal(pointerEventsForInkLayer('overlay', true), 'auto')
  assert.equal(userSelectForInkLayer('pdf-text', true), 'none')
  assert.equal(userSelectForInkLayer('markdown', true), 'none')
  assert.equal(userSelectForInkLayer('worksheet-page', true), 'none')
  assert.equal(userSelectForInkLayer('overlay', true), 'none')

  assert.equal(pointerEventsForInkLayer('pdf-text', false), 'auto')
  assert.equal(pointerEventsForInkLayer('markdown', false), 'auto')
  assert.equal(pointerEventsForInkLayer('worksheet-page', false), 'auto')
  assert.equal(pointerEventsForInkLayer('overlay', false), 'none')
  assert.equal(userSelectForInkLayer('pdf-text', false), 'text')
  assert.equal(userSelectForInkLayer('markdown', false), 'text')
  assert.equal(userSelectForInkLayer('worksheet-page', false), 'text')

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const pdfView = readFileSync(join(root, 'src/components/PdfNoteView.tsx'), 'utf8')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

  const selectorHas = (source, selector, pattern) => {
    let from = 0
    while (from < source.length) {
      const start = source.indexOf(selector, from)
      if (start < 0) return false
      if (pattern.test(source.slice(start, start + 420))) return true
      from = start + selector.length
    }
    return false
  }
  for (const selector of inkUserSelectNoneSelectors) {
    assert.ok(css.includes(selector), `missing ${selector}`)
    assert.ok(
      selectorHas(css, selector, /user-select:\s*none/),
      `${selector} must drop selection under Stift`,
    )
  }
  for (const selector of inkBlockedMarkdownSelectors) {
    assert.ok(css.includes(selector), selector)
  }

  assert.match(
    css,
    /(?<!is-inking )\.pdf-note-text-layer :is\(span, br\) \{[^}]*user-select:\s*text/,
    'Keyboard mode still selects PDF glyphs',
  )
  assert.match(
    css,
    /\.pdf-note-view\.is-inking \.pdf-note-text-layer :is\(span, br\) \{[^}]*user-select:\s*none/,
  )

  assert.equal(inkOverlayHitSelector, '.lw-drawing-board.is-inline.is-input-active .lw-canvas-surface')
  assert.match(board, /\.lw-drawing-board\.is-inline\.is-input-active \.lw-canvas-surface\{[^}]*pointer-events:\s*auto/)
  assert.match(board, /\.lw-drawing-board\.is-inline \.lw-canvas-surface\{[^}]*pointer-events:\s*none/)

  assert.doesNotMatch(pdfView, /textEnabled=\{!inputDisabled\}/)
  assert.match(pdfView, /textEnabled\n\s+highlight=/)
  assert.match(pdfView, /textEnabled \|\| textHost\.childElementCount > 0/)

  return {
    inkBlocksSelect: userSelectForInkLayer('pdf-text', true),
    keyboardAllowsSelect: userSelectForInkLayer('pdf-text', false),
    overlayTakesPen: pointerEventsForInkLayer('overlay', true),
    overlayIdle: pointerEventsForInkLayer('overlay', false),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('ink-vs-text-select ok')
} finally {
  await server.close()
}
