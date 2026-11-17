// Regression check for the "Textfeld" tool on PDF notes.
// Part 1: pure logic (storage format, backward compatibility, geometry helpers).
// Part 1b: per-box merge of several windows, devices and shares (concurrent add, delete vs edit,
//          absorbing remote boxes), write queue, and the .famd round trip with the real codecs.
// Part 2: real Chromium via playwright-core (skipped with FANOTES_SKIP_BROWSER=1 or when no browser exists).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: Number(process.env.FANOTES_CHECK_PORT ?? 0), fs: { strict: false } },
})

await server.listen()
const fields = await server.ssrLoadModule('/src/lib/noteTextField.ts')
const famdTs = await server.ssrLoadModule('/src/lib/famd.ts')
const famd = createRequire(import.meta.url)('../electron/famd.cjs')
const merge = await import(pathToFileURL(join(root, 'electron/noteTextFieldMerge.mjs')).href)

// ---- Part 1: logic -------------------------------------------------------
const legacy = { id: 'tf-old', page: 2, x: 0.25, y: 0.4, width: 0.3, fontSize: 18, text: 'Alt äöü' }
const [loaded] = fields.parseNoteTextFields([legacy])
assert.deepEqual(loaded, legacy, 'a field written by an older build must load unchanged (no new keys)')
const styled = fields.parseNoteTextFields([{ ...legacy, color: '#C62F4A', bold: true }])[0]
assert.equal(styled.color, '#c62f4a')
assert.equal(styled.bold, true)
assert.equal(fields.parseNoteTextFields([{ ...legacy, color: 'red; background:url(x)', bold: 'yes' }])[0].color, undefined, 'only #rrggbb colours are stored')
assert.equal('bold' in fields.parseNoteTextFields([{ ...legacy, bold: 'yes' }])[0], false)
const patched = fields.patchNoteTextField([styled], 'tf-old', { color: undefined, bold: undefined })[0]
assert.equal('color' in patched || 'bold' in patched, false, 'clearing colour and bold drops the keys again')
assert.equal(fields.stepNoteTextFieldFontSize(16, 1), 18)
assert.equal(fields.stepNoteTextFieldFontSize(16, -1), 14)
assert.equal(fields.stepNoteTextFieldFontSize(48, 1), 48)
assert.equal(fields.stepNoteTextFieldFontSize(10, -1), 10)
assert.equal(fields.stepNoteTextFieldFontSize(17, 1), 18)
assert.equal(fields.stepNoteTextFieldFontSize(17, -1), 16)
const pages = [
  { page: 1, left: 100, top: 0, width: 400, height: 500 },
  { page: 2, left: 100, top: 520, width: 400, height: 500 },
]
assert.deepEqual(fields.noteTextFieldPointFromRects(pages, 300, 750), { page: 2, x: 0.5, y: 0.46 })
const gutter = fields.noteTextFieldPointFromRects(pages, 300, 515)
assert.equal(gutter.page, 2, 'the gutter snaps to the nearest page, not page 1')
assert.equal(gutter.y, 0)
assert.equal(fields.noteTextFieldPointFromRects(pages, 900, 1200).page, 2, 'dragging past the sheet clamps to the last page')
assert.equal(fields.noteTextFieldPointFromRects(pages, 900, 1200).x, 1)
// ---- Part 1b: per-box merge ----------------------------------------------
const box = (id, text, extra = {}) => fields.parseNoteTextFields([{ id, page: 1, x: 0.2, y: 0.3, width: 0.3, fontSize: 16, text, ...extra }])[0]
const texts = (list) => list.map((item) => `${item.id}=${item.text}`).sort()
const STAMP = 1_731_800_000_000

// Stamps: kept by both sanitizers, junk is dropped, old files stay free of the new keys.
const stamped = box('tf-s', 'a', { updatedAt: STAMP })
assert.equal(stamped.updatedAt, STAMP)
assert.equal(famd.parseNoteTextFields([stamped])[0].updatedAt, STAMP, 'the main-process sanitizer keeps the stamp')
assert.equal(box('tf-f', 'a', { updatedAt: STAMP + 0.9 }).updatedAt, STAMP, 'a stamp is a whole millisecond')
for (const junk of [0, -5, String(STAMP), Infinity, NaN, 1e300, null, {}]) {
  assert.equal('updatedAt' in box('tf-j', 'a', { updatedAt: junk }), false, `renderer drops stamp ${String(junk)}`)
  assert.equal('updatedAt' in famd.parseNoteTextFields([{ ...legacy, updatedAt: junk }])[0], false, `main drops stamp ${String(junk)}`)
}
assert.equal('updatedAt' in famd.parseNoteTextFields([legacy])[0], false, 'a legacy box gains no stamp when it is only read')

// Tombstones: newest first, one per id, junk dropped, the same in both parsers.
const rawTombs = [{ id: 'tf-a', deletedAt: 10 }, { id: 'tf-a', deletedAt: 30 }, { id: 'bad id', deletedAt: 5 }, { id: 'tf-b', deletedAt: 'x' }, null, 7, { id: 'tf-c', deletedAt: 20 }]
assert.deepEqual(famd.parseNoteTextFieldTombstones(rawTombs), [{ id: 'tf-a', deletedAt: 30 }, { id: 'tf-c', deletedAt: 20 }])
assert.deepEqual(fields.parseNoteTextFieldTombstones(rawTombs), famd.parseNoteTextFieldTombstones(rawTombs))
assert.deepEqual(famd.parseNoteTextFieldOps({ upserts: [{ text: 'no id' }, stamped, stamped], deletes: [{ id: 'tf-x', deletedAt: 9 }, { id: '' }] }), {
  upserts: [stamped],
  deletes: [{ id: 'tf-x', deletedAt: 9 }],
}, 'an op without a valid id is dropped, a repeated id counts once')
assert.deepEqual(famd.parseNoteTextFieldOps('junk'), { upserts: [], deletes: [] })

