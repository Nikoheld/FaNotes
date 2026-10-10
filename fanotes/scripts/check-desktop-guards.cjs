'use strict'

const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { safeEntryName } = require('../electron/entry-names.cjs')
const { publishNewFile } = require('../electron/exclusive-publish.cjs')

assert.equal(safeEntryName('  Mathe  ', 'Notiz'), 'Mathe')
assert.equal(safeEntryName('', 'Unbenannte Notiz'), 'Unbenannte Notiz')
assert.equal(safeEntryName('Kapitel.', 'Notiz'), 'Kapitel')
assert.throws(() => safeEntryName('CON.md', 'Notiz'), /nicht erlaubt/u)
assert.throws(() => safeEntryName('nul.txt', 'Notiz'), /nicht erlaubt/u)
assert.throws(() => safeEntryName('COM1', 'Notiz'), /nicht erlaubt/u)
assert.throws(() => safeEntryName('aux.tar.md', 'Notiz'), /nicht erlaubt/u)
assert.throws(() => safeEntryName('Notiz:1', 'Notiz'), /nicht erlaubt/u)
assert.throws(() => safeEntryName('a<b', 'Notiz'), /nicht erlaubt/u)
assert.throws(() => safeEntryName('.fanotes', 'Notiz'), /nicht erlaubt/u)
assert.throws(() => safeEntryName('../Geheim', 'Notiz'), /nicht erlaubt/u)
assert.equal(safeEntryName('comic.md', 'Notiz'), 'comic.md')
assert.equal(safeEntryName('COM10.md', 'Notiz'), 'COM10.md')

async function assertExclusivePublish() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-exclusive-'))
  try {
    const target = path.join(directory, 'Buch.pdf')
    const first = path.join(directory, 'first.tmp')
    const second = path.join(directory, 'second.tmp')
    await fsp.writeFile(first, 'original')
    await fsp.writeFile(second, 'replacement')
    await publishNewFile(first, target)
    assert.equal(await fsp.readFile(target, 'utf8'), 'original')
    await assert.rejects(publishNewFile(second, target), { code: 'EEXIST' })
    assert.equal(await fsp.readFile(target, 'utf8'), 'original')
    assert.equal(await fsp.readFile(second, 'utf8'), 'replacement')
    const link = path.join(directory, 'link.pdf')
    await fsp.symlink(target, link)
    const third = path.join(directory, 'third.tmp')
    await fsp.writeFile(third, 'via-link')
    await assert.rejects(publishNewFile(third, link), { code: 'EEXIST' })
    assert.equal(await fsp.readFile(target, 'utf8'), 'original')
  } finally {
    await fsp.rm(directory, { recursive: true, force: true })
  }
}

void assertExclusivePublish().then(() => {
  console.log('Desktop-Schutz geprüft: reservierte Dateinamen und exklusives Anlegen.')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
