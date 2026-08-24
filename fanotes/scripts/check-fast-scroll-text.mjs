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
  isIndependentEditorLayer,
  lockPaperViewportScrollStayPut,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')
const { sheetLayerOriginOffset } = await server.ssrLoadModule('/src/lib/paperView.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/u).filter(Boolean))
  return {
    contains: (name) => values.has(name),
    add: (...names) => { names.forEach((name) => values.add(name)) },
    remove: (...names) => { names.forEach((name) => values.delete(name)) },
  }
}

const tokenSet = (selector) => new Set(String(selector).split(',').map((part) => part.trim().replace(/^\./u, '')).filter(Boolean))

const editorLayerDelta = (node) => {
  let x = 0
  let y = 0
  let current = node
  while (current) {
    if (isIndependentEditorLayer(current)) {
      x += current.scrollLeft ?? 0
      y += current.scrollTop ?? 0
    }
    current = current.parentElement
  }
  return { x, y }
}

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
    layoutHeight: extras.layoutHeight ?? 2400,
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
      const extra = editorLayerDelta(this)
      const isScroller = this.classList.contains('paper-view')
      const width = isScroller ? this.clientWidth : this.layoutWidth
      const height = isScroller ? this.clientHeight : this.layoutHeight
      return {
        left: this.contentLeft - (scroller.scrollLeft ?? 0) - extra.x,
        top: this.contentTop - (scroller.scrollTop ?? 0) - extra.y,
        right: this.contentLeft - (scroller.scrollLeft ?? 0) - extra.x + width,
        bottom: this.contentTop - (scroller.scrollTop ?? 0) - extra.y + height,
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

const runOnce = () => {
  const paper = makeNode('paper-view unified-note-view', { clientHeight: 300, layoutHeight: 2400 })
  const plane = append(paper, makeNode('paper-sheet-plane'))
  const ruling = append(plane, makeNode('paper-ruling'))
  const sheet = append(plane, makeNode('unified-paper'))
  const editor = append(sheet, makeNode('editor-pane markdown-editor paper-mode'))
  const cmScroller = append(editor, makeNode('cm-scroller'))

  const before = sheetLayerOriginOffset(editor, ruling)
  assert.ok(Math.abs(before.x) <= 1 && Math.abs(before.y) <= 1, 'text starts on the ruling')

  const burst = [180, 420, 860, 120, 640]
  const afterJumps = []
  for (const [index, jump] of burst.entries()) {
    cmScroller.scrollTop = 48 + index * 6
    cmScroller.scrollLeft = 12
    editor.scrollTop = 24 + index * 3
    editor.scrollLeft = 9
    const result = lockPaperViewportScrollStayPut(paper, {
      scrollTop: jump,
      scrollLeft: index % 2 === 0 ? 40 : 0,
    })
    assert.equal(cmScroller.scrollTop, 0, `burst ${jump}: cm-scroller must stay at 0`)
    assert.equal(cmScroller.scrollLeft, 0, `burst ${jump}: cm-scroller x must stay at 0`)
    assert.equal(editor.scrollTop, 0, `burst ${jump}: editor layer must stay at 0`)
    assert.equal(editor.scrollLeft, 0, `burst ${jump}: editor layer x must stay at 0`)
    assert.equal(result.paperScrollTop, jump, `paper scroller must hold jump ${jump}`)
    const origin = sheetLayerOriginOffset(editor, ruling)
    assert.ok(Math.abs(origin.x) <= 1, `burst ${jump}: text-vs-ruling x ${origin.x}`)
    assert.ok(Math.abs(origin.y) <= 1, `burst ${jump}: text-vs-ruling y ${origin.y}`)
    afterJumps.push({ jump, origin, paperTop: result.paperScrollTop })
  }

  const drifted = sheetLayerOriginOffset(editor, ruling)
  assert.ok(Math.abs(drifted.x - before.x) <= 1)
  assert.ok(Math.abs(drifted.y - before.y) <= 1)

  const editorSource = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
  assert.match(editorSource, /lockPaperViewportScrollStayPut/)
  assert.match(paperView, /lockPaperViewportScrollStayPut/)
  assert.match(editorSource, /onPaperScroll/)

  return { jumps: burst, afterJumps, before }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first.jumps, second.jumps)
  assert.deepEqual(first.afterJumps, second.afterJumps)
  console.log(JSON.stringify({ jumps: first.jumps, last: first.afterJumps.at(-1) }))
  console.log('fast-scroll-text ok')
} finally {
  await server.close()
}
