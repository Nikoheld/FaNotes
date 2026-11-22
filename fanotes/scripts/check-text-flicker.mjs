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
  applyPaperZoomGestureFrame,
  applyPaperZoomStayPut,
  defaultPaperView,
  keepPaperTextOnCameraMove,
} = await server.ssrLoadModule('/src/lib/paperView.ts')
const {
  GHOST_TEXT_SLIP_PX,
  classifyGhostTextMotion,
  commitEditorTextInsert,
  forcePaperCompositorRefresh,
  sampleGhostTextLayout,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')
const {
  decideCommittedEraseHole,
  eraseInkKeepingNoteText,
  inkBudgetSliceClearsBitmap,
  noteBudgetSliceCleared,
} = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { applyToolErase } = await server.ssrLoadModule('/src/lib/toolErase.ts')
const { mayWipeLiveInk, mayWipeLiveInkAfterRedraw } = await server.ssrLoadModule('/src/lib/liveInkHandoff.ts')
const { stepInkRepaint, swapInkBuffer } = await server.ssrLoadModule('/src/lib/inkRepaintJob.ts')
const { bindPaperNoteText } = await server.ssrLoadModule('/src/lib/noteTextStay.ts')

const here = dirname(fileURLToPath(import.meta.url))
const ORIGINAL = 'The harbour note keeps every line.'

const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/u).filter(Boolean))
  return {
    contains: (name) => values.has(name),
    add: (...names) => { names.forEach((name) => values.add(name)) },
    remove: (...names) => { names.forEach((name) => values.delete(name)) },
    toggle: (name, force) => {
      const next = force ?? !values.has(name)
      if (next) values.add(name)
      else values.delete(name)
      return next
    },
  }
}

const makeStyle = () => {
  const props = new Map()
  const style = {
    get zoom() { return props.get('zoom') ?? '' },
    set zoom(value) {
      if (value === '' || value == null) props.delete('zoom')
      else props.set('zoom', String(value))
    },
    get transform() { return props.get('transform') ?? '' },
    set transform(value) {
      if (value === '' || value == null) props.delete('transform')
      else props.set('transform', String(value))
    },
    get transformOrigin() { return props.get('transform-origin') ?? '' },
    set transformOrigin(value) {
      if (value === '' || value == null) props.delete('transform-origin')
      else props.set('transform-origin', String(value))
    },
    get willChange() { return props.get('will-change') ?? '' },
    set willChange(value) {
      if (value === '' || value == null) props.delete('will-change')
      else props.set('will-change', String(value))
    },
    setProperty(name, value) {
      if (value === '' || value == null) props.delete(name)
      else props.set(name, String(value))
    },
    removeProperty(name) { props.delete(name); return '' },
    getPropertyValue(name) { return props.get(name) ?? '' },
  }
  return style
}

const makeNode = (className) => {
  const attrs = new Map()
  const node = {
    className,
    classList: makeClassList(className),
    style: makeStyle(),
    parentElement: null,
    children: [],
    isConnected: true,
    textContent: '',
    layoutWidth: 900,
    layoutHeight: 1273,
    contentLeft: 40,
    contentTop: 20,
    scrollTop: 0,
    scrollLeft: 0,
    scrollWidth: 1200,
    scrollHeight: 1800,
    clientWidth: 400,
    clientHeight: 300,
    offsetWidth: 900,
    offsetHeight: 1273,
    getAttribute(name) { return attrs.get(name) ?? null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    matches(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      return wanted.some((name) => name && this.classList.contains(name))
    },
    closest(selector) {
      let current = this
      while (current) {
        if (current.matches(selector)) return current
        current = current.parentElement
      }
      return null
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    querySelectorAll(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, '')).filter(Boolean)
      const found = []
      const visit = (item) => {
        if (wanted.some((name) => item.classList.contains(name))) found.push(item)
        item.children.forEach(visit)
      }
      this.children.forEach(visit)
      return found
    },
    getBoundingClientRect() {
      const isScroller = this.classList.contains('paper-view') || this.classList.contains('unified-note-view')
      const width = isScroller ? this.clientWidth : this.layoutWidth
      const height = isScroller ? this.clientHeight : this.layoutHeight
      const paper = this.closest('.paper-view') ?? this.closest('.unified-note-view')
      const scrollLeft = isScroller ? 0 : (paper?.scrollLeft ?? 0)
      const scrollTop = isScroller ? 0 : (paper?.scrollTop ?? 0)
      return {
        left: this.contentLeft - scrollLeft,
        top: this.contentTop - scrollTop,
        width,
        height,
        right: this.contentLeft - scrollLeft + width,
        bottom: this.contentTop - scrollTop + height,
      }
    },
  }
  return node
}

