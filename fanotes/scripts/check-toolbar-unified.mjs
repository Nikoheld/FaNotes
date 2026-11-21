// The note formatting bar and the text-box bar are ONE component (FormattingToolbar); both offer sub/superscript;
// rarely used actions sit in "Mehr"; the "hide Markdown buttons" setting works; the PDF slot survives swaps
// (a re-created slot left the PDF bar attached to a detached node: an empty top bar without "Leere Seiten daneben");
// fullscreen has its IPC. Usage: node scripts/check-toolbar-unified.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')

const server = await createServer({ root, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
try {
  const { FormattingToolbar } = await server.ssrLoadModule('/src/components/FormattingToolbar.tsx')
  const { formatTextFieldText } = await server.ssrLoadModule('/src/lib/noteTextFieldFormat.ts')
  const { NoteTextFieldMarkdown } = await server.ssrLoadModule('/src/components/NoteTextFieldMarkdown.tsx')
  const { MarkdownPreview } = await server.ssrLoadModule('/src/components/MarkdownPreview.tsx')

  // 1. One implementation: the text-box bar renders FormattingToolbar, it has no markup of its own for the actions.
  const field = read('src/components/NoteTextFieldLayer.tsx')
  assert.match(field, /import \{ FormattingToolbar \} from '\.\/FormattingToolbar'/)
  assert.match(field, /<FormattingToolbar[\s\S]*?trailing=/)
  assert.doesNotMatch(field, /aria-label="Fett"|Heading1|Strikethrough/)

  // 2. Sub- and superscript in both.
  const bar = renderToStaticMarkup(createElement(FormattingToolbar, { onFormat: () => undefined, onInsertLatex: () => undefined }))
  for (const label of ['Text tiefgestellt', 'Text hochgestellt', 'Fett', 'Mehr', 'Überschrift']) assert.ok(bar.includes(`aria-label="${label}"`), label)
  assert.doesNotMatch(bar, />\s*Überschrift 1\s*</, 'no numbers or words in the bar itself')
  assert.equal(formatTextFieldText('H2O', 1, 2, 'subscript').text, 'H<sub>2</sub>O')
  assert.equal(formatTextFieldText('x2', 1, 2, 'superscript').text, 'x<sup>2</sup>')
  const boxHtml = renderToStaticMarkup(createElement(NoteTextFieldMarkdown, { text: 'H<sub>2</sub>O und x<sup>2</sup>', onToggleTask: () => undefined, onOpenLink: () => undefined }))
  assert.ok(boxHtml.includes('<sub>2</sub>') && boxHtml.includes('<sup>2</sup>'), boxHtml)
  const unsafe = renderToStaticMarkup(createElement(NoteTextFieldMarkdown, { text: '<sub onclick="x">a</sub> <b>b</b>', onToggleTask: () => undefined, onOpenLink: () => undefined }))
  assert.ok(!unsafe.includes('<b>') && !unsafe.includes('<sub onclick'), 'text boxes keep HTML inert')
  const noteHtml = renderToStaticMarkup(createElement(MarkdownPreview, { content: 'H<sub>2</sub>O und x<sup>2</sup>' }))
  assert.ok(noteHtml.includes('<sub>2</sub>') && noteHtml.includes('<sup>2</sup>'), noteHtml)

  // 3. Rare actions are grouped in "Mehr" and everything stays reachable.
  const more = renderToStaticMarkup(createElement(FormattingToolbar, { defaultMoreOpen: true, onFormat: () => undefined, onInsertLatex: () => undefined }))
  for (const label of ['Tabelle einfügen', 'Mathematikblock', 'Codeblock', 'Trennlinie', 'Einklappbarer Bereich', 'Einfaches LaTeX']) assert.ok(more.includes(`aria-label="${label}"`), label)

  // 4. The setting hides the typeable buttons only.
  const hidden = renderToStaticMarkup(createElement(FormattingToolbar, { hideTypeable: true, defaultMoreOpen: true, onFormat: () => undefined, onInsertLatex: () => undefined }))
  for (const label of ['Fett', 'Kursiv', 'Aufzählung', 'Zitat', 'Link', 'Code', 'Codeblock', 'Überschrift']) assert.ok(!hidden.includes(`aria-label="${label}"`), `${label} stays hidden`)
  for (const label of ['Tabelle einfügen', 'Mathematikblock', 'Mehr']) assert.ok(hidden.includes(`aria-label="${label}"`), label)
  for (const file of ['src/types.ts', 'src/defaults.ts', 'electron/settings-sanitize.cjs', 'electron/main.cjs']) assert.match(read(file), /hideMarkdownKeyButtons/, file)
  assert.match(read('src/components/SettingsModal.tsx'), /Markdown-Tasten ausblenden/)
  assert.match(read('resources/i18n/en.json'), /"Markdown-Tasten ausblenden": "Hide Markdown buttons"/)

  // 5. Empty-bar regression: the PDF slot is one element that is never re-created, and PdfNoteView re-resolves its host.
  const app = read('src/App.tsx')
  assert.equal(app.split('id={PDF_TOOLBAR_SLOT_ID}').length - 1, 1, 'one PDF slot element, shared by every toolbar mode')
  assert.match(app, /const pdfSlot = isPdfActive \? <div key="pdf-slot" id=\{PDF_TOOLBAR_SLOT_ID\}/)
  assert.match(read('src/components/PdfNoteView.tsx'), /useLayoutEffect\(\(\) => \{\s*const live = document\.getElementById\(toolbarSlotId\)\s*setToolbarHost\([^\n]*\n\s*\}\)/, 'host is re-resolved on every commit')
  assert.match(read('src/components/PdfNoteView.tsx'), /Leere Seiten daneben/)

  // 6. Fullscreen wiring.
  for (const file of ['electron/main.cjs', 'electron/preload.cjs']) assert.match(read(file), /fanotes:window-fullscreen/, file)
  assert.match(read('electron/main.cjs'), /win\.setFullScreen\(Boolean\(on\)\)/)
  assert.match(read('src/styles.css'), /\.app-shell\.toolbar-fullscreen > \.ribbon/)
  assert.match(app, /else if \(toolbarFullscreen\) setToolbarFullscreenMode\(false\)/)
  console.log('toolbar-unified ok')
} finally {
  await server.close()
}
