import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  applyPaperViewToElements,
  capturePaperAnchor,
  clampViewZoom,
  defaultPaperView,
  readUsedSheetZoom,
  restorePaperAnchor,
  zoomAroundPoint,
  zoomFactorFromWheel,
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
    toString: () => [...values].join(' '),
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
    removeProperty(name) {
      props.delete(name)
      return ''
    },
    getPropertyValue(name) {
      return props.get(name) ?? ''
    },
  }
  return style
}

const tokenSet = (selector) => new Set(
  String(selector)
    .split(',')
    .map((part) => part.trim().replace(/^\./u, ''))
    .filter(Boolean),
)

const makeNode = (className, extras = {}) => {
  const node = {
    className,
    classList: makeClassList(className),
    style: makeStyle(),
    parentElement: extras.parentElement ?? null,
    children: [],
    layoutWidth: extras.layoutWidth ?? 200,
    layoutHeight: extras.layoutHeight ?? 200,
    contentLeft: extras.contentLeft ?? 0,
    contentTop: extras.contentTop ?? 0,
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: extras.clientWidth ?? extras.layoutWidth ?? 200,
    clientHeight: extras.clientHeight ?? extras.layoutHeight ?? 200,
    matches(selector) {
      return [...tokenSet(selector)].some((name) => this.classList.contains(name))
    },
    closest(selector) {
      let current = this
      while (current) {
        if (current.matches(selector)) return current
        current = current.parentElement
      }
      return null
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    },
    querySelectorAll(selector) {
      const wanted = tokenSet(selector)
      const found = []
      const visit = (item) => {
        if ([...wanted].some((name) => item.classList.contains(name))) found.push(item)
        item.children.forEach(visit)
      }
      this.children.forEach(visit)
      return found
    },
    getBoundingClientRect() {
      const zoom = this.classList.contains('paper-view') ? 1 : readUsedSheetZoom(this)
      const scroller = this.closest('.paper-view') ?? this
      // CSS zoom grows width/height from the unzoomed top-left.
      const left = this.contentLeft - (scroller.scrollLeft ?? 0)
      const top = this.contentTop - (scroller.scrollTop ?? 0)
      const width = this.layoutWidth * zoom
      const height = this.layoutHeight * zoom
      return { left, top, width, height, right: left + width, bottom: top + height }
    },
    get offsetWidth() { return this.layoutWidth },
    get scrollWidth() {
      return Math.max(this.clientWidth, this.children[0] ? this.children[0].layoutWidth * readUsedSheetZoom(this.children[0]) : this.layoutWidth)
    },
    get scrollHeight() {
      return Math.max(this.clientHeight, this.children[0] ? this.children[0].layoutHeight * readUsedSheetZoom(this.children[0]) : this.layoutHeight)
    },
  }
  return node
}