// File format: both encodings and both codecs keep stamps and tombstones, and a reader that only knows
// `textFields` (every older build) never sees a deleted box in it.
const goneBox = { id: 'tf-gone', deletedAt: STAMP + 500 }
for (const encoding of ['v1', 'v2']) {
  const payload = { ...famd.emptyFamdPayload('2026-01-02T00:00:00.000Z'), textFields: [stamped], textFieldTombstones: [goneBox] }
  for (const [label, codec] of [['main', famd], ['renderer', famdTs]]) {
    const text = codec.serializeFamd('Hallo\n', { ...payload }, encoding)
    for (const [readLabel, reader] of [['main', famd], ['renderer', famdTs]]) {
      const back = reader.parseFamd(text).payload
      assert.deepEqual(back.textFields, [stamped], `${label} ${encoding} written, ${readLabel} read: boxes`)
      assert.deepEqual(back.textFieldTombstones, [goneBox], `${label} ${encoding} written, ${readLabel} read: tombstones`)
      assert.equal(back.textFields.some((item) => item.id === goneBox.id), false, 'a deleted box is not an entry of textFields')
    }
  }
  const plain = famd.serializeFamd('Hallo\n', { ...famd.emptyFamdPayload('2026-01-02T00:00:00.000Z'), textFields: [legacy] }, encoding)
  assert.equal(plain.includes('textFieldTombstones') || plain.includes('updatedAt":17'), false, `${encoding}: a legacy note gains no new keys`)
  assert.deepEqual(famd.parseFamd(plain).payload.textFields, [legacy])
}

// patch / place stamp real edits only.
const patchedLater = fields.patchNoteTextField([stamped], 'tf-s', { text: 'b' }, STAMP + 5000)[0]
assert.equal(patchedLater.updatedAt, STAMP + 5000, 'an edit stamps the box')
assert.equal(fields.patchNoteTextField([stamped], 'tf-s', { text: 'b' }, STAMP - 9999)[0].updatedAt, STAMP + 1, 'a stamp is always newer than the one it replaces, even with a slow clock')
assert.deepEqual(fields.patchNoteTextField([stamped], 'tf-s', { text: 'a', fontSize: 16 }, STAMP + 9)[0], stamped, 'a patch that changes nothing keeps the box and its stamp')
assert.ok(fields.placeNoteTextField({ page: 1, x: 0.1, y: 0.1 }).updatedAt > 0, 'a placed box carries a stamp')

// diff: only what changed is sent.
{
  const base = [box('tf-a', 'eins', { updatedAt: 100 }), box('tf-b', 'zwei', { updatedAt: 100 }), box('tf-c', 'drei')]
  assert.deepEqual(merge.diffNoteTextFields(base, base, 500), { upserts: [], deletes: [] }, 'untouched boxes send nothing')
  const local = [{ ...base[0], text: 'eins!', updatedAt: 300 }, base[1], box('tf-new', 'neu', { updatedAt: 310 })]
  const ops = merge.diffNoteTextFields(base, local, 500)
  assert.deepEqual(texts(ops.upserts), ['tf-a=eins!', 'tf-new=neu'])
  assert.equal(ops.upserts.find((item) => item.id === 'tf-a').updatedAt, 300, 'a fresh stamp is kept')
  assert.deepEqual(ops.deletes, [{ id: 'tf-c', deletedAt: 500 }])
  const unstamped = merge.diffNoteTextFields(base, [{ ...base[1], x: 0.9 }], 500)
  assert.equal(unstamped.upserts[0].updatedAt, 500, 'a change without a fresh stamp (a page remap) is stamped when it is sent')
  const slow = merge.diffNoteTextFields(base, [{ ...base[0], text: 'x' }], 50)
  assert.equal(slow.upserts[0].updatedAt, 101, 'the stamp is newer than the base copy even when the local clock runs behind')
  // empty boxes: a new one stays in the window, one the disk already knows is kept.
  const fresh = box('tf-e', '')
  const knownEmpty = box('tf-k', '  ')
  assert.deepEqual(merge.persistableNoteTextFields([base[0], fresh, knownEmpty], [knownEmpty]).map((item) => item.id), ['tf-a', 'tf-k'])
}

