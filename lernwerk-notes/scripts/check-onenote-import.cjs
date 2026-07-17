'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { importOneNoteToVault, materializeOneNoteTools, TOOL_MANIFEST } = require('../electron/onenote-importer.cjs')

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
  const result = await importOneNoteToVault({ inputPath, vaultRoot: vault, one2html, sevenZip })
  assert.equal(result.pageCount, 1)
  assert.equal(result.attachmentCount, 1)
  assert.equal(result.importedNotes.length, 1)
  assert.match(result.rootFolder, /^OneNote – /u)

  const note = await fsp.readFile(path.join(vault, result.importedNotes[0]), 'utf8')
  assert.match(note, /^# Test Page/mu)
  assert.match(note, /fanotes-worksheet:[a-f0-9-]{36}/u)
  assert.match(note, /Importierter Text · suchbar und bearbeitbar/u)
  assert.match(note, /Lorem ipsum dolor sit amet/u)
  const worksheetId = /fanotes-worksheet:([a-f0-9-]{36})/u.exec(note)[1]
  const worksheet = JSON.parse(await fsp.readFile(path.join(vault, '.lernwerk', 'worksheets', `${worksheetId}.json`), 'utf8'))
  assert.equal(worksheet.kind, 'html')
  assert.equal(worksheet.mimeType, 'text/html')
  assert.ok(worksheet.pageWidth >= 720)
  assert.ok(worksheet.pageHeight >= 900)

  const html = await fsp.readFile(path.join(vault, '.lernwerk', 'worksheets', `${worksheetId}.html`), 'utf8')
  assert.match(html, /fanotes-onenote-safe-v1/u)
  assert.match(html, /Content-Security-Policy/u)
  assert.match(html, /<math\b/u)
  assert.match(html, /<svg\b/u)
  assert.match(html, /src="data:image\/jpeg;base64,/u)
  assert.doesNotMatch(html, /<script\b|<iframe\b|<embed\b|javascript\s*:/iu)
  assert.doesNotMatch(html, /src="https?:|href=/iu)

  const manifests = (await filesBelow(path.join(vault, '.lernwerk', 'onenote'))).filter((file) => file.endsWith('manifest.json'))
  assert.equal(manifests.length, 1)
  const manifest = JSON.parse(await fsp.readFile(manifests[0], 'utf8'))
  assert.equal(manifest.attachments.length, 1)
  assert.ok(manifest.originalSources.length >= 1)
  const preservedSource = path.join(path.dirname(manifests[0]), 'original', manifest.originalSources[0].storedName)
  assert.match(preservedSource, /\.fanotes-onenote-source$/u)
  assert.equal(hash(await fsp.readFile(preservedSource)), manifest.originalSources[0].sha256)
  const inert = path.join(path.dirname(manifests[0]), 'attachments', manifest.attachments[0].storedName)
  const inertData = await fsp.readFile(inert)
  assert.match(inert, /\.fanotes-attachment$/u)
  assert.equal(hash(inertData), manifest.attachments[0].sha256)
  return result
}

void (async () => {
  if (process.platform !== 'linux') {
    console.log('Der binäre OneNote-Regressionstest läuft auf dem Linux-Buildhost.')
    return
  }
  assert.equal(hash(await fsp.readFile(one2html)), '140c347e192d8bed8225f01a4c736e04c19bed241589d46cdc8b241b906eadb0')
  assert.equal(hash(await fsp.readFile(path.join(root, 'resources', 'onenote', 'windows', 'one2html.exe'))), 'cfcba9231edf433e3f84b92a7ce119ec4af3df870301691bbefea83618f295af')
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
  assert.match(main, /require\('\.\/onenote-importer\.cjs'\)/u)
  assert.match(main, /materializeOneNoteTools/u)
  assert.match(main, /extensions:\s*\['one', 'onetoc2', 'onepkg', 'zip'\]/u)
  assert.match(preload, /importOneNote:\s*\(\)/u)
  assert.match(settings, /Microsoft OneNote Import/u)
  assert.match(settings, /\.one · \.onetoc2 · \.onepkg · OneDrive-ZIP/u)
  assert.match(worksheetLayer, /sandbox=""/u)
  assert.match(worksheetLayer, /page\.clientWidth \/ \(initialDocument\.pageWidth/u)
  const packageConfig = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(packageConfig.build.files.includes('resources/onenote/**/*'))
  assert.equal(packageConfig.build.linux.extraResources, undefined)
  assert.equal(packageConfig.build.win.extraResources, undefined)
  console.log('OneNote-Import erfolgreich: direkte, gezippte und .onepkg-Notizbücher, Hierarchie, Originalquellen, Suchtext, MathML, Ink, Bilder, CSP, Sandbox und hashgeprüfte Delta-Ressourcen geprüft.')
})().finally(() => fsp.rm(temporary, { recursive: true, force: true })).catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
