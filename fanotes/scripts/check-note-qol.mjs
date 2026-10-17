import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const qol = await server.ssrLoadModule('/src/lib/noteQoL.ts')
const {
  clonedWorksheetDocument,
  dailyNoteStem,
  drawingTitleFromJson,
  duplicatePreferredStem,
  folderPathsIn,
  formatNoteStamp,
  nextExpandedFolders,
  noteTitleFromPath,
  recentNotePaths,
  retargetWorksheetMarkers,
  shiftDailyNote,
  stampToInsert,
  wikiLinkForNote,
  withInkMarker,
  withoutInkMarker,
  withoutWorksheetMarker,
  worksheetIdsIn,
} = qol

try {
  assert.equal(noteTitleFromPath('Mathematik/Mechanik.md'), 'Mechanik')
  assert.equal(noteTitleFromPath('Blatt.pdf'), 'Blatt')
  assert.equal(wikiLinkForNote('Mathematik/Mechanik.md'), '[[Mechanik]]')
  assert.equal(wikiLinkForNote('Fach/A|B [alt].md'), '[[A B alt]]')
  assert.equal(wikiLinkForNote('.md'), '[[Notiz]]')

  assert.equal(duplicatePreferredStem('Mechanik.md'), 'Mechanik Kopie')
  assert.equal(duplicatePreferredStem('Mechanik Kopie.md'), 'Mechanik Kopie')
  assert.equal(duplicatePreferredStem('Mechanik Kopie 2.md'), 'Mechanik Kopie')
  assert.equal(duplicatePreferredStem('Kopie.md'), 'Kopie Kopie')
  assert.equal(duplicatePreferredStem('Protokoll.pdf'), 'Protokoll Kopie')
  assert.equal(duplicatePreferredStem('Mechanik Kopie.md', 'Copy'), 'Mechanik Copy')
  assert.equal(duplicatePreferredStem('Mechanik Copy 2.md', 'Copy'), 'Mechanik Copy')

  const noon = new Date(2026, 9, 16, 9, 5)
  assert.equal(formatNoteStamp('YYYY-MM-DD', noon), '2026-10-16')
  assert.equal(formatNoteStamp('DD.MM.YYYY', noon, true), '16.10.2026 09:05')
  assert.equal(formatNoteStamp('', noon), '2026-10-16')
  assert.equal(dailyNoteStem('Tagesnotizen/2026-10-16.md', 'Tagesnotizen', 'YYYY-MM-DD'), '2026-10-16')
  assert.equal(dailyNoteStem('Andere/2026-10-16.md', 'Tagesnotizen', 'YYYY-MM-DD'), null)
  const previous = shiftDailyNote('Tagesnotizen/2026-10-16.md', 'Tagesnotizen', 'YYYY-MM-DD', -1)
  assert.equal(previous && formatNoteStamp('YYYY-MM-DD', previous), '2026-10-15')
  const dotted = shiftDailyNote('Notizen/16.10.2026.md', 'Notizen', 'DD.MM.YYYY', 1)
  assert.equal(dotted && formatNoteStamp('DD.MM.YYYY', dotted), '17.10.2026')
  assert.equal(shiftDailyNote('Los.md', 'Tagesnotizen', 'YYYY-MM-DD', 1), null)
  assert.equal(stampToInsert('', '2026-10-16'), '2026-10-16')
  assert.equal(stampToInsert('Heute', '2026-10-16'), ' 2026-10-16')
  assert.equal(stampToInsert('Heute ', '2026-10-16'), '2026-10-16')
  assert.equal(stampToInsert('Zeile\n', '2026-10-16'), '2026-10-16')

  const history = ['A.md', 'B.md', 'A.md', 'Weg.md', 'C.md']
  const exists = (path) => path !== 'Weg.md'
  assert.deepEqual(recentNotePaths(history, exists, 5), ['C.md', 'A.md', 'B.md'])
  assert.deepEqual(recentNotePaths(history, exists, 2, 'C.md'), ['A.md', 'B.md'])

  const folders = folderPathsIn([
    { kind: 'folder', relativePath: 'Mathematik', children: [
      { kind: 'file', relativePath: 'Mathematik/A.md' },
      { kind: 'folder', relativePath: 'Mathematik/Uebungen', children: [] },
    ] },
    { kind: 'file', relativePath: 'Los.md' },
  ])
  assert.deepEqual(folders, ['Mathematik', 'Mathematik/Uebungen'])
  assert.deepEqual([...nextExpandedFolders(new Set(), folders)], folders)
  assert.equal(nextExpandedFolders(new Set(['Mathematik']), folders).size, 0)

  const marked = 'Text\n\n<!-- fanotes-worksheet:alt -->\n<!-- fanotes-ink:alt -->\n'
  assert.deepEqual(worksheetIdsIn(marked), ['alt'])
  assert.equal(retargetWorksheetMarkers(marked, new Map([['alt', 'neu']])).includes('fanotes-worksheet:neu'), true)
  assert.equal(withoutWorksheetMarker(marked, 'alt').includes('worksheet'), false)
  assert.equal(withoutInkMarker(marked).includes('fanotes-ink'), false)
  assert.match(withInkMarker('Nur Text', 'neu-1'), /<!-- fanotes-ink:neu-1 -->\n$/u)
  assert.equal(withInkMarker(marked, 'neu-1').match(/fanotes-ink/gu)?.length, 1)
  assert.equal(drawingTitleFromJson('{"title":"Seite 1","strokes":[]}', 'Fallback'), 'Seite 1')
  assert.equal(drawingTitleFromJson('{', 'Fallback'), 'Fallback')

  const cloned = clonedWorksheetDocument(
    { id: 'neu', title: 'Kopie', textBoxes: [], highlights: [], source: 'neu' },
    { title: 'Blatt', textBoxes: [{ id: 'b', text: 'Antwort' }], highlights: [{ id: 'h' }], pageWidth: 800, pageHeight: 1100 },
  )
  assert.equal(cloned.id, 'neu')
  assert.equal(cloned.title, 'Blatt')
  assert.equal(cloned.textBoxes[0].text, 'Antwort')
  assert.equal(cloned.source, 'neu')
  assert.equal(cloned.pageWidth, 800)

  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const tree = readFileSync(join(root, 'src/components/FileTree.tsx'), 'utf8')
  for (const needle of [
    "id: 'duplicate-note'",
    "id: 'copy-wiki-link'",
    "id: 'insert-date'",
    "id: 'insert-date-time'",
    'placeholder-recent',
    'duplicatePreferredStem',
    'wikiLinkForNote',
    'formatNoteStamp',
    "id: 'daily-previous'",
    "id: 'daily-next'",
  ]) {
    assert.equal(app.includes(needle), true, needle)
  }
  assert.equal(tree.includes('Alle Ordner einklappen'), true)
  assert.equal(tree.includes('nextExpandedFolders'), true)
  console.log('note-qol ok')
} finally {
  await server.close()
}