const append = (parent, child) => {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

const point = (x, y) => ({ x, y, t: 0, pressure: 0.5 })

try {
  const caretSource = readFileSync(join(here, '../src/lib/paperCaretScroll.ts'), 'utf8')
  const cameraSource = readFileSync(join(here, '../src/lib/paperView.ts'), 'utf8')
  const boardSource = readFileSync(join(here, '../src/components/DrawingBoard.tsx'), 'utf8')
  const css = readFileSync(join(here, '../src/styles.css'), 'utf8')
  assert.doesNotMatch(caretSource, /translateZ\(0\)/)
  assert.doesNotMatch(cameraSource, /willChange = 'transform'/)
  assert.match(boardSource, /eraseInkKeepingNoteText\(/)
  assert.match(boardSource, /decideCommittedEraseHole\(/)
  // Since the double-buffered repaint (#1195) a job counts as cleared from its start: the visible
  // bitmap is unsealed until the buffer is swapped in, so an erase never punches into it.
  assert.match(boardSource, /cleared: true/)
  assert.match(boardSource, /budgetCleared: Boolean\(painting\?\.cleared\)/)
  assert.equal(
    boardSource.match(/if \(eraseHole\.seal\) committedBitmapRef\.current = \{ key: contentKey, topPx(?:, provisional: held\?\.provisional)? \}/g)?.length,
    2,
    'both erase seals wait for the hole decision',
  )
  assert.match(css, /\.unified-note-view \{[\s\S]*?will-change:\s*auto;/)
  assert.doesNotMatch(css, /will-change:\s*scroll-position/)

  const scroller = makeNode('paper-view unified-note-view')
  const plane = append(scroller, makeNode('paper-sheet-plane'))
  const paper = append(plane, makeNode('unified-paper'))
  const editor = append(paper, makeNode('markdown-editor'))
  const content = append(editor, makeNode('cm-content'))
  content.textContent = ORIGINAL
  const line = append(content, makeNode('cm-line'))
  line.textContent = ORIGINAL
  bindPaperNoteText(scroller, ORIGINAL)

  const layer = { note: ORIGINAL, anchorX: 120, anchorY: 64, mounted: true }
  const plain = {
    textContent: '',
    style: { visibility: 'hidden', display: 'none' },
    querySelector() { return null },
  }
  const pan = keepPaperTextOnCameraMove(
    layer,
    { kind: 'pan', scrollLeft: 48, scrollTop: 20 },
    { scroller, text: plain },
  )
  assert.equal(pan.note, ORIGINAL)
  assert.equal(pan.signal, 'visible')
  assert.equal(pan.hide, false)
  assert.equal(pan.unmount, false)
  assert.equal(pan.fullClear, false)
  assert.equal(pan.mounted, true)
  assert.ok(Math.abs(pan.anchorX - layer.anchorX) <= GHOST_TEXT_SLIP_PX)
  assert.ok(Math.abs(pan.anchorY - layer.anchorY) <= GHOST_TEXT_SLIP_PX)
  assert.equal(scroller.scrollLeft, 48)
  assert.equal(scroller.scrollTop, 20)
  assert.equal(plain.textContent, ORIGINAL, 'a blanked text node is restored on pan')
  assert.equal(plain.style.visibility, '')
  assert.equal(plain.style.display, '')
  assert.equal(content.textContent, ORIGINAL)
  assert.equal(line.textContent, ORIGINAL, 'pan must not replace editor lines')

  const keptEditor = {
    textContent: '',
    style: { visibility: 'hidden' },
    querySelector(selector) { return selector === '.cm-line' ? line : null },
  }
  keepPaperTextOnCameraMove(layer, { kind: 'pan', scrollLeft: 48, scrollTop: 20 }, { scroller, text: keptEditor })
  assert.equal(keptEditor.textContent, '', 'a live editor is not rewritten through textContent')
  assert.equal(keptEditor.style.visibility, '')
  assert.equal(line.textContent, ORIGINAL)

  const zoom = keepPaperTextOnCameraMove(
    layer,
    { kind: 'zoom', factor: 1.25, originX: 80, originY: 40 },
    { scroller, plane, text: plain },
  )
  assert.equal(zoom.note, ORIGINAL)
  assert.equal(zoom.hide, false)
  assert.equal(zoom.unmount, false)
  assert.equal(zoom.fullClear, false)
  assert.equal(zoom.signal, 'visible')
  assert.ok(Math.abs(zoom.anchorX - layer.anchorX) <= GHOST_TEXT_SLIP_PX)
  assert.ok(Math.abs(zoom.anchorY - layer.anchorY) <= GHOST_TEXT_SLIP_PX)
  assert.notEqual(plane.style.willChange, 'transform')
  assert.equal(plain.textContent, ORIGINAL)
  assert.equal(content.textContent, ORIGINAL)

  const gesture = {
    baseZoom: 1,
    zoom: 1.4,
    rotation: 0,
    origin: { x: 10, y: 12 },
    anchorLocalX: 80,
    anchorLocalY: 40,
  }
  assert.equal(applyPaperZoomGestureFrame(plane, gesture, plain), true)
  assert.notEqual(plane.style.willChange, 'transform')
  assert.equal(plain.textContent, ORIGINAL)
  const settled = applyPaperZoomStayPut(scroller, paper, defaultPaperView(), 1.4, { x: 80, y: 40 })
  assert.equal(settled.zoom, 1.4)
  assert.equal(content.textContent, ORIGINAL)
  assert.equal(line.textContent, ORIGINAL)

  const before = sampleGhostTextLayout({
    paperX: layer.anchorX,
    paperY: layer.anchorY,
    camX: 0,
    camY: 0,
    editorX: 0,
    editorY: 0,
  })
  const afterPan = sampleGhostTextLayout({
    paperX: layer.anchorX,
    paperY: layer.anchorY,
    camX: 48,
    camY: 20,
    editorX: 0,
    editorY: 0,
  })
  const motion = classifyGhostTextMotion(before, afterPan)
  assert.equal(motion.slip, false)
  assert.ok(Math.abs(afterPan.paperX - before.paperX) <= GHOST_TEXT_SLIP_PX)
  assert.ok(Math.abs(afterPan.paperY - before.paperY) <= GHOST_TEXT_SLIP_PX)

  const at = ORIGINAL.indexOf('keeps')
  const edited = commitEditorTextInsert(ORIGINAL, at, at, 'still ')
  assert.equal(edited.prefix, ORIGINAL.slice(0, at))
  assert.equal(edited.suffix, ORIGINAL.slice(at))
  assert.equal(edited.note, `${edited.prefix}still ${edited.suffix}`)
  assert.equal(edited.hide, false)
  assert.equal(edited.fullClear, false)
  assert.equal(edited.unmount, false)
  assert.ok(edited.note.startsWith(edited.prefix))
  assert.ok(edited.note.endsWith(edited.suffix))

  const pageW = 900
  const pageH = 1273
  const stroke = {
    points: [point(0.2, 0.3), point(0.4, 0.3)],
    baseWidth: 4,
  }
  const other = {
    points: [point(0.7, 0.6), point(0.8, 0.6)],
    baseWidth: 4,
  }
  const ink = [stroke, other]
  const erasedInk = applyToolErase(ink, [{ x: 0.3, y: 0.3 }], 16, pageW, pageH)
  assert.notEqual(erasedInk, ink)
  const erased = eraseInkKeepingNoteText(edited.note, ink, erasedInk, pageW, pageH, () => 6)
  assert.equal(erased.note, edited.note)
  assert.equal(erased.fullClear, false)
  assert.equal(erased.hide, false)
  assert.equal(erased.unmount, false)
  assert.equal(erased.signal, 'visible')
  assert.ok(erased.patch, 'erase still punches only the ink that left')
  assert.equal(erased.note, `${ORIGINAL.slice(0, at)}still ${ORIGINAL.slice(at)}`)

  assert.equal(inkBudgetSliceClearsBitmap(0), true)
  assert.equal(inkBudgetSliceClearsBitmap(12), false)
  let budgetCleared = noteBudgetSliceCleared(false, 0)
  assert.equal(budgetCleared, true, 'the first budget slice clearRect\'s the page')
  const midBudget = decideCommittedEraseHole({
    patchMatchesStrokes: true,
    held: true,
    keyMatches: true,
    topMatches: true,
    resized: false,
    activeStroke: false,
    budgetCleared,
  })
  assert.equal(midBudget.punch, false)
  assert.equal(midBudget.seal, false, 'a mid-budget erase must not seal the cleared bitmap')
  budgetCleared = noteBudgetSliceCleared(budgetCleared, 12)
  assert.equal(budgetCleared, true, 'a later slice does not forget the clear')
  const stillOpen = decideCommittedEraseHole({
    patchMatchesStrokes: true,
    held: true,
    keyMatches: true,
    topMatches: true,
    resized: false,
    activeStroke: false,
    budgetCleared,
  })
  assert.equal(stillOpen.seal, false, 'the open job still must not seal')
  const intact = decideCommittedEraseHole({
    patchMatchesStrokes: true,
    held: true,
    keyMatches: true,
    topMatches: true,
    resized: false,
    activeStroke: false,
    budgetCleared: noteBudgetSliceCleared(false, 12),
  })
  assert.equal(intact.punch, true, 'an intact bitmap still punches only the erased ink')
  assert.equal(intact.seal, true)

  // Heavy-page repaint, frame by frame: the visible committed bitmap shows the old page until the
  // finished page replaces it in one copy, also when the pixel size changes (zoom, DPR, window
  // resize, page grow). A resize up front blanks it for the whole job; a failed or cancelled job
  // never puts a partial page on screen.
  {
    const makeVisible = (width, height, content) => {
      const state = { width, height, content, mode: 'source-over' }
      const canvas = {
        get width() { return state.width },
        set width(value) { state.width = value; state.content = 'blank' },
        get height() { return state.height },
        set height(value) { state.height = value; state.content = 'blank' },
        get content() { return state.content },
        getContext: () => ({
          save() {},
          restore() { state.mode = 'source-over' },
          setTransform() {},
          drawImage(image) { state.content = image.content },
          set globalAlpha(_value) {},
          get globalAlpha() { return 1 },
          set globalCompositeOperation(value) { state.mode = value },
          get globalCompositeOperation() { return state.mode },
        }),
      }
      return canvas
    }
    // One scenario: a visible canvas with the old page, a job painting `total` strokes into a page
    // of `target` size. Returns what the visible canvas shows after every task (frame).
    const heavyRepaint = ({ total = 9, perSlice = 3, target, resizeUpFront = false, failAt = -1, cancelAfter = -1 }) => {
      const visible = makeVisible(100, 50, 'old page')
      if (resizeUpFront) { visible.width = target.width; visible.height = target.height }
      const buffer = { width: target.width, height: target.height, content: 'blank', painted: 0 }
      const strokes = Array.from({ length: total }, () => ({}))
      const job = { key: 'k', strokes, frame: 0, buffer, width: target.width, height: target.height, coverage: null }
      let current = job
      let dirty = false
      const queue = []
      const seen = []
      const record = () => seen.push(`${visible.width}x${visible.height} ${visible.content}`)
      const host = {
        isCurrent: (running) => current === running,
        strokes: () => strokes,
        size: () => target,
        dirty: () => dirty,
        paint: (running, from) => {
          if (from === failAt) return { next: from, coverage: null, failed: true }
          const next = Math.min(from + perSlice, running.strokes.length)
          buffer.painted = next
          buffer.content = next >= running.strokes.length ? 'new page' : `partial ${next}/${running.strokes.length}`
          return { next, coverage: null }
        },
        swap: (running) => swapInkBuffer(visible, running.buffer),
        schedule: (run) => { queue.push(run); return queue.length },
        finished: () => { current = null },
        dropped: () => { current = null },
        failed: () => { current = null },
      }
      record() // frame before the job
      stepInkRepaint(job, 0, host)
      record()
      for (let frame = 0; queue.length && frame < 50; frame += 1) {
        if (frame === cancelAfter) current = null // another repaint took over
        queue.shift()()
        record()
      }
      return { seen, visible }
    }
    const zoom = { width: 200, height: 100 }
    const zoomed = heavyRepaint({ target: zoom })
    assert.ok(zoomed.seen.slice(0, -1).every((frame) => frame === '100x50 old page'), 'the old page stays on screen, not blank, for the whole job')
    assert.equal(zoomed.seen.at(-1), '200x100 new page', 'the swap resizes and fills the visible canvas in the same task')
    assert.ok(!zoomed.seen.some((frame) => /blank|partial/.test(frame)), 'no blank or half painted frame')
    const blanked = heavyRepaint({ target: zoom, resizeUpFront: true })
    assert.ok(blanked.seen.slice(1, -1).every((frame) => frame === '200x100 blank'), 'sanity: the old order (resize before the job) is a blank page until the swap')

    const sameSize = heavyRepaint({ target: { width: 100, height: 50 } })
    assert.ok(sameSize.seen.slice(0, -1).every((frame) => frame === '100x50 old page'))
    assert.equal(sameSize.seen.at(-1), '100x50 new page')

    const failing = heavyRepaint({ target: zoom, failAt: 3 })
    assert.ok(failing.seen.every((frame) => frame === '100x50 old page'), 'a failed job leaves the old page; no partial page is swapped in')
    const cancelled = heavyRepaint({ target: zoom, cancelAfter: 1 })
    assert.ok(cancelled.seen.every((frame) => frame === '100x50 old page'), 'a cancelled job never shows its half page')

    // The live stroke on a page that is being repainted: pen-up keeps it (the direct commit is
    // refused while a job runs), every redraw before the swap keeps it, the swap wipes it. Never a
    // frame without the stroke, and never both layers drawing it once the page is swapped in.
    const penUpFrames = ({ guardRedraw }) => {
      const swapFrame = 3
      let live = true
      const seen = []
      for (let frame = 0; frame < 6; frame += 1) {
        const jobRunning = frame < swapFrame
        if (frame === 0 && mayWipeLiveInk({ committedHasStroke: false, committedPaintRunning: jobRunning })) live = false
        // The microtask redraw after pen-up, and every redraw until the swap.
        const redrawMayWipe = guardRedraw ? mayWipeLiveInkAfterRedraw({ committedPaintRunning: jobRunning }) : true
        if (frame < swapFrame && redrawMayWipe) live = false
        const swapped = frame >= swapFrame
        if (swapped) live = false // the swap wipes the live copy in the same task
        seen.push(live || swapped)
      }
      return seen
    }
    assert.deepEqual(penUpFrames({ guardRedraw: true }), [true, true, true, true, true, true], 'the stroke is on screen in every frame of a heavy repaint')
    assert.deepEqual(penUpFrames({ guardRedraw: false }).slice(0, 3), [false, false, false], 'sanity: an unguarded redraw wipes the only copy of the stroke until the swap')
  }

  const beforeRefresh = plane.style.transform
  const generation = forcePaperCompositorRefresh(scroller)
  assert.ok(generation > 0)
  assert.equal(plane.style.transform, beforeRefresh)
  assert.notEqual(plane.style.transform, 'translateZ(0)')
  assert.equal(content.textContent, ORIGINAL)

  console.log('text-flicker ok')
} finally {
  await server.close()
}
