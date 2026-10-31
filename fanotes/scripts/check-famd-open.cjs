'use strict'

/**
 * Heavy `.famd` opens must stay off the UI thread.
 * The digest check uses the old bit loop, so a faster CRC table cannot
 * disagree with notes already on disk.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  FamdCorruptError,
  composeFamdCompanion,
  emptyFamdPayload,
  openFamdFile,
  parseFamd,
  readFamdCompanion,
  serializeFamd,
} = require('../electron/famd.cjs')
const { crcHex } = require('../electron/famdV2.mjs')
const {
  INK_PACK_POINTS,
  expandPackedInk,
  frameBudgetOpen,
} = require('../electron/famdPack.mjs')
const { close, composeFile, openFile } = require('../electron/famdOpenPool.cjs')

const MAX_DRAWING_JSON_BYTES = 24 * 1024 * 1024

const crc32BitHex = (text) => {
  const bytes = new TextEncoder().encode(text)
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

assert.equal(crcHex('123456789'), 'cbf43926')
assert.equal(crcHex('123456789'), crc32BitHex('123456789'))
assert.equal(crcHex('Größe'), crc32BitHex('Größe'))
assert.equal(crcHex(''), crc32BitHex(''))
assert.equal(crcHex('fanotes-famd:v2'), crc32BitHex('fanotes-famd:v2'))

assert.equal(frameBudgetOpen(0, 100, 0, 6), true)
assert.equal(frameBudgetOpen(0, 100, 1, 6), false)
assert.equal(frameBudgetOpen(0, 3, 4, 6), true)

const frameWholeList = () => {
  const total = 8
  let index = 0
  let frames = 0
  let now = 0
  let largest = 0
  while (index < total) {
    const started = now
    let painted = 0
    while (index < total && frameBudgetOpen(started, now, painted, 6)) {
      index += 1
      painted += 1
      now += 10
    }
    largest = Math.max(largest, painted)
    frames += 1
    if (frames > total) break
  }
  assert.equal(index, total)
  assert.ok(frames > 1)
  assert.ok(largest < total)
  assert.ok(frames <= total)
}
frameWholeList()

const makeStroke = (index, count, pointer, withNote = false) => {
  const points = new Array(count)
  for (let sample = 0; sample < count; sample += 1) {
    const point = {
      x: ((index * 3 + sample) % 97) / 97,
      y: ((index * 5 + sample * 2) % 89) / 89,
      t: sample * 12 + index,
      pressure: 0.35 + (sample % 5) * 0.1,
      tiltX: (sample % 7) - 3,
      tiltY: 4,
      pointerType: pointer === 'mixed' ? (sample % 2 === 0 ? 'pen' : 'mouse') : 'pen',
    }
    if (withNote && sample === 0) point.note = 'Größe'
    points[sample] = point
  }
  return { color: '#203040', baseWidth: 3, points }
}

const documentWith = (strokeCount, samples) => ({
  schemaVersion: 1,
  title: 'Handschrift',
  paperStyle: 'plain',
  sourceWidth: 794,
  sourceHeight: 1123,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
  strokes: [
    makeStroke(0, 12, 'mixed', true),
    ...Array.from({ length: strokeCount }, (_, index) => makeStroke(index + 1, samples, 'pen', true)),
  ],
  sections: [{
    id: 'sec-hidden',
    top: 0.1,
    bodyTop: 0.2,
    collapsed: true,
    hidden: {
      widthPx: 794,
      heightPx: 180,
      strokes: [makeStroke(5000, 24, 'pen', true)],
    },
  }],
  inkHistory: {
    extras: [makeStroke(5001, 16, 'pen', true)],
    undo: [[{ extra: 0 }]],
    redo: [],
  },
})

const sameSample = (left, right, label) => {
  assert.ok(left && right, label)
  assert.ok(Math.abs(left.x - right.x) <= 1e-4, `${label} x`)
  assert.ok(Math.abs(left.y - right.y) <= 1e-4, `${label} y`)
  assert.equal(left.pressure, right.pressure, `${label} pressure`)
  assert.equal(left.t, right.t, `${label} t`)
  assert.equal(left.tiltX, right.tiltX, `${label} tiltX`)
  assert.equal(left.tiltY, right.tiltY, `${label} tiltY`)
  assert.equal(left.pointerType, right.pointerType, `${label} pointer`)
  assert.equal(left.note, right.note, `${label} note`)
}

const sameStroke = (left, right, label) => {
  assert.equal(left.points.length, right.points.length, label)
  sameSample(left.points[0], right.points[0], `${label} first`)
  sameSample(left.points.at(-1), right.points.at(-1), `${label} last`)
  assert.equal(left.color, right.color, label)
}

const assertRoundTrip = (source) => {
  const opened = openFamdFile(source)
  assert.ok(opened.packedInk?.columns, 'medium page stays in columns')
  assert.ok(opened.packedInk.columns.length >= INK_PACK_POINTS * 6)
  const slimBytes = Buffer.byteLength(JSON.stringify(opened.ink), 'utf8')
  const full = readFamdCompanion(source)
  const fullBytes = Buffer.byteLength(JSON.stringify(full.ink), 'utf8')
  assert.ok(slimBytes < fullBytes / 5, `slim ${slimBytes} vs full ${fullBytes}`)
  assert.ok(slimBytes < MAX_DRAWING_JSON_BYTES)
  const expanded = expandPackedInk(opened.ink, opened.packedInk)
  sameStroke(expanded.strokes[0], full.ink.strokes[0], 'mixed')
  sameStroke(expanded.strokes.at(-1), full.ink.strokes.at(-1), 'last')
  const hidden = expanded.sections[0].hidden.strokes[0]
  const hiddenFull = full.ink.sections[0].hidden.strokes[0]
  sameStroke(hidden, hiddenFull, 'hidden')
  sameStroke(expanded.inkHistory.extras[0], full.ink.inkHistory.extras[0], 'history')
  assert.equal(expanded.inkHistory.undo.length, 1)
  assert.deepEqual(expanded.inkHistory.undo[0], [{ extra: 0 }])
  return { opened, slimBytes }
}

const mediumInk = documentWith(200, 80)
const mediumSource = serializeFamd('# Medium\n\nDer Text bleibt vorn.\n', {
  ...emptyFamdPayload('2026-10-31T00:00:00.000Z'),
  ink: mediumInk,
}, 'v2')
assert.ok(mediumSource.includes('fanotes-famd:v2'))
const medium = assertRoundTrip(mediumSource)

const broken = mediumSource.replace(/crc=[0-9a-f]{8}/u, 'crc=00000000')
assert.throws(() => openFamdFile(broken), (error) => error instanceof FamdCorruptError)

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-famd-open-'))
const mediumPath = path.join(directory, 'medium.famd')
const heavyPath = path.join(directory, 'heavy.famd')

const run = async () => {
  fs.writeFileSync(mediumPath, mediumSource)
  const markdown = '# Medium\n\nDer Text bleibt vorn.\n'
  const syncText = composeFamdCompanion(mediumSource, markdown, undefined, 'plain')
  const workerText = await composeFile(mediumPath, markdown, 'plain', 40 * 1024 * 1024)
  const syncParsed = parseFamd(syncText)
  const workerParsed = parseFamd(workerText)
  assert.equal(workerParsed.markdown, syncParsed.markdown)
  assert.notEqual(workerParsed.payload.updatedAt, undefined)
  const syncInk = { ...syncParsed.payload, updatedAt: 'same' }
  const workerInk = { ...workerParsed.payload, updatedAt: 'same' }
  assert.deepEqual(workerInk, syncInk)

  const workerOpen = await openFile(mediumPath, 40 * 1024 * 1024)
  assert.equal(workerOpen.packedInk.columns.length, medium.opened.packedInk.columns.length)
  sameStroke(
    expandPackedInk(workerOpen.ink, workerOpen.packedInk).strokes[0],
    readFamdCompanion(mediumSource).ink.strokes[0],
    'worker mixed',
  )

  const heavyInk = {
    schemaVersion: 1,
    title: 'Handschrift',
    strokes: Array.from({ length: 4000 }, (_, index) => makeStroke(index, 80, 'pen')),
  }
  const heavySource = serializeFamd('# Heavy\n', {
    ...emptyFamdPayload('2026-10-31T00:00:00.000Z'),
    ink: heavyInk,
  }, 'v2')
  fs.writeFileSync(heavyPath, heavySource)
  let maxGap = 0
  let last = Date.now()
  let ticks = 0
  const timer = setInterval(() => {
    const now = Date.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    ticks += 1
  }, 5)
  const opened = await openFile(heavyPath, 40 * 1024 * 1024)
  clearInterval(timer)
  const slimBytes = Buffer.byteLength(JSON.stringify(opened.ink), 'utf8')
  assert.ok(opened.packedInk.columns.length === 4000 * 80 * 6, `columns ${opened.packedInk.columns.length}`)
  assert.ok(slimBytes < MAX_DRAWING_JSON_BYTES, `slim drawing json ${slimBytes}`)
  assert.ok(maxGap < 300, `main-thread gap ${maxGap}ms over ${ticks} ticks`)
  assert.ok(ticks >= 1, `main-thread ticks ${ticks}`)
  console.log(`famd open ok slim=${medium.slimBytes} heavySlim=${slimBytes} gap=${maxGap}ms ticks=${ticks}`)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await close().catch(() => undefined)
  fs.rmSync(directory, { recursive: true, force: true })
})
