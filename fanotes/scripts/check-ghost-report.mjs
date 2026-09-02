import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  acceptBugReportPayload,
  BUG_REPORT_MAX_BODY_BYTES as handlerMaxBody,
} from '../../fanotes-site/bug-report-api.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  captureGhostTextAroundLock,
  classifyGhostTextMotion,
  ghostTextDiagnosticFields,
  glyphExpectedVisual,
  observeGhostTextSequence,
  sampleGhostTextLayout,
} = await server.ssrLoadModule('/src/lib/paperCaretScroll.ts')
const {
  BUG_REPORT_MAX_BODY_BYTES,
  BUG_REPORT_MAX_EVENTS,
  BUG_REPORT_PEN_SAMPLE_MS,
  BUG_REPORT_WINDOW_MS,
  buildBugReportRequest,
  buildPenDiagnosticEvent,
  buildTextMotionDiagnosticEvent,
  createBugReportLog,
} = await server.ssrLoadModule('/src/lib/bugReport.ts')

const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/u).filter(Boolean))
  return {
    contains: (name) => values.has(name),
    add: (...names) => { names.forEach((name) => values.add(name)) },
    remove: (...names) => { names.forEach((name) => values.delete(name)) },
  }
}

const makeNode = (className, extras = {}) => {
  const node = {
    className,
    classList: makeClassList(className),
    parentElement: extras.parentElement ?? null,
    children: [],
    scrollTop: extras.scrollTop ?? 0,
    scrollLeft: extras.scrollLeft ?? 0,
    style: {
      getPropertyValue: (name) => extras.css?.[name] ?? '',
    },
    querySelector(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      const visit = (item) => {
        if (wanted.some((name) => item.classList.contains(name))) return item
        for (const child of item.children) {
          const found = visit(child)
          if (found) return found
        }
        return null
      }
      for (const child of this.children) {
        const found = visit(child)
        if (found) return found
      }
      return null
    },
    closest(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      let current = this
      while (current) {
        if (wanted.some((name) => current.classList.contains(name))) return current
        current = current.parentElement
      }
      return null
    },
    querySelectorAll(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().replace(/^\./u, ''))
      const found = []
      const visit = (item) => {
        if (wanted.some((name) => item.classList.contains(name))) found.push(item)
        item.children.forEach(visit)
      }
      this.children.forEach(visit)
      return found
    },
  }
  return node
}

