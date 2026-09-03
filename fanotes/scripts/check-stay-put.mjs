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
  originPadDelta,
  overlaySampleOntoWritePage,
  paperOriginScrollDelta,
  SCROLL_ROOM,
  textOriginCssPx,
  writePageStayExtent,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const { continueLiveWriteStroke } = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { classifyInkJumpAppend } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const {
  handlePaperEditorScroll,
  lockPaperViewportScrollStayPut,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')

/**
 * Linux 2026.9.2 report 1788366080812: camY 560 → 829 → 1368 at camX 560,
 * page 2186×1408 growing 1440 / 1584 then 3306×2704 while inking.
 */
const REPORT_1788366080812 = [
  { camX: 560, camY: 560, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 560, camY: 829, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 560, camY: 1368, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 560, camY: 1368, width: 2186, height: 1440, padX: 0, padY: 0 },
  { camX: 560, camY: 1368, width: 2186, height: 1584, padX: 0, padY: 0 },
  { camX: 560, camY: 1368, width: 3306, height: 2704, padX: 0, padY: 0 },
]

/**
 * Linux 2026.9.3 report 1788376550462: left-edge WRITE_MARGIN_X pad 108,
 * then a no-new-pad jump of 2×SCROLL_ROOM (2294+1120=3414, 1408+1120=2528).
 */
const REPORT_1788376550462 = [
  { camX: 560, camY: 645, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 668, camY: 645, width: 2294, height: 1408, padX: 108, padY: 0 },
  { camX: 668, camY: 645, width: 3414, height: 2528, padX: 108, padY: 0 },
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
  const ink = { x: 0.22, y: 0.31 }
  const start = { width: 2186, height: 1408 }
  assert.equal(2 * SCROLL_ROOM, 1120)
  assert.equal(originPadDelta(0, 108), 108)
  assert.equal(originPadDelta(108, 108), 0)
  assert.equal(writePageStayExtent(2294, 3414), 2294)
  assert.equal(writePageStayExtent(1408, 2528), 1408)

  const scrolled = markdownGlyphAfterCameraAndGrow(glyph, start, REPORT_1788366080812)
  assert.equal(scrolled.originPaperX, 86)
  assert.equal(scrolled.originPaperY, 78)
  assert.equal(scrolled.frames.length, REPORT_1788366080812.length)
  for (const [index, frame] of scrolled.frames.entries()) {
    assert.ok(
      Math.abs(frame.paperX - scrolled.originPaperX) < 1e-6,
      `scroll step ${index} glyph paper X ${frame.paperX} must stay ${scrolled.originPaperX}`,
    )
    assert.ok(
      Math.abs(frame.paperY - scrolled.originPaperY) < 1e-6,
      `scroll step ${index} glyph paper Y ${frame.paperY} must stay ${scrolled.originPaperY}`,
    )
    assert.equal(frame.editorY, 0, `scroll step ${index} live path must not leave nested editor scroll`)
    assert.equal(frame.camY, REPORT_1788366080812[index].camY)
    assert.equal(frame.width, REPORT_1788366080812[index].width)
    assert.equal(frame.height, REPORT_1788366080812[index].height)
  }

  const sequence = markdownGlyphAfterCameraAndGrow(glyph, start, REPORT_1788376550462)
  assert.equal(sequence.originPaperX, 86)
  assert.equal(sequence.originPaperY, 78)
  assert.equal(sequence.frames.length, REPORT_1788376550462.length)
  const visual0X = sequence.frames[0].paperX - sequence.frames[0].camX
  const visual0Y = sequence.frames[0].paperY - sequence.frames[0].camY
  for (const [index, frame] of sequence.frames.entries()) {
    const expectedPaperX = glyph.x + (REPORT_1788376550462[index].padX ?? 0)
    const expectedPaperY = glyph.y + (REPORT_1788376550462[index].padY ?? 0)
    assert.ok(
      Math.abs(frame.paperX - expectedPaperX) < 1e-6,
      `step ${index} glyph paper X ${frame.paperX} must stay ${expectedPaperX}`,
    )
    assert.ok(
      Math.abs(frame.paperY - expectedPaperY) < 1e-6,
      `step ${index} glyph paper Y ${frame.paperY} must stay ${expectedPaperY}`,
    )
    assert.ok(
      Math.abs(frame.paperX - frame.camX - visual0X) < 1e-6,
      `step ${index} glyph visual X ${frame.paperX - frame.camX} must stay ${visual0X}`,
    )
    assert.ok(
      Math.abs(frame.paperY - frame.camY - visual0Y) < 1e-6,
      `step ${index} glyph visual Y ${frame.paperY - frame.camY} must stay ${visual0Y}`,
    )
    assert.equal(frame.editorY, 0, `step ${index} live path must not leave nested editor scroll`)
    assert.equal(frame.camX, REPORT_1788376550462[index].camX)
    assert.equal(frame.camY, REPORT_1788376550462[index].camY)
  }
  assert.equal(sequence.frames[1].paperX, 194)
  assert.equal(sequence.frames[2].paperX, 194, '2×SCROLL_ROOM jump must not re-apply origin pad 108')
  assert.equal(sequence.frames[2].width, 3414)
  assert.equal(sequence.frames[2].height, 2528)

  const padThenScroll = markdownGlyphAfterCameraAndGrow(glyph, start, [
    REPORT_1788376550462[0],
    REPORT_1788376550462[1],
    { camX: 668, camY: 829, width: 2294, height: 1408, padX: 108, padY: 0 },
    { camX: 668, camY: 1368, width: 2294, height: 1408, padX: 108, padY: 0 },
    REPORT_1788376550462[2],
  ])
  assert.equal(padThenScroll.frames[1].paperX, 194)
  assert.equal(padThenScroll.frames[3].paperX, 194, 'scrolling after a left-edge pad must not re-apply origin pad')
  assert.equal(padThenScroll.frames[4].paperX, 194)
  assert.equal(padThenScroll.frames[3].paperY, 78)
  assert.equal(padThenScroll.frames[3].camY, 1368)

  const afterPad = markdownAndInkAfterMinEdgeGrow(
    ink,
    glyph,
    start,
    { width: 2294, height: 1408, padX: 108, padY: 0 },
  )
  assert.equal(afterPad.origin.x, textOriginCssPx(108, 0).x)
  assert.equal(afterPad.scrollX, paperOriginScrollDelta(108))
  assert.ok(Math.abs(afterPad.visualTextX - glyph.x) < 1e-6)
  assert.ok(Math.abs(afterPad.visualTextY - glyph.y) < 1e-6)
  assert.ok(Math.abs(afterPad.visualInkX - ink.x * 2186) < 1e-6)
  const inkAfterPad = { x: afterPad.inkX / 2294, y: afterPad.inkY / 1408 }
  const glyphAfterPad = { x: afterPad.textX, y: afterPad.textY }
  const afterJump = markdownAndInkAfterMinEdgeGrow(
    inkAfterPad,
    glyphAfterPad,
    { width: 2294, height: 1408 },
    { width: 3414, height: 2528, padX: originPadDelta(108, 108), padY: 0 },
  )
  assert.equal(afterJump.scrollX, 0)
  assert.equal(afterJump.textX, glyphAfterPad.x)
  assert.equal(afterJump.textY, glyphAfterPad.y)
  assert.ok(Math.abs(afterJump.inkX - afterPad.inkX) < 1e-6)
  assert.ok(Math.abs(afterJump.inkY - afterPad.inkY) < 1e-6)

  let page = { width: 2186, height: 1408, originX: 0, originY: 0 }
  let last = null
  let pendingStale = null
  const points = []
  const padSample = { x: 0.0489, y: 0.22 }
  const padLive = continueLiveWriteStroke({
    last,
    current: padSample,
    page,
    painted: { width: 2186, height: 1408 },
    existingCount: 0,
    pendingStale,
  })
  assert.equal(padLive.grew, true)
  assert.equal(padLive.grown.padX, 108)
  assert.equal(padLive.grown.width, 2294)
  assert.notEqual(padLive.action, 'skip')
  points.push(padLive.current)
  last = padLive.current
  pendingStale = padLive.pendingStale
  page = {
    width: padLive.grown.width,
    height: padLive.grown.height,
    originX: 108,
    originY: 0,
  }

  const overlay = { width: 3414, height: 2528 }
  const jumpSample = { x: 0.0618, y: 0.1299 }
  assert.equal(classifyInkJumpAppend(last, jumpSample, points.length), 'skip')
  const lifted = overlaySampleOntoWritePage(jumpSample, page, overlay)
  assert.notEqual(classifyInkJumpAppend(last, lifted, points.length), 'skip')
  const jumpLive = continueLiveWriteStroke({
    last,
    current: jumpSample,
    page,
    painted: overlay,
    existingCount: points.length,
    pendingStale,
  })
  assert.equal(jumpLive.grew, false, 'camera-room overlay must not become write-page extent')
  assert.equal(jumpLive.grown.width, 2294)
  assert.equal(jumpLive.grown.height, 1408)
  assert.equal(jumpLive.grown.padX, 0)
  assert.notEqual(jumpLive.action, 'skip', 'remapped overlay sample must stay on the stroke')
  assert.equal(writePageStayExtent(page.width, overlay.width), 2294)

  const paper = makeNode('paper-view unified-note-view', { scrollTop: 645, scrollLeft: 668 })
  const sheet = append(paper, makeNode('unified-paper'))
  const editor = append(sheet, makeNode('editor-pane markdown-editor'))
  const cm = append(editor, makeNode('cm-scroller', { scrollTop: 40, scrollLeft: 8 }))
  for (const step of REPORT_1788366080812) {
    cm.scrollTop = 48 + step.camY / 10
    editor.scrollTop = 24
    const locked = lockPaperViewportScrollStayPut(paper, {
      scrollTop: step.camY,
      scrollLeft: step.camX,
    })
    assert.equal(cm.scrollTop, 0, `camY ${step.camY}: cm-scroller must stay at 0`)
    assert.equal(editor.scrollTop, 0, `camY ${step.camY}: editor layer must stay at 0`)
    assert.equal(locked.paperScrollTop, step.camY)
    assert.equal(locked.paperScrollLeft, step.camX)
  }
  paper.scrollTop = 1368
  paper.scrollLeft = 560
  assert.equal(handlePaperEditorScroll({
    dom: editor,
    coordsAtPos: () => ({ top: 40, bottom: 60, left: 80, right: 90 }),
  }, { head: 3 }), true)
  assert.equal(paper.scrollTop, 1368, 'scroll-into-view must not pan the paper camera to the caret')
  assert.equal(paper.scrollLeft, 560)
  assert.equal(cm.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)

  const edgeLocked = lockPaperViewportScrollStayPut(paper, { scrollTop: 645, scrollLeft: 668 })
  assert.equal(edgeLocked.paperScrollTop, 645)
  assert.equal(edgeLocked.paperScrollLeft, 668)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const editorSource = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
  const noteCanvas = readFileSync(join(root, 'src/lib/noteCanvas.ts'), 'utf8')
  const paperGrow = readFileSync(join(root, 'src/lib/paperGrow.ts'), 'utf8')
  const caretSource = readFileSync(join(root, 'src/lib/paperCaretScroll.ts'), 'utf8')
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const handlerAt = caretSource.indexOf('export const handlePaperEditorScroll')
  assert.ok(handlerAt >= 0)
  const handlerBlock = caretSource.slice(handlerAt, handlerAt + 900)
  assert.match(handlerBlock, /lockPaperEditorLayerScroll/)
  assert.doesNotMatch(handlerBlock, /keepCaretVisibleInPaperScroller/)
  assert.match(noteCanvas, /export const writePageStayExtent/)
  assert.match(noteCanvas, /export const originPadDelta/)
  assert.match(noteCanvas, /export const overlaySampleOntoWritePage/)
  assert.match(noteCanvas, /export const markdownGlyphAfterCameraAndGrow/)
  assert.match(paperGrow, /writePageStayExtent/)
  assert.match(paperGrow, /overlaySampleOntoWritePage/)
  assert.match(paperGrow, /export const continueLiveWriteStroke/)
  assert.match(board, /continueLiveWriteStroke/)
  assert.match(board, /textOriginCssPx\(/)
  assert.match(board, /paperOriginScrollDelta\(/)
  assert.match(board, /writePageStayExtent\(/)
  assert.match(board, /growPageFromMark\(/)
  assert.match(editorSource, /handlePaperEditorScroll/)
  assert.match(editorSource, /lockPaperViewportScrollStayPut|captureGhostTextAroundLock/)
  assert.match(paperView, /lockPaperViewportScrollStayPut|captureGhostTextAroundLock/)
  assert.match(self, /REPORT_1788366080812/)
  assert.match(self, /REPORT_1788376550462/)
  assert.match(self, /padX: 108/)
  assert.match(self, /width: 3414/)
  assert.equal(REPORT_1788366080812[2].camY, 1368)
  assert.equal(REPORT_1788376550462[0].camY, 645)
  assert.equal(REPORT_1788376550462[2].width, 2294 + 2 * SCROLL_ROOM)
  assert.notEqual(REPORT_1788366080812.length, REPORT_1788376550462.length)

  return {
    scrollFrames: scrolled.frames.length,
    lastCamY: scrolled.frames.at(-1).camY,
    lastScrollWidth: scrolled.frames.at(-1).width,
    lastScrollHeight: scrolled.frames.at(-1).height,
    scrollPaperY: scrolled.frames.at(-1).paperY,
    edgeFrames: sequence.frames.length,
    afterPadPaperX: sequence.frames[1].paperX,
    afterJumpPaperX: sequence.frames[2].paperX,
    padThenScrollPaperX: padThenScroll.frames[3].paperX,
    visualX: visual0X,
    visualY: visual0Y,
    jumpAction: jumpLive.action,
    jumpWidth: jumpLive.grown.width,
    padX: padLive.grown.padX,
    cameraHeld: 1368,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('stay-put ok')
} finally {
  await server.close()
}
