// Writes the shared TS/Kotlin merge fixtures: { name, path, left, right, expected }.
// `expected` is computed by the TS merge (src/writing/syncMerge.ts) and checked
// by scripts/check-writing-sync.mjs and android SyncStoryMergeTest.
import { writeFileSync } from 'node:fs'
const p = (id, key, v, text, extra = {}) => ({ id, key, v, style: 'body', runs: text === null ? [] : [{ text }], ...extra })
const scene = (paragraphs, extra = {}) => ({ format: 'fanotes-story-scene-v1', id: 'scene000001', paragraphs, ...extra })
const base = [p('para000001', 'a0', { laptop: 1 }, 'Es war einmal ein Mädchen.'), p('para000002', 'a1', { laptop: 1 }, 'Sie aß gern Süßes.'), p('para000003', 'a2', { laptop: 1 }, 'Ende.')]
const manifest = (extra) => ({
  format: 'fanotes-story-v1', id: 'story000001', title: 'Roman', language: 'de', page: { size: 'A5' }, styles: { body: { id: 'body' } },
  binder: [{ id: 'chap000001', kind: 'chapter', title: 'Kapitel 1', children: [{ id: 'scene000001', kind: 'scene', title: 'Anfang' }] }],
  dictionary: ['Mädchen'], createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z', ...extra,
})
const cases = [
  { name: 'different paragraphs edited on two devices', path: 'Roman.story/scenes/scene000001.json',
    left: scene([{ ...base[0], v: { laptop: 2 }, runs: [{ text: 'Es war einmal ein großes Mädchen.' }] }, base[1], base[2]]),
    right: scene([base[0], base[1], { ...base[2], v: { laptop: 1, tablet: 1 }, runs: [{ text: 'Ende gut, alles gut.' }] }, p('para000004', 'a3', { tablet: 1 }, 'Nachwort.')]) },
  { name: 'same paragraph edited on both devices keeps both', path: 'Roman.story/scenes/scene000001.json',
    left: scene([base[0], { ...base[1], v: { laptop: 2 }, runs: [{ text: 'Sie aß gern Schokolade.' }] }, base[2]]),
    right: scene([base[0], { ...base[1], v: { laptop: 1, tablet: 1 }, runs: [{ text: 'Sie aß gern Äpfel und Süßes.', m: { i: true } }] }, base[2]]) },
  { name: 'edit beats a concurrent delete', path: 'Roman.story/scenes/scene000001.json',
    left: scene([base[0], { ...base[1], v: { laptop: 2 }, runs: [], deleted: true }, base[2]]),
    right: scene([base[0], { ...base[1], v: { laptop: 1, phone: 1 }, runs: [{ text: 'Sie aß sehr gern Süßes.' }] }, base[2]]) },
  { name: 'reorder on one device, edit on the other', path: 'Roman.story/scenes/scene000001.json',
    left: scene([base[0], base[1], { ...base[2], key: 'Zz', v: { laptop: 2 } }].map((x) => x)),
    right: scene([base[0], { ...base[1], v: { laptop: 1, tablet: 1 }, runs: [{ text: 'Sie aß gern Kuchen.' }] }, base[2]]) },
  { name: 'footnotes and comments union', path: 'Roman.story/scenes/scene000001.json',
    left: scene(base, { footnotes: { fn00000001: { id: 'fn00000001', runs: [{ text: 'Quelle A' }] } } }),
    right: scene(base, { footnotes: { fn00000002: { id: 'fn00000002', runs: [{ text: 'Quelle B' }] } }, comments: { cm00000001: { id: 'cm00000001', author: 'Fabio', at: '2026-11-15', text: 'Gut' } } }) },
  { name: 'manifest: binder union, newer titles, dictionary union', path: 'Roman.story/story.json',
    left: manifest({ title: 'Der Roman', updatedAt: '2026-11-12T10:00:00.000Z', dictionary: ['Mädchen', 'Zwölfe'],
      binder: [{ id: 'chap000001', kind: 'chapter', title: 'Erstes Kapitel', children: [{ id: 'scene000001', kind: 'scene', title: 'Anfang', synopsis: 'Wie alles beginnt' }, { id: 'scene000002', kind: 'scene', title: 'Mitte' }] }] }),
    right: manifest({ updatedAt: '2026-11-11T10:00:00.000Z', ignored: ['spelling:Grüße'], futureField: { keep: true },
      binder: [{ id: 'chap000001', kind: 'chapter', title: 'Kapitel 1', children: [{ id: 'scene000001', kind: 'scene', title: 'Anfang' }, { id: 'scene000003', kind: 'scene', title: 'Schluss' }] },
        { id: 'trashbin', kind: 'folder', title: 'Papierkorb', children: [{ id: 'scene000009', kind: 'scene', title: 'Gestrichen' }] }] }) },
  { name: 'manifest: node deleted on newer side and edited on older side is kept', path: 'Roman.story/story.json',
    left: manifest({ updatedAt: '2026-11-12T10:00:00.000Z', binder: [{ id: 'chap000001', kind: 'chapter', title: 'Kapitel 1', children: [] }] }),
    right: manifest({ updatedAt: '2026-11-11T10:00:00.000Z', binder: [{ id: 'chap000001', kind: 'chapter', title: 'Kapitel 1', children: [{ id: 'scene000001', kind: 'scene', title: 'Anfang (überarbeitet)' }] }] }) },
]
export default cases
