'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')

const archives = process.argv.slice(2).map((candidate) => path.resolve(candidate))
if (!archives.length) {
  throw new Error('Mindestens ein app.asar-Pfad muss angegeben werden.')
}

for (const archive of archives) {
  assert.ok(fs.existsSync(archive), `Das Paketarchiv fehlt: ${archive}`)

  const packedI18n = asar.extractFile(archive, 'electron/i18n.cjs')
  const packedEnglish = asar.extractFile(archive, 'resources/i18n/en.json')
  const englishCatalog = JSON.parse(packedEnglish.toString('utf8'))

  assert.equal(englishCatalog['Unbenannte Notiz'], 'Untitled note')
  assert.equal(englishCatalog['Neuer Ordner'], 'New folder')

  // Execute the exact i18n module from the package without its resource tree.
  // Core vault operations must still work if a legacy/damaged delta omitted the
  // catalog, while intact packages are required to contain the full catalog.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-packed-i18n-'))
  const modulePath = path.join(temporary, 'electron', 'i18n.cjs')
  fs.mkdirSync(path.dirname(modulePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(modulePath, packedI18n, { mode: 0o600 })
  const packagedI18n = require(modulePath)
  assert.equal(packagedI18n.localizeText('Unbenannte Notiz', 'en'), 'Untitled note')
  assert.equal(packagedI18n.localizeText('Neuer Ordner', 'en'), 'New folder')
  fs.rmSync(temporary, { recursive: true, force: true })

  console.log(`FaNotes-Paketlokalisierung geprüft: ${archive}`)
}
