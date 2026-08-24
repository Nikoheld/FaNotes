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
  applyPaperZoomStayPut,
  defaultPaperView,
  sheetLayerOriginOffset,
} = await server.ssrLoadModule('/src/lib/paperView.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const tokenSet = (selector) => new Set(String(selector).split(',').map((part) => part.trim().replace(/^\./u, '')).filter(Boolean))

const makeStyle = () => {
  const props = new Map()
  return {
    get zoom() { return props.get('zoom') ?? '' },
    set zoom(value) {
      if (value === '' || value == null) props.delete('zoom')
      else props.set('zoom', String(value))
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
    scrollLeft: extras.scrollLeft ?? 0,
    scrollTop: extras.scrollTop ?? 0,
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
      const scroller = this.closest('.paper-view') ?? this
      const plane = this.closest('.paper-sheet-plane') ?? this
      const zoom = plane.classList.contains('paper-view') ? 1 : Number.parseFloat(plane.style.zoom || plane.style.getPropertyValue('--view-zoom') || '1') || 1
      const planeLeft = plane.contentLeft - (scroller.scrollLeft ?? 0)
      const planeTop = plane.contentTop - (scroller.scrollTop ?? 0)
      if (this === scroller) {
        return {
          left: 0,
          top: 0,
          width: this.clientWidth,
          height: this.clientHeight,
          right: this.clientWidth,
          bottom: this.clientHeight,
        }
      }
      const left = planeLeft + (this.contentLeft - plane.contentLeft) * zoom
      const top = planeTop + (this.contentTop - plane.contentTop) * zoom
      const width = this.layoutWidth * zoom
      const height = this.layoutHeight * zoom
      return { left, top, width, height, right: left + width, bottom: top + height }
    },
    get offsetWidth() { return this.layoutWidth },
    get offsetHeight() { return this.layoutHeight },
    get scrollWidth() {
      return Math.max(this.clientWidth, this.layoutWidth)
    },
    get scrollHeight() {
      return Math.max(this.clientHeight, this.layoutHeight)
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
  const paper = makeNode('paper-view unified-note-view', {
    clientWidth: 400,
    clientHeight: 300,
    layoutWidth: 400,
    layoutHeight: 300,
  })
  const plane = append(paper, makeNode('paper-sheet-plane', {
    layoutWidth: 1200,
    layoutHeight: 2000,
    contentLeft: 0,
    contentTop: 0,
  }))
  const ruling = append(plane, makeNode('paper-ruling', {
    layoutWidth: 1200,
    layoutHeight: 2000,
    contentLeft: 0,
    contentTop: 0,
  }))
  const sheet = append(plane, makeNode('unified-paper', {
    layoutWidth: 1200,
    layoutHeight: 2000,
    contentLeft: 0,
    contentTop: 0,
  }))
  const editor = append(sheet, makeNode('editor-pane markdown-editor paper-mode', {
    layoutWidth: 900,
    layoutHeight: 1600,
    contentLeft: 0,
    contentTop: 0,
  }))
  const cmScroller = append(editor, makeNode('cm-scroller', {
    layoutWidth: 900,
    layoutHeight: 1600,
    contentLeft: 0,
    contentTop: 0,
  }))
  const ink = append(sheet, makeNode('lw-drawing-board lw-canvas-surface', {
    layoutWidth: 1200,
    layoutHeight: 2000,
    contentLeft: 0,
    contentTop: 0,
  }))
  const mark = append(sheet, makeNode('written-mark', {
    layoutWidth: 8,
    layoutHeight: 8,
    contentLeft: 180,
    contentTop: 220,
  }))

  const beforeOrigin = sheetLayerOriginOffset(editor, ruling)
  assert.ok(Math.abs(beforeOrigin.x) <= 1 && Math.abs(beforeOrigin.y) <= 1, 'text starts on the ruling')
  const inkBefore = sheetLayerOriginOffset(ink, ruling)
  assert.ok(Math.abs(inkBefore.x) <= 1 && Math.abs(inkBefore.y) <= 1, 'ink starts on the ruling')

  const start = mark.getBoundingClientRect()
  const origin = { x: start.left + start.width / 2, y: start.top + start.height / 2 }
  assert.ok(origin.x !== 200 || origin.y !== 150, 'written mark must be off the viewport center')

  const burst = [1.5, 2.2, 3.25]
  let view = defaultPaperView()
  const afterSteps = []
  for (const [index, zoom] of burst.entries()) {
    cmScroller.scrollTop = 48 + index * 6
    cmScroller.scrollLeft = 12
    editor.scrollTop = 24 + index * 3
    editor.scrollLeft = 9
    const result = applyPaperZoomStayPut(paper, plane, view, zoom, origin)
    view = result.view
    assert.equal(view.zoom, zoom, `camera zoom must become ${zoom}`)
    assert.equal(cmScroller.scrollTop, 0, `zoom ${zoom}: cm-scroller must stay at 0`)
    assert.equal(cmScroller.scrollLeft, 0, `zoom ${zoom}: cm-scroller x must stay at 0`)
    assert.equal(editor.scrollTop, 0, `zoom ${zoom}: editor layer must stay at 0`)
    assert.equal(editor.scrollLeft, 0, `zoom ${zoom}: editor layer x must stay at 0`)
    const now = mark.getBoundingClientRect()
    const mappedX = now.left + now.width / 2
    const mappedY = now.top + now.height / 2
    assert.ok(Math.abs(mappedX - origin.x) <= 1, `zoom ${zoom}: written X ${mappedX} left origin ${origin.x}`)
    assert.ok(Math.abs(mappedY - origin.y) <= 1, `zoom ${zoom}: written Y ${mappedY} left origin ${origin.y}`)
    const textOrigin = sheetLayerOriginOffset(editor, ruling)
    const inkOrigin = sheetLayerOriginOffset(ink, ruling)
    assert.ok(Math.abs(textOrigin.x) <= 1, `zoom ${zoom}: text-vs-ruling x ${textOrigin.x}`)
    assert.ok(Math.abs(textOrigin.y) <= 1, `zoom ${zoom}: text-vs-ruling y ${textOrigin.y}`)
    assert.ok(Math.abs(inkOrigin.x) <= 1, `zoom ${zoom}: ink-vs-ruling x ${inkOrigin.x}`)
    assert.ok(Math.abs(inkOrigin.y) <= 1, `zoom ${zoom}: ink-vs-ruling y ${inkOrigin.y}`)
    afterSteps.push({ zoom, mappedX, mappedY, textOrigin, inkOrigin })
  }

  const editorSource = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
  const drawing = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(editorSource, /applyPaperZoomStayPut/)
  assert.match(drawing, /applyPaperZoomStayPut/)
  assert.match(editorSource, /lastZoomOriginRef/)

  return { burst, afterSteps, origin }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first.burst, second.burst)
  assert.deepEqual(first.afterSteps, second.afterSteps)
  console.log(JSON.stringify({ burst: first.burst, last: first.afterSteps.at(-1), origin: first.origin }))
  console.log('zoom-stay-put ok')
} finally {
  await server.close()
}
