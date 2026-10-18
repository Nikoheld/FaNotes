import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUCCESS = 'LaTeX-Schaltflächen geprüft: Einfügen, Darstellung, LaTeX-Code und PDF.'

const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const plainOperands = {
  fraction: { numerator: '3', denominator: '4' },
  sqrt: { radicand: '9' },
  superscript: { base: 'x', exponent: '2' },
  subscript: { base: 'a', index: 'n' },
  plus: {},
  minus: {},
  equals: {},
  pi: {},
  alpha: {},
}

const pdfHeader = (bytes) => Buffer.from(bytes.subarray(0, 5)).toString('ascii')

const assertPdf = (bytes) => {
  assert.equal(pdfHeader(bytes), '%PDF-')
  assert.ok(bytes.byteLength > 500, `PDF ist nur ${bytes.byteLength} Bytes lang.`)
  const text = Buffer.from(bytes).toString('latin1')
  assert.ok(text.includes('/Type /Catalog'))
  assert.ok(text.includes('/Type /Page'))
  assert.ok(text.includes('%%EOF'))
  assert.ok(text.includes('endstream'))
}

try {
  const simpleLatex = await server.ssrLoadModule('/src/lib/simpleLatex.ts')
  const editor = await server.ssrLoadModule('/src/components/MarkdownEditor.tsx')
  const toolbarModule = await server.ssrLoadModule('/src/components/FormattingToolbar.tsx')
  const exportModule = await server.ssrLoadModule('/src/components/EditorExportControls.tsx')
  const slots = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')

  const check = async () => {
    const plain = '# Heute\n\nHeute nur Woerter ohne Formel.\n'
    const plainLatex = simpleLatex.exportNoteLatex(plain, 'Heute')
    const plainPdf = simpleLatex.exportNotePdf(plain, 'Heute')
    assert.ok(plainLatex.includes('\\begin{document}'))
    assert.ok(plainLatex.includes('\\end{document}'))
    assert.ok(plainLatex.includes('Heute nur Woerter ohne Formel.'))
    assertPdf(plainPdf)
    assert.ok(Buffer.from(plainPdf).includes(Buffer.from('Heute nur Woerter ohne Formel.')))
    assert.deepEqual(simpleLatex.exportNotePdf(plain, 'Heute'), plainPdf)

    let note = plain
    const inserted = []
    assert.deepEqual([...simpleLatex.SIMPLE_LATEX_BUTTONS], Object.keys(plainOperands))
    for (const button of simpleLatex.SIMPLE_LATEX_BUTTONS) {
      const operands = plainOperands[button]
      const result = simpleLatex.applySimpleLatexButton(note, button, operands)
      assert.ok(result.inserted.length > 0)
      assert.ok(note.includes(result.inserted) === false || result.inserted === inserted.at(-1))
      assert.ok(result.note.includes(result.inserted))
      assert.ok(!result.inserted.includes('\\newcommand'))
      const html = await editor.renderInsertedLatex(result.inserted)
      assert.match(html, /class="katex"/)
      assert.doesNotMatch(html, /katex-error/)
      const parsed = editor.editorMathSource(result.inserted)
      assert.ok(result.inserted.includes(parsed.source))
      note = result.note
      inserted.push(result.inserted)
    }

    const viaFields = simpleLatex.simpleLatexSnippet('fraction', simpleLatex.operandsForButton('fraction', '3', '4'))
    const viaNamed = simpleLatex.simpleLatexSnippet('fraction', plainOperands.fraction)
    assert.equal(viaFields, viaNamed)
    assert.equal(inserted[0], viaNamed)

    assert.throws(() => simpleLatex.applySimpleLatexButton(plain, 'fraction', { numerator: '\\frac', denominator: '1' }))
    assert.throws(() => simpleLatex.simpleLatexSnippet('sqrt', { radicand: '' }))

    const tex = simpleLatex.exportNoteLatex(note, 'Heute')
    const bodyStart = tex.indexOf('\\begin{document}')
    const bodyEnd = tex.indexOf('\\end{document}')
    assert.ok(bodyStart >= 0 && bodyEnd > bodyStart)
    const body = tex.slice(bodyStart, bodyEnd)
    for (const snippet of inserted) assert.ok(body.includes(snippet), snippet)
    assert.ok(body.includes('Heute nur Woerter ohne Formel.'))

    const pdf = simpleLatex.exportNotePdf(note, 'Heute')
    assertPdf(pdf)
    assert.ok(Buffer.from(pdf).includes(Buffer.from('Heute nur Woerter ohne Formel.')))
    assert.notDeepEqual(Buffer.from(pdf), Buffer.from(plainPdf))

    const toolbar = renderToStaticMarkup(createElement(toolbarModule.FormattingToolbar, {
      onFormat: () => undefined,
      onInsertLatex: () => undefined,
    }))
    for (const label of ['Bruch', 'Quadratwurzel', 'Hochgestellt', 'Tiefgestellt', 'Plus', 'Minus', 'Gleich', 'Pi', 'Alpha', 'Mathematikblock']) {
      assert.ok(toolbar.includes(`aria-label="${label}"`), label)
    }
    assert.ok(toolbar.includes('Einfaches LaTeX'))
    assert.ok(toolbar.includes('simple-latex-tools'))

    const exportsHtml = renderToStaticMarkup(createElement(exportModule.EditorExportControls, {
      onExportPdf: () => undefined,
      onExportLatex: () => undefined,
    }))
    assert.ok(exportsHtml.includes('aria-label="Als PDF exportieren"'))
    assert.ok(exportsHtml.includes('aria-label="Als LaTeX-Code exportieren"'))

    const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
    const drawingSource = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
    assert.equal(slots.penModeToolbarSlot(false, false), 'markdown')
    assert.equal(slots.penModeToolbarSlot(true, false), 'ink')
    assert.match(appSource, /if \(slot === 'ink'\) return <div id=\{INK_TOOLBAR_SLOT_ID\}/)
    assert.match(appSource, /if \(slot === 'pdf'\) return <div id=\{PDF_TOOLBAR_SLOT_ID\}/)
    assert.match(appSource, /return <FormattingToolbar[\s\S]*?onInsertLatex=\{insertSimpleLatex\}/)
    assert.match(appSource, /<EditorExportControls[\s\S]*?onExportPdf=/)
    assert.match(appSource, /onExportLatex=/)
    assert.match(appSource, /exportNotePdf\(/)
    assert.match(appSource, /exportNoteLatex\(/)
    assert.equal(drawingSource.includes('simple-latex-tools'), false)
    assert.equal(drawingSource.includes('EditorExportControls'), false)
    assert.equal(drawingSource.includes('onInsertLatex'), false)

    return {
      buttons: inserted.length,
      snippets: inserted.join('|'),
      latex: tex.length,
      pdf: pdf.byteLength,
      plainPdf: plainPdf.byteLength,
      toolbar: toolbar.includes('aria-label="Bruch"'),
      exports: exportsHtml.includes('Als LaTeX-Code exportieren'),
    }
  }

  const first = await check()
  const second = await check()
  assert.deepEqual(first, second)
  assert.equal(first.buttons, 9)
  assert.equal(first.toolbar, true)
  assert.equal(first.exports, true)
  console.log(SUCCESS)
} finally {
  await server.close()
}