// apply (main process): concurrent adds keep both, per-box newest wins, delete vs edit by time.
{
  const NOW = 10_000
  const alpha = box('tf-a', 'Fenster 1', { updatedAt: 1000 })
  const beta = box('tf-b', 'Fenster 2', { updatedAt: 1100 })
  const one = merge.applyNoteTextFieldOps([], [], { upserts: [alpha], deletes: [] }, NOW)
  const two = merge.applyNoteTextFieldOps(one.fields, one.tombstones, { upserts: [beta], deletes: [] }, NOW)
  assert.deepEqual(texts(two.fields), ['tf-a=Fenster 1', 'tf-b=Fenster 2'], 'a box added in a second window does not replace the first window\'s box')
  const reversed = merge.applyNoteTextFieldOps(merge.applyNoteTextFieldOps([], [], { upserts: [beta], deletes: [] }, NOW).fields, [], { upserts: [alpha], deletes: [] }, NOW)
  assert.deepEqual(texts(reversed.fields), texts(two.fields), 'the arrival order does not matter')

  // the same box edited twice: the newer edit stays even when the older one arrives last
  const newer = { ...alpha, text: 'neu', updatedAt: 3000 }
  const older = { ...alpha, text: 'alt', updatedAt: 2000 }
  const keep = merge.applyNoteTextFieldOps([newer], [], { upserts: [older, beta], deletes: [] }, NOW)
  assert.equal(keep.fields.find((item) => item.id === 'tf-a').text, 'neu', 'a late older edit never overwrites a newer one')
  assert.ok(keep.fields.some((item) => item.id === 'tf-b'), 'but the other boxes of that write still land')
  assert.equal(merge.applyNoteTextFieldOps([older], [], { upserts: [{ ...newer }], deletes: [] }, NOW).fields[0].text, 'neu')
  assert.equal(merge.applyNoteTextFieldOps([newer], [], { upserts: [{ ...newer, text: 'same stamp' }], deletes: [] }, NOW).fields[0].text, 'same stamp', 'the same stamp: the latest write wins')

  // delete vs edit
  const afterDelete = merge.applyNoteTextFieldOps([alpha], [], { upserts: [], deletes: [{ id: 'tf-a', deletedAt: 2000 }] }, NOW)
  assert.deepEqual(afterDelete.fields, [])
  assert.deepEqual(afterDelete.tombstones, [{ id: 'tf-a', deletedAt: 2000 }])
  const staleEdit = merge.applyNoteTextFieldOps(afterDelete.fields, afterDelete.tombstones, { upserts: [{ ...alpha, text: 'getippt vor dem Löschen', updatedAt: 1500 }], deletes: [] }, NOW)
  assert.deepEqual(staleEdit.fields, [], 'an edit made before the delete does not bring the box back')
  const laterEdit = merge.applyNoteTextFieldOps(afterDelete.fields, afterDelete.tombstones, { upserts: [{ ...alpha, text: 'getippt nach dem Löschen', updatedAt: 2500 }], deletes: [] }, NOW)
  assert.deepEqual(texts(laterEdit.fields), ['tf-a=getippt nach dem Löschen'], 'an edit made after the delete keeps the typed text')
  assert.deepEqual(laterEdit.tombstones, [], 'a box that is back loses its tombstone')
  const lateDelete = merge.applyNoteTextFieldOps([{ ...alpha, text: 'bearbeitet', updatedAt: 3000 }], [], { upserts: [], deletes: [{ id: 'tf-a', deletedAt: 2000 }] }, NOW)
  assert.deepEqual(texts(lateDelete.fields), ['tf-a=bearbeitet'], 'a delete older than the stored edit is ignored')
  assert.deepEqual(lateDelete.tombstones, [])
  const sameInstant = merge.applyNoteTextFieldOps([{ ...alpha, updatedAt: 2000 }], [], { upserts: [], deletes: [{ id: 'tf-a', deletedAt: 2000 }] }, NOW)
  assert.equal(sameInstant.fields.length, 1, 'a delete and an edit at the very same millisecond: the box stays')
  assert.equal(merge.applyNoteTextFieldOps([], [{ id: 'tf-a', deletedAt: 2000 }], { upserts: [{ ...alpha, updatedAt: 2000 }], deletes: [] }, NOW).fields.length, 1)
  const twoDeletes = merge.applyNoteTextFieldOps([], [{ id: 'tf-a', deletedAt: 3000 }], { upserts: [], deletes: [{ id: 'tf-a', deletedAt: 2000 }] }, NOW)
  assert.deepEqual(twoDeletes.tombstones, [{ id: 'tf-a', deletedAt: 3000 }], 'the newest delete time is kept')
  assert.deepEqual(merge.applyNoteTextFieldOps([alpha], [], { upserts: [], deletes: [{ id: 'tf-never', deletedAt: 5 }] }, NOW).fields.map((item) => item.id), ['tf-a'], 'deleting an unknown box changes nothing else')

  // housekeeping: old tombstones expire, the list is capped, a skewed clock cannot win for ever, the box limit holds
  const DAY = 24 * 3600 * 1000
  const aged = merge.applyNoteTextFieldOps([], [{ id: 'tf-old', deletedAt: NOW - 31 * DAY }, { id: 'tf-recent', deletedAt: NOW - DAY }], { upserts: [], deletes: [] }, NOW)
  assert.deepEqual(aged.tombstones, [{ id: 'tf-recent', deletedAt: NOW - DAY }])
  const crowd = merge.applyNoteTextFieldOps([], [], { upserts: [], deletes: Array.from({ length: 260 }, (_, index) => ({ id: `tf-d${index}`, deletedAt: NOW - index })) }, NOW)
  assert.equal(crowd.tombstones.length, 200)
  assert.equal(crowd.tombstones[0].id, 'tf-d0', 'the newest tombstones survive the cap')
  const future = merge.applyNoteTextFieldOps([], [], { upserts: [{ ...alpha, updatedAt: NOW + 400 * DAY }], deletes: [] }, NOW)
  assert.ok(future.fields[0].updatedAt <= NOW + 5 * 60 * 1000, 'a stamp from a clock far ahead is clamped')
  // ... and a box that such a clock already stamped can still be edited here by someone who saw that version.
  const poisoned = box('tf-p', 'von der falschen Uhr', { updatedAt: NOW + 400 * DAY })
  const repaired = merge.applyNoteTextFieldOps([poisoned], [], { upserts: [{ ...poisoned, text: 'hier korrigiert', updatedAt: poisoned.updatedAt + 1 }], deletes: [] }, NOW)
  assert.equal(repaired.fields[0].text, 'hier korrigiert', 'a box stamped far ahead is not locked against edits')
  const poisonedTomb = merge.applyNoteTextFieldOps([], [{ id: 'tf-p', deletedAt: NOW + 400 * DAY }], { upserts: [{ ...poisoned, updatedAt: NOW + 400 * DAY + 1 }], deletes: [] }, NOW)
  assert.equal(poisonedTomb.fields.length, 1, 'a tombstone from a clock far ahead does not lock the box either')
  const many = merge.applyNoteTextFieldOps([], [], { upserts: Array.from({ length: 230 }, (_, index) => box(`tf-m${index}`, 'x', { updatedAt: 1 })), deletes: [] }, NOW)
  assert.equal(many.fields.length, 200)
  assert.equal(merge.applyNoteTextFieldOps(undefined, undefined, undefined, NOW).fields.length, 0, 'missing inputs are tolerated')
}

