'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const locations = require('./folder-locations.cjs')

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-locations-'))
  const vault = path.join(dir, 'vault')
  const amat = path.join(vault, 'amat')
  const extra = path.join(dir, 'extra')
  const other = path.join(dir, 'other')
  fs.mkdirSync(amat, { recursive: true })
  fs.mkdirSync(extra, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  return { dir, vault, amat, extra, other }
}

test('a folder can show files from two directories and new notes use the first', async () => {
  const { dir, vault, extra, other } = scratch()
  fs.writeFileSync(path.join(extra, 'Eins.md'), '# Eins\n')
  fs.writeFileSync(path.join(other, 'Zwei.md'), '# Zwei\n')
  fs.writeFileSync(path.join(extra, 'Gleich.md'), 'primary\n')
  fs.writeFileSync(path.join(other, 'Gleich.md'), 'secondary\n')
  const store = locations.loadStore(dir)
  const map = {}
  const first = await locations.validateLocation(vault, extra, [], map, 'amat')
  const second = await locations.validateLocation(vault, other, [first], map, 'amat')
  map.amat = [first, second]
  const roots = locations.contentRoots(map, vault, 'amat')
  assert.equal(roots.mapped, true)
  assert.equal(roots.primary, first)
  const primary = await locations.resolveLocated({
    vault, logical: 'amat/Gleich.md', map, expected: 'file',
  })
  assert.equal(fs.readFileSync(primary.target, 'utf8'), 'primary\n')
  const secondFile = await locations.resolveLocated({
    vault, logical: 'amat/Zwei.md', map, expected: 'file',
  })
  assert.equal(path.basename(secondFile.target), 'Zwei.md')
  assert.equal(locations.identityPath(vault, secondFile.target, map), 'amat/Zwei.md')
  assert.equal(await locations.resolveLocated({
    vault, logical: 'amat', map, expected: 'directory',
  }), null)
  const content = await locations.resolveLocated({
    vault, logical: 'amat', map, expected: 'directory', asContent: true,
  })
  assert.equal(content.target, first)
})

test('moving into a new folder leaves conflicts behind and clears the old copies', async () => {
  const { dir, vault, amat, extra } = scratch()
  fs.writeFileSync(path.join(amat, 'Alt.md'), 'alt\n')
  fs.mkdirSync(path.join(amat, 'Unter'))
  fs.writeFileSync(path.join(amat, 'Unter', 'Tief.md'), 'tief\n')
  fs.writeFileSync(path.join(extra, 'Alt.md'), 'schon da\n')
  const report = await locations.moveContents(amat, extra)
  assert.equal(report.moved, 1)
  assert.deepEqual(report.conflicts, ['Alt.md'])
  assert.equal(fs.readFileSync(path.join(extra, 'Unter', 'Tief.md'), 'utf8'), 'tief\n')
  assert.equal(fs.existsSync(path.join(amat, 'Unter', 'Tief.md')), false)
  assert.equal(fs.readFileSync(path.join(amat, 'Alt.md'), 'utf8'), 'alt\n')
  assert.equal(fs.readFileSync(path.join(extra, 'Alt.md'), 'utf8'), 'schon da\n')
  const store = locations.loadStore(dir)
  locations.writeMap(store, vault, { amat: [extra] })
  locations.saveStore(dir, store)
  const loaded = locations.mapFor(locations.loadStore(dir), vault)
  assert.deepEqual(loaded.amat, [path.resolve(extra)])
})

test('a path inside the vault or inside another folder is refused', async () => {
  const { vault, amat, extra, other } = scratch()
  await assert.rejects(
    () => locations.validateLocation(vault, amat, [], {}, 'amat'),
    /nicht im Vault/,
  )
  const first = await locations.validateLocation(vault, extra, [], {}, 'amat')
  const nested = path.join(extra, 'nested')
  fs.mkdirSync(nested)
  await assert.rejects(
    () => locations.validateLocation(vault, nested, [first], {}, 'amat'),
    /überlappen/,
  )
  await assert.rejects(
    () => locations.validateLocation(vault, nested, [], { amat: [first] }, 'physik'),
    /bereits einem anderen/,
  )
  const second = await locations.validateLocation(vault, other, [], { amat: [first] }, 'physik')
  assert.notEqual(second, first)
  const link = path.join(path.dirname(vault), 'link')
  fs.symlinkSync(extra, link)
  await assert.rejects(
    () => locations.validateLocation(vault, link, [], {}, 'amat'),
    /Symbolische Links/,
  )
})

test('renaming the folder keeps its paths', () => {
  const map = { amat: ['/tmp/amat'], 'amat/haus': ['/tmp/haus'], physik: ['/tmp/physik'] }
  const renamed = locations.retargetMap(map, 'amat', 'schule/amat')
  assert.deepEqual(renamed['schule/amat'], ['/tmp/amat'])
  assert.deepEqual(renamed['schule/amat/haus'], ['/tmp/haus'])
  assert.deepEqual(renamed.physik, ['/tmp/physik'])
  assert.equal(renamed.amat, undefined)
  const forgotten = locations.forgetMap(renamed, 'schule/amat')
  assert.deepEqual(Object.keys(forgotten), ['physik'])
})