const append = (parent, child) => {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

const GLYPH = { paperX: 86, paperY: 78 }

const driveSlipThenReturn = () => {
  const frames = [
    { ...GLYPH, camX: 0, camY: 40, padX: 0, padY: 0, editorX: 0, editorY: 0 },
    { ...GLYPH, camX: 0, camY: 40, padX: 0, padY: 0, editorX: 0, editorY: 180 },
    { ...GLYPH, camX: 0, camY: 40, padX: 0, padY: 0, editorX: 0, editorY: 0 },
  ]
  const observed = observeGhostTextSequence(frames)
  assert.equal(observed[0].slip, false, 'idle frame is not a slip')
  assert.equal(observed[0].back, false)
  assert.equal(observed[1].slip, true, 'nested editor-layer offset must flag a slip')
  assert.equal(observed[1].back, false)
  assert.equal(observed[2].slip, false)
  assert.equal(observed[2].back, true, 'return to the same paper pixel must flag snap-back')
  assert.equal(observed[1].sample.paperY, GLYPH.paperY)
  assert.equal(observed[2].sample.paperY, GLYPH.paperY)
  const expected = glyphExpectedVisual(observed[2].sample)
  assert.ok(Math.abs(observed[2].sample.visualY - expected.y) < 1e-6)
  assert.ok(Math.abs(observed[1].sample.visualY - expected.y) > 2)

  const mismatch = classifyGhostTextMotion(
    null,
    sampleGhostTextLayout({
      ...GLYPH,
      camX: 0,
      camY: 0,
      padX: 0,
      padY: 144,
      editorX: 0,
      editorY: 0,
      visualX: GLYPH.paperX,
      visualY: GLYPH.paperY,
    }),
  )
  assert.equal(mismatch.slip, true, 'origin/camera mismatch (pad without matching visual) must flag a slip')

  const paper = makeNode('paper-view unified-note-view', { scrollTop: 40 })
  const sheet = append(paper, makeNode('unified-paper'))
  const editor = append(sheet, makeNode('editor-pane markdown-editor'))
  const cm = append(editor, makeNode('cm-scroller', { scrollTop: 180, scrollLeft: 12 }))
  const captured = captureGhostTextAroundLock(paper, editor, { x: GLYPH.paperX, y: GLYPH.paperY })
  assert.equal(captured.slip.slip, true, 'live lock path must see the nested-layer slip before zeroing')
  assert.equal(captured.back.back, true, 'live lock path must see snap-back after editor layers return to 0')
  assert.equal(cm.scrollTop, 0)
  assert.equal(editor.scrollTop, 0)
  assert.equal(captured.after.editorY, 0)
  assert.equal(captured.before.paperY, captured.after.paperY)

  return { observed, captured, mismatch }
}

const runOnce = () => {
  const driven = driveSlipThenReturn()
  const now = 20_000_000 + BUG_REPORT_WINDOW_MS
  const log = createBugReportLog()
  const motionEvents = driven.observed.flatMap((step, index) => {
    if (!step.slip && !step.back) return []
    return [buildTextMotionDiagnosticEvent({
      at: now - 8_000 + index * BUG_REPORT_PEN_SAMPLE_MS,
      noteId: 'Notizen/Deutsch.md',
      ...ghostTextDiagnosticFields(step.sample, step),
      version: '2026.9.2',
      platform: 'linux',
      pageW: 900,
      pageH: 1273,
    })]
  })
  for (const event of motionEvents) log.record(event, now)
  log.record(buildPenDiagnosticEvent({
    at: now - 1_000,
    noteId: 'Notizen/Deutsch.md',
    x: 0.22,
    y: 0.31,
    pointerType: 'pen',
    tool: 'pen',
    version: '2026.9.2',
    platform: 'linux',
    pageW: 900,
    pageH: 1273,
    padX: 0,
    padY: 0,
    camX: 0,
    camY: 40,
    grew: false,
    jump: false,
  }), now)

  const request = buildBugReportRequest({
    description: 'Text rutscht und springt dann zurück.',
    events: log.snapshot(now),
    version: '2026.9.2',
    platform: 'linux',
    now,
  })
  const accepted = acceptBugReportPayload(request.body)
  assert.equal(accepted.ok, true)
  const storedText = accepted.report.events.filter((event) => event.kind === 'text')
  const storedPen = accepted.report.events.filter((event) => event.kind === 'pen')
  assert.ok(storedText.length >= 2, 'handler must keep text-motion samples')
  assert.ok(storedText.some((event) => event.slip === true), 'handler must keep slip')
  assert.ok(storedText.some((event) => event.back === true), 'handler must keep snap-back')
  for (const event of storedText) {
    assert.equal(typeof event.paperX, 'number')
    assert.equal(typeof event.paperY, 'number')
    assert.equal(typeof event.edX, 'number')
    assert.equal(typeof event.edY, 'number')
    assert.equal(typeof event.camX, 'number')
    assert.equal(typeof event.camY, 'number')
    assert.equal(typeof event.padX, 'number')
    assert.equal(typeof event.padY, 'number')
  }
  assert.equal(storedPen.length, 1)
  assert.equal(typeof storedPen[0].pageW, 'number')
  assert.equal(typeof storedPen[0].camY, 'number')

  const fullLog = createBugReportLog()
  const start = now - BUG_REPORT_WINDOW_MS + 1
  const step = Math.max(1, Math.floor((BUG_REPORT_WINDOW_MS - 2) / BUG_REPORT_MAX_EVENTS))
  for (let index = 0; index < BUG_REPORT_MAX_EVENTS; index += 1) {
    const slipping = index % 17 === 0
    const backing = index % 29 === 0
    if (slipping || backing) {
      fullLog.record(buildTextMotionDiagnosticEvent({
        at: start + index * step,
        noteId: 'Faecher/Mathematik/Uebungen/Lineare-Algebra-Blatt-12.md',
        visualX: 86,
        visualY: slipping ? 78 - 180 : 78,
        paperX: 86,
        paperY: 78,
        camX: 0,
        camY: 40,
        padX: 0,
        padY: 0,
        edX: 0,
        edY: slipping ? 180 : 0,
        slip: slipping,
        back: backing && !slipping,
        version: '2026.9.2',
        platform: 'linux',
        pageW: 900,
        pageH: 1273,
      }), now)
    } else {
      fullLog.record(buildPenDiagnosticEvent({
        at: start + index * step,
        noteId: 'Faecher/Mathematik/Uebungen/Lineare-Algebra-Blatt-12.md',
        x: 0.031 + (index % 50) / 1000,
        y: 0.071 + (index % 40) / 100,
        pointerType: 'pen',
        tool: 'fineliner',
        version: '2026.9.2',
        platform: 'linux',
        pageW: 1544,
        pageH: 1800,
        padX: 108,
        padY: 144,
        camX: 108,
        camY: 144,
        grew: index % 41 === 0,
        jump: index % 53 === 0,
      }), now)
    }
  }
  const maxRequest = buildBugReportRequest({
    description: 'x'.repeat(2000),
    events: fullLog.snapshot(now),
    version: '2026.9.2',
    platform: 'linux',
    now,
  })
  const encoded = Buffer.byteLength(JSON.stringify(maxRequest.body), 'utf8')
  assert.equal(maxRequest.body.events.length, BUG_REPORT_MAX_EVENTS)
  assert.ok(encoded < BUG_REPORT_MAX_BODY_BYTES, `max-window payload ${encoded} must stay under ${BUG_REPORT_MAX_BODY_BYTES}`)
  assert.equal(BUG_REPORT_MAX_BODY_BYTES, handlerMaxBody)
  const maxAccepted = acceptBugReportPayload(maxRequest.body)
  assert.equal(maxAccepted.ok, true)
  assert.equal(maxAccepted.report.events.length, BUG_REPORT_MAX_EVENTS)
  assert.ok(maxAccepted.report.events.some((event) => event.slip === true && typeof event.edY === 'number'))
  assert.ok(maxAccepted.report.events.some((event) => event.kind === 'pen' && typeof event.pageW === 'number'))

  const editor = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  const paperView = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
  const caret = readFileSync(join(root, 'src/lib/paperCaretScroll.ts'), 'utf8')
  const bugReport = readFileSync(join(root, 'src/lib/bugReport.ts'), 'utf8')
  const handler = readFileSync(join(root, '../fanotes-site/bug-report-api.mjs'), 'utf8')
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.match(caret, /export const classifyGhostTextMotion/)
  assert.match(caret, /export const captureGhostTextAroundLock/)
  assert.match(caret, /export const observeGhostTextSequence/)
  assert.match(bugReport, /export const buildTextMotionDiagnosticEvent/)
  assert.match(bugReport, /kind: 'text'/)
  assert.match(editor, /captureGhostTextAroundLock/)
  assert.match(editor, /buildTextMotionDiagnosticEvent/)
  assert.match(paperView, /captureGhostTextAroundLock/)
  assert.match(paperView, /buildTextMotionDiagnosticEvent/)
  assert.match(handler, /paperX: finiteLayout\(raw\.paperX\)/)
  assert.match(handler, /edX: finiteLayout\(raw\.edX\)/)
  assert.match(handler, /slip: raw\.slip === true/)
  assert.match(handler, /back: raw\.back === true/)
  assert.match(handler, /'text'/)
  assert.match(self, /observeGhostTextSequence/)
  assert.match(self, /captureGhostTextAroundLock/)

  return {
    slip: driven.observed[1].slip,
    back: driven.observed[2].back,
    mismatch: driven.mismatch.slip,
    liveSlip: driven.captured.slip.slip,
    liveBack: driven.captured.back.back,
    storedText: storedText.length,
    storedPen: storedPen.length,
    maxBytes: encoded,
    limit: BUG_REPORT_MAX_BODY_BYTES,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('ghost-report ok')
} finally {
  await server.close()
}
