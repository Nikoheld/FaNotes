// Writing mode: model, merge, layout and pagination. Run: node scripts/check-writing.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const load = (path) => vite.ssrLoadModule(path)
const results = []
const test = async (name, body) => {
  try {
    await body()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error])
  }
}

try {
  const keys = await load('/src/writing/model/keys.ts')
  const runs = await load('/src/writing/model/runs.ts')
  const defaults = await load('/src/writing/model/defaults.ts')
  const sanitize = await load('/src/writing/model/sanitize.ts')
  const merge = await load('/src/writing/model/merge.ts')
  const flow = await load('/src/writing/model/flow.ts')
  const measure = await load('/src/writing/layout/measure.ts')
  const linebreak = await load('/src/writing/layout/linebreak.ts')
  const paginate = await load('/src/writing/layout/paginate.ts')
  const measurer = new measure.FixedMeasurer()

  await test('order keys sort, stay short and always leave room', () => {
    let previous = null
    const appended = []
    for (let index = 0; index < 10_000; index += 1) {
      previous = keys.keyBetween(previous, null)
      appended.push(previous)
    }
    assert.deepEqual([...appended].sort(), appended)
    assert.ok(appended.at(-1).length <= 4, appended.at(-1))
    let a = 'a0'
    let b = 'a1'
    for (let index = 0; index < 50; index += 1) {
      const middle = keys.keyBetween(a, b)
      assert.ok(a < middle && middle < b)
      assert.ok(keys.isValidKey(middle), middle)
      if (index % 2) a = middle
      else b = middle
    }
    const spread = keys.keysBetween('a5', 'a6', 500)
    assert.equal(new Set(spread).size, 500)
    assert.deepEqual([...spread].sort(), spread)
    assert.ok(spread[0] > 'a5' && spread.at(-1) < 'a6')
    const before = keys.keyBetween(null, 'a0')
    assert.ok(before < 'a0' && keys.isValidKey(before))
    assert.equal(keys.isValidKey('a10'), false, 'no trailing zero in the fraction')
  })

  await test('runs: insert, delete, marks and normalisation', () => {
    let value = [{ text: 'Hallo Welt' }]
    value = runs.applyMarks(value, 6, 10, { b: true })
    assert.deepEqual(value, [{ text: 'Hallo ' }, { text: 'Welt', m: { b: true } }])
    value = runs.insertText(value, 10, '!', runs.marksAt(value, 10))
    assert.deepEqual(value, [{ text: 'Hallo ' }, { text: 'Welt!', m: { b: true } }])
    value = runs.deleteRange(value, 4, 8)
    assert.equal(runs.runsText(value), 'Halllt!')
    value = runs.applyMarks(value, 0, 7, { b: null })
    assert.deepEqual(value, [{ text: 'Halllt!' }])
    const anchored = runs.insertRuns([{ text: 'Satz.' }], 5, [{ text: '', m: { fn: 'abcdef1' } }])
    assert.equal(anchored.length, 2, 'a footnote anchor survives normalisation')
    assert.equal(runs.marksAt(anchored, 6), undefined, 'typing after a footnote does not continue it')
    assert.equal(runs.rangeHasMark([{ text: 'ab', m: { i: true } }, { text: 'cd' }], 0, 2, 'i'), true)
    assert.equal(runs.rangeHasMark([{ text: 'ab', m: { i: true } }, { text: 'cd' }], 0, 4, 'i'), false)
  })

  await test('a new story and a stored one load the same; damage is repaired, not thrown away', () => {
    const story = defaults.newStory({ title: 'Die Brücke', language: 'de-CH', deviceId: 'dev1' })
    const manifest = sanitize.sanitizeManifest(JSON.parse(JSON.stringify(story.manifest)))
    assert.deepEqual(manifest, story.manifest)
    const scene = sanitize.sanitizeScene(JSON.parse(JSON.stringify(story.scenes[0])))
    assert.deepEqual(scene, story.scenes[0])
    const damaged = sanitize.sanitizeScene({
      format: 'fanotes-story-scene-v1',
      id: story.scenes[0].id,
      paragraphs: [
        { id: 'aaaaaaaaaaaa', key: 'bad!', v: { dev1: 1 }, style: 'body', runs: [{ text: 'Erster' }, { text: 5 }, null] },
        null,
        { id: 'aaaaaaaaaaaa', key: 'a1', style: 'Body Style', runs: [{ text: 'Zweiter\r\nTeil', m: { b: true, size: 9000, color: 'red' } }] },
      ],
    })
    assert.equal(damaged.paragraphs.length, 2, 'both readable paragraphs kept')
    assert.notEqual(damaged.paragraphs[0].id, damaged.paragraphs[1].id, 'duplicate ids are split')
    assert.ok(damaged.paragraphs.every((paragraph) => keys.isValidKey(paragraph.key)))
    assert.equal(damaged.paragraphs[1].runs[0].text, 'Zweiter\nTeil')
    assert.deepEqual(damaged.paragraphs[1].runs[0].m, { b: true })
    assert.equal(damaged.paragraphs[1].style, 'body')
    assert.equal(sanitize.sanitizeScene({ format: 'other' }), null)
    const empty = sanitize.sanitizeScene({ format: 'fanotes-story-scene-v1', id: 'scene12345', paragraphs: [] })
    assert.equal(empty.paragraphs.length, 1, 'a scene always has a paragraph to type into')
  })

  const para = (id, key, v, text, extra = {}) => ({ id, key, v, style: 'body', runs: text ? [{ text }] : [], ...extra })
  const sceneOf = (paragraphs) => ({ format: 'fanotes-story-scene-v1', id: 'scene000001', paragraphs })

  await test('merge: edits of different paragraphs combine, on both devices alike', () => {
    const base = [para('p000001', 'a0', { A: 1 }, 'Eins'), para('p000002', 'a1', { A: 1 }, 'Zwei'), para('p000003', 'a2', { A: 1 }, 'Drei')]
    const left = sceneOf([{ ...base[0], runs: [{ text: 'Eins (Laptop)' }], v: { A: 2 } }, base[1], base[2]])
    const right = sceneOf([base[0], base[1], { ...base[2], runs: [{ text: 'Drei (Tablet)' }], v: { A: 1, B: 1 } }, para('p000004', 'a3', { B: 1 }, 'Vier')])
    const one = merge.mergeScenes(left, right)
    const two = merge.mergeScenes(right, left)
    assert.equal(one.conflicts, 0)
    assert.deepEqual(one.scene.paragraphs.map((p) => runs.runsText(p.runs)), ['Eins (Laptop)', 'Zwei', 'Drei (Tablet)', 'Vier'])
    assert.deepEqual(one.scene.paragraphs, two.scene.paragraphs, 'symmetric')
  })

  await test('merge: the same paragraph changed on both devices keeps both versions, converging', () => {
    const left = sceneOf([para('p000001', 'a0', { A: 2 }, 'Sie ging.')])
    const right = sceneOf([para('p000001', 'a0', { A: 1, B: 1 }, 'Sie rannte.')])
    const one = merge.mergeScenes(left, right)
    const two = merge.mergeScenes(right, left)
    assert.equal(one.conflicts, 1)
    assert.deepEqual(one.scene.paragraphs, two.scene.paragraphs)
    const texts = one.scene.paragraphs.map((p) => runs.runsText(p.runs)).sort()
    assert.deepEqual(texts, ['Sie ging.', 'Sie rannte.'])
    const copy = one.scene.paragraphs.find((p) => p.conflictOf)
    assert.equal(copy.conflictOf, 'p000001')
    assert.ok(keys.isValidKey(copy.key) && copy.key > 'a0')
    // Merging again changes nothing (idempotent), whichever side.
    assert.deepEqual(merge.mergeScenes(one.scene, two.scene).scene.paragraphs, one.scene.paragraphs)
    assert.deepEqual(merge.mergeScenes(one.scene, right).scene.paragraphs, one.scene.paragraphs)
  })

  await test('merge: an edit beats a concurrent delete; a later delete wins', () => {
    const edited = sceneOf([para('p000001', 'a0', { A: 1, B: 1 }, 'Behalten')])
    const deleted = sceneOf([{ ...para('p000001', 'a0', { A: 2 }, ''), deleted: true }])
    const merged = merge.mergeScenes(edited, deleted).scene
    assert.equal(merged.paragraphs.length, 1)
    assert.equal(merged.paragraphs[0].deleted, undefined)
    assert.equal(runs.runsText(merged.paragraphs[0].runs), 'Behalten')
    const laterDelete = sceneOf([{ ...para('p000001', 'a0', { A: 2, B: 1 }, ''), deleted: true }])
    assert.equal(merge.mergeScenes(edited, laterDelete).scene.paragraphs[0].deleted, true)
  })

  await test('stampEdits counts changed paragraphs and records deletes as tombstones', () => {
    const saved = sceneOf([para('p000001', 'a0', { A: 1 }, 'Eins'), para('p000002', 'a1', { A: 1 }, 'Zwei')])
    const current = sceneOf([{ ...saved.paragraphs[0], runs: [{ text: 'Eins!' }] }])
    const stamped = merge.stampEdits(current, saved, 'A')
    assert.equal(stamped.paragraphs[0].v.A, 2)
    assert.equal(stamped.paragraphs[1].deleted, true)
    assert.equal(stamped.paragraphs[1].v.A, 2)
    assert.equal(merge.stampEdits(saved, saved, 'A'), saved, 'unchanged scene stays the same object')
  })

  const story = defaults.newStory({ title: 'Test', language: 'de', deviceId: 'dev1', size: 'A5' })
  await test('flow: chapter titles, scenes, scene breaks and first paragraphs', () => {
    const scene2 = { ...defaults.emptyScene('dev1', 'first', 'Zweite Szene.'), id: 'scenetwo00001' }
    const manifest = structuredClone(story.manifest)
    manifest.binder[0].children.push({ id: scene2.id, kind: 'scene', title: 'Szene 2' })
    manifest.binder.push({ id: 'chaptertwo001', kind: 'chapter', title: 'Kapitel 2', children: [], exclude: true })
    const scenes = new Map([[story.scenes[0].id, story.scenes[0]], [scene2.id, scene2]])
    const blocks = flow.buildFlow(manifest, scenes)
    assert.deepEqual(blocks.map((block) => block.ref.kind), ['title', 'para', 'break', 'para'])
    assert.equal(blocks[0].chapterStart, true)
    assert.equal(blocks[1].afterBreak, true)
    assert.equal(blocks[3].afterBreak, true, 'first paragraph after a scene break')
    assert.equal(blocks[2].runs[0].text, '* * *')
  })

  const resolved = (overrides = {}) => linebreak.resolveStyle({ ...story.manifest.styles.body, ...overrides })
  const lorem = 'Der alte Leuchtturmwärter stieg jeden Abend die hundertzwölf Stufen hinauf, zündete das Licht an und sah hinaus auf das dunkle Wasser, über dem der Wind die Wolken jagte.'

  await test('lines never overflow, cover the whole text, and justified lines fill the width', () => {
    const layout = linebreak.layoutParagraph({ runs: [{ text: lorem }], style: resolved(), width: 300, measurer })
    assert.ok(layout.lines.length > 2)
    assert.equal(layout.lines[0].from, 0)
    assert.equal(layout.lines.at(-1).to, lorem.length)
    for (let index = 1; index < layout.lines.length; index += 1) assert.equal(layout.lines[index].from, layout.lines[index - 1].to)
    for (const line of layout.lines) assert.ok(line.width <= line.available + 0.5, `${line.width} > ${line.available}`)
    for (const line of layout.lines.slice(0, -1)) assert.ok(Math.abs(line.width - line.available) < 0.5, 'justified line fills the measure')
    assert.ok(layout.lines.at(-1).width < layout.lines.at(-1).available, 'the last line is not stretched')
    assert.ok(layout.lines[0].x > 0, 'first-line indent')
    const words = layout.lines.flatMap((line) => line.pieces.filter((piece) => piece.kind === 'word').map((piece) => piece.text))
    assert.equal(words.join(' '), lorem.split(/\s+/u).join(' '))
  })

  await test('hyphenation splits long German words at pattern points and draws a hyphen', async () => {
    const hyphenator = await measure.loadHyphenator('de')
    assert.deepEqual(hyphenator('Leuchtturmwärter'), [6, 10, 13], 'Leucht-turm-wär-ter')
    const text = 'Am Ufer stand die Donaudampfschifffahrtsgesellschaft mit ihren Kapitänen.'
    const layout = linebreak.layoutParagraph({ runs: [{ text }], style: resolved({ indentFirst: 0 }), width: 260, measurer, hyphenator, hyphenate: true })
    const hyphenated = layout.lines.filter((line) => line.pieces.at(-1)?.hyphen)
    assert.ok(hyphenated.length >= 1, 'at least one line ends in a hyphen')
    for (const line of layout.lines) {
      // Pieces sit left to right without overlapping (the hyphenated piece included).
      for (let index = 1; index < line.pieces.length; index += 1) assert.ok(line.pieces[index].x >= line.pieces[index - 1].x + line.pieces[index - 1].width - 0.01, `overlap in line ${line.from}`)
    }
    for (const line of layout.lines) assert.ok(line.width <= line.available + 0.5)
    assert.equal(layout.lines.flatMap((line) => line.pieces.filter((piece) => piece.kind === 'word').map((piece) => piece.text)).join(''), text.replace(/ /gu, ''), 'the text is all there')
  })

  await test('forced line breaks, empty paragraphs, a word longer than the line', () => {
    const forced = linebreak.layoutParagraph({ runs: [{ text: 'Zeile eins\nZeile zwei' }], style: resolved({ align: 'left', indentFirst: 0 }), width: 400, measurer })
    assert.equal(forced.lines.length, 2)
    assert.equal(forced.lines[0].last, true)
    const empty = linebreak.layoutParagraph({ runs: [], style: resolved(), width: 400, measurer })
    assert.equal(empty.lines.length, 1)
    assert.ok(empty.height > 0)
    const long = linebreak.layoutParagraph({ runs: [{ text: 'x'.repeat(200) }], style: resolved({ indentFirst: 0 }), width: 100, measurer })
    assert.ok(long.lines.length > 1)
    for (const line of long.lines) assert.ok(line.width <= line.available + 0.5)
  })

  await test('list paragraphs hang their marker left of the text', () => {
    const style = linebreak.resolveStyle(story.manifest.styles.list)
    const layout = linebreak.layoutParagraph({ runs: [{ text: lorem }], style, width: 300, measurer })
    const marker = layout.lines[0].pieces[0]
    assert.equal(marker.kind, 'marker')
    assert.equal(marker.display, '•')
    assert.ok(marker.x < 0, 'the marker sits in the hanging indent')
    assert.equal(layout.lines[0].x, layout.lines[1].x, 'first and following lines align')
    assert.equal(linebreak.caretX(layout, 0, 0, measurer), layout.lines[0].pieces[1].x, 'the caret starts at the text, not at the marker')
  })

  await test('a drop cap takes its lines and indents them', () => {
    const style = linebreak.resolveStyle({ ...story.manifest.styles.first, dropCap: 3 }, { afterBreak: true })
    const layout = linebreak.layoutParagraph({ runs: [{ text: `„${lorem}` }], style, width: 300, measurer })
    assert.equal(layout.dropCap.text, '„D')
    assert.ok(layout.lines[0].x > 10 && layout.lines[2].x === layout.lines[0].x && layout.lines[3].x < layout.lines[0].x)
    assert.equal(layout.lines[0].from, 0)
  })

  await test('caret geometry: x for an offset and the offset for an x agree', () => {
    const layout = linebreak.layoutParagraph({ runs: [{ text: lorem }], style: resolved({ align: 'left' }), width: 300, measurer })
    for (const offset of [0, 5, 23, 60, lorem.length]) {
      const line = linebreak.lineAt(layout, offset)
      const x = linebreak.caretX(layout, line, offset, measurer)
      assert.equal(linebreak.offsetAtX(layout, line, x, measurer), offset, `offset ${offset}`)
    }
  })

  const novel = (chapters, paragraphsPerChapter, sentence = lorem) => {
    const manifest = structuredClone(story.manifest)
    manifest.binder = []
    const scenes = new Map()
    let counter = 0
    for (let chapter = 0; chapter < chapters; chapter += 1) {
      const scene = { format: 'fanotes-story-scene-v1', id: `scene${String(chapter).padStart(6, '0')}`, paragraphs: [] }
      const sceneKeys = keys.keysBetween(null, null, paragraphsPerChapter)
      for (let index = 0; index < paragraphsPerChapter; index += 1) {
        counter += 1
        scene.paragraphs.push({ id: `para${String(counter).padStart(8, '0')}`, key: sceneKeys[index], v: { A: 1 }, style: index === 0 ? 'first' : 'body', runs: [{ text: `${sentence} ${sentence.slice(0, (counter * 37) % sentence.length)}` }] })
      }
      scenes.set(scene.id, scene)
      manifest.binder.push({ id: `chapter${String(chapter).padStart(6, '0')}`, kind: 'chapter', title: `Kapitel ${chapter + 1}`, children: [{ id: scene.id, kind: 'scene', title: 'Szene' }] })
    }
    return { manifest, scenes }
  }

  await test('pagination: chapters on new pages, widows and orphans, keep with next, headers', () => {
    const { manifest, scenes } = novel(3, 30)
    manifest.page = { ...manifest.page, header: { left: '{title}', center: '', right: '{chapter}' }, footer: { left: '', center: '{page}', right: '' } }
    const blocks = flow.buildFlow(manifest, scenes)
    const result = paginate.layoutManuscript(manifest, blocks, new paginate.LayoutCache(), { measurer })
    assert.ok(result.pages.length > 6)
    // Every line placed exactly once, in order.
    const placed = result.pages.flatMap((page) => page.lines.map((line) => `${line.blockIndex}:${line.lineIndex}`))
    const expected = result.layouts.flatMap((layout, blockIndex) => layout.lines.map((_, lineIndex) => `${blockIndex}:${lineIndex}`))
    assert.deepEqual(placed, expected)
    // Lines stay inside the content box.
    for (const page of result.pages) {
      for (const line of page.lines) {
        const box = result.layouts[line.blockIndex].lines[line.lineIndex]
        assert.ok(line.y + box.height <= page.content.y + page.content.height + 0.5, `page ${page.number} overflows`)
      }
    }
    // Chapter titles start pages; their page has no header.
    for (const [index, block] of blocks.entries()) {
      if (!block.chapterStart) continue
      const page = result.pages[result.blockPages[index]]
      assert.equal(page.lines[0].blockIndex, index, 'a chapter starts at the top of a page')
      assert.equal(page.header, null)
    }
    // No orphan (single first line at a page bottom) and no widow (single last line at a page top).
    for (const page of result.pages) {
      const last = page.lines.at(-1)
      const first = page.lines[0]
      const lastLayout = result.layouts[last.blockIndex]
      if (last.lineIndex === 0 && lastLayout.lines.length > 1) assert.fail(`orphan on page ${page.number}`)
      const firstLayout = result.layouts[first.blockIndex]
      if (first.lineIndex === firstLayout.lines.length - 1 && first.lineIndex > 0 && firstLayout.lines.length >= 3) assert.fail(`widow on page ${page.number}`)
    }
    const second = result.pages[1]
    assert.equal(second.header.left, 'Kapitel 1' === second.chapterTitle && second.side === 'left' && manifest.page.mirror ? 'Kapitel 1' : second.header.left)
    assert.equal(second.footer.center, second.number)
  })

  await test('chapters can start on a right-hand page (blank page inserted)', () => {
    const { manifest, scenes } = novel(3, 1)
    manifest.page = { ...manifest.page, chapterStartsRight: true }
    const result = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), new paginate.LayoutCache(), { measurer })
    for (const [index, block] of result.blocks.entries()) if (block.chapterStart) assert.equal(result.pages[result.blockPages[index]].side, 'right')
    assert.ok(result.pages.some((page) => page.blank && page.lines.length === 0 && page.header === null))
  })

  await test('an edited footnote re-paginates incrementally exactly like a full pass', () => {
    const manifest = structuredClone(story.manifest)
    const scene = structuredClone(story.scenes[0])
    scene.paragraphs[0].runs = [{ text: 'Ein Satz mit Fussnote' }, { text: '', m: { fn: 'note000001' } }, { text: ' und weiter.' }]
    scene.footnotes = { note000001: { id: 'note000001', runs: [{ text: 'Kurz.' }] } }
    const scenes = new Map([[scene.id, scene]])
    const blocks = flow.buildFlow(manifest, scenes)
    const cache = new paginate.LayoutCache()
    const first = paginate.layoutManuscript(manifest, blocks, cache, { measurer, footnoteRuns: (id) => scene.footnotes[id]?.runs ?? null })
    scene.footnotes = { note000001: { id: 'note000001', runs: [{ text: 'Eine viel längere Erklärung, '.repeat(12) }] } }
    const incremental = paginate.layoutManuscript(manifest, blocks, cache, { measurer, footnoteRuns: (id) => scene.footnotes[id]?.runs ?? null }, first)
    const full = paginate.layoutManuscript(manifest, blocks, new paginate.LayoutCache(), { measurer, footnoteRuns: (id) => scene.footnotes[id]?.runs ?? null })
    const shape = (result) => result.pages.map((page) => page.footnotes.map((note) => note.layout?.lines?.length ?? note.lines?.length ?? JSON.stringify(note).length))
    assert.deepEqual(shape(incremental), shape(full))
    assert.notDeepEqual(shape(first), shape(full))
  })

  await test('sanitize: names of Object.prototype members are not style ids; text is never cut inside an emoji', () => {
    const raw = structuredClone(story.manifest)
    raw.styles.constructor = { ...raw.styles.body, id: 'constructor' }
    raw.page = { ...raw.page, size: 'toString' }
    const manifest = sanitize.sanitizeManifest(JSON.parse(JSON.stringify(raw)))
    assert.ok(!Object.hasOwn(manifest.styles, 'constructor'))
    assert.equal(manifest.page.size, 'A5')
    const scene = sanitize.sanitizeScene({ format: 'fanotes-story-scene-v1', id: 'scene0001', paragraphs: [{ id: 'para000001', key: 'a0', v: {}, style: 'constructor', runs: [{ text: `${'x'.repeat(2)}😀` }] }] })
    assert.equal(scene.paragraphs[0].style, 'body')
    const cut = sanitize.sanitizeScene({ format: 'fanotes-story-scene-v1', id: 'scene0001', paragraphs: [{ id: 'para000001', key: 'a0', v: {}, style: 'body', runs: [{ text: 'ab\uD83D' }] }] })
    assert.equal(cut.paragraphs[0].runs[0].text, 'ab\uFFFD', 'a lone surrogate becomes U+FFFD')
  })

  await test('footnotes sit at the bottom of the page of their reference', () => {
    const manifest = structuredClone(story.manifest)
    const scene = structuredClone(story.scenes[0])
    scene.paragraphs[0].runs = [{ text: 'Ein Satz mit Fussnote' }, { text: '', m: { fn: 'note000001' } }, { text: ' und weiter.' }]
    scene.footnotes = { note000001: { id: 'note000001', runs: [{ text: 'Die Erklärung.' }] } }
    const scenes = new Map([[scene.id, scene]])
    const result = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), new paginate.LayoutCache(), { measurer, footnoteRuns: (id) => scene.footnotes[id]?.runs ?? null })
    const page = result.pages.find((candidate) => candidate.footnotes.length)
    assert.ok(page)
    assert.equal(page.footnotes[0].number, '1')
    const lastLine = page.lines.at(-1)
    assert.ok(page.footnotes[0].y > lastLine.y, 'the note is below the text')
    const anchor = result.layouts[1].lines[0].pieces.find((piece) => piece.kind === 'anchor')
    assert.equal(anchor.display, '1')
  })

  await test('typing re-lays out one paragraph only (cache)', () => {
    const { manifest, scenes } = novel(5, 40)
    const cache = new paginate.LayoutCache()
    const first = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), cache, { measurer })
    assert.equal(first.stats.measured, first.blocks.length)
    const scene = scenes.get('scene000002')
    const changed = { ...scene, paragraphs: scene.paragraphs.map((paragraph, index) => (index === 3 ? { ...paragraph, runs: runs.insertText(paragraph.runs, 5, 'x') } : paragraph)) }
    scenes.set(scene.id, changed)
    const second = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), cache, { measurer })
    assert.equal(second.stats.measured, 1)
  })

  await test('incremental pagination gives exactly the pages of a full pass (120 random edits)', () => {
    const { manifest, scenes } = novel(6, 25)
    manifest.page = { ...manifest.page, chapterStartsRight: true, header: { left: '{title}', center: '{pages}', right: '{chapter}' } }
    const signature = (result) => JSON.stringify({
      pages: result.pages.map((page) => [page.number, page.side, page.blank ? 1 : 0, page.chapterTitle, page.header, page.footer, page.lines.map((line) => [line.blockKey, line.lineIndex, Math.round(line.x * 100), Math.round(line.y * 100)]), page.footnotes.map((note) => [note.id, Math.round(note.y)])]),
      blockPages: result.blockPages,
    })
    const incrementalCache = new paginate.LayoutCache()
    let previous = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), incrementalCache, { measurer })
    let seed = 7
    const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit }
    let reusedSome = false
    for (let step = 0; step < 120; step += 1) {
      const sceneIds = [...scenes.keys()]
      const scene = scenes.get(sceneIds[random(sceneIds.length)])
      const paragraphs = scene.paragraphs.slice()
      const index = random(paragraphs.length)
      const target = paragraphs[index]
      const kind = random(6)
      if (kind <= 2) {
        // Type a few words (sometimes enough to add a line).
        const text = runs.runsText(target.runs)
        const at = random(text.length + 1)
        paragraphs[index] = { ...target, runs: runs.insertText(target.runs, at, ' neue Worte'.repeat(1 + random(kind === 2 ? 12 : 2))) }
      } else if (kind === 3 && paragraphs.length > 3) {
        paragraphs.splice(index, 1)
      } else if (kind === 4) {
        const next = paragraphs[index + 1]?.key ?? null
        paragraphs.splice(index + 1, 0, { id: `new${step}x${random(99999)}`, key: keys.keyBetween(target.key, next), v: {}, style: 'body', runs: [{ text: 'Ein eingefügter Absatz.' }] })
      } else {
        const text = runs.runsText(target.runs)
        paragraphs[index] = { ...target, runs: runs.deleteRange(target.runs, 0, Math.min(text.length, 1 + random(120))) }
      }
      scenes.set(scene.id, { ...scene, paragraphs })
      const blocks = flow.buildFlow(manifest, scenes)
      const incremental = paginate.layoutManuscript(manifest, blocks, incrementalCache, { measurer }, previous)
      const full = paginate.layoutManuscript(manifest, blocks, new paginate.LayoutCache(), { measurer })
      if (signature(incremental) !== signature(full)) {
        const a = JSON.parse(signature(incremental))
        const b = JSON.parse(signature(full))
        const page = a.pages.findIndex((value, index) => JSON.stringify(value) !== JSON.stringify(b.pages[index]))
        const blockIndex = a.blockPages.findIndex((value, index) => value !== b.blockPages[index])
        assert.fail(`step ${step} (edit kind ${kind}): pages ${a.pages.length}/${b.pages.length}, first differing page ${page}: ${JSON.stringify(a.pages[page])?.slice(0, 300)} vs ${JSON.stringify(b.pages[page])?.slice(0, 300)}; blockPages differ at ${blockIndex}: ${a.blockPages[blockIndex]} vs ${b.blockPages[blockIndex]} (lengths ${a.blockPages.length}/${b.blockPages.length})`)
      }
      if (incremental.stats.repaginatedPages < incremental.pages.length / 2) reusedSome = true
      previous = incremental
    }
    assert.ok(reusedSome, 'most edits re-paginate only part of the manuscript')
  })

  await test('a 320-page novel lays out quickly (fixed-width measurer)', () => {
    const { manifest, scenes } = novel(32, 120)
    const cache = new paginate.LayoutCache()
    const started = performance.now()
    const result = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), cache, { measurer })
    const full = performance.now() - started
    const again = performance.now()
    paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), cache, { measurer })
    const repaginate = performance.now() - again
    // One keystroke in the middle of the book, incrementally.
    const middle = scenes.get('scene000016')
    scenes.set(middle.id, { ...middle, paragraphs: middle.paragraphs.map((paragraph, index) => (index === 50 ? { ...paragraph, runs: runs.insertText(paragraph.runs, 10, 'x') } : paragraph)) })
    const typed = performance.now()
    const incremental = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), cache, { measurer }, result)
    const keystroke = performance.now() - typed
    console.log(`  ${result.pages.length} pages, ${result.stats.lines} lines: full layout ${full.toFixed(0)} ms, full re-pagination ${repaginate.toFixed(1)} ms, one keystroke ${keystroke.toFixed(2)} ms (${incremental.stats.repaginatedPages} page(s) re-paginated)`)
    assert.ok(incremental.stats.repaginatedPages <= 3, `${incremental.stats.repaginatedPages} pages re-paginated for one character`)
    assert.ok(result.pages.length >= 300, `${result.pages.length} pages`)
    assert.ok(repaginate < 120, `re-pagination ${repaginate} ms`)
  })
  const docMod = await load('/src/writing/editor/doc.ts')
  const commands = await load('/src/writing/editor/commands.ts')
  const controllerMod = await load('/src/writing/editor/controller.ts')
  const texts = (doc) => doc.flow.map((block) => `${block.ref.kind}:${runs.runsText(block.runs)}`)
  const freshState = () => {
    const created = defaults.newStory({ title: 'Probe', language: 'de', deviceId: 'dev1' })
    const doc = docMod.makeDoc(created.manifest, new Map(created.scenes.map((scene) => [scene.id, scene])))
    const first = doc.flow.find((block) => block.ref.kind === 'para')
    return { doc, selection: docMod.caret({ block: first.key, offset: 0 }), storedMarks: null }
  }
  const type = (state, text) => commands.insertText(state, text)

  await test('a patched flow (typing, formatting) equals a rebuilt one', () => {
    let state = type(freshState(), 'Erster Absatz.')
    state = commands.splitParagraph(state)
    state = type(state, 'Zweiter Absatz.')
    const patched = commands.toggleMark({ ...state, selection: { anchor: { block: state.doc.flow[2].key, offset: 0 }, head: { block: state.doc.flow[2].key, offset: 7 } } }, 'b').doc
    const typed = type({ ...state, selection: docMod.caret({ block: state.doc.flow[1].key, offset: 5 }) }, 'xyz').doc
    for (const doc of [patched, typed, commands.setAlign(state, 'center').doc]) {
      const rebuilt = docMod.makeDoc(doc.manifest, doc.scenes)
      assert.deepEqual(doc.flow.map((block) => ({ ...block, paragraph: undefined })), rebuilt.flow.map((block) => ({ ...block, paragraph: undefined })))
      assert.deepEqual([...doc.index], [...rebuilt.index])
    }
  })

  await test('typing, Enter, Backspace across paragraphs, Delete', () => {
    let state = type(freshState(), 'Hallo Welt')
    state = commands.splitParagraph(state)
    state = type(state, 'Zweite Zeile')
    assert.deepEqual(texts(state.doc).slice(1), ['para:Hallo Welt', 'para:Zweite Zeile'])
    assert.equal(state.doc.flow[2].style, 'body', 'Enter after a first paragraph continues with body text')
    state = { ...state, selection: docMod.caret({ block: state.doc.flow[2].key, offset: 0 }) }
    state = commands.deleteBackward(state)
    assert.deepEqual(texts(state.doc).slice(1), ['para:Hallo WeltZweite Zeile'])
    assert.equal(state.selection.head.offset, 10)
    state = commands.deleteBackward(state, 'word')
    assert.deepEqual(texts(state.doc).slice(1), ['para:Hallo WeltZweite Zeile'.replace('Welt', '')])
    state = commands.deleteForward({ ...state, selection: docMod.caret({ block: state.doc.flow[1].key, offset: 0 }) })
    assert.equal(runs.runsText(state.doc.flow[1].runs), 'allo Zweite Zeile')
    // Grapheme-safe: an emoji with a modifier is one Backspace.
    state = type({ ...state, selection: docMod.caret({ block: state.doc.flow[1].key, offset: 0 }) }, '👍🏽')
    state = commands.deleteBackward(state)
    assert.equal(runs.runsText(state.doc.flow[1].runs), 'allo Zweite Zeile')
  })

  await test('a selection across paragraphs deletes and joins; titles stay', () => {
    let state = type(freshState(), 'Eins zwei drei')
    state = commands.splitParagraph(state)
    state = type(state, 'Vier fünf')
    state = commands.splitParagraph(state)
    state = type(state, 'Sechs sieben')
    const [, a, , c] = state.doc.flow
    state = { ...state, selection: { anchor: { block: a.key, offset: 5 }, head: { block: c.key, offset: 6 } } }
    state = commands.deleteSelection(state)
    assert.deepEqual(texts(state.doc).slice(1), ['para:Eins sieben'])
    // Select from the title into the text: the title is shortened, not removed.
    state = { ...state, selection: { anchor: { block: state.doc.flow[0].key, offset: 7 }, head: { block: state.doc.flow[1].key, offset: 5 } } }
    state = commands.deleteSelection(state)
    assert.equal(state.doc.flow[0].ref.kind, 'title')
    assert.equal(runs.runsText(state.doc.flow[0].runs), 'Kapitel')
    assert.equal(runs.runsText(state.doc.flow[1].runs), 'sieben')
  })

  await test('formatting: toggle on a selection, stored marks on a caret, styles and alignment', () => {
    let state = type(freshState(), 'Ein kühner Satz')
    const block = state.doc.flow[1]
    state = { ...state, selection: { anchor: { block: block.key, offset: 4 }, head: { block: block.key, offset: 10 } } }
    state = commands.toggleMark(state, 'i')
    assert.deepEqual(state.doc.flow[1].runs, [{ text: 'Ein ' }, { text: 'kühner', m: { i: true } }, { text: ' Satz' }])
    state = commands.toggleMark(state, 'i')
    assert.deepEqual(state.doc.flow[1].runs, [{ text: 'Ein kühner Satz' }])
    state = { ...state, selection: docMod.caret({ block: block.key, offset: 15 }) }
    state = commands.toggleMark(state, 'b')
    state = type(state, '!')
    assert.deepEqual(state.doc.flow[1].runs.at(-1), { text: '!', m: { b: true } })
    state = commands.setParagraphStyle(state, 'quote')
    state = commands.setAlign(state, 'center')
    assert.equal(state.doc.flow[1].style, 'quote')
    assert.equal(state.doc.flow[1].align, 'center')
  })

  await test('page break, new scene and new chapter at the caret', () => {
    let state = type(freshState(), 'Anfang. Mitte. Ende.')
    const key = state.doc.flow[1].key
    state = commands.insertPageBreak({ ...state, selection: docMod.caret({ block: key, offset: 8 }) })
    assert.equal(state.doc.flow[2].breakBefore, 'page')
    state = commands.splitScene({ ...state, selection: docMod.caret({ block: state.doc.flow[2].key, offset: 6 }) }, { titles: { scene: 'Szene 2', chapter: 'Kapitel 2' } })
    assert.deepEqual(texts(state.doc), ['title:Kapitel 1', 'para:Anfang. ', 'para:Mitte.', 'break:* * *', 'para: Ende.'])
    state = commands.splitScene({ ...state, selection: docMod.caret({ block: state.doc.flow[1].key, offset: 3 }) }, { chapter: true, titles: { scene: 'Szene', chapter: 'Kapitel 2' } })
    assert.deepEqual(texts(state.doc), ['title:Kapitel 1', 'para:Anf', 'title:Kapitel 2', 'para:ang. ', 'para:Mitte.', 'break:* * *', 'para: Ende.'])
    assert.equal(state.doc.manifest.binder.length, 2)
    assert.equal(state.doc.manifest.binder[1].children.length, 2, 'the later scene moved into the new chapter')
  })

  await test('undo groups typing by word, redo restores, and saving writes only changed scenes with stamps', async () => {
    const controller = new controllerMod.WritingController(freshState().doc, 'dev1')
    for (const char of 'Ein Wort') controller.apply(commands.insertText(controller.state, char), 'typing', char)
    assert.equal(runs.runsText(controller.state.doc.flow[1].runs), 'Ein Wort')
    controller.undo()
    assert.equal(runs.runsText(controller.state.doc.flow[1].runs), 'Ein ')
    controller.undo()
    assert.equal(runs.runsText(controller.state.doc.flow[1].runs), '')
    controller.redo()
    controller.redo()
    assert.equal(runs.runsText(controller.state.doc.flow[1].runs), 'Ein Wort')
    const written = []
    const storage = { writeManifest: async (manifest) => written.push(['manifest', manifest]), writeScene: async (scene) => written.push(['scene', scene]) }
    assert.equal(await controller.save(storage), true)
    assert.equal(written.length, 1)
    assert.equal(written[0][1].paragraphs[0].v.dev1, 2, 'the edited paragraph is stamped')
    written.length = 0
    assert.equal(await controller.save(storage), true)
    assert.equal(written.length, 0, 'nothing changed, nothing written')
    controller.undo()
    await controller.save(storage)
    assert.equal(written.length, 1, 'an undo is an edit too')
    assert.ok(written[0][1].paragraphs.find((p) => !p.deleted).v.dev1 >= 3)
    const failing = { writeManifest: async () => { throw new Error('disk full') }, writeScene: async () => { throw new Error('disk full') } }
    controller.apply(commands.insertText(controller.state, 'x'), 'typing', 'x')
    assert.equal(await controller.save(failing), false)
    assert.equal(controller.isDirty(), true, 'a failed save keeps the change pending')
    assert.equal(controller.lastSaveError, 'disk full')
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
