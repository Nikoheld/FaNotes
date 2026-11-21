'use strict'

// Page picker backend: tree, selection, destination folder, section folders, re-import, cancel, per-page errors.

const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const { describeSession, disposeSession, importOneNotePages, readImportIndex } = require('../electron/onenote-importer.cjs')
const { inkPath, inkSvg, makeSession, page, paragraph, tempVault } = require('./fixtures/onenote/synthetic.cjs')

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name]))

void (async () => {
  const sources = [
    { title: 'Alpha', section: ['Biologie'], pageId: '{A}' },
    { title: 'Beta', section: ['Biologie'], pageId: '{B}', html: page({ title: 'Beta', pageId: '{B}', body: paragraph('mit Tinte') }).replace('</body>', `${inkSvg({ left: 0, top: 0, width: 200, height: 100, paths: [inkPath('M 1 1 L 50 50')] })}</body>`) },
    { title: 'Gamma', section: ['Chemie', 'Organik'], pageId: '{C}' },
    { title: 'Alpha', section: ['Chemie'], pageId: '{A2}' },
  ]
  const session = await makeSession(sources)
  const vault = tempVault()
  try {
    // Tree: sections with their pages, ink flags, nothing imported yet.
    const scan = describeSession(session)
    assert.equal(scan.pageCount, 4)
    assert.equal(scan.inkPageCount, 1)
    assert.deepEqual(scan.sections.map((section) => section.name), ['Biologie', 'Chemie / Organik', 'Chemie'])
    assert.deepEqual(scan.sections[0].pages.map((entry) => [entry.title, entry.hasInk]), [['Alpha', false], ['Beta', true]])
    assert.ok(scan.sections.every((section) => section.pages.every((entry) => !entry.alreadyImported)))
    assert.ok(!JSON.stringify(scan).includes(session.root), 'no temp paths reach the renderer')

    // Only the selected pages, into a destination that did not exist, with section folders.
    const destination = { physical: path.join(vault, 'Uni', 'Semester 1'), logical: 'Uni/Semester 1' }
    fs.mkdirSync(destination.physical, { recursive: true })
    const progress = []
    const first = await importOneNotePages({ session, pageIds: ['p1', 'p2'], destination, vaultRoot: vault, onProgress: (event) => progress.push(event) })
    assert.deepEqual(first.imported.map((entry) => entry.path).sort(), ['Uni/Semester 1/Biologie/Beta.md', 'Uni/Semester 1/Chemie/Organik/Gamma.md'])
    assert.equal(first.failed.length, 0)
    assert.deepEqual(walk(vault).filter((file) => !file.startsWith('.fanotes')).sort(), ['Uni/Semester 1/Biologie/Beta.famd', 'Uni/Semester 1/Biologie/Beta.md', 'Uni/Semester 1/Chemie/Organik/Gamma.md'])
    assert.deepEqual(progress.map((event) => `${event.status}:${event.done}/${event.total}`), ['working:0/2', 'done:1/2', 'working:1/2', 'done:2/2', 'finished:2/2'])

    // Re-import: nothing is duplicated, earlier pages are reported as skipped, new ones are added.
    const again = await importOneNotePages({ session, pageIds: ['p0', 'p1', 'p2'], destination, vaultRoot: vault })
    assert.deepEqual(again.skipped.map((entry) => entry.title).sort(), ['Beta', 'Gamma'])
    assert.deepEqual(again.imported.map((entry) => entry.path), ['Uni/Semester 1/Biologie/Alpha.md'])
    const rescanned = describeSession(session, await readImportIndex(vault))
    assert.deepEqual(rescanned.sections.flatMap((section) => section.pages.filter((entry) => entry.alreadyImported).map((entry) => entry.title)).sort(), ['Alpha', 'Beta', 'Gamma'])
    const index = JSON.parse(fs.readFileSync(path.join(vault, '.fanotes', 'onenote', 'imports.json'), 'utf8'))
    assert.equal(Object.keys(index.pages).length, 3)

    // A note the user deleted is imported again; a same-titled page of another section does not collide.
    fs.rmSync(path.join(vault, 'Uni', 'Semester 1', 'Biologie', 'Beta.md'))
    fs.rmSync(path.join(vault, 'Uni', 'Semester 1', 'Biologie', 'Beta.famd'))
    const restored = await importOneNotePages({ session, pageIds: ['p1', 'p3'], destination, vaultRoot: vault })
    assert.deepEqual(restored.imported.map((entry) => entry.path).sort(), ['Uni/Semester 1/Biologie/Beta.md', 'Uni/Semester 1/Chemie/Alpha.md'])

    // Without section folders every page goes straight into the destination; an existing name is never replaced.
    const flat = { physical: path.join(vault, 'Flach'), logical: 'Flach' }
    fs.mkdirSync(flat.physical)
    const flatResult = await importOneNotePages({ session, pageIds: ['p0', 'p3'], destination: flat, vaultRoot: vault, sectionFolders: false })
    assert.deepEqual(flatResult.imported.map((entry) => entry.path), ['Flach/Alpha.md', 'Flach/Alpha 2.md'])

    // Root destination.
    const rootSession = await makeSession([{ title: 'Wurzel', section: [] }])
    const rootVault = tempVault()
    try {
      const rooted = await importOneNotePages({ session: rootSession, pageIds: ['p0'], destination: { physical: rootVault, logical: '' }, vaultRoot: rootVault })
      assert.equal(rooted.imported[0].path, 'Wurzel.md')
    } finally {
      await disposeSession(rootSession)
      await fsp.rm(rootVault, { recursive: true, force: true })
    }

    // One broken page is reported and the others still import.
    const broken = await makeSession([{ title: 'Gut 1', section: ['X'] }, { title: 'Kaputt', section: ['X'] }, { title: 'Gut 2', section: ['X'] }])
    const brokenVault = tempVault()
    try {
      fs.rmSync(broken.pages[1].file)
      const outcome = await importOneNotePages({ session: broken, pageIds: ['p0', 'p1', 'p2'], destination: { physical: brokenVault, logical: '' }, vaultRoot: brokenVault })
      assert.equal(outcome.imported.length, 2)
      assert.equal(outcome.failed.length, 1)
      assert.equal(outcome.failed[0].title, 'Kaputt')
      assert.ok(outcome.failed[0].error.length > 0)

      // Cancel stops after the page in progress; written pages stay.
      const controller = new AbortController()
      const cancelled = await importOneNotePages({
        session: broken,
        pageIds: ['p0', 'p2'],
        destination: { physical: path.join(brokenVault, 'Zwei'), logical: 'Zwei' },
        vaultRoot: brokenVault,
        signal: controller.signal,
        onProgress: (event) => { if (event.status === 'done') controller.abort() },
      })
      assert.equal(cancelled.cancelled, true)
      assert.equal(cancelled.imported.length, 1)
    } finally {
      await disposeSession(broken)
      await fsp.rm(brokenVault, { recursive: true, force: true })
    }

    // No importer output carries an internal marker.
    for (const file of walk(vault).filter((name) => /\.(?:md|famd)$/u.test(name))) {
      const text = fs.readFileSync(path.join(vault, file), 'utf8')
      assert.doesNotMatch(text.split('<!-- fanotes-famd')[0], /fanotes-onenote|fanotes-worksheet|<!--/u, file)
    }

    // The renderer wiring: dialog, preload bridge and main handlers exist for every step.
    const root = path.resolve(__dirname, '..')
    const dialog = fs.readFileSync(path.join(root, 'src', 'components', 'OneNoteImportDialog.tsx'), 'utf8')
    for (const needle of ['importOneNotePages', 'cancelOneNoteImport', 'onOneNoteProgress', 'Zielordner', 'Neuer Ordner', 'toggle(ids, event.target.checked)', 'Bereits importiert', 'Fehler pro Seite']) assert.ok(dialog.includes(needle), needle)
    const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
    for (const channel of ['fanotes:import-onenote-pages', 'fanotes:cancel-onenote-import', 'fanotes:close-onenote', 'fanotes:onenote-progress']) {
      assert.ok(main.includes(channel) && fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8').includes(channel), channel)
    }
  } finally {
    await disposeSession(session)
    await fsp.rm(vault, { recursive: true, force: true })
  }
  console.log('OneNote-Seitenauswahl geprüft: Baum, Auswahl, Zielordner, Abschnittsordner, Re-Import ohne Duplikate, Abbruch und Fehler pro Seite.')
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