// absorb (window side): three-way merge of this window, the disk and the disk state this window saw last.
{
  const a = box('tf-a', 'eins', { updatedAt: 100 })
  const b = box('tf-b', 'zwei', { updatedAt: 100 })
  const ids = (list) => list.map((item) => item.id)
  assert.deepEqual(ids(merge.mergeNoteTextFields([a], [a], [a, b])), ['tf-a', 'tf-b'], 'a box another window added comes in')
  assert.equal(merge.mergeNoteTextFields([a], [a], [{ ...a, text: 'eins!', updatedAt: 200 }])[0].text, 'eins!', 'an edit from outside comes in')
  const both = merge.mergeNoteTextFields([a], [{ ...a, x: 0.7, updatedAt: 150 }, box('tf-n', 'neu', { updatedAt: 160 })], [a, b])
  assert.deepEqual(texts(both), ['tf-a=eins', 'tf-b=zwei', 'tf-n=neu'].sort(), 'local edit, local add and remote add all stay')
  assert.equal(both.find((item) => item.id === 'tf-a').x, 0.7)
  assert.deepEqual(ids(merge.mergeNoteTextFields([a, b], [a, b], [a])), ['tf-a'], 'a box deleted elsewhere goes away here')
  assert.deepEqual(ids(merge.mergeNoteTextFields([a, b], [a, { ...b, text: 'zwei!', updatedAt: 150 }], [a])), ['tf-a', 'tf-b'], 'but not when it was edited here: typed text is never dropped')
  assert.deepEqual(ids(merge.mergeNoteTextFields([a, b], [a], [a, b])), ['tf-a'], 'a box deleted here stays deleted')
  assert.deepEqual(ids(merge.mergeNoteTextFields([a, b], [a], [a, { ...b, text: 'zwei!', updatedAt: 150 }])), ['tf-a', 'tf-b'], 'unless it was edited elsewhere meanwhile')
  const clash = merge.mergeNoteTextFields([a], [{ ...a, text: 'hier', updatedAt: 300 }], [{ ...a, text: 'dort', updatedAt: 200 }])
  assert.equal(clash[0].text, 'hier', 'both edited it: the newer edit wins')
  assert.equal(merge.mergeNoteTextFields([a], [{ ...a, text: 'hier', updatedAt: 200 }], [{ ...a, text: 'dort', updatedAt: 300 }])[0].text, 'dort')
  assert.equal(merge.mergeNoteTextFields([a], [{ ...a, text: 'hier', updatedAt: 200 }], [{ ...a, text: 'dort', updatedAt: 200 }])[0].text, 'hier', 'a tie stays local')
  assert.deepEqual(ids(merge.mergeNoteTextFields([], [a], [b])), ['tf-a', 'tf-b'], 'nothing known about the disk: both sets are kept')
  const inProgress = box('tf-e', '')
  assert.deepEqual(ids(merge.mergeNoteTextFields([a], [a, inProgress], [a, b])), ['tf-a', 'tf-e', 'tf-b'], 'a box still being placed survives an absorb')
  assert.equal(merge.mergeNoteTextFields([a], [a], [{ ...a, updatedAt: 999 }])[0].updatedAt, 999, 'same content: the stored copy (and its stamp) is the one kept')
  assert.equal(merge.mergeNoteTextFields([], [], Array.from({ length: 230 }, (_, index) => box(`tf-r${index}`, 'x'))).length, 200)
  assert.ok(merge.noteTextFieldsEqual([a, b], [a, b]) && !merge.noteTextFieldsEqual([a], [{ ...a, updatedAt: 101 }]))
}

