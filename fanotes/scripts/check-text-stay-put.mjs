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
  keepCaretVisibleInPaperScroller,
  lockPaperEditorLayerScroll,
  lockPaperEditorScrollBurst,
  lockPaperEditorScrollIfNeeded,
  lockPaperViewportEditorScroll,
  lockPaperViewportScrollBurst,
  PAPER_EDITOR_FLING_HOLD_FRAMES,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')
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
    scrollTop: 0,
    scrollLeft: 0,
    clientWidth: 400,
    clientHeight: 300,
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
      const paper = this.closest('.paper-view') ?? this.closest('.unified-note-view')
      const isScroller = this.classList.contains('paper-view') || this.classList.contains('unified-note-view')
      const paperScroll = paper && paper !== this ? (paper.scrollTop ?? 0) : 0
      const ownScroll = (
        this.classList.contains('cm-scroller')
        || this.classList.contains('markdown-editor')
        || this.classList.contains('editor-pane')
        || this.classList.contains('cm-editor')
      ) ? (this.scrollTop ?? 0) : 0
      const width = isScroller ? this.clientWidth : this.layoutWidth * zoom
      const height = isScroller ? this.clientHeight : this.layoutHeight * zoom
      return {
        left: this.contentLeft - (isScroller ? 0 : (paper?.scrollLeft ?? 0)),
        top: this.contentTop - paperScroll - ownScroll,
        width,
        height,
        right: this.contentLeft - (isScroller ? 0 : (paper?.scrollLeft ?? 0)) + width,
        bottom: this.contentTop - paperScroll - ownScroll + height,
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
  const pane = append(paper, makeNode('editor-pane'))
  const editor = append(pane, makeNode('markdown-editor paper-mode'))
  const cmScroller = append(editor, makeNode('cm-scroller'))
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

  const nextH = neededWriteExtent(0.94, PAPER_SOURCE_HEIGHT, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT)
  assert.ok(nextH > PAPER_SOURCE_HEIGHT, 'bottom-edge writing must grow the sheet')
  const mark = { x: 0.2, y: 0.94 }
  const visualY = mark.y * 1273
  const grown = applyLiveHandwritingGrow(
    mark,
    { sourceW: 900, sourceH: PAPER_SOURCE_HEIGHT, layoutW: 900, layoutH: 1273 },
    { sourceW: 900, sourceH: nextH, layoutW: 900, layoutH: nextH },
  )
  assert.equal(grown.remapped, true)
  assert.ok(Math.abs(grown.nextPixelY - visualY) <= 1, `painted Y ${grown.nextPixelY} must stay ${visualY}`)
  assert.ok(Math.abs(grown.y * nextH - visualY) <= 1)

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

  const originBefore = sheetLayerOriginOffset(editor, ruling)
  cmScroller.scrollTop = 96
  editor.scrollTop = 40
  pane.scrollTop = 18
  noteView.scrollTop = 0
  assert.ok(Math.abs(sheetLayerOriginOffset(editor, ruling).y - originBefore.y) > 1, 'independent editor scroll would drift type off the ruling')
  lockPaperEditorLayerScroll(editor)
  assert.equal(cmScroller.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)
  assert.equal(pane.scrollTop, 0)
  assert.equal(noteView.scrollTop, 0, 'zeroing the editor layer must not move the paper scroller')
  const originLocked = sheetLayerOriginOffset(editor, ruling)
  assert.equal(originLocked.x, originBefore.x)
  assert.equal(originLocked.y, originBefore.y)

  cmScroller.scrollTop = 70
  editor.scrollTop = 22
  const caret = { top: 360, bottom: 378, left: 80, right: 82 }
  lockPaperEditorScrollIfNeeded(editor, caret)
  assert.equal(cmScroller.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)
  assert.ok(noteView.scrollTop > 0, 'caret keep-visible may move only the paper scroller')
  const originCaret = sheetLayerOriginOffset(editor, ruling)
  assert.equal(originCaret.x, originBefore.x)
  assert.equal(originCaret.y, originBefore.y)

  cmScroller.scrollTop = 55
  editor.scrollTop = 16
  pane.scrollTop = 9
  const paperTop = noteView.scrollTop
  lockPaperViewportEditorScroll(noteView)
  assert.equal(cmScroller.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)
  assert.equal(pane.scrollTop, 0)
  assert.equal(noteView.scrollTop, paperTop, 'paper viewport scroll stays; only editor layers are zeroed')
  keepCaretVisibleInPaperScroller(noteView, caret)
  const originPaper = sheetLayerOriginOffset(editor, ruling)
  assert.equal(originPaper.x, originBefore.x)
  assert.equal(originPaper.y, originBefore.y)

  const paperTopBeforeBurst = noteView.scrollTop
  const burst = lockPaperEditorScrollBurst(editor, [
    { scrollTop: 180, scrollLeft: 24 },
    { scrollTop: 240, scrollLeft: 40 },
    { scrollTop: 310, scrollLeft: 12 },
    { scrollTop: 90, scrollLeft: 8 },
    { scrollTop: 400, scrollLeft: 60 },
  ])
  assert.ok(burst.length >= 5 + PAPER_EDITOR_FLING_HOLD_FRAMES - 5)
  for (const sample of burst) {
    assert.equal(sample.editorTop, 0)
    assert.ok(sample.layerTops.every((top) => top === 0), 'every nested editor layer is origin after a fast pulse')
  }
  assert.equal(cmScroller.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)
  assert.equal(pane.scrollTop, 0)
  assert.equal(noteView.scrollTop, paperTopBeforeBurst, 'fast editor-layer burst must not pan via nested scroll')
  const originBurst = sheetLayerOriginOffset(editor, ruling)
  assert.equal(originBurst.x, originBefore.x)
  assert.equal(originBurst.y, originBefore.y)

  cmScroller.scrollTop = 12
  const viewportBurst = lockPaperViewportScrollBurst(noteView, [
    { scrollTop: 150 },
    { scrollTop: 220 },
    { scrollTop: 70 },
  ])
  for (const sample of viewportBurst) {
    assert.equal(sample.paperTop, paperTopBeforeBurst)
    assert.ok(sample.layerTops.every((top) => top === 0))
  }
  assert.equal(cmScroller.scrollTop, 0)
  assert.equal(sheetLayerOriginOffset(editor, ruling).y, originBefore.y)

  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const viewSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/components/PaperView.tsx'), 'utf8')
  const editorSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/components/MarkdownEditor.tsx'), 'utf8')
  assert.match(viewSource, /lockPaperViewportEditorScroll/)
  assert.match(viewSource, /tickPaperViewportEditorScrollHold/)
  assert.match(editorSource, /lockPaperEditorLayerScroll\(this\.view\.dom\)/)
  assert.match(editorSource, /tickPaperEditorScrollHold/)
  assert.match(editorSource, /PAPER_EDITOR_FLING_HOLD_FRAMES/)

  console.log(JSON.stringify({
    atOne: measure(1),
    atTwo: measure(2),
    originLocked,
    paperScrollTop: noteView.scrollTop,
  }))
  console.log('text-stay-put ok')
} finally {
  await server.close()
}