const append = (parent, child) => {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

const math = () => {
  const zoomIn = zoomFactorFromWheel(-120, 0, 5)
  const zoomOut = zoomFactorFromWheel(120, 0, 5)
  assert.ok(zoomIn > 1, `Ctrl+wheel up must zoom in, got ${zoomIn}`)
  assert.ok(zoomOut < 1, `Ctrl+wheel down must zoom out, got ${zoomOut}`)
  const first = clampViewZoom(1 * zoomIn)
  const second = clampViewZoom(1 * zoomIn)
  assert.equal(first, second, 'the same wheel input must yield the same next zoom')
  const view = defaultPaperView()
  const around = zoomAroundPoint(view, first)
  const aroundAgain = zoomAroundPoint(view, first)
  assert.equal(around.zoom, first)
  assert.deepEqual(around, aroundAgain)
  assert.ok(around.zoom > 1)

  const scroller = makeNode('paper-view', { layoutWidth: 400, layoutHeight: 400, clientWidth: 400, clientHeight: 400 })
  const plane = append(scroller, makeNode('paper-sheet-plane', {
    layoutWidth: 200,
    layoutHeight: 200,
    contentLeft: 100,
    contentTop: 100,
  }))
  const origin = { x: 200, y: 200 }
  const before = defaultPaperView()
  const anchor = capturePaperAnchor(scroller, plane, origin)
  assert.ok(Math.abs(anchor.relX - 0.5) < 0.02, `anchor relX should be paper center, got ${anchor.relX}`)
  assert.ok(Math.abs(anchor.relY - 0.5) < 0.02, `anchor relY should be paper center, got ${anchor.relY}`)
  applyPaperViewToElements(plane, scroller, zoomAroundPoint(before, 2))
  restorePaperAnchor(scroller, plane, anchor)
  const after = plane.getBoundingClientRect()
  const mappedX = after.left + anchor.relX * after.width
  const mappedY = after.top + anchor.relY * after.height
  assert.ok(Math.abs(mappedX - origin.x) <= 1, `restored X ${mappedX} should stay on cursor ${origin.x}`)
  assert.ok(Math.abs(mappedY - origin.y) <= 1, `restored Y ${mappedY} should stay on cursor ${origin.y}`)
  return {
    zoomIn,
    first,
    second,
    mappedX,
    mappedY,
    origin,
    scrollLeft: scroller.scrollLeft,
    scrollTop: scroller.scrollTop,
  }
}

const layers = () => {
  const noteView = makeNode('paper-view unified-note-view')
  const plane = append(noteView, makeNode('paper-sheet-plane', { layoutWidth: 900, layoutHeight: 1273 }))
  const paper = append(plane, makeNode('unified-paper', { layoutWidth: 900, layoutHeight: 1273 }))
  const ruling = append(paper, makeNode('paper-ruling', { layoutWidth: 900, layoutHeight: 1273 }))
  ruling.style.setProperty('background-size', '28px 28px')
  const editor = append(paper, makeNode('editor-pane', { layoutWidth: 900, layoutHeight: 400 }))
  editor.style.zoom = '1'
  const ink = append(paper, makeNode('lw-drawing-board lw-canvas-surface', { layoutWidth: 900, layoutHeight: 1273 }))
  ink.style.zoom = '1'

  applyPaperViewToElements(paper, noteView, defaultPaperView())
  const atOne = {
    plane: readUsedSheetZoom(plane),
    ruling: readUsedSheetZoom(ruling),
    editor: readUsedSheetZoom(editor),
    ink: readUsedSheetZoom(ink),
    planeInline: plane.style.zoom,
    editorInline: editor.style.zoom,
    rulingInline: ruling.style.zoom,
    inkInline: ink.style.zoom,
  }
  assert.equal(atOne.plane, 1)
  assert.equal(atOne.ruling, 1)
  assert.equal(atOne.editor, 1)
  assert.equal(atOne.ink, 1)
  assert.equal(atOne.editorInline, '', 'leftover editor zoom:1 must be stripped at 1×')
  assert.equal(atOne.inkInline, '', 'leftover ink zoom:1 must be stripped at 1×')

  applyPaperViewToElements(paper, noteView, { zoom: 2, rotation: 0, pan: { x: 0, y: 0 } })
  const atTwo = {
    plane: readUsedSheetZoom(plane),
    ruling: readUsedSheetZoom(ruling),
    editor: readUsedSheetZoom(editor),
    ink: readUsedSheetZoom(ink),
    planeInline: plane.style.zoom,
    editorInline: editor.style.zoom,
    rulingInline: ruling.style.zoom,
    inkInline: ink.style.zoom,
    rulingBackground: ruling.style.getPropertyValue('background-size'),
  }
  assert.equal(atTwo.planeInline, '2')
  assert.equal(atTwo.editorInline, '', 'editor must inherit the camera, not specify its own zoom')
  assert.equal(atTwo.rulingInline, '', 'ruling must inherit the camera, not specify its own zoom')
  assert.equal(atTwo.inkInline, '', 'ink must inherit the camera, not specify its own zoom')
  assert.equal(atTwo.plane, 2)
  assert.equal(atTwo.ruling, atTwo.plane)
  assert.equal(atTwo.editor, atTwo.plane)
  assert.equal(atTwo.ink, atTwo.plane)
  assert.notEqual(atTwo.ruling, 1, 'ruling must not stay at 1× while the plane is 2×')
  assert.notEqual(atTwo.editor, 1, 'text must not stay at 1× while the plane is 2×')
  const relative = Math.max(
    Math.abs(atTwo.ruling - atTwo.editor) / atTwo.plane,
    Math.abs(atTwo.ink - atTwo.editor) / atTwo.plane,
  )
  assert.ok(relative < 0.01, `layer zooms must match, relative error ${relative}`)
  return { atOne, atTwo, relative }
}

try {
  const mathResult = math()
  const layerResult = layers()
  console.log('paper-zoom math', JSON.stringify(mathResult))
  console.log('paper-zoom layers', JSON.stringify(layerResult))
  console.log('paper-zoom ok')
} finally {
  await server.close()
}