// Two windows on one note, driven through the real codecs exactly like the app does it
// (diff against the last seen disk state, the main-process merge inside the write, absorb of the result).
for (const encoding of ['v1', 'v2']) {
  const makeDisk = () => {
    let source = famd.serializeFamd('Text\n', famd.emptyFamdPayload('2026-01-01T00:00:00.000Z'), encoding)
    return {
      raw: () => source,
      boxes: () => famd.parseFamd(source).payload?.textFields ?? [],
      tombstones: () => famd.parseFamd(source).payload?.textFieldTombstones ?? [],
      // The main-process handler: parse the ops like the IPC does, read the stored note, apply, write.
      merge(rawOps, now) {
        const ops = famd.parseNoteTextFieldOps(JSON.parse(JSON.stringify(rawOps)))
        if (!ops.upserts.length && !ops.deletes.length) return this.boxes()
        const parsed = famd.parseFamd(source, { unpack: false })
        const merged = merge.applyNoteTextFieldOps(parsed.payload.textFields, parsed.payload.textFieldTombstones, ops, now)
        source = famd.serializeFamd(parsed.markdown, { ...parsed.payload, textFields: merged.fields, textFieldTombstones: merged.tombstones }, famd.famdEncodingForSave(source))
        return merged.fields
      },
    }
  }
  const openWindow = (disk) => {
    const win = { base: fields.parseNoteTextFields(disk.boxes()), live: fields.parseNoteTextFields(disk.boxes()) }
    win.add = (id, text, now) => { win.live = [...win.live, box(id, text, { updatedAt: now })] }
    win.type = (id, text, now) => { win.live = fields.patchNoteTextField(win.live, id, { text }, now) }
    win.remove = (id) => { win.live = win.live.filter((item) => item.id !== id) }
    win.flush = (now) => {
      const persist = merge.persistableNoteTextFields(win.live, win.base)
      const ops = merge.diffNoteTextFields(win.base, persist, now)
      if (!ops.upserts.length && !ops.deletes.length) return
      const stored = fields.parseNoteTextFields(disk.merge(ops, now))
      win.live = fields.parseNoteTextFields(merge.mergeNoteTextFields(persist, win.live, stored))
      win.base = [...stored]
    }
    win.refresh = () => {
      const stored = fields.parseNoteTextFields(disk.merge({ upserts: [], deletes: [] }, 0))
      win.live = fields.parseNoteTextFields(merge.mergeNoteTextFields(win.base, win.live, stored))
      win.base = [...stored]
    }
    return win
  }

  // The reported repro: a box in each window, then edit again in the first.
  {
    const disk = makeDisk()
    const first = openWindow(disk)
    const second = openWindow(disk)
    first.add('tf-1', 'erstes', 1000)
    first.flush(1100)
    second.add('tf-2', 'zweites', 1200)
    second.flush(1300)
    assert.deepEqual(texts(second.live), ['tf-1=erstes', 'tf-2=zweites'], `${encoding}: the second window's write brings the first window's box in`)
    first.type('tf-1', 'erstes, bearbeitet', 1400)
    first.flush(1500)
    assert.deepEqual(texts(disk.boxes()), ['tf-1=erstes, bearbeitet', 'tf-2=zweites'], `${encoding}: the first window's next write no longer deletes the second window's box`)
    assert.deepEqual(texts(first.live), texts(disk.boxes()), `${encoding}: and shows it`)
    second.refresh()
    assert.deepEqual(texts(second.live), texts(disk.boxes()), `${encoding}: a re-read brings the edit to the other window`)
  }

  // Both windows add before either saves; the order of the saves does not matter.
  for (const order of ['12', '21']) {
    const disk = makeDisk()
    const first = openWindow(disk)
    const second = openWindow(disk)
    first.add('tf-1', 'links', 1000)
    second.add('tf-2', 'rechts', 1001)
    for (const which of order) (which === '1' ? first : second).flush(2000 + Number(which))
    first.refresh()
    second.refresh()
    assert.deepEqual(texts(disk.boxes()), ['tf-1=links', 'tf-2=rechts'], `${encoding}: concurrent adds (${order}) keep both`)
    assert.deepEqual(texts(first.live), texts(second.live), `${encoding}: both windows converge (${order})`)
  }

  // Delete vs edit, in both arrival orders; the later action wins either way.
  for (const order of ['delete-first', 'edit-first']) {
    for (const [editAt, deleteAt, expected] of [[1500, 2000, []], [2500, 2000, ['tf-x=nachher getippt']]]) {
      const disk = makeDisk()
      const seed = openWindow(disk)
      seed.add('tf-x', 'Start', 1000)
      seed.flush(1001)
      const editor = openWindow(disk)
      const deleter = openWindow(disk)
      editor.type('tf-x', 'nachher getippt', editAt)
      deleter.remove('tf-x')
      const flushDelete = () => deleter.flush(deleteAt)
      const flushEdit = () => editor.flush(editAt + 10)
      if (order === 'delete-first') { flushDelete(); flushEdit() } else { flushEdit(); flushDelete() }
      editor.refresh()
      deleter.refresh()
      assert.deepEqual(texts(disk.boxes()), expected, `${encoding}: delete at ${deleteAt} vs edit at ${editAt} (${order})`)
      assert.deepEqual(texts(editor.live), expected, `${encoding}: the editing window follows (${order}, edit ${editAt})`)
      assert.deepEqual(texts(deleter.live), expected, `${encoding}: the deleting window follows (${order}, edit ${editAt})`)
    }
  }

  // A box another window deleted disappears here without an edit, and a window that never saw a box cannot delete it.
  {
    const disk = makeDisk()
    const owner = openWindow(disk)
    owner.add('tf-keep', 'bleibt', 1000)
    owner.add('tf-drop', 'geht', 1001)
    owner.flush(1100)
    const viewer = openWindow(disk)
    owner.remove('tf-drop')
    owner.flush(1200)
    viewer.refresh()
    assert.deepEqual(texts(viewer.live), ['tf-keep=bleibt'], `${encoding}: a delete from another window shows up on re-read`)
    const late = openWindow(makeDisk())
    late.add('tf-solo', 'allein', 1)
    late.flush(2)
    assert.deepEqual(late.base.map((item) => item.id), ['tf-solo'])
    assert.equal(disk.tombstones().some((item) => item.id === 'tf-drop'), true, `${encoding}: the delete left a tombstone on disk`)
  }

  // A rejected write (the box was deleted after this edit) does not leave a phantom box behind.
  {
    const disk = makeDisk()
    const seed = openWindow(disk)
    seed.add('tf-x', 'Start', 1000)
    seed.flush(1001)
    const stale = openWindow(disk)
    const other = openWindow(disk)
    other.remove('tf-x')
    other.flush(5000)
    stale.type('tf-x', 'alt getippt', 3000)
    stale.flush(6000)
    assert.deepEqual(disk.boxes(), [], `${encoding}: the older edit does not resurrect the box`)
    assert.deepEqual(stale.live, [], `${encoding}: the window drops the rejected box instead of keeping a phantom`)
  }

  // An empty box another device placed (Android saves it at once) is not deleted by this window.
  {
    const disk = makeDisk()
    disk.merge({ upserts: [box('tf-empty', '', { updatedAt: 500 })], deletes: [] }, 600)
    const win = openWindow(disk)
    win.add('tf-t', 'Text', 700)
    win.flush(800)
    assert.deepEqual(disk.boxes().map((item) => item.id).sort(), ['tf-empty', 'tf-t'], `${encoding}: a known empty box stays on disk`)
    win.add('tf-pending', '', 900)
    win.flush(1000)
    assert.equal(disk.boxes().some((item) => item.id === 'tf-pending'), false, `${encoding}: a box still empty is not written`)
    assert.ok(win.live.some((item) => item.id === 'tf-pending'), `${encoding}: but it stays in the window`)
  }
}

