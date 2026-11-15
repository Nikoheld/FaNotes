// Story tools: binder moves and trash, bible entries, progress and streaks,
// snapshots (diff, restore that merges with other devices).
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const results = []
const test = async (name, body) => {
  try { await body(); results.push(['PASS', name]) } catch (error) { results.push(['FAIL', name, error]) }
}

try {
  const binder = await vite.ssrLoadModule('/src/writing/model/binder.ts')
  const bible = await vite.ssrLoadModule('/src/writing/model/bible.ts')
  const progress = await vite.ssrLoadModule('/src/writing/model/progress.ts')
  const snapshots = await vite.ssrLoadModule('/src/writing/model/snapshots.ts')
  const merge = await vite.ssrLoadModule('/src/writing/model/merge.ts')
  const sanitize = await vite.ssrLoadModule('/src/writing/model/sanitize.ts')
  const defaults = await vite.ssrLoadModule('/src/writing/model/defaults.ts')

  const tree = () => [
    { id: 'chapter1', kind: 'chapter', title: 'Eins', children: [{ id: 'scene11', kind: 'scene', title: 'A' }, { id: 'scene12', kind: 'scene', title: 'B' }] },
    { id: 'chapter2', kind: 'chapter', title: 'Zwei', children: [{ id: 'scene21', kind: 'scene', title: 'C' }] },
  ]
  const shape = (nodes) => nodes.map((node) => (node.children ? `${node.id}[${shape(node.children)}]` : node.id)).join(',')

  await test('binder: moves scenes and chapters, refuses cycles and wrong kinds', () => {
    assert.equal(shape(binder.moveNode(tree(), 'scene12', 'scene21', 'after')), 'chapter1[scene11],chapter2[scene21,scene12]')
    assert.equal(shape(binder.moveNode(tree(), 'scene21', 'scene11', 'before')), 'chapter1[scene21,scene11,scene12],chapter2[]')
    assert.equal(shape(binder.moveNode(tree(), 'scene11', 'chapter2', 'inside')), 'chapter1[scene12],chapter2[scene21,scene11]')
    assert.equal(shape(binder.moveNode(tree(), 'chapter2', 'chapter1', 'before')), 'chapter2[scene21],chapter1[scene11,scene12]')
    const original = tree()
    assert.equal(binder.moveNode(original, 'chapter1', 'scene11', 'after'), original, 'a chapter cannot go inside its own scene list')
    assert.equal(binder.moveNode(original, 'chapter1', 'scene21', 'inside'), original, 'nothing goes inside a scene')
    assert.equal(binder.moveNode(original, 'chapter2', 'chapter1', 'inside'), original, 'a chapter does not hold chapters')
    assert.equal(binder.moveNode(original, 'scene11', 'scene11', 'after'), original)
  })

  await test('binder: trash keeps scenes (and survives a reload), add before the trash, reading order skips it', () => {
    let nodes = binder.moveToTrash(tree(), 'scene12', 'Papierkorb')
    assert.equal(shape(nodes), 'chapter1[scene11],chapter2[scene21],trashbin[scene12]')
    assert.deepEqual([...binder.trashedIds(nodes)].sort(), ['scene12', 'trashbin'])
    const manifest = { ...defaults.newStory({ title: 'T', language: 'de', deviceId: 'device01' }).manifest, binder: nodes }
    const reloaded = sanitize.sanitizeManifest(JSON.parse(JSON.stringify(manifest)))
    assert.equal(shape(reloaded.binder), shape(nodes), 'the trash folder id passes the id rules')
    const added = binder.addNode(nodes, 'chapter', 'Drei', null)
    assert.equal(shape(added.nodes).split(',').at(-2).startsWith(added.node.id), true, 'new top-level nodes go before the trash')
    assert.deepEqual(binder.scenesInOrder(nodes).map((entry) => `${entry.chapter?.id}/${entry.scene.id}`), ['chapter1/scene11', 'chapter2/scene21'])
    nodes = binder.moveNode(nodes, 'scene12', 'chapter1', 'inside')
    assert.equal(shape(nodes), 'chapter1[scene11,scene12],chapter2[scene21],trashbin[]', 'restoring from the trash is a move')
  })

  await test('binder: scene links, characters and places survive sanitizing; bad links are dropped', () => {
    const manifest = defaults.newStory({ title: 'T', language: 'de', deviceId: 'device01' }).manifest
    const scene = binder.scenesInOrder(manifest.binder)[0].scene
    const nodes = binder.updateNode(manifest.binder, scene.id, (node) => ({ ...node, characters: ['abcdef1'], places: ['abcdef2', 'BAD'], links: ['Schule/Deutsch/Notiz.md', '../etc/passwd', '/abs', 'ok.md'] }))
    const clean = sanitize.sanitizeManifest(JSON.parse(JSON.stringify({ ...manifest, binder: nodes })))
    const saved = binder.findIn(clean.binder, scene.id)
    assert.deepEqual(saved.characters, ['abcdef1'])
    assert.deepEqual(saved.places, ['abcdef2'])
    assert.deepEqual(saved.links, ['Schule/Deutsch/Notiz.md', 'ok.md'])
  })

  await test('bible: entries round-trip, hostile input is cleaned, paths and mentions', () => {
    const entry = bible.newBibleEntry('character', 'Anna Maria', false, 'device01')
    assert.equal(entry.fields[0].label, 'Alter')
    assert.equal(bible.newBibleEntry('character', 'X', true).fields[0].label, 'Age')
    entry.aliases = ['Anna', 'Mia']
    const back = bible.sanitizeBibleEntry(JSON.parse(bible.serializeBibleEntry(entry)))
    assert.deepEqual(back, entry)
    assert.equal(bible.sanitizeBibleEntry({ ...entry, id: '../x' }), null)
    assert.equal(bible.sanitizeBibleEntry({ ...entry, kind: 'monster' }), null)
    assert.equal(bible.sanitizeBibleEntry({ ...entry, color: 'red; x' }).color, undefined)
    assert.equal(bible.biblePath('Roman.story', 'event', entry.id), `Roman.story/bible/events/${entry.id}.json`)
    assert.deepEqual(bible.bibleFileOf(`bible/places/${entry.id}.json`), { kind: 'place', id: entry.id })
    assert.equal(bible.bibleFileOf('bible/places/../x.json'), null)
    const pattern = bible.mentionPattern(entry)
    assert.ok(pattern.test('Dann kam Mia herein.'))
    assert.ok(pattern.test('„Anna!“, rief er.'))
    assert.ok(!pattern.test('Die Annahme war falsch.'), 'whole words only')
  })

  await test('progress: per-day baseline, sum over devices, streaks, goal maths, calendar', () => {
    const day = (iso) => new Date(`${iso}T12:00:00`)
    let file = progress.recordProgress(null, 'laptop01', 1000, day('2026-11-13'))
    file = progress.recordProgress(file, 'laptop01', 1600, day('2026-11-13'))
    assert.equal(progress.recordProgress(file, 'laptop01', 1600, day('2026-11-13')), file, 'nothing changed, no write')
    file = progress.recordProgress(file, 'laptop01', 1600, day('2026-11-14'))
    file = progress.recordProgress(file, 'laptop01', 2100, day('2026-11-14'))
    assert.deepEqual(file.days['2026-11-14'], { start: 1600, words: 500 })
    const tablet = { format: progress.PROGRESS_FORMAT, writer: 'tablet01', days: { '2026-11-14': { start: 2100, words: 300 }, '2026-11-15': { start: 2400, words: -50 } }, updatedAt: '' }
    const days = progress.wordsPerDay([file, tablet])
    assert.equal(days.get('2026-11-14'), 800)
    assert.equal(days.get('2026-11-15'), 0, 'cutting text is not negative progress')
    assert.deepEqual(progress.streaks(days, 500, '2026-11-15'), { current: 2, longest: 2, todayMet: false })
    assert.deepEqual(progress.streaks(days, 700, '2026-11-15'), { current: 1, longest: 1, todayMet: false })
    const status = progress.goalStatus(40_000, { project: 80_000, deadline: '2026-11-24' }, '2026-11-15')
    assert.deepEqual(status, { share: 0.5, left: 40_000, daysLeft: 10, perDay: 4000 })
    const weeks = progress.calendarWeeks(2, '2026-11-15')
    assert.equal(weeks.length, 2)
    assert.equal(weeks[1][6], '2026-11-15', 'Sunday ends the last column')
    assert.equal(weeks[0][0], '2026-11-02', 'Monday two weeks back')
    assert.equal(progress.sanitizeProgress({ ...file, writer: '../x' }), null)
  })

  const para = (id, key, text, v = { laptop01: 1 }) => ({ id, key, v, style: 'body', runs: [{ text }] })

  await test('snapshots: stamp and path rules, paragraph and word diff', () => {
    const stamp = snapshots.snapshotStamp(new Date('2026-11-15T15:30:12.345Z'), 'laptop0123')
    assert.equal(stamp, '20261115T153012Z-laptop01')
    assert.deepEqual(snapshots.snapshotFileOf(`snapshots/scene11/${stamp}.json`), { sceneId: 'scene11', stamp })
    assert.equal(snapshots.snapshotFileOf('snapshots/scene11/../x.json'), null)
    const then = [para('para01', 'a0', 'Es war einmal ein Haus.'), para('para02', 'a1', 'Weg damit.'), para('para03', 'a2', 'Gleich.')]
    const now = [para('para01', 'a0', 'Es war einmal ein altes Haus.'), para('para03', 'a2', 'Gleich.'), para('para04', 'a3', 'Neu.')]
    const rows = snapshots.diffScene(then, now)
    assert.deepEqual(rows.map((row) => `${row.kind}:${row.id}`), ['changed:para01', 'removed:para02', 'same:para03', 'added:para04'])
    assert.deepEqual(rows[0].pieces.filter((piece) => piece.kind !== 'same').map((piece) => `${piece.kind}:${piece.text}`), ['added:altes '])
  })

  await test('snapshots: restore = edits of the current scene; a device that edited meanwhile merges cleanly', () => {
    const base = { format: 'fanotes-story-scene-v1', id: 'scene11', paragraphs: [para('para01', 'a0', 'Eins.'), para('para02', 'a1', 'Zwei.'), para('para03', 'a2', 'Drei.')] }
    const snapshot = snapshots.makeSnapshot(base, 'A', 'laptop01', 'manual', 'vor dem Umbau', new Date('2026-11-15T10:00:00Z'))
    assert.equal(snapshot.note, 'vor dem Umbau')
    assert.deepEqual(snapshots.sanitizeSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot)
    // On the laptop: p2 deleted (saved as tombstone), p4 added, p1 rewritten.
    let laptop = merge.stampEdits({ ...base, paragraphs: [para('para01', 'a0', 'Eins, neu.'), para('para03', 'a2', 'Drei.'), para('para04', 'a3', 'Vier.')] }, base, 'laptop01')
    assert.ok(laptop.paragraphs.find((paragraph) => paragraph.id === 'para02').deleted)
    const restoredDraft = snapshots.restoreSnapshot(laptop, snapshot)
    const restored = merge.stampEdits(restoredDraft, laptop, 'laptop01')
    const visible = (scene) => scene.paragraphs.filter((paragraph) => !paragraph.deleted).map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
    assert.deepEqual(visible(restored), ['Eins.', 'Zwei.', 'Drei.'])
    assert.ok(restored.paragraphs.find((paragraph) => paragraph.id === 'para04').deleted, 'added since: tombstone, not dropped')
    // Meanwhile the tablet (which had synced the laptop's earlier state) edited p3.
    const tablet = merge.stampEdits({ ...laptop, paragraphs: laptop.paragraphs.map((paragraph) => (paragraph.id === 'para03' ? { ...paragraph, runs: [{ text: 'Drei, vom Tablet.' }] } : paragraph)) }, laptop, 'tablet01')
    const merged = merge.mergeScenes(restored, tablet)
    assert.deepEqual(visible(merged.scene ?? merged), ['Eins.', 'Zwei.', 'Drei, vom Tablet.'])
  })
} finally {
  await vite.close()
}

for (const [status, name, error] of results) {
  console.log(`${status}  ${name}`)
  if (error) console.log(`      ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n      ')}`)
}
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
