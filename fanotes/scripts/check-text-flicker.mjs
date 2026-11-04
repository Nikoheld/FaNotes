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
const { eraseInkKeepingNoteText } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { applyToolErase } = await server.ssrLoadModule('/src/lib/toolErase.ts')
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
