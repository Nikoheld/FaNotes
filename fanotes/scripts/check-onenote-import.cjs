'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  decodeHtmlEntities,
  describeSession,
  disposeSession,
  importOneNotePages,
  sanitizeOneNoteHtml,
  materializeOneNoteTools,
  safeSegment,
  scanOneNote,
  TOOL_MANIFEST,
  writeNoteFiles,
} = require('../electron/onenote-importer.cjs')

assert.equal(decodeHtmlEntities('A&#x41;&#65;&amp;'), 'AAA&')
assert.equal(decodeHtmlEntities('&#xD800;&#x110000;&#999999999999;'), '\uFFFD\uFFFD\uFFFD')
assert.equal(safeSegment('CON', 'OneNote-Seite'), 'OneNote-Seite')
assert.equal(safeSegment('comic', 'OneNote-Seite'), 'comic')
async function assertUniqueNoteDoesNotReplace() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-onenote-name-'))
  try {
    await fsp.writeFile(path.join(directory, 'Seite.md'), 'keep')
    const created = await writeNoteFiles(directory, 'Seite', 'new', null)
    assert.equal(await fsp.readFile(path.join(directory, 'Seite.md'), 'utf8'), 'keep')
    assert.equal(await fsp.readFile(created.mdPath, 'utf8'), 'new')
    // A lone .famd of the same stem is never taken over by a new note either.
    await fsp.writeFile(path.join(directory, 'Tinte.famd'), 'keep')
    const beside = await writeNoteFiles(directory, 'Tinte', 'body', 'ink')
    assert.equal(await fsp.readFile(path.join(directory, 'Tinte.famd'), 'utf8'), 'keep')
    assert.equal(path.basename(beside.mdPath), 'Tinte 2.md')
    assert.equal(await fsp.readFile(beside.famdPath, 'utf8'), 'ink')
    const device = await writeNoteFiles(directory, 'NUL.txt', 'device', null)
    assert.match(path.basename(device.mdPath), /^OneNote-Seite\.md$/u)
  } finally {
    await fsp.rm(directory, { recursive: true, force: true })
  }
}

const root = path.resolve(__dirname, '..')
const fixtures = path.join(__dirname, 'fixtures', 'onenote')
let one2html = path.join(root, 'resources', 'onenote', 'linux', 'one2html')
let sevenZip = path.join(root, 'resources', 'onenote', 'linux', '7za')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-onenote-check-'))

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')

async function filesBelow(directory) {
  const files = []
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else files.push(target)
    }
  }
  return files
}

async function verifyImport(inputPath, suffix) {
  const vault = path.join(temporary, `vault-${suffix}`)
  await fsp.mkdir(vault, { mode: 0o700 })
  const session = await scanOneNote({ inputPath, one2html, sevenZip })
  try {
    const scan = describeSession(session)
    assert.equal(scan.pageCount, 1)
    assert.equal(scan.sections.length, 1)
    assert.equal(scan.sections[0].pages[0].title, 'Test Page')
    assert.equal(scan.sections[0].pages[0].hasInk, true)
    assert.equal(scan.sections[0].pages[0].imageCount, 1)
    const result = await importOneNotePages({ session, pageIds: [session.pages[0].id], destination: { physical: vault, logical: '' }, vaultRoot: vault })
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
    assert.equal(result.imported.length, 1)
    assert.equal(result.imported[0].path, 'New Section 1/Test Page.md')
    assert.equal(result.inkPages, 1)
    assert.equal(result.imageCount, 1)

    // The fixture page has ink, so its text lives in positioned text fields and the .md keeps the title.
    const { parseFamd } = require('../electron/famd.cjs')
    const note = await fsp.readFile(path.join(vault, result.imported[0].path), 'utf8')
    assert.equal(note, '# Test Page\n')
    assert.doesNotMatch(note, /fanotes-onenote|fanotes-worksheet|<details|<svg|<div/u, 'no internal marker or HTML in the note')
    const famdText = await fsp.readFile(path.join(vault, 'New Section 1', 'Test Page.famd'), 'utf8')
    const famd = parseFamd(famdText)
    const text = famd.payload.textFields.map((field) => field.text).join('\n\n')
    assert.match(text, /^## ABCDEF$/mu)
    assert.match(text, /^- \[ \] ABCDEF$/mu)
    assert.match(text, /^- \[x\] ABCDEFG$/mu)
    assert.match(text, /\*\*Lorem\*\* ipsum \*dolor\*/u)
    assert.match(text, /\[magna\]\(https:\/\/example\.com\)/u)
    assert.match(text, /^\| A \| B \| C \|$/mu)
    assert.match(text, /^\$\$a=b\$\$$/mu)
    assert.equal(famd.payload.annotations.filter((item) => item.kind === 'image').length, 1, 'the picture is a positioned image')
    assert.ok(fs.readdirSync(path.join(vault, '.fanotes', 'assets', 'onenote')).some((name) => name.endsWith('.jpg')), 'and is also kept in the vault')
    assert.equal(famd.payload.ink.strokes.length, 1)
    assert.ok(famd.payload.ink.strokes[0].points.length > 50)
    assert.ok(famd.payload.ink.sourceWidth >= 900 && famd.payload.ink.sourceHeight >= 1273)
    assert.ok(famd.payload.ink.strokes[0].points.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1))
    assert.doesNotMatch(famdText, /fanotes-onenote:/u)
    assert.equal(famd.markdown.trim(), note.trim())
    assert.equal(await fsp.stat(path.join(vault, '.fanotes', 'worksheets')).catch(() => null), null, 'no legacy worksheet pages are written')
    return result
  } finally {
    await disposeSession(session)
  }
}

