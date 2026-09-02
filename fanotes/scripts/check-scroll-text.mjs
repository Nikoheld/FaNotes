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
  markdownAndInkAfterMinEdgeGrow,
  markdownGlyphAfterCameraAndGrow,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  handlePaperEditorScroll,
  lockPaperViewportScrollStayPut,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')

/**
 * Linux 2026.9.2 report 1788366080812: camY 560 → 829 → 1368 at camX 560,
 * page 2186×1408 growing 1440 / 1584 then 3306×2704 while inking.
 */
const REPORT_1788366080812 = [
  { camX: 560, camY: 560, width: 2186, height: 1408 },
  { camX: 560, camY: 829, width: 2186, height: 1408 },
  { camX: 560, camY: 1368, width: 2186, height: 1408 },
  { camX: 560, camY: 1368, width: 2186, height: 1440 },
  { camX: 560, camY: 1368, width: 2186, height: 1584 },
  { camX: 560, camY: 1368, width: 3306, height: 2704 },
]

const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/u).filter(Boolean))
  return {
    contains: (name) => values.has(name),
    add: (...names) => { names.forEach((name) => values.add(name)) },
    remove: (...names) => { names.forEach((name) => values.delete(name)) },
  }
}

const makeNode = (className, extras = {}) => {
  const node = {
    className,
    classList: makeClassList(className),
    parentElement: extras.parentElement ?? null,
    children: [],
    scrollTop: extras.scrollTop ?? 0,
    scrollLeft: extras.scrollLeft ?? 0,
    closest(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      let current = this
      while (current) {
        if (wanted.some((name) => current.classList.contains(name))) return current
        current = current.parentElement
      }
      return null
    },
    querySelectorAll(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      const found = []
      const visit = (item) => {
        if (wanted.some((name) => item.classList.contains(name))) found.push(item)
        item.children.forEach(visit)
      }
      this.children.forEach(visit)
      return found
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    },
  }
  return node
}

const append = (parent, child) => {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

const runOnce = () => {
  const glyph = { x: 86, y: 78 }
  const start = { width: 2186, height: 1408 }
  const sequence = markdownGlyphAfterCameraAndGrow(glyph, start, REPORT_1788366080812)
  assert.equal(sequence.originPaperX, 86)
  assert.equal(sequence.originPaperY, 78)
  assert.equal(sequence.frames.length, REPORT_1788366080812.length)
  for (const [index, frame] of sequence.frames.entries()) {
    assert.ok(
      Math.abs(frame.paperX - sequence.originPaperX) < 1e-6,
      `step ${index} glyph paper X ${frame.paperX} must stay ${sequence.originPaperX}`,
    )
    assert.ok(
      Math.abs(frame.paperY - sequence.originPaperY) < 1e-6,
      `step ${index} glyph paper Y ${frame.paperY} must stay ${sequence.originPaperY}`,
    )
    assert.equal(frame.camY, REPORT_1788366080812[index].camY)
    assert.equal(frame.height, REPORT_1788366080812[index].height)
    assert.equal(frame.width, REPORT_1788366080812[index].width)
    assert.equal(frame.editorY, 0, `step ${index} live path must not leave nested editor scroll`)
  }

  const lastGrow = markdownAndInkAfterMinEdgeGrow(
    { x: 0.2, y: 0.3 },
    glyph,
    { width: 2186, height: 1584 },
    { width: 3306, height: 2704, padX: 0, padY: 0 },
  )
  assert.equal(lastGrow.scrollY, 0)
  assert.equal(lastGrow.textY, glyph.y)
  assert.ok(Math.abs(lastGrow.visualTextY - glyph.y) < 1e-6)

  const paper = makeNode('paper-view unified-note-view', { scrollTop: 560, scrollLeft: 560 })
  const sheet = append(paper, makeNode('unified-paper'))
  const editor = append(sheet, makeNode('editor-pane markdown-editor'))
  const cm = append(editor, makeNode('cm-scroller', { scrollTop: 240, scrollLeft: 18 }))
  for (const step of REPORT_1788366080812) {
    cm.scrollTop = 48 + step.camY / 10
    editor.scrollTop = 24
    const locked = lockPaperViewportScrollStayPut(paper, {
      scrollTop: step.camY,
      scrollLeft: step.camX,
    })
    assert.equal(cm.scrollTop, 0, `camY ${step.camY}: cm-scroller must stay at 0`)
    assert.equal(editor.scrollTop, 0, `camY ${step.camY}: editor layer must stay at 0`)
    assert.equal(locked.paperScrollTop, step.camY, `paper camera must hold camY ${step.camY}`)
    assert.equal(locked.paperScrollLeft, step.camX)
  }

  paper.scrollTop = 1368
  paper.scrollLeft = 560
  const caret = { top: 40, bottom: 60, left: 80, right: 90 }
  const view = {
    dom: editor,
    coordsAtPos: () => caret,
  }
  assert.equal(handlePaperEditorScroll(view, { head: 3 }), true)
  assert.equal(paper.scrollTop, 1368, 'scroll-into-view must not pan the paper camera to the caret')
  assert.equal(paper.scrollLeft, 560)
  assert.equal(cm.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const editorSource = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
  const caretSource = readFileSync(join(root, 'src/lib/paperCaretScroll.ts'), 'utf8')
  const noteCanvas = readFileSync(join(root, 'src/lib/noteCanvas.ts'), 'utf8')
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const handlerAt = caretSource.indexOf('export const handlePaperEditorScroll')
  assert.ok(handlerAt >= 0)
  const handlerBlock = caretSource.slice(handlerAt, handlerAt + 900)
  assert.match(handlerBlock, /lockPaperEditorLayerScroll/)
  assert.doesNotMatch(handlerBlock, /keepCaretVisibleInPaperScroller/)
  assert.match(noteCanvas, /export const markdownGlyphAfterCameraAndGrow/)
  assert.match(editorSource, /lockPaperViewportScrollStayPut|captureGhostTextAroundLock/)
  assert.match(paperView, /lockPaperViewportScrollStayPut|captureGhostTextAroundLock/)
  assert.match(board, /continueLiveWriteStroke|growPageFromMark/)
  assert.match(self, /REPORT_1788366080812/)
  assert.match(self, /camY: 1368/)

  return {
    frames: sequence.frames.length,
    lastCamY: sequence.frames.at(-1).camY,
    lastHeight: sequence.frames.at(-1).height,
    lastWidth: sequence.frames.at(-1).width,
    paperY: sequence.frames.at(-1).paperY,
    originY: sequence.originPaperY,
    cameraHeld: 1368,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('scroll-text ok')
} finally {
  await server.close()
}
