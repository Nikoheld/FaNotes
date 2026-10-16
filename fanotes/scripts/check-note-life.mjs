import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const life = await server.ssrLoadModule('/src/lib/noteLife.ts')
  const {
    dailyNoteStem,
    duplicatePreferredName,
    formatNoteDate,
    formatNoteStamp,
    inkDuplicatePayload,
    markdownForDuplicate,
    nearestHeadingTitle,
    newDuplicateInkId,
    noteTitleFromPath,
    parseNoteDate,
    shiftDailyNote,
    toggleTaskLine,
    wikiLinkForHeading,
    wikiLinkForPath,
  } = life

  assert.equal(toggleTaskLine('- [ ] Milch'), '- [x] Milch')
  assert.equal(toggleTaskLine('- [x] Milch'), '- [ ] Milch')
  assert.equal(toggleTaskLine('* [X] Offen'), '* [ ] Offen')
  assert.equal(toggleTaskLine('  12. [ ] Schritt'), '  12. [x] Schritt')
  assert.equal(toggleTaskLine('- Einkaufen'), '- [ ] Einkaufen')
  assert.equal(toggleTaskLine('  Freitext'), '  - [ ] Freitext')
  assert.equal(toggleTaskLine(''), '- [ ] ')
  assert.equal(toggleTaskLine('   '), '   - [ ] ')

  assert.equal(wikiLinkForPath('Physik/Mechanik.md'), '[[Mechanik]]')
  assert.equal(wikiLinkForPath('Notizen/Name].md'), '[[Name]]')
  assert.equal(wikiLinkForHeading('Physik/Mechanik.md', 'Kräfte'), '[[Mechanik#Kräfte]]')
  assert.equal(wikiLinkForHeading('Physik/Mechanik.md', '  '), '[[Mechanik]]')
  assert.equal(noteTitleFromPath('a/b.pdf'), 'b')
  assert.equal(nearestHeadingTitle('# Oben\n\nText\n## Unten\nmehr', 3), 'Oben')
  assert.equal(nearestHeadingTitle('# Oben\n\nText\n## Unten\nmehr', 5), 'Unten')
  assert.equal(nearestHeadingTitle('ohne überschrift', 1), '')

  const day = new Date(2026, 9, 16, 15, 4, 0, 0)
  assert.equal(formatNoteDate('YYYY-MM-DD', day), '2026-10-16')
  assert.equal(formatNoteDate('DD.MM.YYYY', day), '16.10.2026')
  assert.equal(formatNoteDate('YY/MM/DD', day), '26/10/16')
  assert.equal(formatNoteStamp('YYYY-MM-DD', day, false), '2026-10-16')
  assert.equal(formatNoteStamp('DD.MM.YYYY', day, true), '16.10.2026 15:04')
  assert.equal(parseNoteDate('2026-10-16', 'YYYY-MM-DD')?.getDate(), 16)
  assert.equal(parseNoteDate('16.10.2026', 'DD.MM.YYYY')?.getMonth(), 9)
  assert.equal(parseNoteDate('26/10/16', 'YY/MM/DD', 2026)?.getFullYear(), 2026)
  assert.equal(parseNoteDate('99-01-02', 'YY-MM-DD', 2026)?.getFullYear(), 1999)
  assert.equal(parseNoteDate('2026-02-31', 'YYYY-MM-DD'), null)
  assert.equal(parseNoteDate('2023-02-29', 'YYYY-MM-DD'), null)
  assert.equal(parseNoteDate('nicht-ein-datum', 'YYYY-MM-DD'), null)
  assert.equal(parseNoteDate('2026-10-16', 'nur-text'), null)

  assert.equal(dailyNoteStem('Tagesnotizen/2026-10-16.md', 'Tagesnotizen/', 'YYYY-MM-DD'), '2026-10-16')
  assert.equal(dailyNoteStem('Andere/2026-10-16.md', 'Tagesnotizen', 'YYYY-MM-DD'), null)
  assert.equal(dailyNoteStem('Tagesnotizen/2026-10-16.markdown', 'Tagesnotizen', 'YYYY-MM-DD'), null)
  const previous = shiftDailyNote('Tagesnotizen/2026-01-01.md', 'Tagesnotizen', 'YYYY-MM-DD', -1)
  assert.equal(formatNoteDate('YYYY-MM-DD', previous), '2025-12-31')
  const next = shiftDailyNote('Schule/Tage/16.10.2026.md', 'Schule/Tage', 'DD.MM.YYYY', 1)
  assert.equal(formatNoteDate('DD.MM.YYYY', next), '17.10.2026')
  assert.equal(shiftDailyNote('Tagesnotizen/Protokoll.md', 'Tagesnotizen', 'YYYY-MM-DD', 1), null)

  const duplicated = markdownForDuplicate('# Protokoll\n\nText\n\n<!-- fanotes-ink:abc -->\n<!-- fanotes-worksheet:sheet1 -->\n\nEnde\n')
  assert.equal(duplicated, '# Protokoll\n\nText\n\nEnde\n')
  assert.equal(markdownForDuplicate('sichtbar <!-- fanotes-ink:abc --> bleibt'), 'sichtbar  bleibt\n')
  assert.equal(markdownForDuplicate('   \n<!-- fanotes-worksheet:x -->\n'), '')
  assert.equal(duplicatePreferredName('Physik/Mechanik.md'), 'Mechanik Kopie')
  assert.equal(duplicatePreferredName('Physik/Mechanik.md', 'Copy'), 'Mechanik Copy')

  const ink = inkDuplicatePayload(JSON.stringify({
    schemaVersion: 1,
    id: 'old-id',
    title: 'Handschrift',
    strokes: [{ id: 's1' }],
  }), '2026-10-16T12:00:00.000Z')
  assert.equal(ink.title, 'Handschrift')
  const parsedInk = JSON.parse(ink.drawingJson)
  assert.equal(parsedInk.id, undefined)
  assert.equal(parsedInk.updatedAt, '2026-10-16T12:00:00.000Z')
  assert.equal(parsedInk.strokes.length, 1)
  assert.equal(inkDuplicatePayload(JSON.stringify({ schemaVersion: 1, title: 'Leer', strokes: [] })), null)
  assert.equal(inkDuplicatePayload('{'), null)
  assert.match(newDuplicateInkId(), /^[a-zA-Z0-9_-]{1,96}$/u)

  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const editor = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  const tree = readFileSync(join(root, 'src/components/FileTree.tsx'), 'utf8')
  const toolbar = readFileSync(join(root, 'src/components/FormattingToolbar.tsx'), 'utf8')
  for (const id of [
    'duplicate-note',
    'copy-wiki-link',
    'copy-heading-link',
    'insert-date',
    'insert-datetime',
    'toggle-task',
    'close-tab',
    'copy-path',
    'daily-previous',
    'daily-next',
  ]) {
    assert.ok(app.includes(`id: '${id}'`), `palette action ${id}`)
  }
  assert.match(app, /aria-label="Vorherige Tagesnotiz"/)
  assert.match(app, /aria-label="Nächste Tagesnotiz"/)
  assert.match(app, /aria-label="Benachbarte Tagesnotizen"/)
  assert.match(editor, /key: 'Mod-Enter'/)
  assert.match(editor, /key: 'Shift-Mod-d'/)
  assert.match(editor, /toggleTask/)
  assert.match(tree, /Wiki-Link kopieren/)
  assert.match(tree, /Duplizieren/)
  assert.match(toolbar, /Aufgabe abhaken/)

  console.log('note-life ok')
} finally {
  await server.close()
}