async function assertSanitizerVectors() {
  // The committed bundle is what the entry and the pinned packages build.
  const { bundleOneNoteSanitizer } = await import('./build-onenote-sanitizer.mjs')
  assert.equal(await bundleOneNoteSanitizer(), fs.readFileSync(path.join(root, 'electron', 'onenote-sanitizer.bundle.cjs'), 'utf8'), 'electron/onenote-sanitizer.bundle.cjs is stale: run node scripts/build-onenote-sanitizer.mjs')
  // Shared with crates/fanotes-host/src/onenote.rs (ammonia).
  const { cases } = JSON.parse(fs.readFileSync(path.join(fixtures, 'sanitize-vectors.json'), 'utf8'))
  assert.ok(cases.length >= 20)
  for (const { html, absent, present } of cases) {
    const clean = sanitizeOneNoteHtml(html)
    for (const pattern of absent) assert.doesNotMatch(clean, new RegExp(pattern, 'iu'), `${html} -> ${clean}`)
    for (const pattern of present) assert.match(clean, new RegExp(pattern, 'iu'), `${html} -> ${clean}`)
    // Idempotent: cleaning the cleaned page changes nothing (no mutation on re-parse).
    assert.equal(sanitizeOneNoteHtml(clean), clean, `re-parse of ${clean}`)
  }
}

