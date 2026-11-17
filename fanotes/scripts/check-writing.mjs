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

  await test('a typed space moves the caret at once (trailing and leading spaces)', () => {
    for (const align of ['left', 'justify', 'center', 'right']) {
      const plain = linebreak.layoutParagraph({ runs: [{ text: 'Es war einmal' }], style: resolved({ align, indentFirst: 0 }), width: 400, measurer })
      const spaced = linebreak.layoutParagraph({ runs: [{ text: 'Es war einmal ' }], style: resolved({ align, indentFirst: 0 }), width: 400, measurer })
      const before = linebreak.caretX(spaced, 0, 13, measurer)
      const after = linebreak.caretX(spaced, linebreak.lineAt(spaced, 14), 14, measurer)
      // On a right-aligned line the text ends at the margin: the caret stays in the box instead of leaving it.
      if (align === 'right') assert.ok(after <= spaced.lines[0].available + 0.001 && after >= before, `${align}: the caret stays inside the box (${before} → ${after})`)
      else assert.ok(after > before + 1, `${align}: the caret moved past the space (${before} → ${after})`)
      assert.equal(spaced.lines[0].width, plain.lines[0].width, `${align}: the hanging space does not change the alignment`)
      assert.equal(spaced.lines[0].pieces.at(-1).hang, true)
    }
    const only = linebreak.layoutParagraph({ runs: [{ text: ' ' }], style: resolved({ indentFirst: 0 }), width: 400, measurer })
    assert.ok(linebreak.caretX(only, 0, 1, measurer) > linebreak.caretX(only, 0, 0, measurer), 'a space in an empty paragraph moves the caret')
    const leading = linebreak.layoutParagraph({ runs: [{ text: ' Hallo' }], style: resolved({ indentFirst: 0 }), width: 400, measurer })
    assert.ok(linebreak.caretX(leading, 0, 1, measurer) > 0, 'a leading space is kept')
    // Spaces at a soft wrap hang at the end of their line: the next line starts with its word.
    const wrapped = linebreak.layoutParagraph({ runs: [{ text: lorem }], style: resolved({ indentFirst: 0, align: 'left' }), width: 300, measurer })
    for (const line of wrapped.lines.slice(1)) assert.notEqual(line.pieces[0].kind, 'space')
    for (const line of wrapped.lines) assert.ok(line.width <= line.available + 0.5)
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

  // ── Soft wraps and line ends ─────────────────────────────────────────────
  const ALIGNS = ['left', 'justify', 'center', 'right']
  const fontOf = (style) => ({ family: style.font, bold: false, italic: false, size: style.size })
  const widthOf = (style, text) => measurer.width(text, fontOf(style))
  /** Every caret position a line offers (what the keyboard and the mouse can reach), with its x. */
  const stopsOf = (layout, index) => {
    const end = linebreak.lineEnd(layout, index)
    const line = layout.lines[index]
    const out = []
    for (let offset = index === 0 && layout.dropCap ? 0 : line.from; offset <= end.offset; offset += 1) out.push({ offset, x: linebreak.caretX(layout, index, offset, measurer) })
    return out
  }

  await test('a soft wrap: the spaces hang at the end of their line, so both the line end and the next line start are caret positions', () => {
    for (const align of ALIGNS) {
      const style = resolved({ align, indentFirst: 0 })
      const width = widthOf(style, 'hello wor') // holds "hello" but not "hello world"
      const layout = linebreak.layoutParagraph({ runs: [{ text: 'hello world again' }], style, width, measurer })
      assert.deepEqual(layout.lines.map((line) => [line.from, line.to]), [[0, 6], [6, 12], [12, 17]], align)
      const [first, second, third] = layout.lines
      assert.equal(first.pieces.at(-1).hang, true, `${align}: the space hangs`)
      assert.equal(second.pieces[0].text, 'world', `${align}: the next line starts with its word`)
      // Alignment ignores the hanging space.
      const alone = linebreak.layoutParagraph({ runs: [{ text: 'hello' }], style, width, measurer })
      assert.equal(first.pieces[0].x, alone.lines[0].pieces[0].x, `${align}: x`)
      assert.equal(first.width, alone.lines[0].width, `${align}: width`)
      // Offset 5 is the end of "hello": on line 0, right after the word, even when the caret moves forward.
      const hello = first.pieces[0]
      assert.equal(linebreak.lineAt(layout, 5, true), 0, `${align}: the end of "hello" is on its own line`)
      assert.ok(Math.abs(linebreak.caretX(layout, 0, 5, measurer) - Math.min(hello.x + hello.width, first.available)) < 0.001, `${align}: right after "hello"`)
      // Offset 6 is the start of the next line; one Right from 5 moves to another place.
      assert.equal(linebreak.lineAt(layout, 6, true), 1, `${align}: after the space the caret is on the next line`)
      assert.equal(linebreak.caretX(layout, 1, 6, measurer), second.pieces[0].x, `${align}: at its first word`)
      assert.notDeepEqual([linebreak.lineAt(layout, 5, true), linebreak.caretX(layout, 0, 5, measurer)], [linebreak.lineAt(layout, 6, true), linebreak.caretX(layout, 1, 6, measurer)], `${align}: Right from 5 to 6 shows`)
      // End and clicks: the line end stays on the line; left of the next line is its start.
      assert.deepEqual(linebreak.lineEnd(layout, 0), { offset: 5, upstream: false }, align)
      assert.deepEqual(linebreak.caretAtX(layout, 0, 9999, measurer), { offset: 5, upstream: false }, `${align}: a click right of line 0`)
      assert.deepEqual(linebreak.caretAtX(layout, 1, -9999, measurer), { offset: 6, upstream: false }, `${align}: a click left of line 1`)
      assert.deepEqual(linebreak.lineEnd(layout, 2), { offset: 17, upstream: false }, `${align}: the paragraph ends the last line`)
      assert.equal(linebreak.offsetAtX(layout, 1, 9999, measurer), 11, `${align}: a click right of line 1`)
      // No caret leaves the line's box, and x never goes back within a line.
      layout.lines.forEach((line, index) => {
        let previous = -Infinity
        for (let offset = line.from; offset <= line.to; offset += 1) {
          const x = linebreak.caretX(layout, index, offset, measurer)
          assert.ok(x <= line.available + 0.001, `${align}: line ${index} offset ${offset} inside the box (${x} > ${line.available})`)
          assert.ok(x >= previous - 0.001, `${align}: line ${index} offset ${offset} does not go back`)
          previous = x
        }
      })
      assert.equal(third.pieces.at(-1).hang, undefined)
      // Several typed spaces at the wrap all hang on the first line; the caret passes them, End stays before them.
      const spaced = linebreak.layoutParagraph({ runs: [{ text: 'hello   world again' }], style, width, measurer })
      assert.deepEqual(spaced.lines.map((line) => [line.from, line.to]), [[0, 8], [8, 14], [14, 19]], `${align}: three spaces`)
      assert.deepEqual(linebreak.lineEnd(spaced, 0), { offset: 5, upstream: false })
      for (const offset of [5, 6, 7]) assert.equal(linebreak.lineAt(spaced, offset, true), 0, `${align}: offset ${offset} is on line 0`)
      assert.equal(linebreak.lineAt(spaced, 8, true), 1)
      assert.ok(linebreak.caretX(spaced, 0, 7, measurer) >= linebreak.caretX(spaced, 0, 5, measurer), `${align}: x does not go back`)
      assert.equal(linebreak.offsetAtX(spaced, 0, 9999, measurer), 5, `${align}: a click right of the wrapped line goes before the spaces`)
    }
  })

  await test('a soft wrap with a space: justified lines stay full, the hanging space is not drawn into the width', () => {
    const style = resolved({ align: 'justify', indentFirst: 0 })
    const layout = linebreak.layoutParagraph({ runs: [{ text: lorem }], style, width: 300, measurer })
    layout.lines.slice(0, -1).forEach((line, index) => {
      assert.ok(Math.abs(line.width - line.available) < 0.5, `line ${index} fills the measure`)
      assert.equal(line.pieces.at(-1).hang, true, `line ${index} ends in a hanging space`)
      assert.equal(line.to, layout.lines[index + 1].from)
      assert.ok(linebreak.caretX(layout, index, line.to, measurer) <= line.available + 0.001, `line ${index}: the caret after the hanging space stays in the box`)
    })
  })

  await test('a wrap without a space (hyphen, dash, inside a long word): the line end is an upstream caret of that line', async () => {
    const hyphenator = await measure.loadHyphenator('de')
    const text = 'Am Ufer stand die Donaudampfschifffahrtsgesellschaft mit ihren Kapitänen.'
    for (const align of ALIGNS) {
      const layout = linebreak.layoutParagraph({ runs: [{ text }], style: resolved({ indentFirst: 0, align }), width: 260, measurer, hyphenator, hyphenate: true })
      const hyphenated = layout.lines.map((line, index) => ({ line, index })).filter(({ line }) => line.pieces.at(-1)?.hyphen)
      assert.ok(hyphenated.length >= 1, `${align}: a line ends in a hyphen`)
      for (const { line, index } of hyphenated) {
        assert.deepEqual(linebreak.lineEnd(layout, index), { offset: line.to, upstream: true }, `${align}: End`)
        assert.equal(linebreak.lineAt(layout, line.to, true), index + 1, `${align}: as a plain offset it is the start of the next line`)
        assert.equal(linebreak.lineAt(layout, line.to, false), index, `${align}: upstream it is the end of this line`)
        const piece = line.pieces.at(-1)
        assert.ok(Math.abs(linebreak.caretX(layout, index, line.to, measurer) - Math.min(piece.x + piece.width + measurer.width('-', piece.font), line.available)) < 0.001, `${align}: the end caret sits after the hyphen`)
        assert.deepEqual(linebreak.caretAtX(layout, index, 9999, measurer), { offset: line.to, upstream: true }, `${align}: a click right of the line`)
        assert.deepEqual(linebreak.caretAtX(layout, index + 1, -9999, measurer), { offset: line.to, upstream: false }, `${align}: a click left of the next line`)
      }
    }
    // A break after a dash.
    const style = resolved({ indentFirst: 0, align: 'left' })
    const dash = linebreak.layoutParagraph({ runs: [{ text: 'Der selbst-bewusste Wärter' }], style, width: widthOf(style, 'Der selbst-') + 2, measurer })
    assert.equal(dash.lines[0].pieces.at(-1).text, 'selbst-')
    assert.deepEqual(linebreak.lineEnd(dash, 0), { offset: 11, upstream: true })
    assert.equal(linebreak.lineAt(dash, 11, true), 1)
    assert.equal(linebreak.lineAt(dash, 11, false), 0)
    // A word wider than the line, broken by characters.
    const long = linebreak.layoutParagraph({ runs: [{ text: 'x'.repeat(60) }], style, width: 100, measurer })
    assert.ok(long.lines.length > 2)
    long.lines.forEach((line, index) => {
      const last = index === long.lines.length - 1
      assert.deepEqual(linebreak.lineEnd(long, index), { offset: line.to, upstream: !last }, `line ${index}`)
      assert.equal(linebreak.lineAt(long, line.to, !linebreak.lineEnd(long, index).upstream), index)
    })
  })

  await test('spaces after a forced break (Shift+Enter) are typed text: they keep their width and the caret passes them', () => {
    for (const align of ALIGNS) {
      const style = resolved({ align, indentFirst: 0 })
      const indented = linebreak.layoutParagraph({ runs: [{ text: 'a\n   b' }], style, width: 400, measurer })
      const second = indented.lines[1]
      assert.deepEqual([second.from, second.to], [2, 6], align)
      assert.equal(second.pieces[0].kind, 'space', `${align}: the line starts with the spaces`)
      assert.equal(second.pieces[0].hang, undefined, `${align}: they do not hang`)
      assert.ok(Math.abs(second.pieces[1].x - second.pieces[0].x - widthOf(style, '   ')) < 0.001, `${align}: the word is shifted by three spaces`)
      const xs = stopsOf(indented, 1).map((stop) => stop.x)
      assert.equal(xs.length, 5, `${align}: offsets 2 to 6`)
      for (let index = 1; index < xs.length; index += 1) assert.ok(xs[index] > xs[index - 1] + 1, `${align}: the caret passes space ${index} (${xs.join(', ')})`)
      assert.equal(linebreak.offsetAtX(indented, 1, xs[2], measurer), 4, `${align}: a click in the spaces`)
      // Only spaces after the break: they hang, but the caret still passes them (as at the end of a paragraph).
      const only = linebreak.layoutParagraph({ runs: [{ text: 'a\n   ' }], style, width: 400, measurer })
      assert.deepEqual([only.lines[1].from, only.lines[1].to], [2, 5], align)
      assert.equal(only.lines[1].pieces.length, 1, `${align}: the spaces are a piece`)
      const onlyXs = stopsOf(only, 1).map((stop) => stop.x)
      assert.equal(onlyXs.length, 4, align)
      if (align !== 'right') for (let index = 1; index < onlyXs.length; index += 1) assert.ok(onlyXs[index] > onlyXs[index - 1] + 1, `${align}: the caret passes space ${index} of an empty line`)
      assert.equal(linebreak.offsetAtX(only, 1, 9999, measurer), 5, `${align}: a click right of the spaces`)
      assert.deepEqual(linebreak.lineEnd(only, 1), { offset: 5, upstream: false }, align)
    }
    // Spaces after a forced break and a word that does not fit after them: the spaces stay, the word moves down.
    const style = resolved({ align: 'left', indentFirst: 0 })
    const tight = linebreak.layoutParagraph({ runs: [{ text: `a\n${' '.repeat(12)}wordwordword` }], style, width: widthOf(style, 'wordwordword') + 10, measurer })
    assert.equal(tight.lines.map((line) => linebreak.lineEnd(tight, tight.lines.indexOf(line)).offset).length, tight.lines.length)
    assert.equal(tight.lines.map((line) => line.pieces.filter((piece) => piece.kind !== 'newline').map((piece) => piece.text).join('')).join('|'), `a|${' '.repeat(12)}|wordwordword`)
    for (const line of tight.lines) assert.ok(line.width <= line.available + 0.5)
  })

  await test('alignment ignores the spaces before a forced break just like those at the end of the paragraph', () => {
    for (const align of ALIGNS) {
      const style = resolved({ align, indentFirst: 0 })
      const broken = linebreak.layoutParagraph({ runs: [{ text: 'ab   \ncd' }], style, width: 200, measurer })
      const ended = linebreak.layoutParagraph({ runs: [{ text: 'ab   ' }], style, width: 200, measurer })
      const [line] = broken.lines
      assert.equal(line.pieces[0].x, ended.lines[0].pieces[0].x, `${align}: "ab" sits where it does at the paragraph end`)
      assert.equal(line.width, ended.lines[0].width, `${align}: width`)
      assert.deepEqual(line.pieces.map((piece) => piece.kind), ['word', 'space', 'newline'], `${align}: the break stays last`)
      assert.equal(line.pieces[1].hang, true, `${align}: the spaces hang`)
      assert.equal(line.pieces[2].x, line.pieces[1].x + line.pieces[1].width, `${align}: the break comes after the hanging spaces`)
      assert.equal(line.last, true)
      // The caret before the break is after the spaces; End goes there, and so does a click right of the line.
      assert.deepEqual(linebreak.lineEnd(broken, 0), { offset: 5, upstream: false }, align)
      assert.equal(linebreak.offsetAtX(broken, 0, 9999, measurer), 5, align)
      assert.equal(linebreak.lineAt(broken, 5, true), 0, align)
      assert.ok(linebreak.caretX(broken, 0, 5, measurer) >= linebreak.caretX(broken, 0, 2, measurer), align)
      assert.ok(linebreak.caretX(broken, 0, 5, measurer) <= line.available + 0.001, align)
      assert.equal(broken.lines[1].from, 6, align)
    }
  })

  await test('a drop cap has caret positions of its own: Home then Right moves, and a click on the cap lands before or after it', () => {
    const style = linebreak.resolveStyle({ ...story.manifest.styles.first, dropCap: 3 }, { afterBreak: true })
    for (const text of [lorem, `„${lorem}`]) {
      const layout = linebreak.layoutParagraph({ runs: [{ text }], style, width: 300, measurer })
      const cap = layout.dropCap
      const xs = []
      for (let offset = 0; offset <= cap.text.length; offset += 1) xs.push(linebreak.caretX(layout, 0, offset, measurer))
      assert.ok(Math.abs(xs[0] + cap.width) < 0.001, `${cap.text}: offset 0 is the cap's left edge`)
      assert.ok(Math.abs(xs.at(-1) - layout.lines[0].pieces[0].x) < 0.001, `${cap.text}: after the cap the text starts`)
      for (let index = 1; index < xs.length; index += 1) assert.ok(xs[index] > xs[index - 1] + 1, `${cap.text}: offset ${index} is right of offset ${index - 1}`)
      xs.forEach((x, offset) => assert.equal(linebreak.offsetAtX(layout, 0, x, measurer), offset, `${cap.text}: x ${x}`))
      assert.equal(linebreak.offsetAtX(layout, 0, -cap.width - 20, measurer), 0, 'left of the cap')
      assert.equal(linebreak.offsetAtX(layout, 0, -1, measurer), cap.text.length, 'right of the cap')
      assert.equal(linebreak.offsetAtX(layout, 1, -cap.width, measurer), layout.lines[1].from, 'beside the cap on a later line: the line start')
    }
    // A paragraph that is only the cap letter.
    const only = linebreak.layoutParagraph({ runs: [{ text: 'D' }], style, width: 300, measurer })
    assert.ok(linebreak.caretX(only, 0, 1, measurer) > linebreak.caretX(only, 0, 0, measurer) + 1)
    assert.equal(linebreak.offsetAtX(only, 0, -1, measurer), 1)
  })

  await test('a hyphen is measured in the font it is drawn in (bold, larger or smaller last piece)', async () => {
    const hyphenator = await measure.loadHyphenator('de')
    const style = resolved({ indentFirst: 0, align: 'justify' })
    for (const marks of [{ b: true }, { size: 16 }, { i: true, size: 8 }]) {
      const runsIn = [{ text: 'Am Ufer stand die ' }, { text: 'Donaudampfschifffahrtsgesellschaft', m: marks }, { text: ' mit ihren Kapitänen.' }]
      const layout = linebreak.layoutParagraph({ runs: runsIn, style, width: 260, measurer, hyphenator, hyphenate: true })
      const hyphenated = layout.lines.filter((line) => line.pieces.at(-1)?.hyphen)
      assert.ok(hyphenated.length >= 1, `${JSON.stringify(marks)}: a line ends in a hyphen`)
      for (const line of hyphenated) {
        const piece = line.pieces.at(-1)
        assert.ok(Math.abs(line.width - (piece.x + piece.width + measurer.width('-', piece.font))) < 0.001, `${JSON.stringify(marks)}: the line ends where its hyphen does`)
        assert.ok(line.width <= line.available + 0.5, `${JSON.stringify(marks)}: the hyphen stays inside the line`)
      }
      // A line that holds only the base font's hyphen still fits when the hyphen is narrower.
      assert.equal(layout.lines.map((line) => line.pieces.filter((piece) => piece.kind === 'word').map((piece) => piece.text).join('')).join(''), runsIn.map((run) => run.text).join('').replace(/ /gu, ''), 'the text is all there')
    }
  })

  await test('soft wraps keep every invariant for random paragraphs (spaces, tabs, breaks, hyphens, drop caps, marks)', async () => {
    const hyphenator = await measure.loadHyphenator('de')
    let seed = 20261116
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    const pick = (list) => list[Math.floor(random() * list.length)]
    const words = ['Der', 'alte', 'Leuchtturmwärter', 'stieg', 'Donaudampfschifffahrtsgesellschaft', 'a', 'selbst-bewusst', 'x/y', 'hundertzwölf', 'Wind', 'über', 'MMMM', 'ß']
    const separators = [' ', ' ', ' ', '  ', '   ', '\t', ' \n', '\n', '\n  ', '  \n  ']
    let stops = 0
    for (let round = 0; round < 500; round += 1) {
      let text = ''
      const count = 1 + Math.floor(random() * 14)
      if (random() < 0.15) text += pick(['  ', ' ', '\n', '   '])
      for (let index = 0; index < count; index += 1) text += pick(words) + (index < count - 1 || random() < 0.4 ? pick(separators) : '')
      const align = pick(ALIGNS)
      const width = pick([40, 60, 90, 130, 200, 300])
      const marked = random() < 0.3 && text.length > 9
      const runsIn = marked ? [{ text: text.slice(0, 4) }, { text: text.slice(4, 9), m: { b: true } }, { text: text.slice(9) }] : [{ text }]
      const style = linebreak.resolveStyle({ ...story.manifest.styles.first, size: 10, align, indentFirst: pick([0, 5]), dropCap: random() < 0.15 ? 3 : 0 }, { afterBreak: true })
      const layout = linebreak.layoutParagraph({ runs: runsIn, style, width, measurer, hyphenator, hyphenate: random() < 0.6 })
      const where = JSON.stringify({ text, align, width, dropCap: style.dropCap })
      const lines = layout.lines
      const capLength = layout.dropCap ? layout.dropCap.text.length : 0
      assert.equal(lines[0].from, 0, where)
      assert.equal(lines.at(-1).to, text.length, where)
      lines.forEach((line, index) => {
        if (index) assert.equal(line.from, lines[index - 1].to, `lines are contiguous: ${where}`)
        // Every typed character is in a piece of its line (nothing vanishes), in order.
        assert.equal(line.pieces.filter((piece) => piece.kind !== 'marker' && piece.kind !== 'anchor').map((piece) => piece.text).join(''), text.slice(index === 0 ? capLength : line.from, line.to), `pieces cover line ${index}: ${where}`)
        const end = linebreak.lineEnd(layout, index)
        assert.ok(end.offset >= line.from && end.offset <= line.to, `End is in its line: ${where}`)
        assert.equal(linebreak.lineAt(layout, end.offset, !end.upstream), index, `End stays on line ${index}: ${where}`)
        const all = stopsOf(layout, index)
        all.forEach((stop, position) => {
          if (index === 0 && stop.offset < capLength) return
          assert.equal(linebreak.lineAt(layout, stop.offset, !(stop.offset === end.offset && end.upstream)), index, `offset ${stop.offset} belongs to line ${index}: ${where}`)
          assert.ok(stop.x <= line.available + 0.001, `the caret is inside the box (${stop.x} > ${line.available}): ${where}`)
          if (position) assert.ok(stop.x >= all[position - 1].x - 0.01, `x does not go back at offset ${stop.offset} of line ${index}: ${where}`)
          // The offset nearest to a caret's x is that caret (unless another caret shares its x).
          if (!all.some((other) => other.offset !== stop.offset && Math.abs(other.x - stop.x) < 0.01)) {
            assert.deepEqual(linebreak.caretAtX(layout, index, stop.x, measurer), { offset: stop.offset, upstream: stop.offset === end.offset && end.upstream }, `a click on the caret of offset ${stop.offset} (line ${index}): ${where}`)
          }
          stops += 1
        })
        for (const x of [-999, -3, 0, 3, 17, 50, 130, 999]) {
          const hit = linebreak.caretAtX(layout, index, x, measurer)
          assert.ok(hit.offset >= (index === 0 ? 0 : line.from) && hit.offset <= end.offset, `a click at ${x} stays in line ${index}: ${where}`)
          assert.equal(linebreak.lineAt(layout, hit.offset, !hit.upstream), index, `a click at ${x} lands on line ${index}: ${where}`)
        }
      })
    }
    assert.ok(stops > 10_000, `${stops} caret positions checked`)
  })

  await test('React keys of a line are unique: a list marker and its first word, footnote anchors at one offset', async () => {
    const pageView = await load('/src/writing/ui/PageView.tsx')
    const listStyle = linebreak.resolveStyle(story.manifest.styles.list)
    const list = linebreak.layoutParagraph({ runs: [{ text: lorem }], style: listStyle, width: 300, measurer })
    assert.deepEqual(list.lines[0].pieces.slice(0, 2).map((piece) => [piece.kind, piece.from]), [['marker', 0], ['word', 0]], 'both start at offset 0')
    const anchored = linebreak.layoutParagraph({ runs: [{ text: 'Satz' }, { text: '', m: { fn: 'note0000001' } }, { text: '', m: { fn: 'note0000002' } }, { text: ' weiter.' }], style: resolved({ indentFirst: 0 }), width: 300, measurer })
    assert.equal(anchored.lines[0].pieces.filter((piece) => piece.kind === 'anchor').length, 2)
    for (const layout of [list, anchored]) {
      for (const line of layout.lines) {
        const keys = line.pieces.map((piece, index) => pageView.pieceKey(piece, index))
        assert.equal(new Set(keys).size, keys.length, keys.join(' '))
      }
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

  const navigation = await load('/src/writing/ui/navigation.ts')
  await test('End, Home, a click and Up/Down at a soft wrap stay on the line: the drawn caret is on the line, not on the next one', async () => {
    const hyphenator = await measure.loadHyphenator('de')
    const sentence = 'Der alte Leuchtturmwärter stieg jeden Abend die hundertzwölf Stufen hinauf, zündete das Licht an und sah hinaus auf das dunkle Wasser, über dem der Wind die Wolken jagte. Die Donaudampfschifffahrtsgesellschaft fuhr vorbei.'
    const seen = { hung: 0, upstream: 0, lines: 0 }
    for (const align of ALIGNS) {
      let state = type(freshState(), `${sentence} ${sentence}`)
      state = commands.setAlign(state, align)
      const key = state.doc.flow[1].key
      const layout = paginate.layoutManuscript(state.doc.manifest, state.doc.flow, new paginate.LayoutCache(), { measurer, hyphenators: { de: hyphenator } })
      const blockIndex = layout.blocks.findIndex((block) => block.key === key)
      const paragraph = layout.layouts[blockIndex]
      assert.ok(paragraph.lines.length >= 6, `${align}: ${paragraph.lines.length} lines`)
      const placed = (index) => navigation.placedLine(layout, blockIndex, index)
      /** Where the caret is drawn: page and top of its line. */
      const drawn = (pos, upstream) => {
        const box = navigation.caretBox(layout, pos, measurer, state.doc.index, upstream)
        return [box.page, box.y]
      }
      const lineBox = (index) => [placed(index).page.index, placed(index).placed.y]
      paragraph.lines.forEach((line, index) => {
        const start = { block: key, offset: Math.min(line.to, line.from + 2) }
        // End: the caret is on this line.
        const end = navigation.move(state.doc, layout, start, 'lineEnd', measurer, null)
        assert.deepEqual(drawn(end.pos, Boolean(end.upstream)), lineBox(index), `${align}: End on line ${index}`)
        if (index < paragraph.lines.length - 1) {
          assert.ok(end.pos.offset <= line.to, `${align}: line ${index}`)
          if (end.upstream) seen.upstream += 1
          else if (end.pos.offset < line.to) seen.hung += 1
        } else assert.equal(end.pos.offset, line.to, `${align}: the last line ends the paragraph`)
        seen.lines += 1
        // End again changes nothing; the caret is where the End key left it.
        const again = navigation.move(state.doc, layout, end.pos, 'lineEnd', measurer, null, Boolean(end.upstream))
        assert.deepEqual([again.pos, Boolean(again.upstream)], [end.pos, Boolean(end.upstream)], `${align}: End twice on line ${index}`)
        // Home from the end: the start of this line.
        const home = navigation.move(state.doc, layout, end.pos, 'lineStart', measurer, null, Boolean(end.upstream))
        assert.equal(home.pos.offset, line.from, `${align}: Home on line ${index}`)
        assert.deepEqual(drawn(home.pos, false), lineBox(index), `${align}: Home on line ${index} is drawn there`)
        // A click right of the line, and one left of it.
        const here = placed(index)
        const right = navigation.hitTestCaret(layout, here.page.index, here.placed.x + line.available + 30, here.placed.y + 1, measurer)
        assert.deepEqual([right.pos.offset, right.upstream], [end.pos.offset, Boolean(end.upstream)], `${align}: a click right of line ${index} is End`)
        assert.deepEqual(drawn(right.pos, right.upstream), lineBox(index), `${align}: a click right of line ${index} is drawn there`)
        const left = navigation.hitTestCaret(layout, here.page.index, here.placed.x - 30, here.placed.y + 1, measurer)
        assert.deepEqual([left.pos.offset, left.upstream], [index === 0 ? 0 : line.from, false], `${align}: a click left of line ${index} is Home`)
        assert.equal(navigation.hitTest(layout, here.page.index, here.placed.x + line.available + 30, here.placed.y + 1, measurer).offset, right.pos.offset, 'hitTest agrees')
        // Down and Up from the end of the line move by one line, whatever the line is like.
        if (index < paragraph.lines.length - 1) {
          const down = navigation.move(state.doc, layout, end.pos, 'down', measurer, null, Boolean(end.upstream))
          assert.deepEqual(drawn(down.pos, Boolean(down.upstream)), lineBox(index + 1), `${align}: Down from the end of line ${index}`)
          // Right from the end moves to the next line (after its first word's start for a wrap without spaces).
          const next = navigation.move(state.doc, layout, end.pos, 'right', measurer, null, Boolean(end.upstream))
          assert.deepEqual(drawn(next.pos, Boolean(next.upstream)), lineBox(index + 1), `${align}: Right from the end of line ${index}`)
        }
        if (index > 0) {
          const up = navigation.move(state.doc, layout, end.pos, 'up', measurer, null, Boolean(end.upstream))
          assert.deepEqual(drawn(up.pos, Boolean(up.upstream)), lineBox(index - 1), `${align}: Up from the end of line ${index}`)
          // Left from the start of the line moves back onto the previous line.
          const back = navigation.move(state.doc, layout, { block: key, offset: line.from }, 'left', measurer, null)
          assert.deepEqual(drawn(back.pos, false), lineBox(index - 1), `${align}: Left from the start of line ${index}`)
        }
      })
    }
    assert.ok(seen.hung >= 6 && seen.upstream >= 1, `lines ended at a space: ${seen.hung}, without one: ${seen.upstream}`)
  })

  await test('Shift+Enter indentation: Home, Right and a click pass the spaces; the caret flag is only set where it matters', () => {
    let state = type(commands.insertLineBreak(type(freshState(), 'Vers eins')), '      eingerückt')
    const key = state.doc.flow[1].key
    const layout = paginate.layoutManuscript(state.doc.manifest, state.doc.flow, new paginate.LayoutCache(), { measurer })
    const blockIndex = layout.blocks.findIndex((block) => block.key === key)
    const second = layout.layouts[blockIndex].lines[1]
    assert.equal(second.from, 10)
    const x = (offset) => navigation.caretBox(layout, { block: key, offset }, measurer, state.doc.index).x
    for (let offset = 10; offset < 16; offset += 1) assert.ok(x(offset + 1) > x(offset) + 1, `Right moves the caret from offset ${offset}`)
    const home = navigation.move(state.doc, layout, { block: key, offset: 20 }, 'lineStart', measurer, null)
    assert.equal(home.pos.offset, 10)
    const placed = navigation.placedLine(layout, blockIndex, 1)
    const hit = navigation.hitTest(layout, placed.page.index, placed.placed.x + (x(13) - placed.placed.x), placed.placed.y + 1, measurer)
    assert.equal(hit.offset, 13, 'a click in the indentation')
    // The flag is only there when asked for.
    assert.deepEqual(docMod.caret({ block: key, offset: 3 }), { anchor: { block: key, offset: 3 }, head: { block: key, offset: 3 } })
    assert.equal(docMod.caret({ block: key, offset: 3 }, true).upstream, true)
    assert.equal(navigation.move(state.doc, layout, { block: key, offset: 3 }, 'right', measurer, null).upstream, undefined)
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

  await test('live sync: edits from another device merge into the open story, never overwritten', async () => {
    const syncMerge = await load('/src/writing/syncMerge.ts')
    const live = await load('/src/writing/liveSync.ts')
    const text = (controller) => controller.state.doc.flow.filter((block) => block.ref.kind === 'para').map((block) => runs.runsText(block.runs)).join(' | ')
    // One disk shared by both devices; sync is simulated by merging into it like the engine does.
    const disk = new Map()
    const storageFor = () => ({
      writeManifest: async (manifest) => { disk.set('story.json', JSON.stringify(manifest)) },
      writeScene: async (scene) => { disk.set(scene.id, JSON.stringify(scene)) },
      readScene: async (id) => (disk.has(id) ? syncMerge.mergeableScene(JSON.parse(disk.get(id)), id) : null),
      readManifest: async () => (disk.has('story.json') ? syncMerge.mergeableManifest(JSON.parse(disk.get('story.json'))) : null),
    })
    const a = new controllerMod.WritingController(freshState().doc, 'dev1')
    disk.set('story.json', JSON.stringify(a.state.doc.manifest))
    a.apply(type(a.state, 'Hier schreibt der Laptop.'), 'typing', '.')
    assert.equal(await a.save(storageFor()), true)
    const sceneId = [...a.state.doc.scenes.keys()][0]
    // The tablet opens the same story and adds a paragraph.
    const otherDevice = (edit) => {
      const scene = JSON.parse(disk.get(sceneId))
      const b = new controllerMod.WritingController(docMod.makeDoc(JSON.parse(disk.get('story.json')), new Map([[sceneId, scene]])), 'dev2')
      const end = b.state.doc.flow.filter((block) => block.ref.kind === 'para').at(-1)
      b.select(docMod.caret({ block: end.key, offset: docMod.blockLength(end) }))
      b.apply(commands.splitParagraph(b.state), 'structure')
      b.apply(type(b.state, edit), 'typing', '.')
      return [...b.state.doc.scenes.values()][0]
    }
    const tablet = otherDevice('Das Tablet schreibt auch.')
    // Sync merges the tablet's version with the file here (both changed) and writes it.
    disk.set(sceneId, JSON.stringify(syncMerge.mergeSceneVersions(JSON.parse(disk.get(sceneId)), tablet).scene))
    assert.equal(a.isDirty(), false)
    assert.equal(a.absorb([syncMerge.mergeableScene(JSON.parse(disk.get(sceneId)), sceneId)], null), true)
    assert.match(text(a), /Laptop.*Tablet schreibt auch/u, 'the open editor shows the paragraph from the other device')
    assert.equal(a.isDirty(), false, 'absorbed changes count as saved')

    // The tablet writes again while the laptop has unsaved typing (the race the gate prevents, simulated):
    a.apply(type(a.state, ' Mehr vom Laptop.'), 'typing', '.')
    const second = otherDevice('Zweiter Absatz vom Tablet.')
    disk.set(sceneId, JSON.stringify(syncMerge.mergeSceneVersions(JSON.parse(disk.get(sceneId)), second).scene))
    assert.equal(await a.save(storageFor()), true)
    const onDisk = runs.runsText(JSON.parse(disk.get(sceneId)).paragraphs.filter((p) => !p.deleted).flatMap((p) => p.runs))
    assert.match(onDisk, /Mehr vom Laptop/u)
    assert.match(onDisk, /Zweiter Absatz vom Tablet/u, 'the save merged the file on disk instead of writing over it')
    assert.match(text(a), /Zweiter Absatz vom Tablet/u, 'and the editor shows it')

    // Typing during a slow save: the merged-in version still reaches the editor and the next save.
    const third = otherDevice('Dritter vom Tablet.')
    disk.set(sceneId, JSON.stringify(syncMerge.mergeSceneVersions(JSON.parse(disk.get(sceneId)), third).scene))
    a.apply(type(a.state, ' Noch mehr.'), 'typing', '.')
    const slow = storageFor()
    const write = slow.writeScene
    slow.writeScene = async (scene) => { a.apply(type(a.state, ' Während des Speicherns.'), 'typing', '.'); await write(scene) }
    await a.save(slow)
    assert.match(text(a), /Dritter vom Tablet/u)
    assert.match(text(a), /Während des Speicherns/u)
    await a.save(storageFor())
    const final = runs.runsText(JSON.parse(disk.get(sceneId)).paragraphs.filter((p) => !p.deleted).flatMap((p) => p.runs))
    for (const part of ['Laptop', 'Tablet schreibt auch', 'Zweiter Absatz', 'Dritter vom Tablet', 'Noch mehr', 'Während des Speicherns']) assert.match(final, new RegExp(part, 'u'), part)

    // Undo after another device's text was merged in must not take that text out again.
    a.apply(type(a.state, ' Letzter Satz.'), 'typing', '.')
    await a.save(storageFor())
    const fourth = otherDevice('Vierter vom Tablet.')
    disk.set(sceneId, JSON.stringify(syncMerge.mergeSceneVersions(JSON.parse(disk.get(sceneId)), fourth).scene))
    a.absorb([syncMerge.mergeableScene(JSON.parse(disk.get(sceneId)), sceneId)], null)
    assert.equal(a.canUndo(), false, 'the history ends at a merge')
    assert.equal(a.undo(), false)
    assert.match(text(a), /Vierter vom Tablet/u)

    // Sync wrote over a save that finished during its download: our text is not on disk.
    a.apply(type(a.state, ' Nur hier.'), 'typing', '.')
    await a.save(storageFor())
    const before = JSON.parse(disk.get(sceneId))
    const lost = { ...before, paragraphs: before.paragraphs.map((p) => ({ ...p, runs: p.runs.map((run) => ({ ...run, text: run.text.replace(' Nur hier.', '') })) })) }
    disk.set(sceneId, JSON.stringify(lost))
    a.absorb([syncMerge.mergeableScene(JSON.parse(disk.get(sceneId)), sceneId)], null)
    assert.match(text(a), /Nur hier/u, 'the editor keeps the text')
    assert.equal(a.isDirty(), true, 'and saves it again, since it is not on disk')
    await a.save(storageFor())
    assert.match(runs.runsText(JSON.parse(disk.get(sceneId)).paragraphs.filter((p) => !p.deleted).flatMap((p) => p.runs)), /Nur hier/u)

    // A clean editor absorbing the same content written with another key order stays clean (no save ping-pong).
    const same = JSON.parse(disk.get(sceneId))
    const reordered = { paragraphs: same.paragraphs.map((p) => Object.fromEntries(Object.entries(p).reverse())), id: same.id, format: same.format }
    disk.set(sceneId, JSON.stringify(reordered))
    a.absorb([syncMerge.mergeableScene(JSON.parse(disk.get(sceneId)), sceneId)], null)
    assert.equal(a.isDirty(), false, 'same content, other key order: nothing to save')

    // The gate: scenes and manifest of the open story may be written only while the editor is clean.
    let dirty = false
    const changed = []
    const off = live.registerStoryGate({ path: 'B/R.story', isBusy: () => dirty, changed: (files) => changed.push(...files) })
    assert.equal(live.storySyncBusy('B/R.story', 'B/R.story/scenes/abc123.json'), false)
    assert.equal(live.storySyncBusy('B/R.story', 'B/R.story/story.json'), false)
    assert.equal(live.storySyncBusy('B/R.story', 'B/R.story/bible/characters/abc123.json'), true, 'other story files wait until it is closed')
    assert.equal(live.storySyncBusy('B/R.story', 'B/R.story/scenes/../x.json'), true)
    assert.equal(live.storySyncBusy('B/R.story', 'B/Other.md'), false)
    dirty = true
    assert.equal(live.storySyncBusy('B/R.story', 'B/R.story/scenes/abc123.json'), true, 'unsaved edits make it wait')
    live.notifyStoryWritten('B/R.story', ['B/R.story/scenes/abc123.json', 'B/R.story/progress/x.json', 'B/Other.md'])
    assert.deepEqual(changed, ['scenes/abc123.json'])
    off()
    assert.equal(live.storySyncBusy('B/R.story', 'B/R.story/scenes/abc123.json'), true, 'without an editor the whole story waits')
  })

  await test('absorb: a document that turns clean without changing still emits', async () => {
    const c = new controllerMod.WritingController(freshState().doc, 'dev1')
    c.apply(type(c.state, 'Schon auf der Platte.'), 'typing', '.')
    const saved = { writeManifest: async () => {}, writeScene: async () => {} }
    assert.equal(await c.save(saved), true)
    const sceneId = [...c.state.doc.scenes.keys()][0]
    const onDisk = c.state.doc.scenes.get(sceneId)
    // An equal but not identical saved copy (what a reload of the same file gives): dirty by identity.
    c.savedScenes.set(sceneId, JSON.parse(JSON.stringify(onDisk)))
    assert.equal(c.isDirty(), true, 'dirty by identity')
    let emitted = 0
    c.subscribe(() => { emitted += 1 })
    // Sync wrote exactly what the editor shows.
    c.absorb([JSON.parse(JSON.stringify(onDisk))], null)
    assert.equal(c.isDirty(), false, 'equal to what is on disk: clean')
    assert.ok(emitted >= 1, 'listeners hear that it is clean')
  })

  await test('android host: the editor pushes busy, Kotlin calls back with the written files', async () => {
    const al = await load('/src/writing/androidLive.ts')
    let dirty = false
    let saving = false
    const listeners = new Set()
    const source = { isDirty: () => dirty, isSaving: () => saving, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } }
    const emit = () => [...listeners].forEach((l) => l())
    const pushed = []
    let failing = false
    const retries = []
    const bridge = { storyBusy: (busy) => { if (failing) throw new Error('bridge'); pushed.push(busy) } }
    const stop = al.reportEditorBusy(source, bridge, (retry) => retries.push(retry))
    assert.deepEqual(pushed, [false], 'initial state is reported')
    emit()
    assert.deepEqual(pushed, [false], 'unchanged state is not pushed again')
    dirty = true; emit()
    saving = true; dirty = false; emit()
    assert.deepEqual(pushed, [false, true], 'saving counts as busy')
    saving = false; emit()
    assert.deepEqual(pushed, [false, true, false])
    failing = true; dirty = true; emit()
    assert.equal(retries.length, 1, 'a failed push is retried')
    failing = false; retries.shift()()
    assert.deepEqual(pushed, [false, true, false, true])
    // Kotlin swapped its gate: the same state is sent again although it did not change.
    const count = pushed.length
    stop.resend()
    assert.deepEqual(pushed.slice(count), [true], 'resend pushes an unchanged state')
    stop()
    assert.equal(pushed.at(-1), true, 'stopping holds the files')
    dirty = false; emit()
    assert.equal(pushed.at(-1), true, 'no push after stop')
    // No bridge method (older app): nothing happens.
    al.reportEditorBusy(source, {})()
    al.reportEditorBusy(source, null)()
    // The entry Kotlin calls.
    const target = {}
    const got = []
    let resent = 0
    const off = al.installStoryWrittenEntry(target, (files) => got.push(...files), () => { resent += 1 })
    target[al.REPORT_BUSY_ENTRY]()
    assert.equal(resent, 1)
    target[al.STORY_WRITTEN_ENTRY](JSON.stringify(['scenes/abc123.json', 5, 'story.json']))
    target[al.STORY_WRITTEN_ENTRY]('not json')
    target[al.STORY_WRITTEN_ENTRY]('{}')
    assert.deepEqual(got, ['scenes/abc123.json', 'story.json'])
    off()
    assert.equal(target[al.STORY_WRITTEN_ENTRY], undefined)
    assert.equal(target[al.REPORT_BUSY_ENTRY], undefined)
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
