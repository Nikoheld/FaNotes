'use strict'

const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { safeEntryName } = require('../electron/entry-names.cjs')
const { publishNewFile } = require('../electron/exclusive-publish.cjs')
const { MAX_RECORD_BYTES, createAddonStore } = require('../electron/addons.cjs')
const { MAX_CAPTURE_BYTES, encodeWindowCapture } = require('../electron/window-capture.cjs')
const { coerceWorksheetBytes } = require('../electron/worksheet-bytes.cjs')

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
assert.deepEqual([...coerceWorksheetBytes(Buffer.from([1, 2, 3]), 8)], [1, 2, 3])
assert.deepEqual([...coerceWorksheetBytes(new Uint8Array([4, 5]), 8)], [4, 5])
assert.throws(() => coerceWorksheetBytes({ length: 100_000_000 }, 32), /zu groß/u)
assert.throws(() => coerceWorksheetBytes(new Uint8Array(40), 32), /zu groß/u)
assert.throws(() => coerceWorksheetBytes(9, 32), /zu groß/u)

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
    const unsupported = async () => {
      const error = new Error('hard links are unavailable')
      error.code = 'ENOTSUP'
      throw error
    }
    await assert.rejects(publishNewFile(second, target, unsupported), { code: 'EEXIST' })
    assert.equal(await fsp.readFile(target, 'utf8'), 'original')
    const created = path.join(directory, 'Neu.pdf')
    await publishNewFile(second, created, unsupported)
    assert.equal(await fsp.readFile(created, 'utf8'), 'replacement')
  } finally {
    await fsp.rm(directory, { recursive: true, force: true })
  }
}

function fakeCapture(width, height) {
  return {
    getSize: () => ({ width, height }),
    resize(options) { return fakeCapture(options.width, options.height) },
    toJPEG(quality) { return Buffer.alloc(Math.max(1, Math.ceil(width * height * (quality / 400)))) },
  }
}

async function assertAddonRecordCap() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-addon-cap-'))
  try {
    const store = createAddonStore(root)
    await store.save({ id: 'alpha', title: 'Alpha' })
    await assert.rejects(store.save({ id: 'huge', title: 'x'.repeat(MAX_RECORD_BYTES + 1) }), /zu groß/u)
    const listed = await store.list()
    assert.deepEqual(listed.map((item) => item.id), ['alpha'])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

function assertWindowCaptureBound() {
  const encoded = encodeWindowCapture(fakeCapture(4000, 3000))
  assert.match(encoded, /^data:image\/jpeg;base64,/u)
  const bytes = Buffer.from(encoded.slice(encoded.indexOf(',') + 1), 'base64')
  assert.ok(bytes.length <= MAX_CAPTURE_BYTES)
  assert.throws(() => encodeWindowCapture({ getSize: () => ({ width: 0, height: 10 }), toJPEG: () => Buffer.from([1]) }), /leer/u)
}

void Promise.all([assertExclusivePublish(), assertAddonRecordCap()]).then(() => {
  assertWindowCaptureBound()
  console.log('Desktop-Schutz geprüft: reservierte Dateinamen, exklusives Anlegen, Add-on-Größe und Fensterbild.')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
