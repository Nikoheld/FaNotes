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
  paperCameraAfterMaxEdgeGrow,
  paperOriginScrollDelta,
  paperScrollBoundsFromVisualRect,
  paperSheetLayoutShift,
  applyStayPutOp,
  liveWriteStayPut,
  nestedEditorOffsetOnWritePage,
  reduceStayPutOps,
  stayPutAfterExtentGrow,
  stayPutPaperAfterOp,
  stayPutPaperMovedByPadOnly,
  SCROLL_ROOM,
  textOriginCssPx,
  writePageStayExtent,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const { continueLiveWriteStroke } = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { classifyInkJumpAppend } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const {
  applyLiveStayPutStep,
  handlePaperEditorScroll,
  lockPaperEditorScrollIfNeeded,
  lockPaperViewportScrollStayPut,
  observeGhostTextSequence,
  pinPaperViewportAfterExtentGrow,
  sealNestedEditorScroll,
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

/**
 * Linux 2026.9.5 report 1788416428895: pads 108/144 already applied,
 * then user pan cam 668/640 → 632/1978 with max-edge height grows
 * 1552 → 2016 → 2160 → 2304 → 2448. No jump.
 */
const REPORT_1788416428895 = [
  { camX: 668, camY: 640, width: 2294, height: 1552, padX: 108, padY: 144 },
  { camX: 632, camY: 1978, width: 2294, height: 2016, padX: 108, padY: 144 },
  { camX: 632, camY: 1978, width: 2294, height: 2160, padX: 108, padY: 144 },
  { camX: 632, camY: 1978, width: 2294, height: 2304, padX: 108, padY: 144 },
  { camX: 632, camY: 1978, width: 2294, height: 2448, padX: 108, padY: 144 },
]

/**
 * Linux 2026.9.6 report 1788433450822: pad 0, pan cam 560/560 → 435/1745,
 * then max-edge canvas-extend height 1408 → 1440…2160, then camY 2586
 * with 2592 / 2736 / 2880. No jump.
 */
const REPORT_1788433450822 = [
  { camX: 560, camY: 560, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1440, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1584, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1728, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1872, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 2016, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 2160, padX: 0, padY: 0 },
  { camX: 435, camY: 2586, width: 2186, height: 2592, padX: 0, padY: 0 },
  { camX: 435, camY: 2586, width: 2186, height: 2736, padX: 0, padY: 0 },
  { camX: 435, camY: 2586, width: 2186, height: 2880, padX: 0, padY: 0 },
]

/**
 * Linux 2026.9.7 report 1788435936618: origin pads 108 then 144 at
 * cam 668/382 → 668/526, user pan to camY 1978, then max-edge height
 * 1872 / 2016 / 2160 / 2304 with pads already applied, then cam 665/181.
 */
const REPORT_1788435936618 = [
  { camX: 668, camY: 382, width: 2294, height: 1408, padX: 108, padY: 0 },
  { camX: 668, camY: 526, width: 2294, height: 1552, padX: 108, padY: 144 },
  { camX: 668, camY: 526, width: 2294, height: 1552, padX: 108, padY: 144 },
  { camX: 668, camY: 1978, width: 2294, height: 1872, padX: 108, padY: 144 },
  { camX: 668, camY: 1978, width: 2294, height: 2016, padX: 108, padY: 144 },
  { camX: 668, camY: 1978, width: 2294, height: 2160, padX: 108, padY: 144 },
  { camX: 668, camY: 1978, width: 2294, height: 2304, padX: 108, padY: 144 },
  { camX: 665, camY: 181, width: 2294, height: 2304, padX: 108, padY: 144 },
]

/** Closed stay-put ops: pan, max-edge height, max-edge width, min-edge pad, overlay. */
const PAN_ONLY = [
  { camX: 560, camY: 560, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 665, camY: 181, width: 2186, height: 1408, padX: 0, padY: 0 },
]
const MAX_EDGE_DOWN = [
  { camX: 435, camY: 1745, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1440, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1584, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1728, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 1872, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 2016, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 2160, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 2592, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 2736, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2186, height: 2880, padX: 0, padY: 0 },
]
const MAX_EDGE_WIDTH = [
  { camX: 435, camY: 1745, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2294, height: 1408, padX: 0, padY: 0 },
  { camX: 435, camY: 1745, width: 2500, height: 1408, padX: 0, padY: 0 },
]
const MIN_EDGE_PAD = [
  { camX: 560, camY: 560, width: 2186, height: 1408, padX: 0, padY: 0 },
  { camX: 668, camY: 560, width: 2294, height: 1408, padX: 108, padY: 0 },
  { camX: 668, camY: 704, width: 2294, height: 1552, padX: 108, padY: 144 },
]
const OVERLAY_JUMP = [
  { camX: 668, camY: 645, width: 2294, height: 1408, padX: 108, padY: 0 },
  {
    camX: 668,
    camY: 645,
    width: 2294,
    height: 1408,
    padX: 108,
    padY: 0,
    paintedWidth: 2294 + 2 * 560,
    paintedHeight: 1408 + 2 * 560,
  },
]
const NESTED_LOCK = [
  {
    camX: 560,
    camY: 560,
    width: 2186,
    height: 1408,
    padX: 0,
    padY: 0,
    lockEditor: true,
    editorX: 8,
    editorY: 40,
  },
]
const SHEET_ORIGIN_SHIFT = [
  {
    camX: 435,
    camY: 1745,
    width: 2186,
    height: 1584,
    padX: 0,
    padY: 0,
    sheetShift: { x: 0, y: 40 },
  },
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

  const paddedStart = { width: 2294, height: 1552 }
  const padded = markdownGlyphAfterCameraAndGrow(glyph, paddedStart, REPORT_1788416428895)
  assert.equal(padded.frames.length, REPORT_1788416428895.length)
  const paddedPaperX = glyph.x + 108
  const paddedPaperY = glyph.y + 144
  assert.equal(originPadDelta(108, 108), 0)
  assert.equal(originPadDelta(144, 144), 0)
  for (const [index, frame] of padded.frames.entries()) {
    assert.ok(
      Math.abs(frame.paperX - paddedPaperX) < 1e-6,
      `padded-scroll step ${index} paper X ${frame.paperX} must stay ${paddedPaperX} (pads not re-applied)`,
    )
    assert.ok(
      Math.abs(frame.paperY - paddedPaperY) < 1e-6,
      `padded-scroll step ${index} paper Y ${frame.paperY} must stay ${paddedPaperY} (pads not re-applied)`,
    )
    assert.equal(frame.editorY, 0)
    assert.equal(frame.camX, REPORT_1788416428895[index].camX)
    assert.equal(frame.camY, REPORT_1788416428895[index].camY)
    assert.equal(frame.height, REPORT_1788416428895[index].height)
    assert.equal(frame.padX, 108)
    assert.equal(frame.padY, 144)
  }
  assert.equal(padded.frames[0].camX, 668)
  assert.equal(padded.frames[1].camX, 632, 'camX 668→632 must not slide paper X')
  assert.equal(padded.frames.at(-1).height, 2448)
  assert.equal(padded.frames.at(-1).paperX, padded.frames[0].paperX)
  assert.equal(padded.frames.at(-1).paperY, padded.frames[0].paperY)

  const extended = markdownGlyphAfterCameraAndGrow(glyph, start, REPORT_1788433450822)
  assert.equal(extended.frames.length, REPORT_1788433450822.length)
  assert.equal(paperCameraAfterMaxEdgeGrow({ x: 435, y: 1745 }, 0, 0).x, 435)
  assert.equal(paperCameraAfterMaxEdgeGrow({ x: 435, y: 1745 }, 0, 0).y, 1745)
  assert.equal(paperCameraAfterMaxEdgeGrow({ x: 560, y: 560 }, 108, 0).x, 668)
  for (const [index, frame] of extended.frames.entries()) {
    assert.ok(
      Math.abs(frame.paperX - glyph.x) < 1e-6,
      `extend step ${index} paper X ${frame.paperX} must stay ${glyph.x}`,
    )
    assert.ok(
      Math.abs(frame.paperY - glyph.y) < 1e-6,
      `extend step ${index} paper Y ${frame.paperY} must stay ${glyph.y}`,
    )
    assert.equal(frame.editorY, 0)
    assert.equal(frame.camX, REPORT_1788433450822[index].camX)
    assert.equal(frame.camY, REPORT_1788433450822[index].camY)
    assert.equal(frame.height, REPORT_1788433450822[index].height)
    assert.equal(frame.padX, 0)
  }
  assert.equal(extended.frames[0].camX, 560)
  assert.equal(extended.frames[1].camX, 435, 'camX 560→435 must not slide paper X')
  assert.equal(extended.frames[1].camY, 1745)
  assert.equal(extended.frames.at(-1).camY, 2586)
  assert.equal(extended.frames.at(-1).height, 2880)
  assert.equal(extended.frames.at(-1).paperX, glyph.x)
  assert.equal(extended.frames.at(-1).paperY, glyph.y)

  const enlarge = markdownGlyphAfterCameraAndGrow(glyph, start, REPORT_1788435936618)
  assert.equal(enlarge.frames.length, REPORT_1788435936618.length)
  const enlargePaperX = glyph.x + 108
  const enlargePaperY = glyph.y + 144
  assert.equal(enlarge.frames[0].paperX, enlargePaperX)
  assert.equal(enlarge.frames[0].paperY, glyph.y)
  assert.equal(enlarge.frames[1].paperY, enlargePaperY)
  for (const [index, frame] of enlarge.frames.entries()) {
    assert.ok(
      Math.abs(frame.paperX - enlargePaperX) < 1e-6,
      `enlarge step ${index} paper X ${frame.paperX} must stay ${enlargePaperX}`,
    )
    if (index >= 1) {
      assert.ok(
        Math.abs(frame.paperY - enlargePaperY) < 1e-6,
        `enlarge step ${index} paper Y ${frame.paperY} must stay ${enlargePaperY}`,
      )
    }
    assert.equal(frame.editorY, 0)
    assert.equal(frame.camX, REPORT_1788435936618[index].camX)
    assert.equal(frame.camY, REPORT_1788435936618[index].camY)
    assert.equal(frame.height, REPORT_1788435936618[index].height)
    assert.equal(frame.padX, 108)
  }
  assert.equal(enlarge.frames[1].padY, 144)
  assert.equal(enlarge.frames[3].camY, 1978)
  assert.equal(enlarge.frames[6].height, 2304)
  assert.equal(enlarge.frames[6].paperX, enlarge.frames[1].paperX)
  assert.equal(enlarge.frames[6].paperY, enlarge.frames[1].paperY)
  assert.equal(enlarge.frames.at(-1).camX, 665, 'camX 668→665 must not slide paper X')
  assert.equal(enlarge.frames.at(-1).camY, 181)
  assert.equal(paperSheetLayoutShift({ x: 560, y: 560 }, { x: 560, y: 600 }).y, 40)
  assert.equal(paperCameraAfterMaxEdgeGrow({ x: 668, y: 1978 }, 0, 0).y, 1978)
  assert.equal(paperCameraAfterMaxEdgeGrow({ x: 668, y: 1978 }, 0, 0, { y: 40 }).y, 2018)
  const sheetBefore = paperScrollBoundsFromVisualRect(
    { left: 100, top: 80, right: 400, bottom: 500 },
    { left: 0, top: 0, scrollLeft: 668, scrollTop: 1978 },
  )
  const sheetAfter = paperScrollBoundsFromVisualRect(
    { left: 100, top: 120, right: 400, bottom: 640 },
    { left: 0, top: 0, scrollLeft: 668, scrollTop: 1978 },
  )
  const enlargeShift = paperSheetLayoutShift(
    { x: sheetBefore.minX, y: sheetBefore.minY },
    { x: sheetAfter.minX, y: sheetAfter.minY },
  )
  assert.equal(enlargeShift.y, 40)
  const pinned = paperCameraAfterMaxEdgeGrow({ x: 668, y: 1978 }, 0, 0, enlargeShift)
  assert.equal(pinned.y, 2018)
  const growGhost = observeGhostTextSequence(
    REPORT_1788435936618.slice(3, 7).map((step) => ({
      paperX: enlargePaperX,
      paperY: enlargePaperY,
      camX: step.camX,
      camY: step.camY,
      padX: step.padX,
      padY: step.padY,
      editorX: 0,
      editorY: 0,
    })),
  )
  for (const [index, frame] of growGhost.entries()) {
    assert.equal(frame.slip, false, `enlarge grow ${index} must not ghost-slip`)
    assert.equal(frame.sample.visualY, growGhost[0].sample.visualY)
  }
  const enlargePaper = makeNode('paper-view unified-note-view', { scrollTop: 1978, scrollLeft: 668 })
  const enlargeSheet = append(enlargePaper, makeNode('unified-paper'))
  const enlargeEditor = append(enlargeSheet, makeNode('editor-pane markdown-editor'))
  const enlargeCm = append(enlargeEditor, makeNode('cm-scroller', { scrollTop: 36, scrollLeft: 4 }))
  const enlargePinned = pinPaperViewportAfterExtentGrow(enlargePaper, { x: 668, y: 1978 })
  assert.equal(enlargePinned.paperScrollTop, 1978)
  assert.equal(enlargePinned.paperScrollLeft, 668)
  assert.equal(enlargeCm.scrollTop, 0)
  assert.equal(enlargeEditor.scrollTop, 0)

  const stayPutSeed = (ops) => ({
    paperX: glyph.x,
    paperY: glyph.y,
    camX: ops[0].camX,
    camY: ops[0].camY,
    width: start.width,
    height: start.height,
    originX: 0,
    originY: 0,
    editorX: 0,
    editorY: 0,
  })
  const assertClosed = (name, ops, seed = stayPutSeed(ops)) => {
    const reduced = reduceStayPutOps(seed, ops)
    let previous = seed
    for (const [index, frame] of reduced.frames.entries()) {
      assert.equal(
        stayPutPaperMovedByPadOnly(previous, frame),
        true,
        `${name} step ${index} paper X/Y ${frame.paperX},${frame.paperY} moved by more than new origin pad`,
      )
      assert.equal(frame.editorX, 0, `${name} step ${index} editor X must be 0`)
      assert.equal(frame.editorY, 0, `${name} step ${index} editor Y must be 0`)
      previous = frame
    }
    return reduced
  }
  const closedLatest = assertClosed('latest-enlarge', REPORT_1788435936618)
  assert.equal(closedLatest.end.paperX, glyph.x + 108)
  assert.equal(closedLatest.end.paperY, glyph.y + 144)
  assert.equal(closedLatest.end.camY, 181)
  assert.equal(closedLatest.end.height, 2304)
  const closedPan = assertClosed('pan-only', PAN_ONLY)
  assert.equal(closedPan.end.paperX, glyph.x)
  assert.equal(closedPan.end.paperY, glyph.y)
  assert.equal(closedPan.end.camX, 665)
  assert.equal(closedPan.end.camY, 181)
  const closedDown = assertClosed('max-edge-down', MAX_EDGE_DOWN)
  assert.equal(closedDown.end.paperY, glyph.y)
  assert.equal(closedDown.end.height, 2880)
  assert.equal(closedDown.end.camY, 1745)
  const closedWidth = assertClosed('max-edge-width', MAX_EDGE_WIDTH)
  assert.equal(closedWidth.end.paperX, glyph.x)
  assert.equal(closedWidth.end.width, 2500)
  const closedPad = assertClosed('min-edge-pad', MIN_EDGE_PAD)
  assert.equal(closedPad.frames[1].paperX, glyph.x + 108)
  assert.equal(closedPad.frames[2].paperY, glyph.y + 144)
  assert.equal(closedPad.frames[1].paperX - closedPad.frames[1].camX, glyph.x - 560)
  assert.equal(closedPad.frames[2].paperY - closedPad.frames[2].camY, glyph.y - 560)
  const livePad = applyStayPutOp(stayPutSeed(MIN_EDGE_PAD), { padX: 108, width: 2294, height: 1408 })
  assert.equal(livePad.paperX, glyph.x + 108)
  assert.equal(livePad.camX, stayPutAfterExtentGrow({ x: 560, y: 560 }, 108, 0).x)
  assert.equal(livePad.paperX - livePad.camX, glyph.x - 560)
  assert.equal(stayPutPaperAfterOp({ x: glyph.x, y: glyph.y }, 0, 0, 108, 0).x, glyph.x + 108)
  const closedOverlay = assertClosed('overlay-jump', OVERLAY_JUMP)
  assert.equal(closedOverlay.end.width, 2294)
  assert.equal(closedOverlay.end.height, 1408)
  assert.equal(closedOverlay.end.paperX, glyph.x + 108)
  const shifted = applyStayPutOp(stayPutSeed(MAX_EDGE_DOWN), {
    camX: 435,
    camY: 1745,
    width: 2186,
    height: 1584,
    padX: 0,
    padY: 0,
    sheetShift: { x: 0, y: 40 },
  })
  assert.equal(shifted.paperX, glyph.x)
  assert.equal(shifted.paperY, glyph.y)
  assert.equal(shifted.camY, stayPutAfterExtentGrow({ x: 435, y: 1745 }, 0, 0, { y: 40 }).y)
  const nested = applyStayPutOp({
    ...stayPutSeed(PAN_ONLY),
    editorX: 8,
    editorY: 40,
  }, { camX: 560, camY: 560, width: 2186, height: 1408, padX: 0, padY: 0, lockEditor: true, editorX: 8, editorY: 40 })
  assert.equal(nested.editorX, 0)
  assert.equal(nested.editorY, 0)
  assert.equal(nested.paperX, glyph.x)
  assert.equal(nested.camY, 560)
  assertClosed('report-1788366080812', REPORT_1788366080812)
  assertClosed('report-1788376550462', REPORT_1788376550462)
  assertClosed('report-1788416428895', REPORT_1788416428895)
  assertClosed('report-1788433450822', REPORT_1788433450822)
  assertClosed('report-1788435936618', REPORT_1788435936618)
  const closedNested = assertClosed(
    'nested-lock-editor',
    NESTED_LOCK,
    { ...stayPutSeed(NESTED_LOCK), editorX: 8, editorY: 40 },
  )
  assert.equal(closedNested.end.editorX, 0)
  assert.equal(closedNested.end.editorY, 0)
  assert.equal(closedNested.end.paperX, glyph.x)
  const closedShift = assertClosed('sheet-origin-shift', SHEET_ORIGIN_SHIFT, stayPutSeed(MAX_EDGE_DOWN))
  assert.equal(closedShift.end.paperX, glyph.x)
  assert.equal(closedShift.end.paperY, glyph.y)
  assert.equal(closedShift.end.camY, stayPutAfterExtentGrow({ x: 435, y: 1745 }, 0, 0, { y: 40 }).y)
  const keptNested = applyStayPutOp(stayPutSeed(PAN_ONLY), {
    camX: 560,
    camY: 560,
    width: 2186,
    height: 1408,
    editorX: 8,
    editorY: 40,
  })
  assert.equal(keptNested.editorX, nestedEditorOffsetOnWritePage(8, 40).x)
  assert.equal(keptNested.editorY, nestedEditorOffsetOnWritePage(8, 40).y)
  assert.equal(keptNested.paperX, glyph.x)
  assert.equal(keptNested.paperY, glyph.y)

  const liveMin = continueLiveWriteStroke({
    last: null,
    current: { x: 0.0489, y: 0.22 },
    page: { width: 2186, height: 1408, originX: 0, originY: 0 },
    painted: { width: 2186, height: 1408 },
    existingCount: 0,
    stayPut: stayPutSeed(MIN_EDGE_PAD),
  })
  const reducedMin = applyStayPutOp(stayPutSeed(MIN_EDGE_PAD), {
    width: liveMin.grown.width,
    height: liveMin.grown.height,
    padX: liveMin.grown.padX,
    padY: liveMin.grown.padY,
  })
  const viaLiveWrite = liveWriteStayPut(stayPutSeed(MIN_EDGE_PAD), {
    grown: liveMin.grown,
    painted: { width: 2186, height: 1408 },
  })
  assert.equal(liveMin.stayPut.paperX, reducedMin.paperX)
  assert.equal(liveMin.stayPut.paperY, reducedMin.paperY)
  assert.equal(liveMin.stayPut.paperX, viaLiveWrite.paperX)
  assert.equal(liveMin.stayPut.paperY, viaLiveWrite.paperY)
  assert.equal(liveMin.stayPut.camX, viaLiveWrite.camX)
  assert.equal(stayPutPaperMovedByPadOnly(stayPutSeed(MIN_EDGE_PAD), liveMin.stayPut), true)
  assert.equal(liveMin.stayPut.editorX, 0)
  assert.equal(liveMin.stayPut.editorY, 0)

  const liveMax = continueLiveWriteStroke({
    last: null,
    current: { x: 0.5, y: 0.99 },
    page: { width: 2186, height: 1408, originX: 0, originY: 0 },
    painted: { width: 2186, height: 1408 },
    existingCount: 0,
    stayPut: stayPutSeed(MAX_EDGE_DOWN),
  })
  const reducedMax = applyStayPutOp(stayPutSeed(MAX_EDGE_DOWN), {
    width: liveMax.grown.width,
    height: liveMax.grown.height,
    padX: stayPutSeed(MAX_EDGE_DOWN).originX + liveMax.grown.padX,
    padY: stayPutSeed(MAX_EDGE_DOWN).originY + liveMax.grown.padY,
  })
  assert.equal(liveMax.stayPut.paperX, reducedMax.paperX)
  assert.equal(liveMax.stayPut.paperY, reducedMax.paperY)
  assert.equal(stayPutPaperMovedByPadOnly(stayPutSeed(MAX_EDGE_DOWN), liveMax.stayPut), true)
  assert.equal(liveMax.stayPut.editorY, 0)

  const nestedPaper = makeNode('paper-view unified-note-view', { scrollTop: 560, scrollLeft: 560 })
  const nestedSheet = append(nestedPaper, makeNode('unified-paper'))
  const nestedEditor = append(nestedSheet, makeNode('editor-pane markdown-editor'))
  const nestedCm = append(nestedEditor, makeNode('cm-scroller', { scrollTop: 40, scrollLeft: 8 }))
  nestedCm.scrollTop = 40
  nestedCm.scrollLeft = 8
  nestedEditor.scrollTop = 12
  const nestedLive = applyLiveStayPutStep(
    stayPutSeed(PAN_ONLY),
    {
      camX: 560,
      camY: 560,
      width: 2186,
      height: 1408,
      padX: 0,
      padY: 0,
      editorX: nestedCm.scrollLeft,
      editorY: nestedCm.scrollTop,
    },
    nestedPaper,
  )
  assert.equal(nestedLive.editorX, 0)
  assert.equal(nestedLive.editorY, 0)
  assert.equal(stayPutPaperMovedByPadOnly(stayPutSeed(PAN_ONLY), nestedLive), true)
  assert.equal(nestedCm.scrollTop, 0)
  assert.equal(nestedCm.scrollLeft, 0)
  assert.equal(nestedEditor.scrollTop, 0)
  nestedCm.scrollTop = 99
  nestedCm.scrollLeft = 77
  nestedEditor.scrollTop = 55
  assert.equal(nestedCm.scrollTop, 0, 'nested cm-scroller cannot keep a non-zero scroll offset')
  assert.equal(nestedCm.scrollLeft, 0, 'nested cm-scroller cannot keep a non-zero scrollLeft')
  assert.equal(nestedEditor.scrollTop, 0, 'nested editor-pane cannot keep a non-zero scroll offset')
  const nestedAfterAssign = applyLiveStayPutStep(nestedLive, {
    camX: 560,
    camY: 1745,
    width: 2186,
    height: 1440,
    padX: 0,
    padY: 0,
    editorX: nestedCm.scrollLeft,
    editorY: nestedCm.scrollTop,
  }, nestedPaper)
  assert.equal(stayPutPaperMovedByPadOnly(nestedLive, nestedAfterAssign), true)
  assert.equal(nestedAfterAssign.editorY, 0)
  assert.equal(nestedAfterAssign.paperX, nestedLive.paperX)
  assert.equal(nestedAfterAssign.paperY, nestedLive.paperY)
  const sealedFresh = makeNode('cm-scroller', { scrollTop: 40, scrollLeft: 8 })
  sealNestedEditorScroll(sealedFresh)
  sealedFresh.scrollTop = 120
  sealedFresh.scrollLeft = 60
  assert.equal(sealedFresh.scrollTop, 0)
  assert.equal(sealedFresh.scrollLeft, 0)
  const sealedOffset = nestedEditorOffsetOnWritePage(sealedFresh.scrollLeft, sealedFresh.scrollTop)
  assert.equal(sealedOffset.x, 0)
  assert.equal(sealedOffset.y, 0)

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

  paper.scrollTop = 1978
  paper.scrollLeft = 632
  cm.scrollTop = 40
  editor.scrollTop = 12
  assert.equal(lockPaperEditorScrollIfNeeded(editor, { top: 40, bottom: 60, left: 80, right: 90 }), true)
  assert.equal(paper.scrollTop, 1978, 'grow/selection measure must not pan the paper camera to the caret')
  assert.equal(paper.scrollLeft, 632)
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
  const styles = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const handlerAt = caretSource.indexOf('export const handlePaperEditorScroll')
  assert.ok(handlerAt >= 0)
  const handlerBlock = caretSource.slice(handlerAt, handlerAt + 900)
  assert.match(handlerBlock, /lockPaperEditorLayerScroll/)
  assert.doesNotMatch(handlerBlock, /keepCaretVisibleInPaperScroller/)
  const lockIfNeededAt = caretSource.indexOf('export const lockPaperEditorScrollIfNeeded')
  assert.ok(lockIfNeededAt >= 0)
  const lockIfNeededBlock = caretSource.slice(lockIfNeededAt, lockIfNeededAt + 700)
  assert.match(lockIfNeededBlock, /lockPaperEditorLayerScroll/)
  assert.doesNotMatch(lockIfNeededBlock, /applyPaperArrowNavigation/)
  assert.doesNotMatch(lockIfNeededBlock, /keepCaretVisibleInPaperScroller/)
  assert.match(editorSource, /applyPaperArrowNavigation/)
  assert.match(editorSource, /lockPaperEditorScrollIfNeeded/)
  assert.match(noteCanvas, /export const writePageStayExtent/)
  assert.match(noteCanvas, /export const originPadDelta/)
  assert.match(noteCanvas, /export const overlaySampleOntoWritePage/)
  assert.match(noteCanvas, /export const markdownGlyphAfterCameraAndGrow/)
  assert.match(noteCanvas, /export const paperCameraAfterMaxEdgeGrow/)
  assert.match(noteCanvas, /export const paperSheetLayoutShift/)
  assert.match(noteCanvas, /export const stayPutAfterExtentGrow/)
  assert.match(noteCanvas, /export const stayPutPaperAfterOp/)
  assert.match(noteCanvas, /export const applyStayPutOp/)
  assert.match(noteCanvas, /export const stayPutPaperMovedByPadOnly/)
  assert.match(noteCanvas, /export const liveWriteStayPut/)
  assert.match(noteCanvas, /export const nestedEditorOffsetOnWritePage/)
  assert.match(noteCanvas, /state = applyStayPutOp\(state/)
  assert.match(paperGrow, /writePageStayExtent/)
  assert.match(paperGrow, /overlaySampleOntoWritePage/)
  assert.match(paperGrow, /export const continueLiveWriteStroke/)
  assert.match(paperGrow, /liveWriteStayPut/)
  assert.match(board, /continueLiveWriteStroke/)
  assert.match(board, /textOriginCssPx\(/)
  assert.match(board, /liveWriteStayPut\(/)
  assert.match(board, /paperSheetLayoutShift\(/)
  assert.match(board, /pinPaperViewportAfterExtentGrow\(/)
  assert.match(board, /lockPaperViewportEditorScroll\(/)
  assert.match(board, /writePageStayExtent\(/)
  assert.match(board, /growPageFromMark\(/)
  assert.doesNotMatch(board, /requestAnimationFrame\(\(\) => \{\s*pinGrowFrameRef/)
  assert.match(caretSource, /export const pinPaperViewportAfterExtentGrow/)
  assert.match(caretSource, /export const sealNestedEditorScroll/)
  assert.match(caretSource, /export const applyLiveStayPutStep/)
  assert.match(styles, /\.paper-sheet-plane[\s\S]{0,400}overflow-anchor:\s*none/)
  assert.match(styles, /\.unified-paper \.markdown-editor \.cm-scroller[\s\S]{0,280}overflow:\s*clip/)
  assert.match(styles, /\.unified-paper \.markdown-editor \.cm-scroller[\s\S]{0,280}overflow-anchor:\s*none/)
  assert.match(editorSource, /overflow: paperMode \? 'clip'/)
  assert.match(editorSource, /handlePaperEditorScroll/)
  assert.match(editorSource, /lockPaperViewportScrollStayPut|captureGhostTextAroundLock/)
  assert.match(paperView, /lockPaperViewportScrollStayPut|captureGhostTextAroundLock/)
  assert.match(self, /REPORT_1788366080812/)
  assert.match(self, /REPORT_1788376550462/)
  assert.match(self, /REPORT_1788416428895/)
  assert.match(self, /REPORT_1788433450822/)
  assert.match(self, /REPORT_1788435936618/)
  assert.match(self, /PAN_ONLY/)
  assert.match(self, /MAX_EDGE_DOWN/)
  assert.match(self, /MAX_EDGE_WIDTH/)
  assert.match(self, /MIN_EDGE_PAD/)
  assert.match(self, /OVERLAY_JUMP/)
  assert.match(self, /NESTED_LOCK/)
  assert.match(self, /SHEET_ORIGIN_SHIFT/)
  assert.match(self, /padX: 108/)
  assert.match(self, /padY: 144/)
  assert.match(self, /width: 3414/)
  assert.equal(REPORT_1788366080812[2].camY, 1368)
  assert.equal(REPORT_1788376550462[0].camY, 645)
  assert.equal(REPORT_1788376550462[2].width, 2294 + 2 * SCROLL_ROOM)
  assert.equal(REPORT_1788416428895[1].camY, 1978)
  assert.equal(REPORT_1788416428895.at(-1).height, 2448)
  assert.equal(REPORT_1788433450822[1].camX, 435)
  assert.equal(REPORT_1788433450822[1].camY, 1745)
  assert.equal(REPORT_1788433450822.at(-1).height, 2880)
  assert.equal(REPORT_1788435936618[0].camY, 382)
  assert.equal(REPORT_1788435936618[1].padY, 144)
  assert.equal(REPORT_1788435936618[6].height, 2304)
  assert.equal(REPORT_1788435936618.at(-1).camY, 181)
  assert.notEqual(REPORT_1788366080812.length, REPORT_1788435936618.length)
  assert.notEqual(REPORT_1788376550462.length, REPORT_1788435936618.length)
  assert.notEqual(REPORT_1788416428895.length, REPORT_1788435936618.length)
  assert.notEqual(REPORT_1788433450822.length, REPORT_1788435936618.length)

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
    paddedScrollFrames: padded.frames.length,
    paddedPaperX: padded.frames.at(-1).paperX,
    paddedPaperY: padded.frames.at(-1).paperY,
    paddedCamX: padded.frames.at(-1).camX,
    paddedCamY: padded.frames.at(-1).camY,
    paddedHeight: padded.frames.at(-1).height,
    visualX: visual0X,
    visualY: visual0Y,
    jumpAction: jumpLive.action,
    jumpWidth: jumpLive.grown.width,
    padX: padLive.grown.padX,
    cameraHeld: 1368,
    paddedCameraHeld: 1978,
    extendFrames: extended.frames.length,
    extendPaperX: extended.frames.at(-1).paperX,
    extendPaperY: extended.frames.at(-1).paperY,
    extendCamX: extended.frames.at(-1).camX,
    extendCamY: extended.frames.at(-1).camY,
    extendHeight: extended.frames.at(-1).height,
    enlargeFrames: enlarge.frames.length,
    enlargePaperX: enlarge.frames.at(-1).paperX,
    enlargePaperY: enlarge.frames.at(-1).paperY,
    enlargeCamX: enlarge.frames.at(-1).camX,
    enlargeCamY: enlarge.frames.at(-1).camY,
    enlargeHeight: enlarge.frames.at(-1).height,
    enlargeGrowCamY: enlarge.frames[6].camY,
    closedPanCamY: closedPan.end.camY,
    closedDownHeight: closedDown.end.height,
    closedWidth: closedWidth.end.width,
    closedPadPaperY: closedPad.end.paperY,
    closedOverlayWidth: closedOverlay.end.width,
    closedShiftCamY: shifted.camY,
    closedNestedEditorY: nested.editorY,
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
