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

const makeNode = (className, extras = {}) => {
  const node = {
    className,
    classList: makeClassList(className),
    style: makeStyle(),
    parentElement: extras.parentElement ?? null,
    children: [],
    layoutWidth: extras.layoutWidth ?? 900,
    layoutHeight: extras.layoutHeight ?? 1273,
    contentLeft: extras.contentLeft ?? 40,
    contentTop: extras.contentTop ?? 20,
    scrollLeft: 0,
    scrollTop: 0,
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
      const scroller = this.closest('.paper-view') ?? this
      return {
        left: this.contentLeft - (scroller.scrollLeft ?? 0),
        top: this.contentTop - (scroller.scrollTop ?? 0),
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
    const offset = sheetLayerOriginOffset(editor, ruling)
    assert.equal(readUsedSheetZoom(plane), zoom)
    assert.equal(readUsedSheetZoom(ruling), zoom)
    assert.equal(readUsedSheetZoom(editor), zoom)
    assert.equal(readUsedSheetZoom(ink), zoom)
    assert.equal(editor.style.zoom, '', 'editor must not specify its own zoom')
    assert.equal(ruling.style.zoom, '', 'ruling must not specify its own zoom')
    assert.equal(ink.style.zoom, '', 'ink must not specify its own zoom')
    assert.equal(editor.style.transform, '', 'editor must not specify its own transform')
    assert.ok(Math.abs(offset.x) <= 1, `text-vs-ruling X ${offset.x} must stay within 1px at ${zoom}×`)
    assert.ok(Math.abs(offset.y) <= 1, `text-vs-ruling Y ${offset.y} must stay within 1px at ${zoom}×`)
    return { zoom, offset, plane: readUsedSheetZoom(plane), editor: readUsedSheetZoom(editor) }
  }

  const atOne = measure(1)
  const atTwo = measure(2)
  console.log(JSON.stringify({ atOne, atTwo }))
  console.log('paper-lock ok')
} finally {
  await server.close()
}
