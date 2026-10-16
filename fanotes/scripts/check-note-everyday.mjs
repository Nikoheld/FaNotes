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
  const everyday = await server.ssrLoadModule('/src/lib/noteEveryday.ts')
  const {
    canDuplicateNote,
    duplicateStem,
    fenceIsOpen,
    formatNoteDate,
    formatNoteTime,
    markdownForDuplicate,
    noteStemFromPath,
    parentFolderOf,
    remapDuplicateLinks,
    retitleMatchingHeading,
    takenStemsInFolder,
    toggleTaskLine,
    wikiLinkForPath,
  } = everyday

  assert.equal(noteStemFromPath('Physik/Mechanik.md'), 'Mechanik')
  assert.equal(parentFolderOf('Physik/Mechanik.md'), 'Physik')
  assert.equal(parentFolderOf('Willkommen.md'), '')
  assert.equal(wikiLinkForPath('Physik/Mechanik.md'), '[[Mechanik]]')
  assert.equal(canDuplicateNote('Physik/Mechanik.md'), true)
  assert.equal(canDuplicateNote('Physik/Blatt.pdf'), false)

  const taken = takenStemsInFolder([
    'Physik/Mechanik.md',
    'Physik/Mechanik Kopie.md',
    'Chemie/Mechanik Kopie.md',
  ], 'Physik')
  assert.equal(duplicateStem('Mechanik', taken), 'Mechanik Kopie 2')
  assert.equal(duplicateStem('Mechanik Kopie', taken), 'Mechanik Kopie 2')
  assert.equal(duplicateStem('Mechanik', taken, 'Copy'), 'Mechanik Copy')
  assert.equal(duplicateStem('Optik', taken), 'Optik Kopie')

  const noon = new Date(2026, 9, 16, 9, 5)
  assert.equal(formatNoteDate('YYYY-MM-DD', noon), '2026-10-16')
  assert.equal(formatNoteDate('DD.MM.YY', noon), '16.10.26')
  assert.equal(formatNoteDate('', noon), '2026-10-16')
  assert.equal(formatNoteTime(noon), '09:05')

  assert.equal(toggleTaskLine('- [ ] offen'), '- [x] offen')
  assert.equal(toggleTaskLine('- [x] fertig'), '- [ ] fertig')
  assert.equal(toggleTaskLine('- [X] fertig'), '- [ ] fertig')
  assert.equal(toggleTaskLine('  1. Punkt'), '  1. [ ] Punkt')
  assert.equal(toggleTaskLine('# Titel'), '# Titel')
  assert.equal(toggleTaskLine('> Zitat'), '> Zitat')
  assert.equal(toggleTaskLine('| A | B |'), '| A | B |')
  assert.equal(toggleTaskLine('---'), '---')
  assert.equal(toggleTaskLine(''), '- [ ] ')
  assert.equal(toggleTaskLine('  '), '  - [ ] ')
  assert.equal(toggleTaskLine('Hausaufgabe'), '- [ ] Hausaufgabe')
  assert.equal(fenceIsOpen(['Text', '```', 'code']), true)
  assert.equal(fenceIsOpen(['```', 'code', '```']), false)

  const titled = retitleMatchingHeading('# Mechanik\n\n## Mechanik\n', 'Mechanik', 'Mechanik Kopie')
  assert.equal(titled, '# Mechanik Kopie\n\n## Mechanik\n')
  assert.equal(retitleMatchingHeading('# Mechanik extra\n', 'Mechanik', 'Mechanik Kopie'), '# Mechanik extra\n')

  const copied = markdownForDuplicate(
    '# Mechanik\n\nText  \n\n<!-- fanotes-worksheet:blatt1 -->\n<!-- fanotes-ink:alt -->\n',
    'neu',
  )
  assert.equal(copied.droppedWorksheets, true)
  assert.equal(copied.markdown.includes('fanotes-worksheet'), false)
  assert.equal(copied.markdown.includes('fanotes-ink:alt'), false)
  assert.equal(copied.markdown.includes('<!-- fanotes-ink:neu -->'), true)
  assert.equal(copied.markdown.endsWith('\n'), true)

  const links = remapDuplicateLinks([
    {
      id: 'alt',
      sourcePath: 'Physik/Mechanik.md',
      targetPath: 'Physik/Optik.md',
      page: 1,
      x: 0.2,
      y: 0.3,
      style: 'text',
      label: 'Optik',
    },
    {
      id: 'self',
      sourcePath: 'Physik/Mechanik.md',
      targetPath: 'Physik/Mechanik Kopie.md',
      page: 1,
      x: 0.5,
      y: 0.5,
      style: 'symbol',
      label: 'Kopie',
    },
  ], 'Physik/Mechanik.md', 'Physik/Mechanik Kopie.md', () => 'nl-neu')
  assert.equal(links.length, 1)
  assert.equal(links[0].id, 'nl-neu')
  assert.equal(links[0].sourcePath, 'Physik/Mechanik Kopie.md')
  assert.equal(links[0].targetPath, 'Physik/Optik.md')

  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const tree = readFileSync(join(root, 'src/components/FileTree.tsx'), 'utf8')
  const editor = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  for (const needle of [
    "id: 'duplicate-note'",
    "id: 'copy-wikilink'",
    "id: 'insert-date'",
    "id: 'insert-time'",
    "id: 'toggle-task'",
    "id: 'collapse-folders'",
    'Wiki-Link kopieren',
    'Alle Ordner zuklappen',
    'collapseToken',
    'markdownForDuplicate',
  ]) {
    assert.equal(app.includes(needle) || tree.includes(needle), true, needle)
  }
  assert.equal(editor.includes("key: 'Mod-Enter'"), true)
  assert.equal(editor.includes('toggleTaskLine'), true)

  console.log('note-everyday ok')
} finally {
  await server.close()
}