void (async () => {
  await assertSanitizerVectors()
  await assertUniqueNoteDoesNotReplace()
  if (process.platform !== 'linux') {
    console.log('Der binäre OneNote-Regressionstest läuft auf dem Linux-Buildhost.')
    return
  }
  assert.equal(hash(await fsp.readFile(one2html)), '343c247d7a5513df08185418d2be0ecaeb00ac06e4bc427f084f1e2179af5523')
  const windowsExe = await fsp.readFile(path.join(root, 'resources', 'onenote', 'windows', 'one2html.exe'))
  assert.equal(hash(windowsExe), '9d3d043f86a65e8b97782bb72275837768a066353c771dab96bceef683136981')
  assert.equal(windowsExe.subarray(0, 2).toString('latin1'), 'MZ')
  const version = spawnSync(one2html, ['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr || version.stdout)
  assert.match(version.stdout, /^one2html 2\.0\.1\b/u)
  assert.equal(hash(await fsp.readFile(sevenZip)), TOOL_MANIFEST.linux.sevenZip.sha256)
  assert.equal(hash(await fsp.readFile(path.join(root, 'resources', 'onenote', 'windows', '7za.exe'))), TOOL_MANIFEST.win32.sevenZip.sha256)
  const materialized = await materializeOneNoteTools({
    embeddedRoot: path.join(root, 'resources', 'onenote'),
    cacheRoot: path.join(temporary, 'tool-cache'),
    platform: 'linux',
  })
  one2html = materialized.one2html
  sevenZip = materialized.sevenZip
  assert.equal(hash(await fsp.readFile(one2html)), TOOL_MANIFEST.linux.one2html.sha256)
  assert.equal((await fsp.stat(one2html)).mode & 0o777, 0o700)
  await verifyImport(path.join(fixtures, 'Open Notebook.onetoc2'), 'direct')
  await verifyImport(path.join(fixtures, 'New Section 1.one'), 'section')

  const archive = path.join(temporary, 'OneDrive-Export.zip')
  const archived = spawnSync(sevenZip, ['a', '-tzip', archive, 'Open Notebook.onetoc2', 'New Section 1.one'], { cwd: fixtures, encoding: 'utf8' })
  assert.equal(archived.status, 0, archived.stderr || archived.stdout)
  await verifyImport(archive, 'zip')
  const onepkg = path.join(temporary, 'OneDrive-Export.onepkg')
  await fsp.copyFile(archive, onepkg)
  await verifyImport(onepkg, 'onepkg')

  const main = await fsp.readFile(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = await fsp.readFile(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const settings = await fsp.readFile(path.join(root, 'src', 'components', 'SettingsModal.tsx'), 'utf8')
  const worksheetLayer = await fsp.readFile(path.join(root, 'src', 'components', 'WorksheetLayer.tsx'), 'utf8')
  const importer = await fsp.readFile(path.join(root, 'electron', 'onenote-importer.cjs'), 'utf8')
  assert.match(importer, /stageWindowsCrt/u)
  assert.doesNotMatch(importer, /fanotes-onenote:|fanotes-worksheet:/u, 'the importer writes no visible markers')
  assert.match(importer, /vcruntime140\.dll/u)
  assert.match(importer, /dirname\(process\.execPath\)/u)
  assert.match(main, /require\('\.\/onenote-importer\.cjs'\)/u)
  assert.match(main, /materializeOneNoteTools/u)
  assert.match(main, /extensions:\s*\['one', 'onetoc2', 'onepkg', 'zip'\]/u)
  assert.match(preload, /importOneNote:\s*\(\)/u)
  assert.match(preload, /importOneNotePages:\s*\(request\)/u)
  assert.match(settings, /Microsoft OneNote Import/u)
  assert.match(settings, /\.one · \.onetoc2 · \.onepkg · OneDrive-ZIP/u)
  assert.match(main, /importOneNotePages/u)
  assert.match(worksheetLayer, /sandbox=""/u)
  assert.match(worksheetLayer, /page\.clientWidth \/ \(initialDocument\.pageWidth/u)
  // Worksheet pages render through the shared double-buffered painter, which queues
  // every bitmap in pdfDocument's single render queue.
  assert.match(worksheetLayer, /createPdfPagePainter\(/u)
  const pdfPagePainter = await fsp.readFile(path.join(root, 'src', 'lib', 'pdfPagePainter.ts'), 'utf8')
  assert.match(pdfPagePainter, /enqueuePdfRender\(/u)
  assert.match(worksheetLayer, /loadVaultPdfBytes/u)
  assert.match(worksheetLayer, /HIDE_DEBOUNCE_MS/u)
  assert.match(preload, /readAssetBytes:\s*\(relativePath\)/u)
  assert.match(main, /fanotes:read-asset-bytes/u)
  const packageConfig = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(packageConfig.build.files.includes('resources/onenote/**/*'))
  for (const platform of ['linux', 'win']) {
    const extraResources = packageConfig.build[platform].extraResources ?? []
    assert.ok(extraResources.every((entry) => !String(entry.from ?? '').includes('resources/onenote') && !String(entry.to ?? '').includes('onenote')))
  }
  console.log('OneNote-Import erfolgreich: direkte .one-Abschnitte, Notizbücher, ZIP, .onepkg, Seitenauswahl, Markdown, MathML, Ink als .famd, Bilder und hashgeprüfte Delta-Ressourcen geprüft.')
})().finally(() => fsp.rm(temporary, { recursive: true, force: true })).catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
