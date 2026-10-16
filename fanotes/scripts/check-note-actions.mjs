import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const actions = await server.ssrLoadModule('/src/lib/noteActions.ts')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const tree = readFileSync(new URL('../src/components/FileTree.tsx', import.meta.url), 'utf8')
  const editor = readFileSync(new URL('../src/components/MarkdownEditor.tsx', import.meta.url), 'utf8')

  assert.equal(actions.duplicateNoteStem('Mechanik.md'), 'Mechanik Kopie')
  assert.equal(actions.duplicateNoteStem('Mechanik.markdown'), 'Mechanik Kopie')
  assert.equal(actions.duplicateNoteStem('Mechanik Kopie.md'), 'Mechanik Kopie')
  assert.equal(actions.duplicateNoteStem('Mechanik Kopie 2.md'), 'Mechanik Kopie')
  assert.equal(actions.duplicateNoteStem('Mechanik Copy.md', 'Copy'), 'Mechanik Copy')
  assert.equal(actions.duplicateNoteStem('Physik/Note.md'.split('/').pop()), 'Note Kopie')
  assert.equal(actions.isMarkdownNotePath('a/Note.md'), true)
  assert.equal(actions.isMarkdownNotePath('a/Blatt.pdf'), false)

  const prepared = actions.prepareDuplicateMarkdown('# Titel\n\nText\n\n<!-- fanotes-ink:abc -->\n<!-- fanotes-worksheet:sheet1 -->\n')
  assert.equal(prepared.hadWorksheet, true)
  assert.equal(prepared.markdown.includes('fanotes-ink'), false)
  assert.equal(prepared.markdown.includes('fanotes-worksheet'), false)
  assert.match(prepared.markdown, /# Titel/)
  assert.match(prepared.markdown, /Text/)
  const plain = actions.prepareDuplicateMarkdown('# Nur Text\n')
  assert.equal(plain.hadWorksheet, false)
  assert.equal(plain.markdown, '# Nur Text\n')

  assert.equal(actions.wikiLinkForPath('Physik/Mechanik.md'), '[[Mechanik]]')
  assert.equal(actions.wikiLinkForPath('a].md'), '[[a]]')
  assert.equal(actions.wikiLinkForPath('Welcome.pdf'), '[[Welcome]]')

  const stamp = new Date(2026, 9, 16, 7, 5, 9)
  assert.equal(actions.formatDatePattern('YYYY-MM-DD', stamp), '2026-10-16')
  assert.equal(actions.formatDatePattern('DD.MM.YY HH:mm', stamp), '16.10.26 07:05')
  assert.equal(actions.formatDatePattern('', stamp), '2026-10-16')
  assert.equal(actions.formatClock(stamp), '07:05')

  assert.equal(actions.drawingTitleFromJson('{"title":"Seite","strokes":[]}'), 'Seite')
  assert.equal(actions.drawingTitleFromJson('not json'), null)
  assert.equal(actions.drawingTitleFromJson('{"title":"  "}'), null)

  const links = actions.retargetCopiedLinks([
    { id: 'old', sourcePath: 'A.md', targetPath: 'B.md', label: 'B' },
    { id: 'self', sourcePath: 'A.md', targetPath: 'A Kopie.md', label: 'loop' },
  ], 'A Kopie.md', (index) => `nl-${index}`)
  assert.deepEqual(links, [{ id: 'nl-0', sourcePath: 'A Kopie.md', targetPath: 'B.md', label: 'B' }])

  assert.equal(actions.toggleTaskLine('Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine('- Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine('* Milch'), '* [ ] Milch')
  assert.equal(actions.toggleTaskLine('1. Milch'), '1. [ ] Milch')
  assert.equal(actions.toggleTaskLine('  - [ ] Milch'), '  - [x] Milch')
  assert.equal(actions.toggleTaskLine('- [x] Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine('- [X] Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine(''), '- [ ] ')
  assert.equal(actions.toggleTaskLine('# Titel'), '# Titel')
  assert.equal(actions.toggleTaskLine('---'), '---')
  assert.equal(actions.toggleTaskLine('| a | b |'), '| a | b |')
  assert.equal(actions.toggleTaskLine('```js'), '```js')
  assert.equal(actions.toggleTaskLine('> offen'), '> - [ ] offen')
  assert.equal(actions.toggleTaskLine('> - [ ] offen'), '> - [x] offen')
  assert.equal(actions.taskAfterHeading('## Aufgabe'), '- [ ] ')
  assert.equal(actions.taskAfterHeading('kein Titel'), null)

  const fenced = ['```', 'code', '```', '- [ ] draussen']
  assert.equal(actions.lineInsideFence(fenced, 1), true)
  assert.equal(actions.lineInsideFence(fenced, 3), false)
  const math = ['$$', 'x', '$$', 'danach']
  assert.equal(actions.lineInsideFence(math, 1), true)
  assert.equal(actions.lineInsideFence(math, 3), false)
  assert.deepEqual(actions.taskToggleChanges(['```', 'code', '```', '- sichtbar'], 1, 4), [
    { line: 4, insert: '- [ ] sichtbar' },
  ])
  assert.deepEqual(actions.taskToggleChanges(['# Titel'], 1, 1), [{ line: 1, insert: '\n- [ ] ' }])
  assert.deepEqual(actions.taskToggleChanges(['- [ ] a', '- [x] b'], 1, 2), [
    { line: 1, insert: '- [x] a' },
    { line: 2, insert: '- [ ] b' },
  ])

  for (const id of ['duplicate-note', 'insert-date', 'insert-time', 'copy-wiki-link', 'reveal-tree', 'toggle-task']) {
    assert.match(app, new RegExp(`id: '${id}', label:`))
  }
  assert.match(app, /Ctrl ⇧ D/)
  assert.match(app, /Ctrl ⇧ C/)
  assert.match(app, /event\.key\.toLowerCase\(\) === 'd'\)/)
  assert.match(app, /!event\.shiftKey && event\.key\.toLowerCase\(\) === 'd'/)
  assert.match(tree, /Duplizieren/)
  assert.match(tree, /Wiki-Link kopieren/)
  assert.match(editor, /key: 'Mod-Enter'/)
  assert.match(editor, /toggleTask:/)

  console.log('note-actions ok')
} finally {
  await server.close()
}
