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
  readUsedSheetZoom,
  sheetLayerOriginOffset,
} = await server.ssrLoadModule('/src/lib/paperView.ts')
const {
  PAPER_SOURCE_HEIGHT,
  PAGE_GROW_STEP_HEIGHT,
  WRITE_SLACK_HEIGHT,
  applyLiveHandwritingGrow,
  neededWriteExtent,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

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
    setProperty(name, value) {
      if (value === '' || value == null) props.delete(name)
      else props.set(name, String(value))
    },
    removeProperty(name) { props.delete(name); return '' },
    getPropertyValue(name) { return props.get(name) ?? '' },
  }
}

const tokenSet = (selector) => new Set(String(selector).split(',').map((part) => part.trim().replace(/^\./u, '')).filter(Boolean))

const makeNode = (className) => {
  const node = {
    className,
    classList: makeClassList(className),
    style: makeStyle(),
    parentElement: null,
    children: [],
    layoutWidth: 900,
    layoutHeight: 1273,
    contentLeft: 40,
    contentTop: 20,
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
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
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
      return {
        left: this.contentLeft,
        top: this.contentTop,
        width: this.layoutWidth * zoom,
        height: this.layoutHeight * zoom,
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

try {
  const noteView = makeNode('paper-view unified-note-view')
  const plane = append(noteView, makeNode('paper-sheet-plane'))
  const paper = append(plane, makeNode('unified-paper'))
  const ruling = append(paper, makeNode('paper-ruling'))
  const editor = append(paper, makeNode('editor-pane markdown-editor'))
  const ink = append(paper, makeNode('lw-drawing-board lw-canvas-surface'))
  editor.style.zoom = '1'
  ink.style.transform = 'scale(1)'

  const measure = (zoom) => {
    applyPaperViewToElements(paper, noteView, { zoom, rotation: 0, pan: { x: 0, y: 0 } })
    return {
      zoom,
      plane: readUsedSheetZoom(plane),
      ruling: readUsedSheetZoom(ruling),
      editor: readUsedSheetZoom(editor),
      ink: readUsedSheetZoom(ink),
      editorZoom: editor.style.zoom,
      editorTransform: editor.style.transform,
      offset: sheetLayerOriginOffset(editor, ruling),
    }
  }

  const nextH = neededWriteExtent(0.55, PAPER_SOURCE_HEIGHT, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  applyLiveHandwritingGrow(
    { x: 0.2, y: 0.55 },
    { sourceW: 900, sourceH: PAPER_SOURCE_HEIGHT, layoutW: 900, layoutH: 1273 },
    { sourceW: 900, sourceH: nextH, layoutW: 900, layoutH: 1911 },
  )

  for (const zoom of [1, 2]) {
    const before = measure(zoom)
    paper.layoutHeight = 1911
    const after = measure(zoom)
    assert.equal(after.plane, zoom)
    assert.equal(after.ruling, zoom)
    assert.equal(after.editor, zoom)
    assert.equal(after.ink, zoom)
    assert.equal(after.editorZoom, '', 'typed text must not pick up its own zoom after grow')
    assert.equal(after.editorTransform, '')
    assert.ok(Math.abs(after.offset.x) <= 1)
    assert.ok(Math.abs(after.offset.y) <= 1)
    assert.equal(after.plane, before.plane, 'grow must not change the paper camera')
  }

  console.log(JSON.stringify({ atOne: measure(1), atTwo: measure(2) }))
  console.log('text-stay-put ok')
} finally {
  await server.close()
}
