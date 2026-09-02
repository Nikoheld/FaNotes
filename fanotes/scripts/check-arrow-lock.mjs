import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  applyPaperArrowNavigation,
  handlePaperEditorScroll,
  isIndependentEditorLayer,
  lockPaperEditorScrollIfNeeded,
  lockPaperEditorScrollBurst,
  lockPaperViewportEditorScroll,
  lockPaperViewportScrollBurst,
  resolvePaperCaretScroller,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')
const { sheetLayerOriginOffset } = await server.ssrLoadModule('/src/lib/paperView.ts')

const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/u).filter(Boolean))
  return {
    contains: (name) => values.has(name),
    add: (...names) => { names.forEach((name) => values.add(name)) },
    remove: (...names) => { names.forEach((name) => values.delete(name)) },
  }
}

const tokenSet = (selector) => new Set(String(selector).split(',').map((part) => part.trim().replace(/^\./u, '')).filter(Boolean))

const makeNode = (className, extras = {}) => {
  const node = {
    className,
    classList: makeClassList(className),
    parentElement: extras.parentElement ?? null,
    children: [],
    scrollTop: extras.scrollTop ?? 0,
    scrollLeft: extras.scrollLeft ?? 0,
    contentLeft: extras.contentLeft ?? 40,
    contentTop: extras.contentTop ?? 20,
    layoutWidth: extras.layoutWidth ?? 900,
    layoutHeight: extras.layoutHeight ?? 640,
    clientWidth: extras.clientWidth ?? 400,
    clientHeight: extras.clientHeight ?? 300,
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
      const isScroller = this.classList.contains('paper-view')
      const width = isScroller ? this.clientWidth : this.layoutWidth
      const height = isScroller ? this.clientHeight : this.layoutHeight
      return {
        left: this.contentLeft,
        top: this.contentTop - (scroller.scrollTop ?? 0),
        right: this.contentLeft + width,
        bottom: this.contentTop - (scroller.scrollTop ?? 0) + height,
        width,
        height,
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
  const paper = makeNode('paper-view unified-note-view', { clientHeight: 300, layoutHeight: 900 })
  const plane = append(paper, makeNode('paper-sheet-plane'))
  const sheet = append(plane, makeNode('unified-paper'))
  const ruling = append(sheet, makeNode('paper-ruling'))
  const editor = append(sheet, makeNode('markdown-editor paper-mode'))
  const cmScroller = append(editor, makeNode('cm-scroller', { scrollTop: 0 }))

  const before = sheetLayerOriginOffset(editor, ruling)
  assert.ok(Math.abs(before.x) <= 1 && Math.abs(before.y) <= 1, 'text starts on the ruling')
  assert.equal(isIndependentEditorLayer(cmScroller), true)
  assert.equal(isIndependentEditorLayer(paper), false)
  assert.equal(resolvePaperCaretScroller(editor), paper)

  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) {
    cmScroller.scrollTop = 48
    editor.scrollTop = 24
    const caret = { top: 340, bottom: 358, left: 80, right: 82 }
    const result = applyPaperArrowNavigation(editor, caret)
    assert.equal(cmScroller.scrollTop, 0, `${key} must not leave the editor layer scrolled`)
    assert.equal(editor.scrollTop, 0, `${key} must zero the markdown editor scroll`)
    assert.equal(result.paperScroller, paper)
    assert.ok(paper.scrollTop > 0, `${key} may move the paper scroller to keep the caret visible`)
    const after = sheetLayerOriginOffset(editor, ruling)
    assert.equal(after.x, before.x, `${key} must not shift text horizontally off the ruling`)
    assert.equal(after.y, before.y, `${key} must not shift text vertically off the ruling`)
    paper.scrollTop = 0
  }

  cmScroller.scrollTop = 64
  editor.scrollTop = 18
  const mockView = {
    dom: editor,
    coordsAtPos() {
      return { top: 340, bottom: 358, left: 80, right: 82 }
    },
  }
  paper.scrollTop = 0
  const intercepted = handlePaperEditorScroll(mockView, { head: 12 })
  assert.equal(intercepted, true, 'scrollHandler must swallow CodeMirror scrollIntoView on paper')
  assert.equal(cmScroller.scrollTop, 0, 'scrollHandler must zero the cm-scroller after measure()')
  assert.equal(editor.scrollTop, 0, 'scrollHandler must zero the markdown editor after measure()')
  assert.equal(paper.scrollTop, 0, 'scrollHandler must not pan the paper camera to the caret')
  const afterHandler = sheetLayerOriginOffset(editor, ruling)
  assert.equal(afterHandler.x, before.x, 'scrollHandler must not shift text off the ruling')
  assert.equal(afterHandler.y, before.y, 'scrollHandler must not shift text off the ruling')

  cmScroller.scrollTop = 80
  editor.scrollTop = 12
  const snapshotCaught = lockPaperEditorScrollIfNeeded(editor, { top: 340, bottom: 358, left: 80, right: 82 })
  assert.equal(snapshotCaught, true, 'snapshot/programmatic cm-scroller scroll must be caught')
  assert.equal(cmScroller.scrollTop, 0, 'post-measure snapshot must not leave the editor layer scrolled')
  assert.equal(editor.scrollTop, 0, 'post-measure snapshot must not leave the markdown editor scrolled')
  const afterSnapshot = sheetLayerOriginOffset(editor, ruling)
  assert.equal(afterSnapshot.x, before.x, 'snapshot scroll must not shift text off the ruling')
  assert.equal(afterSnapshot.y, before.y, 'snapshot scroll must not shift text off the ruling')

  const looseEditor = makeNode('markdown-editor')
  assert.equal(
    handlePaperEditorScroll({
      dom: looseEditor,
      coordsAtPos() { return { top: 10, bottom: 20, left: 10, right: 12 } },
    }, { head: 0 }),
    false,
    'non-paper editors keep the default CodeMirror scroller',
  )

  cmScroller.scrollTop = 40
  editor.scrollTop = 9
  paper.scrollTop = 0
  let deferred = 0
  const duringUpdate = handlePaperEditorScroll({
    dom: editor,
    coordsAtPos() {
      throw new Error("Reading the editor layout isn't allowed during an update")
    },
    requestMeasure() { deferred += 1 },
  }, { head: 12 })
  assert.equal(duringUpdate, true, 'scrollHandler must swallow scroll even when layout reads are forbidden')
  assert.equal(cmScroller.scrollTop, 0, 'forbidden layout read still zeros the editor layer')
  assert.equal(deferred, 0, 'scrollHandler must not requestMeasure; pan-to-caret is not deferred')

  cmScroller.scrollTop = 33
  editor.scrollTop = 11
  const paperTop = paper.scrollTop
  lockPaperViewportEditorScroll(paper)
  assert.equal(cmScroller.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)
  assert.equal(paper.scrollTop, paperTop)

  const originBurstBefore = sheetLayerOriginOffset(editor, ruling)
  const burst = lockPaperEditorScrollBurst(editor, [
    { scrollTop: 120 },
    { scrollTop: 200 },
    { scrollTop: 80 },
    { scrollTop: 260 },
  ])
  for (const sample of burst) {
    assert.equal(sample.editorTop, 0)
    assert.ok(sample.layerTops.every((top) => top === 0))
  }
  assert.equal(cmScroller.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)
  const originBurst = sheetLayerOriginOffset(editor, ruling)
  assert.equal(originBurst.x, originBurstBefore.x)
  assert.equal(originBurst.y, originBurstBefore.y)
  const viewportBurst = lockPaperViewportScrollBurst(paper, [{ scrollTop: 90 }, { scrollTop: 140 }])
  assert.ok(viewportBurst.every((sample) => sample.layerTops.every((top) => top === 0)))
  assert.equal(paper.scrollTop, paperTop)

  console.log(JSON.stringify({ before, paperScrollAfterDown: true, editorLocked: true, scrollHandler: true }))
  console.log('arrow-lock ok')
} finally {
  await server.close()
}
