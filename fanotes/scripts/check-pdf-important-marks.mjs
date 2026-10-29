// Mark important: quotes must be real page text, and only the highlighter is written.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const marks = await server.ssrLoadModule('/src/lib/pdfImportantMarks.ts')
  const painted = await server.ssrLoadModule('/src/lib/pdfTextMarks.ts')
  const provider = require('../electron/ai-provider.cjs')
  assert.equal(provider.PDF_IMPORTANT_SYSTEM, marks.PDF_IMPORTANT_SYSTEM)
  assert.equal(provider.isPdfImportantAction(['markImportant']), true)
  assert.equal(provider.isPdfImportantAction(['markImportant', 'spelling']), false)

  const pages = [
    { page: 1, text: 'Die Photosynthese wandelt Licht in chemische Energie um. Der Nebensatz ist unwichtig.' },
    { page: 2, text: 'Auf der zweiten Seite steht ein Ergebnis zur Zellatmung und zum Sauerstoff.' },
  ]
  const raw = [
    'Vorheriger Satz.',
    '```json',
    JSON.stringify({
      marks: [
        { page: 1, quote: 'Photosynthese wandelt Licht in chemische Energie' },
        { page: 1, quote: 'diese Stelle steht nicht im Text' },
        { page: 2, quote: 'Photosynthese wandelt Licht' },
        { page: 1, quote: 'Photosynthese   wandelt Licht in chemische Energie' },
        { page: 1, quote: 'kurz' },
        { page: 1, quote: 'Der Nebensatz ist unwichtig', kind: 'underline' },
        { page: 2, quote: 'Ergebnis zur Zellatmung' },
      ],
    }),
    '```',
  ].join('\n')
  const found = marks.parsePdfImportantMarks(raw, pages)
  assert.deepEqual(found.map((mark) => `${mark.page}:${mark.quote}`), [
    '1:Photosynthese wandelt Licht in chemische Energie',
    '1:Der Nebensatz ist unwichtig',
    '2:Ergebnis zur Zellatmung',
  ])
  assert.deepEqual(marks.parsePdfImportantMarks('[{"page":2,"quote":"Ergebnis zur Zellatmung und zum Sauerstoff"}]', pages), [
    { page: 2, quote: 'Ergebnis zur Zellatmung und zum Sauerstoff' },
  ])
  assert.deepEqual(marks.parsePdfImportantMarks('keine stellen', pages), [])
  const prompt = marks.buildPdfImportantPrompt(pages)
  assert.match(prompt, /SEITE 1/)
  assert.doesNotMatch(prompt, /vollständige Markdown/)
  assert.equal(marks.isPdfImportantAction(['markImportant']), true)

  const source = '# Aufgaben\n\nDer Satz bleibt stehen.\n'
  const once = marks.highlightPdfImportantMarks(source, [{ page: 1, quote: 'Photosynthese wandelt Licht' }])
  assert.match(once, /^# Aufgaben/)
  assert.match(once, /Der Satz bleibt stehen/)
  assert.match(once, /"kind": "highlight"/)
  assert.doesNotMatch(once, /underline/)
  const kept = painted.readPdfMarks(once)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].kind, 'highlight')
  assert.equal(kept[0].quote, 'Photosynthese wandelt Licht')
  const twice = marks.highlightPdfImportantMarks(once, [{ page: 1, quote: 'Photosynthese wandelt Licht' }])
  assert.equal(painted.readPdfMarks(twice).length, 1)
  const withOld = marks.highlightPdfImportantMarks(once, [{ page: 2, quote: 'Ergebnis zur Zellatmung' }])
  const both = painted.readPdfMarks(withOld)
  assert.deepEqual(both.map((mark) => mark.quote), ['Photosynthese wandelt Licht', 'Ergebnis zur Zellatmung'])
  assert.ok(both.every((mark) => mark.kind === 'highlight'))

  assert.deepEqual(painted.spanIndexesForQuotes(
    ['ist', 'Photosynthese', 'ist', 'wichtig', 'heute'],
    ['Photosynthese ist wichtig'],
  ), [1, 2, 3])

  const panel = read('src/components/AiPanel.tsx')
  const app = read('src/App.tsx')
  const browser = read('src/lib/aiProviderBrowser.ts')
  const studio = read('src/lib/lmStudioBrowser.ts')
  const main = read('electron/main.cjs')
  const view = read('src/components/PdfNoteView.tsx')
  assert.match(panel, /id: 'markImportant', title: 'Wichtiges markieren'/)
  assert.match(panel, /textPdf \? ACTIONS : ACTIONS\.filter\(\(action\) => action\.id !== 'markImportant'\)/)
  assert.match(panel, /buildPdfImportantPrompt\(pdfPages\)/)
  assert.match(panel, /parsePdfImportantMarks\(transformed\.markdown, pdfPages\)/)
  assert.match(panel, /onApplyMarks\?\.\(markPreview\)/)
  const markCall = panel.indexOf("actions: ['markImportant']")
  const rewriteCall = panel.indexOf('markdown: note.markdown, actions: [...actions]')
  assert.ok(markCall > 0 && rewriteCall > markCall)
  assert.match(app, /pdfPath=\{isPdfActive && activeTab \? activeTab\.path : null\}/)
  assert.match(app, /highlightPdfImportantMarks\(current, found\)/)
  assert.match(app, /Wichtige Stellen wurden mit dem Textmarker markiert/)
  assert.match(browser, /marking \? payload\.markdown : actionPrompt\(payload\)/)
  assert.match(browser, /marking \? PDF_IMPORTANT_SYSTEM/)
  assert.match(studio, /marking \? request\.markdown : promptFor\(request\)/)
  assert.match(studio, /marking \? PDF_IMPORTANT_SYSTEM/)
  assert.match(read('electron/ai-provider.cjs'), /const prompt = marking \? request\.markdown : buildPrompt\(request\)/)
  assert.match(read('electron/ai-provider.cjs'), /const systemPrompt = marking \? PDF_IMPORTANT_SYSTEM : SYSTEM_PROMPT/)
  assert.match(main, /const prompt = marking \? request\.markdown : lmStudioPrompt\(request\)/)
  assert.match(main, /marking \? aiProviderModule\.PDF_IMPORTANT_SYSTEM/)
  assert.match(view, /spanIndexesForQuotes/)
  assert.doesNotMatch(view, /quote\.includes\(text\)/)
  console.log('pdf-important-marks ok')
} finally {
  await server.close()
}