// Writes and re-reads run one after the other, and a caller learns about success only after everything before it is done.
{
  const queue = fields.createSerialJobQueue()
  const log = []
  const job = (name, ms, result = true) => async () => {
    log.push(`start ${name}`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    log.push(`end ${name}`)
    if (result === 'throw') throw new Error(name)
    return result
  }
  const slow = queue.run(job('slow', 60))
  const fast = queue.run(job('fast', 5))
  const reread = queue.run(job('reread', 5), false)
  assert.equal(queue.writes(), 2, 'queued writes count as unsaved, a plain re-read does not')
  assert.equal(await fast, true)
  assert.deepEqual(log.slice(0, 4), ['start slow', 'end slow', 'start fast', 'end fast'], 'jobs never overlap and keep their order')
  assert.equal(log.includes('end slow'), true, 'the second job only reports success after the first finished')
  await slow
  await reread
  assert.equal(queue.writes(), 0)
  const failing = queue.run(job('bad', 1, 'throw'))
  const after = queue.run(job('after', 1))
  await assert.rejects(failing)
  assert.equal(await after, true, 'a failed write does not block the next one')
  assert.equal(await queue.drained(), true)
  assert.equal(queue.writes(), 0)
}

console.log('text box logic ok')

// ---- Part 2: browser -----------------------------------------------------
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('browser part skipped (no chromium / playwright-core)')
  await server.close()
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)

