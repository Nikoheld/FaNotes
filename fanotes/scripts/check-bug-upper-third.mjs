import assert from 'node:assert/strict'
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
  WRITE_SLACK_HEIGHT,
  applyLiveHandwritingGrow,
  liveGrowScale,
  neededWriteExtent,
  paintedBoxIsUsable,
  paperPixelY,
  pendingGrowScale,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const {
  applyPaperViewToElements,
  defaultPaperView,
  readUsedSheetZoom,
  sheetLayerOriginOffset,
} = await server.ssrLoadModule('/src/lib/paperView.ts')

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
  return {
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
    removeProperty(name) {
      props.delete(name)
      return ''
    },
    getPropertyValue(name) {
      return props.get(name) ?? ''
    },
  }
}

const makeNode = (className, box = {}) => {
  const style = makeStyle()
  const node = {
    className,
    classList: makeClassList(className),
    style,
    children: [],
    parentElement: null,
    matches(selector) {
      const names = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      return names.some((name) => this.classList.contains(name))
    },
    closest(selector) {
      let current = this
      while (current) {
        if (current.matches(selector)) return current
        current = current.parentElement
      }
      return null
    },
    offsetWidth: box.layoutWidth ?? 900,
    offsetHeight: box.layoutHeight ?? 1273,
    clientWidth: box.clientWidth ?? box.layoutWidth ?? 900,
    clientHeight: box.clientHeight ?? box.layoutHeight ?? 1273,
    scrollLeft: 0,
    scrollTop: 0,
    querySelector(selector) {
      return this.children.find((child) => child.classList.contains(selector.replace(/^\./u, ''))) ?? null
    },
    querySelectorAll(selector) {
      const names = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      const found = []
      const walk = (el) => {
        if (names.some((name) => el.classList.contains(name))) found.push(el)
        el.children.forEach(walk)
      }
      this.children.forEach(walk)
      return found
    },
    getBoundingClientRect() {
      return {
        left: 40,
        top: 20,
        width: this.offsetWidth,
        height: this.offsetHeight,
      }
    },
  }
  return node
}

try {
  const reportY = 0.31
  const a4 = PAPER_SOURCE_HEIGHT
  const start = { x: 0.42, y: reportY }
  const visualY = paperPixelY(reportY, a4)

  assert.equal(
    neededWriteExtent(reportY, a4, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT),
    a4,
    'report y≈0.30 on A4 must not grow the page',
  )
  assert.equal(liveGrowScale(0, a4), 1, 'a missing painted box must not scale')
  assert.equal(liveGrowScale(Number.NaN, a4), 1)
  assert.equal(paintedBoxIsUsable(0), false)
  assert.equal(paintedBoxIsUsable(a4), true)

  const zeroBox = applyLiveHandwritingGrow(
    start,
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: a4, layoutW: 0, layoutH: 0 },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: a4, layoutW: 900, layoutH: a4 },
  )
  assert.equal(zeroBox.remapped, false, 'zero painted box must not remap 0–1 Y')
  assert.equal(zeroBox.y, reportY)
  assert.ok(Math.abs(zeroBox.nextPixelY - visualY) <= 1, `zero-box painted Y ${zeroBox.nextPixelY} must stay ${visualY}`)
  assert.ok(zeroBox.y > 0.2, 'must not slam the report point toward y≈0')

  const sameBox = applyLiveHandwritingGrow(
    start,
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: a4, layoutW: 900, layoutH: a4 },
    { sourceW: PAPER_SOURCE_WIDTH, sourceH: a4, layoutW: 900, layoutH: a4 },
  )
  assert.equal(sameBox.remapped, false)
  assert.equal(sameBox.y, reportY)
  assert.ok(Math.abs(sameBox.nextPixelY - visualY) <= 1)

  const pendingZero = pendingGrowScale({
    prevH: a4,
    nextH: a4,
    prevW: PAPER_SOURCE_WIDTH,
    nextW: PAPER_SOURCE_WIDTH,
    prevLayoutH: 0,
    prevLayoutW: 0,
  }, 900, a4)
  assert.equal(pendingZero.ready, false, 'flush from a 0 painted box must not scale')
  assert.equal(pendingZero.discard, true)
  assert.equal(pendingZero.scaleY, 1)

  const pendingSame = pendingGrowScale({
    prevH: a4,
    nextH: a4 + 638,
    prevW: PAPER_SOURCE_WIDTH,
    nextW: PAPER_SOURCE_WIDTH,
    prevLayoutH: a4,
    prevLayoutW: 900,
  }, 900, a4)
  assert.equal(pendingSame.ready, false, 'stale/same painted box after a source change must not scale')
  assert.equal(pendingSame.scaleY, 1)

  const noteView = makeNode('paper-view unified-note-view')
  const plane = makeNode('paper-sheet-plane', { layoutWidth: 900, layoutHeight: a4 })
  const paper = makeNode('unified-paper', { layoutWidth: 900, layoutHeight: a4 })
  const ruling = makeNode('paper-ruling', { layoutWidth: 900, layoutHeight: a4 })
  const editor = makeNode('editor-pane markdown-editor', { layoutWidth: 900, layoutHeight: 400 })
  plane.children.push(paper)
  paper.children.push(ruling, editor)
  paper.parentElement = plane
  noteView.children.push(plane)
  applyPaperViewToElements(paper, noteView, defaultPaperView())
  assert.equal(readUsedSheetZoom(plane), 1)
  assert.equal(readUsedSheetZoom(editor), 1)
  assert.equal(editor.style.zoom, '')
  const offset = sheetLayerOriginOffset(editor, ruling)
  assert.ok(Math.abs(offset.x) <= 1)
  assert.ok(Math.abs(offset.y) <= 1)

  console.log(JSON.stringify({
    reportY,
    visualY,
    extent: a4,
    zeroBoxY: zeroBox.y,
    zeroPainted: zeroBox.nextPixelY,
    pendingDiscard: pendingZero.discard,
    editorZoom: editor.style.zoom,
    offset,
  }))
  console.log('bug-upper-third ok')
} finally {
  await server.close()
}
