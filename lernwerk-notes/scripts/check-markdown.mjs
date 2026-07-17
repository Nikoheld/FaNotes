import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorState } from '@codemirror/state'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { MarkdownPreview } = await server.ssrLoadModule('/src/components/MarkdownPreview.tsx')
  const { findDetailsBlocks } = await server.ssrLoadModule('/src/components/MarkdownEditor.tsx')
  const markdown = `# Titel

**fett** *kursiv* ~~durch~~ [Link](https://example.com) und [[Notiz]]

- [x] Aufgabe

| A | B |
| --- | --- |
| 1 | 2 |

> Zitat

$\\sqrt{7}$

<details open onclick="alert(1)">
<summary>Antwort</summary>

- Punkt

<script>alert(1)</script>

</details>`
  const html = renderToStaticMarkup(createElement(MarkdownPreview, { content: markdown }))
  for (const required of [
    '<h1', '<strong>', '<em>', '<del>', '<a', '<table', 'type="checkbox"',
    '<blockquote', '<details', '<summary', 'class="katex',
  ]) assert.ok(html.includes(required), `Markdown-Ausgabe fehlt: ${required}`)
  assert.ok(html.includes('open=""'), 'Das open-Attribut des Klappbereichs fehlt.')
  assert.ok(!html.includes('onclick'), 'Unsicherer Event-Handler wurde nicht entfernt.')
  assert.ok(!html.includes('<script'), 'Unsicheres Script wurde nicht entfernt.')

  const editorDocument = `<details>
<summary>Mehr erfahren</summary>

**Inhalt**

</details>

<details><summary>Kurz</summary>Antwort</details>`
  const blocks = findDetailsBlocks(EditorState.create({ doc: editorDocument }))
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].summary, 'Mehr erfahren')
  assert.equal(blocks[0].body, '**Inhalt**')
  assert.equal(blocks[1].summary, 'Kurz')
  assert.equal(blocks[1].body, 'Antwort')

  console.log('Markdownprüfung erfolgreich: CommonMark, GFM, Mathematik, Wikilinks, sichere HTML-Klappbereiche und Live-Editor-Blöcke.')
} finally {
  await server.close()
}