const buildPdf = (count) => {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < count; i += 1) {
    const stream = `BT /F1 24 Tf 60 760 Td (Seite ${i + 1}) Tj ET`
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const pdfPath = join(mkdtempSync(join(tmpdir(), 'fanotes-pdf-text-')), 'Textfelder.pdf')
writeFileSync(pdfPath, buildPdf(2))

const address = server.httpServer.address()
const base = process.env.FANOTES_CHECK_URL ?? `http://127.0.0.1:${address.port}/?web`
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const shot = (name) => process.env.FANOTES_SHOT_DIR ? page.screenshot({ path: join(process.env.FANOTES_SHOT_DIR, name) }) : null

const TOOL = 'button.toolbar-button[aria-label="Insert text field"]'
const boxes = () => page.evaluate(() => [...document.querySelectorAll('[data-note-text-field]')].map((node) => {
  const rect = node.getBoundingClientRect()
  const wrap = node.closest('.note-text-field')
  return { id: node.getAttribute('data-note-text-field'), value: node.value, x: rect.x, y: rect.y, w: rect.width, h: rect.height, font: parseFloat(getComputedStyle(node).fontSize), weight: getComputedStyle(node).fontWeight, color: getComputedStyle(node).color, selected: wrap.classList.contains('is-selected'), focused: document.activeElement === node }
}))
const pageRect = (n) => page.evaluate((index) => {
  const rect = document.querySelector(`[data-pdf-page="${index}"]`).getBoundingClientRect()
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
}, n)
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`)
// What the app has stored for the open note (the web build keeps the .famd in IndexedDB).
const noteOnDisk = () => page.evaluate(async () => {
  const walk = (entries) => entries.flatMap((entry) => (entry.kind === 'file' ? [entry] : walk(entry.children ?? [])))
  return walk(await window.fanotes.getTree()).find((entry) => /Textfelder\.pdf$/iu.test(entry.relativePath))?.relativePath ?? null
})
const storedBoxes = async () => page.evaluate(async (path) => (await window.fanotes.readNoteCompanion(path))?.textFields ?? [], await noteOnDisk())
// The raw .famd record from IndexedDB (readFile only returns the markdown part).
const storedFamd = async () => page.evaluate(async (path) => {
  const databases = [{ name: 'fanotes-web-vault' }]
  const name = databases.find((item) => /fanotes/iu.test(item.name ?? ''))?.name
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  const record = await new Promise((resolve, reject) => { const r = db.transaction('files').objectStore('files').get(path.replace(/\.pdf$/iu, '.famd')); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  db.close()
  return record?.content ?? ''
}, await noteOnDisk())
const settle = (ms = 350) => page.waitForTimeout(ms)
const scrollPaperTo = async (n) => {
  await page.evaluate((index) => {
    const view = document.querySelector('.paper-view')
    const top = document.querySelector(`[data-pdf-page="${index}"]`).getBoundingClientRect().top - view.getBoundingClientRect().top
    view.scrollTop += top - 20
  }, n)
  await settle(500)
}
const placeAt = async (n, fx, fy) => {
  await page.locator(TOOL).click()
  const rect = await pageRect(n)
  const point = { x: rect.x + rect.w * fx, y: rect.y + rect.h * fy }
  await page.mouse.click(point.x, point.y)
  await settle()
  return point
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  // The cold Vite dev server occasionally stalls the first load: retry once.
  const startupSelector = '.first-run-continue, .pdf-import-button'
  await page.waitForSelector(startupSelector, { timeout: 45_000 }).catch(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(startupSelector, { timeout: 90_000 })
  })
  for (let step = 0; step < 6 && await page.locator('.first-run-continue').count(); step += 1) {
    await page.locator('.first-run-continue').first().click()
    await settle(900)
  }
  await page.waitForSelector('button.pdf-import-button', { timeout: 90_000 })
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button.pdf-import-button').first().click()])
  await chooser.setFiles(pdfPath)
  await page.waitForSelector('[data-pdf-page="2"]', { timeout: 40_000 }).catch(async (e) => { await page.screenshot({ path: '/srv/agents/fanotes/.site-redesign-tools/pdftext/fail.png' }); throw e })
  await settle(2500)

  // zoom in once so placement is checked on a zoomed sheet
  await page.locator('button[aria-label="Zoom in"]').last().click()
  await settle(800)

  // 1. place on page 1: box lands under the pointer, focused and selected at once
  const first = await placeAt(1, 0.3, 0.3)
  let list = await boxes()
  assert.equal(list.length, 1)
  assert.equal(list[0].focused, true, 'a placed box takes focus immediately')
  assert.equal(list[0].selected, true)
  near(list[0].x, first.x, 6, 'page 1 x')
  near(list[0].y, first.y, 6, 'page 1 y')
  await page.keyboard.type('Grüße äöü Größe')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  await settle()
  list = await boxes()
  assert.equal(list[0].value, 'Grüße äöü Größ', 'typing, umlauts and edit keys stay inside the box')
  assert.equal(await page.locator('.note-text-field-toolbar').count(), 1, 'the top toolbar shows the controls for the selected box')
  await shot('pdf-text-box-selected.png')

  // long text grows the box instead of cutting it off
  const heightBefore = list[0].h
  await page.keyboard.type(' und noch viel mehr Text der in mehrere Zeilen umbrechen muss, damit das Feld wachsen kann')
  await settle()
  assert.ok((await boxes())[0].h > heightBefore + 10, 'the box auto-grows with its text')

  // 2. Escape finishes: toolbar gone, text kept
  await page.keyboard.press('Escape')
  await settle()
  list = await boxes()
  assert.equal(list.length, 1)
  assert.equal(list[0].focused, false)
  assert.equal(list[0].selected, false)
  assert.equal(await page.locator('.note-text-field-toolbar').count(), 0)

  // 3. an empty box vanishes when left
  await placeAt(1, 0.7, 0.2)
  assert.equal((await boxes()).length, 2)
  await settle(900)
  const writtenWhileEmpty = await storedBoxes()
  assert.equal(writtenWhileEmpty.length, 1, 'a box that is still empty is not written, so it cannot come back as a ghost')
  assert.ok(writtenWhileEmpty.every((item) => item.text.trim() !== '' && item.updatedAt > 0), 'a saved box has text and an edit stamp')
  const outside = await pageRect(1)
  await page.mouse.click(outside.x + 20, outside.y + 20)
  await settle()
  assert.equal((await boxes()).length, 1, 'an empty box is removed when the user clicks elsewhere')

  // 4. place on page 2 after scrolling
  await scrollPaperTo(2)
  const second = await placeAt(2, 0.5, 0.2)
  list = await boxes()
  assert.equal(list.length, 2)
  const secondBox = list.find((item) => item.focused)
  assert.ok(secondBox, 'the page-2 box is focused')
  near(secondBox.x, second.x, 6, 'page 2 x')
  near(secondBox.y, second.y, 6, 'page 2 y')
  await page.keyboard.type('Seite zwei')
  // toolbar: bigger font, bold, colour
  await page.locator('.note-text-field-toolbar button[aria-label="Larger text"], .note-text-field-toolbar button[aria-label="Schrift größer"]').click()
  await page.locator('.note-text-field-toolbar button[aria-pressed][aria-label="Bold"], .note-text-field-toolbar button[aria-label="Fett"]').click()
  await page.locator('.note-text-field-toolbar button[aria-label="Blue"], .note-text-field-toolbar button[aria-label="Blau"]').click()
  await settle()
  list = await boxes()
  const styledBox = list.find((item) => item.value === 'Seite zwei')
  assert.equal(styledBox.focused, true, 'toolbar buttons do not steal focus from the text')
  assert.ok(styledBox.weight === '700' || styledBox.weight === 'bold')
  assert.equal(styledBox.color, 'rgb(37, 99, 201)')
  assert.equal(styledBox.font > 16, true, 'larger text step applied')

  // 5. move with the grip, across no page boundary
  const gripBox = await page.locator('.note-text-field.is-selected .note-text-field-move').boundingBox()
  assert.ok(gripBox && gripBox.width >= 20, 'the drag handle is visible and big enough')
  const beforeMove = (await boxes()).find((item) => item.value === 'Seite zwei')
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(gripBox.x + gripBox.width / 2 - 60, gripBox.y + gripBox.height / 2 + 40, { steps: 6 })
  await page.mouse.up()
  await settle()
  const afterMove = (await boxes()).find((item) => item.value === 'Seite zwei')
  near(afterMove.x - beforeMove.x, -60, 8, 'move dx')
  near(afterMove.y - beforeMove.y, 40, 8, 'move dy')
  // 6. resize
  const handle = await page.locator('.note-text-field.is-selected .note-text-field-resize').boundingBox()
  const widthBefore = (await boxes()).find((item) => item.value === 'Seite zwei').w
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2, { steps: 5 })
  await page.mouse.up()
  await settle()
  near((await boxes()).find((item) => item.value === 'Seite zwei').w - widthBefore, 80, 10, 'resize dw')
  await shot('pdf-text-box-edited.png')

  // dragging into the gutter between pages must not teleport the box
  await scrollPaperTo(2)
  const gutterGrip = await page.locator('.note-text-field.is-selected .note-text-field-move').boundingBox()
  const gutterY = await page.evaluate(() => {
    const a = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect()
    const b = document.querySelector('[data-pdf-page="2"]').getBoundingClientRect()
    return (a.bottom + b.top) / 2
  })
  await page.mouse.move(gutterGrip.x + gutterGrip.width / 2, gutterGrip.y + gutterGrip.height / 2)
  await page.mouse.down()
  await page.mouse.move(gutterGrip.x + gutterGrip.width / 2, gutterY, { steps: 8 })
  await page.mouse.up()
  await settle()
  const afterGutter = (await boxes()).find((item) => item.value === 'Seite zwei')
  assert.ok(Math.abs(afterGutter.y - gutterY) < 120, `a drop in the gutter keeps the box next to the gutter (${afterGutter.y} vs ${gutterY}), not a jump to the top of page 1`)
  await scrollPaperTo(2)

  // 7. typing never fires sheet shortcuts ('[' and ']' rotate the sheet)
  await page.keyboard.type('[]0')
  await settle()
  assert.ok((await boxes()).some((item) => item.value.endsWith('[]0')), 'tool/view keys type text instead of firing')
  assert.equal(await page.evaluate(() => document.querySelector('.unified-paper')?.className.includes('is-view-rotated') ?? false), false)

  await page.keyboard.press('Escape')
  await settle(1200)
  assert.deepEqual(await page.evaluate(() => document.querySelectorAll('.note-text-field-toolbar').length), 0)

  // 8. persistence: reload the app and reopen the note
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.file-tree__entry-button', { timeout: 90_000 })
  await page.locator('.file-tree__entry-button', { hasText: 'Textfelder' }).first().click()
  await page.waitForSelector('[data-note-text-field]', { timeout: 60_000 })
  await settle(1000)
  list = await boxes()
  assert.equal(list.length, 2, 'both boxes survive a reload')
  assert.ok(list.some((item) => item.value.startsWith('Grüße äöü Größ')))
  const reloaded = list.find((item) => item.value.startsWith('Seite zwei'))
  assert.ok(reloaded, 'edited text is saved')
  assert.ok(reloaded.weight === '700' || reloaded.weight === 'bold', 'bold survives the reload')
  assert.equal(reloaded.color, 'rgb(37, 99, 201)', 'colour survives the reload')
  assert.equal(await page.evaluate(() => typeof window.fanotes.mergeNoteTextFields), 'function', 'the app saves boxes through the per-box merge')

  // 9. a box that is typed but not yet saved counts as unsaved, and hiding the page saves it at once.
  const idleGuard = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  assert.equal(await idleGuard(), false, 'nothing unsaved: closing the tab does not ask')
  await page.locator('[data-note-text-field]').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' +x')
  assert.equal(await idleGuard(), true, 'a typed box that is not saved yet makes the tab ask before it closes')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await settle(250)
  assert.ok((await storedBoxes()).some((item) => item.text.endsWith(' +x')), 'hiding the page saves the box without waiting for the pause')
  await page.evaluate(() => { delete document.visibilityState })
  await page.keyboard.type('!')
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await settle(250)
  assert.ok((await storedBoxes()).some((item) => item.text.endsWith(' +x!')), 'pagehide saves the box too')
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow'))) // the synthetic pagehide above did not really leave the page
  await settle(1200)
  assert.equal(await idleGuard(), false, 'once saved the tab closes without asking')
  assert.ok((await storedBoxes()).every((item) => item.updatedAt > 0), 'every stored box carries its edit stamp')

  // 10. deleting a box removes it for good and leaves a tombstone, kept apart from the live boxes.
  assert.equal((famdTs.parseFamd(await storedFamd()).payload?.textFieldTombstones ?? []).length, 0, 'no tombstone before anything was deleted')
  await scrollPaperTo(2)
  const doomed = (await boxes()).find((item) => item.value.startsWith('Seite zwei'))
  await page.locator(`[data-note-text-field="${doomed.id}"]`).click()
  await page.locator('.note-text-field-toolbar button[aria-label="Remove text field"], .note-text-field-toolbar button[aria-label="Textfeld entfernen"]').click()
  await settle(900)
  assert.equal((await boxes()).length, 1)
  assert.equal((await storedBoxes()).length, 1, 'the deleted box is gone from the stored list')
  const tombstones = famdTs.parseFamd(await storedFamd()).payload?.textFieldTombstones ?? []
  assert.ok(tombstones.some((item) => item.id === doomed.id), 'the delete left a tombstone for that box')

  // 11. two windows on the same note: a box added in each survives, and an edit in one does not drop the other's box.
  const openNoteIn = async (p) => {
    await p.goto(base, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.file-tree__entry-button', { timeout: 90_000 })
    await p.locator('.file-tree__entry-button', { hasText: 'Textfelder' }).first().click()
    await p.waitForSelector('[data-note-text-field]', { timeout: 60_000 })
    await p.waitForTimeout(1200)
  }
  const addBoxIn = async (p, fx, fy, text) => {
    await p.locator(TOOL).click()
    await p.evaluate(() => document.querySelector('[data-pdf-page="1"]').scrollIntoView({ block: 'start', inline: 'start' }))
    await p.waitForTimeout(300)
    const rect = await p.evaluate(() => {
      const r = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    await p.mouse.click(Math.min(rect.x + rect.w * fx, 1200), Math.min(rect.y + rect.h * fy, 860))
    await p.waitForTimeout(400)
    await p.keyboard.type(text)
  }
  const valuesIn = (p) => p.evaluate(() => [...document.querySelectorAll('[data-note-text-field]')].map((node) => node.value).sort())
  const winA = page
  const winB = await context.newPage()
  winB.on('pageerror', (error) => pageErrors.push(String(error)))
  await openNoteIn(winB)
  const baseline = (await valuesIn(winA)).length
  await addBoxIn(winA, 0.2, 0.45, 'from window A')
  await addBoxIn(winB, 0.6, 0.45, 'from window B')
  await settle(1500)
  await winA.evaluate(() => { const n = [...document.querySelectorAll('[data-note-text-field]')].find((x) => x.value.startsWith('from window A')); n.focus() })
  await winA.keyboard.press('End')
  await winA.keyboard.type(' edited')
  await settle(1500)
  await winA.reload({ waitUntil: 'domcontentloaded' })
  await winB.reload({ waitUntil: 'domcontentloaded' })
  for (const w of [winA, winB]) {
    await w.waitForSelector('.file-tree__entry-button', { timeout: 90_000 })
    await w.locator('.file-tree__entry-button', { hasText: 'Textfelder' }).first().click()
    await w.waitForSelector('[data-note-text-field]', { timeout: 60_000 })
    await w.waitForTimeout(1500)
    const values = await valuesIn(w)
    assert.equal(values.length, baseline + 2, `both windows' boxes are present after reload: ${JSON.stringify(values)}`)
    assert.ok(values.includes('from window A edited'), 'window A edit kept')
    assert.ok(values.includes('from window B'), "window B's box kept")
  }
  await winB.close()

  // 12. closing the tab within the 650 ms debounce still saves the typed text.
  const closer = await context.newPage()
  closer.on('dialog', (dialog) => dialog.accept().catch(() => undefined))
  await openNoteIn(closer)
  await addBoxIn(closer, 0.7, 0.35, 'typed then closed')
  await closer.close({ runBeforeUnload: true })
  const reopened = await context.newPage()
  await openNoteIn(reopened)
  assert.ok((await valuesIn(reopened)).includes('typed then closed'), 'text typed right before closing the tab is saved')
  await reopened.close()
  assert.deepEqual(pageErrors, [], 'no page errors')
  console.log('pdf text box browser check ok')
} finally {
  await browser.close()
  await server.close()
}
