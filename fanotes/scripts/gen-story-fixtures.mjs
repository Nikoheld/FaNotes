// Parity fixtures for the Rust writing engine (crates/fanotes-story).
//
//   node scripts/gen-story-fixtures.mjs            fixtures + timing
//   node scripts/gen-story-fixtures.mjs --patterns also rewrite data/hyphen/*.json
//   node scripts/gen-story-fixtures.mjs --chromium also measure canvas widths in headless
//                                                  Chromium (tests/fixtures/canvas-widths.json)
//
// Loads the TypeScript writing modules through Vite (as check-writing.mjs does),
// runs them on fixed inputs and writes inputs + outputs as JSON into
// crates/fanotes-story/tests/fixtures/. `cargo test -p fanotes-story` must
// reproduce every output exactly. Random ids come from a seeded generator put
// in place of crypto.getRandomValues (the same one as SeededIds in Rust).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const crateRoot = join(appRoot, '..', 'crates', 'fanotes-story')
const outDir = join(crateRoot, 'tests', 'fixtures')
mkdirSync(outDir, { recursive: true })
const require = createRequire(join(appRoot, 'package.json'))

// ── Seeded ids ─────────────────────────────────────────────────────────────
let state = 1n
const seed = (value) => { state = BigInt(value) & 0x7fffffffn }
globalThis.crypto.getRandomValues = (array) => {
  for (let index = 0; index < array.length; index += 1) {
    state = (state * 1103515245n + 12345n) % 2147483648n
    array[index] = Number((state >> 16n) & 255n)
  }
  return array
}

if (process.argv.includes('--patterns')) {
  for (const [name, file] of [['de-1996', 'de'], ['en-us', 'en-us'], ['en-gb', 'en-gb']]) {
    writeFileSync(join(crateRoot, 'data', 'hyphen', `${file}.json`), `${JSON.stringify(require(`hyphen/patterns/${name}.js`))}\n`)
  }
}

// Canonical JSON (sorted keys) and a 32-bit FNV-1a over its UTF-16 units: compact checks for big layouts.
const canonical = (value) => JSON.stringify(value, (_, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item))
const fnv = (text) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
const write = (name, value) => {
  writeFileSync(join(outDir, name), `${JSON.stringify(value)}\n`)
  console.log(`  ${name}: ${(JSON.stringify(value).length / 1024).toFixed(0)} KiB`)
}

// ── Canvas widths in Chromium, for the Rust font measurer ─────────────────
if (process.argv.includes('--chromium')) {
  const fontDir = join(appRoot, 'public', 'writing', 'fonts')
  const families = { literata: ['FaNotes Literata', 'Literata'], garamond: ['FaNotes Garamond', 'EBGaramond'], courier: ['FaNotes Courier', 'CourierPrime'], atkinson: ['FaNotes Atkinson', 'AtkinsonHyperlegible'] }
  const faces = Object.entries(families).flatMap(([family, [css, file]]) => [['Regular', false, false], ['Italic', false, true], ['Bold', true, false], ['BoldItalic', true, true]].map(([variant, bold, italic]) => ({ family, css, file: `${file}-${variant}.ttf`, bold, italic })))
  const sentences = [
    'Der alte Leuchtturmwärter stieg jeden Abend die hundertzwölf Stufen hinauf, zündete das Licht an und sah hinaus auf das dunkle Wasser, über dem der Wind die Wolken jagte.',
    '„Kommst du mit?“, fragte sie leise. – Er schüttelte den Kopf: »Nein, heute nicht.« Straße, Größe, Fußgänger, Äpfel, Öl, Übermut.',
    'The quick brown fox jumps over the lazy dog; “Well,” she said, “it’s a fine affair—isn’t it?” Officially, the coffee was flawless.',
    'AVATAR WAVE Tyrol Yacht LT VA To Ta fi fl ffi ffl 0123456789 % & @ § ( ) [ ] – — … · • ’ ‘ « » ‹ ›',
  ]
  const samples = [...new Set(sentences.flatMap((sentence) => [sentence, ...sentence.split(' ')]).filter(Boolean))]
  const sizes = [14.666666666666666, 9.533333333333333, 26.666666666666664]
  const html = `<!doctype html><meta charset="utf-8"><body><script>
const faces = ${JSON.stringify(faces)}; const samples = ${JSON.stringify(samples)}; const sizes = ${JSON.stringify(sizes)};
(async () => {
  for (const f of faces) { const face = new FontFace(f.css, 'url("file://${fontDir}/' + f.file + '")', { weight: f.bold ? '700' : '400', style: f.italic ? 'italic' : 'normal' }); document.fonts.add(await face.load()) }
  const ctx = document.createElement('canvas').getContext('2d'); ctx.fontKerning = 'normal'
  const widths = []; const metrics = []
  for (const f of faces) for (const size of sizes) {
    ctx.font = (f.italic ? 'italic ' : '') + (f.bold ? '700' : '400') + ' ' + size + 'px "' + f.css + '"'
    for (const text of samples) widths.push([f.family, f.bold, f.italic, size, text, ctx.measureText(text).width])
    const m = ctx.measureText('Hgjpqy'); metrics.push([f.family, f.bold, f.italic, size, m.fontBoundingBoxAscent, m.fontBoundingBoxDescent])
  }
  document.body.textContent = JSON.stringify({ widths, metrics })
})().catch((error) => { document.body.textContent = 'ERROR ' + error })
</script>`
  const page = join(process.env.TMPDIR ?? '/tmp', `story-canvas-${process.pid}.html`)
  writeFileSync(page, html)
  const dom = execFileSync('chromium', ['--headless', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files', '--virtual-time-budget=30000', '--dump-dom', `file://${page}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const body = dom.slice(dom.indexOf('<body>') + 6, dom.lastIndexOf('</body>')).replace(/<script>[\s\S]*<\/script>/u, '').trim().replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
  if (!body.startsWith('{')) throw new Error(`Chromium measurement failed: ${body.slice(0, 200)}`)
  unlinkSync(page)
  const chromium = execFileSync('chromium', ['--version'], { encoding: 'utf8' }).trim()
  writeFileSync(join(outDir, 'canvas-widths.json'), `${JSON.stringify({ chromium, ...JSON.parse(body) })}\n`)
  console.log(`  canvas-widths.json from ${chromium}`)
}

const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
const load = (path) => vite.ssrLoadModule(path)
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
  const hyphenators = {}
  for (const language of ['de', 'de-CH', 'en-US', 'en-GB']) hyphenators[language] = await measure.loadHyphenator(language)

  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim()
  const tsBase = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src/writing/model', 'src/writing/layout'], { cwd: appRoot, encoding: 'utf8' }).trim()
  const meta = {
    generatedBy: 'fanotes/scripts/gen-story-fixtures.mjs',
    baseCommit: base,
    writingEngineCommit: tsBase,
    hyphen: require('hyphen/package.json').version,
    node: process.version,
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  {
    const cases = []
    const run = (fn, args) => {
      try {
        cases.push({ fn, args, out: fn === 'keyBetween' ? keys.keyBetween(...args) : keys.keysBetween(...args) })
      } catch (error) {
        cases.push({ fn, args, error: true })
      }
    }
    let previous = null
    for (let index = 0; index < 3000; index += 1) {
      run('keyBetween', [previous, null])
      previous = cases.at(-1).out
    }
    let next = 'a0'
    for (let index = 0; index < 300; index += 1) {
      run('keyBetween', [null, next])
      next = cases.at(-1).out
    }
    let a = 'a0'
    let b = 'a1'
    for (let index = 0; index < 60; index += 1) {
      run('keyBetween', [a, b])
      if (index % 3) a = cases.at(-1).out
      else b = cases.at(-1).out
    }
    for (const args of [[null, null], ['a0', 'a0'], ['a1', 'a0'], ['a0', 'a0V'], ['a0V', 'a1'], ['Zz', 'a0'], ['zzzzzzzzzzzzzzzzzzzzzzzzzzz', null], [null, 'A00000000000000000000000001'], ['a10', null], ['b', null], ['!', null], ['a0', 'b00'], ['az', null], ['Y00', null], [null, 'Y00'], ['a0x', 'a0y'], ['a0xV', 'a0xW']]) run('keyBetween', args)
    for (const args of [[null, null, 50], ['a5', 'a6', 37], [null, 'a0', 12], ['a0', null, 9], ['a0', 'a1', 1], ['a0', 'a1', 0]]) run('keysBetween', args)
    const valid = ['a0', 'a10', 'a1V', 'Zz', 'A00000000000000000000000000', 'z', '', 'a!', 'b00', 'b0', 'a0é', 'x'.repeat(600), 'a0V3k9', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzz'].map((key) => [key, keys.isValidKey(key)])
    write('keys.json', { cases, valid })
  }

  // ── sanitize ─────────────────────────────────────────────────────────────
  const long = 'Langer Text. '.repeat(16_000)
  const hostileScenes = [
    { format: 'fanotes-story-scene-v1', id: 'scene000001', paragraphs: [{ id: 'aaaaaaaaaaaa', key: 'bad!', v: { dev1: 1 }, style: 'body', runs: [{ text: 'Erster' }, { text: 5 }, null] }, null, { id: 'aaaaaaaaaaaa', key: 'a1', style: 'Body Style', runs: [{ text: 'Zweiter\r\nTeil\r', m: { b: true, size: 9000, color: 'red' } }] }] },
    { format: 'fanotes-story-scene-v1', id: 'scene12345', paragraphs: [] },
    { format: 'other' },
    null,
    [1, 2],
    { format: 'fanotes-story-scene-v1', id: 'BAD', paragraphs: [] },
    { format: 'fanotes-story-scene-v1', paragraphs: [{ id: 'para000001', key: 'a0', v: {}, style: 'body', runs: [{ text: 'x' }] }], _expected: 'fromfile01' },
    {
      format: 'fanotes-story-scene-v1',
      id: 'scene000003',
      paragraphs: [
        { id: 'para00000c', key: 'a2', v: { b: 1, 10: 2, a: 3, 2: 4, '-x': 5, BAD: 6, 'zz-1': 1.5, neg: -1, big: 9007199254740992, ok: 9007199254740991 }, style: 'quote', runs: [{ text: 'Mit\u0000Steuer\u0007zeichen\u000b und\ttabs', m: { b: true, i: 1, u: true, s: 'yes', sc: true, sup: true, sub: true, font: 'garamond', size: 4.25, color: '#AABBCC', hl: '#00ff00', link: 'HTTPS://example.org', fn: 'note000001', cm: 'BAD id', lang: 'en-GB' } }, { text: '', m: { fn: 'note000002' } }, { text: '', m: { b: true } }, { text: 'gleich', m: { size: 12.74 } }, { text: 'gleich', m: { size: 12.75 } }], lang: 'de-CH', align: 'center', breakBefore: 'page', conflictOf: 'para00000a' },
        { id: 'para00000b', key: 'a2', v: { A: 1 }, style: 'body', runs: [{ text: 'gleicher Schlüssel' }], align: 'middle', lang: 'fr', breakBefore: 'column' },
        { id: 'para00000a', key: 'a1', v: [], style: 'x'.repeat(41), deleted: true, runs: [{ text: 'gelöscht' }] },
        { id: 'para00000d', key: 'a0', v: null, style: 'heading', deleted: 'yes', runs: 'kein Array' },
        { id: 'para00000e', key: 'a3', v: { dev: 1 }, style: 'body', runs: [{ text: 'links', m: { link: 'javascript:alert(1)' } }, { text: 'mail', m: { link: 'mailto:a@b.c' } }, { text: 'lang', m: { link: `https://${'x'.repeat(2000)}` } }, { text: 'farbe', m: { color: '#12345', hl: 'blue', size: 3.9 } }, { text: 'gross', m: { size: 144.1 } }, { text: 'emoji 👍🏽 und   Zeilen' }] },
      ],
      footnotes: { note000001: { id: 'ignored', runs: [{ text: 'Fussnote', m: { i: true } }] }, bad: { runs: [] }, note000002: 'kein Objekt', 123456: { runs: [{ text: 'zahl' }] } },
      comments: { comment001: { author: `${'A'.repeat(90)}`, at: '2026-11-15T10:00:00.000Z'.repeat(3), text: 'Bitte prüfen', resolved: true }, comment002: { author: 5, text: null, resolved: 'yes' }, X: {} },
    },
    { format: 'fanotes-story-scene-v1', id: 'scene000004', paragraphs: [{ id: 'para000001', key: 'a0', v: { A: 1 }, style: 'body', deleted: true, runs: [] }, { id: 'para000002', key: 'a0', v: { A: 1 }, style: 'body', runs: [] }, { id: 'para000001', key: 'a5', v: { A: 1 }, style: 'body', runs: [{ text: 'dup' }] }] },
    { format: 'fanotes-story-scene-v1', id: 'scene000005', paragraphs: [{ id: 'para000001', key: 'a0', v: { A: 1 }, style: 'body', deleted: true, runs: [] }] },
    { format: 'fanotes-story-scene-v1', id: 'scene000006', paragraphs: [{ id: 'para000001', key: 'a0', v: { A: 1 }, style: 'body', runs: [{ text: long }, { text: 'ab', m: { b: true } }, { text: long }] }] },
    { format: 'fanotes-story-scene-v1', id: 'scene000007', paragraphs: [{ id: 'para000001', key: 'a0', v: {}, style: 'body', runs: [{ text: 'a' }, { text: 'b', m: {} }, { text: 'c', m: { b: false } }, { text: 'd', m: { fn: 'note000001' } }, { text: 'e', m: { fn: 'note000001' } }] }] },
  ]
  const sanitizeCases = []
  hostileScenes.forEach((input, index) => {
    const expected = input?._expected
    if (expected) delete input._expected
    seed(1000 + index)
    const output = sanitize.sanitizeScene(input, expected)
    sanitizeCases.push({ kind: 'scene', seed: 1000 + index, input: JSON.stringify(input), expectedId: expected ?? null, output: output ? JSON.stringify(output) : null })
  })
  const story = (seedValue, options) => {
    seed(seedValue)
    return defaults.newStory({ deviceId: 'dev1', now: new Date(Date.UTC(2026, 10, 15, 12)), ...options })
  }
  const stories = [
    story(1, { title: 'Die Brücke', language: 'de-CH' }),
    story(2, { title: '  ', language: 'en-US', size: 'manuscript', author: 'Jane Roe' }),
    story(3, { title: 'Letters', language: 'en-GB', size: 'Letter' }),
    story(4, { title: 'Pocket', language: 'de', size: 'pocket' }),
    story(5, { title: 'Trade', language: 'en-US', size: 'trade' }),
    story(6, { title: 'A4', language: 'de', size: 'A4', author: '' }),
  ]
  const hostileManifests = [
    ...stories.map((entry) => entry.manifest),
    { format: 'fanotes-story-v1', id: 'story00001' },
    { format: 'fanotes-story-v1', id: 'bad' },
    { format: 'fanotes-story-v2', id: 'story00001' },
    {
      format: 'fanotes-story-v1', id: 'story00002', title: 'T'.repeat(400), subtitle: 'Sub', author: 'Ich', language: 'xx',
      page: { size: 'custom', width: 10, height: 1e9, margins: { top: -5, bottom: 'x', inner: 30, outer: -0 }, mirror: 'yes', header: { left: 5, center: '{page}', right: 'r'.repeat(300) }, footer: null, hideOnChapterStart: false, chapterStartsRight: true, pageNumberStart: 3.5, headerOffset: 61, footerOffset: 0, widowsOrphans: false, hyphenate: 1, sceneBreak: '' },
      styles: {
        body: { name: { de: 'Text', en: '' }, font: 'comic', size: 200, lineHeight: 0.1, spaceBefore: -1, spaceAfter: 'x', indentFirst: -60, indentLeft: 50, indentRight: 101, align: 'middle', bold: true, italic: 'yes', color: '#ABCDEF', dropCap: 2.6, next: 'Bad', listMarker: '→→→→→→', outlineLevel: 7 },
        chapter: { bold: false, keepWithNext: false, uppercase: true, smallCaps: true, noIndentAfterBreak: true, next: 'first', listMarker: '', dropCap: 0.4, outlineLevel: 0.3 },
        custom: { name: { de: 'Eigen' }, size: 9 },
        10: { size: 10 }, 2: { size: 2 }, 'Bad Id': { size: 12 }, list: 'nicht', quote: null,
      },
      binder: [
        { id: 'chapter001', kind: 'chapter', title: 'Eins', synopsis: 'kurz', status: 'final', label: '#ff0000', pov: 'person01', exclude: true, goal: 1000.4, children: [{ id: 'scene00001', kind: 'scene', title: 'S', children: [{ id: 'ignored01', kind: 'scene' }], goal: -1 }, { id: 'scene00001', kind: 'scene', title: 'Doppelt' }, { id: 'scene00002', kind: 'note', title: 'Art' }] },
        { id: 'part000001', kind: 'part', title: 5, label: 'red', status: 'done', goal: 2e7, children: 'x' },
        { id: 'folder0001', kind: 'folder', title: 'Tief', children: [{ id: 'deep000001', kind: 'folder', children: [{ id: 'deep000002', kind: 'folder', children: [{ id: 'deep000003', kind: 'folder', children: [{ id: 'deep000004', kind: 'folder', children: [{ id: 'deep000005', kind: 'folder', children: [{ id: 'deep000006', kind: 'folder', children: [{ id: 'deep000007', kind: 'folder', children: [{ id: 'deep000008', kind: 'scene' }] }] }] }] }] }] }] }] },
        null, 'x',
      ],
      goals: { project: 80000.6, deadline: '2026-12-31', session: -5, daily: 'x' },
      dictionary: ['Wort', 'Wort', '', 5, 'x'.repeat(81), 'Name'],
      ignored: ['rule:text', 'rule:text', 7, 'y'.repeat(201), ''],
      createdAt: 'c'.repeat(50),
    },
    { format: 'fanotes-story-v1', id: 'story00003', language: 'en-US', page: { size: 'manuscript' }, styles: [], goals: [], dictionary: 'x', ignored: 'x', binder: {} },
    { format: 'fanotes-story-v1', id: 'story00004', language: 'en-GB', page: 'A4', styles: null },
  ]
  for (const input of hostileManifests) {
    const output = sanitize.sanitizeManifest(input)
    sanitizeCases.push({ kind: 'manifest', input: JSON.stringify(input), output: output ? `${JSON.stringify(output, null, 1)}\n` : null })
  }
  // Names of Object.prototype members are refused as style ids and page sizes (4944bb44).
  const prototypeManifests = [
    { format: 'fanotes-story-v1', id: 'abcdef', styles: { constructor: {}, toString: { size: 30 }, hasOwnProperty: {}, body: { next: 'valueOf' } } },
    { format: 'fanotes-story-v1', id: 'abcdef', page: { size: 'toString' } },
    { format: 'fanotes-story-v1', id: 'abcdef', page: { size: '__proto__' } },
    { format: 'fanotes-story-v1', id: 'abcdef', page: { size: ['A5'] } },
    // Clipping keeps surrogate pairs whole; lone surrogates become U+FFFD.
    { format: 'fanotes-story-v1', id: 'abcdef', title: `${'t'.repeat(299)}😀`, subtitle: `a\uD800b\uDC00c`, author: `${'x'.repeat(198)}😀😀`, page: { sceneBreak: `${'*'.repeat(39)}😀`, header: { left: `\uDBFF${'h'.repeat(198)}😀` } } },
  ]
  for (const input of prototypeManifests) {
    const output = sanitize.sanitizeManifest(input)
    sanitizeCases.push({ kind: 'manifest', input: JSON.stringify(input), output: output ? `${JSON.stringify(output, null, 1)}\n` : null })
  }
  const prototypeScenes = [
    { format: 'fanotes-story-scene-v1', id: 'scene000008', paragraphs: [{ id: 'para000001', key: 'a0', v: {}, style: 'constructor', runs: [{ text: 'a' }] }, { id: 'para000002', key: 'a1', v: {}, style: '__proto__', runs: [{ text: 'b' }] }, { id: 'para000003', key: 'a2', v: {}, style: 'quote', runs: [{ text: 'Herz \uD83D und \uDE00 allein, 😀 ganz' }] }] },
    { format: 'fanotes-story-scene-v1', id: 'scene000009', paragraphs: [{ id: 'para000001', key: 'a0', v: {}, style: 'body', runs: [{ text: `${'y'.repeat(199_999)}😀z` }] }], comments: { comment001: { author: `${'b'.repeat(79)}😀`, at: 'x', text: '\uDFFFok' } } },
  ]
  prototypeScenes.forEach((input, index) => {
    seed(2000 + index)
    const output = sanitize.sanitizeScene(input)
    sanitizeCases.push({ kind: 'scene', seed: 2000 + index, input: JSON.stringify(input), expectedId: null, output: output ? JSON.stringify(output) : null })
  })
  const tsBugs = []
  write('sanitize.json', { cases: sanitizeCases, tsBugs, newStories: stories.map((entry, index) => ({ seed: index + 1, manifest: `${JSON.stringify(entry.manifest, null, 1)}\n`, scenes: entry.scenes.map((scene) => `${JSON.stringify(scene)}\n`) })) })

  // ── merge ────────────────────────────────────────────────────────────────
  {
    const para = (id, key, v, text, extra = {}) => ({ id, key, v, style: 'body', runs: text ? [{ text }] : [], ...extra })
    const sceneOf = (paragraphs, extra = {}) => ({ format: 'fanotes-story-scene-v1', id: 'scene000001', paragraphs, ...extra })
    const pairs = []
    const b0 = [para('p000001', 'a0', { A: 1 }, 'Eins'), para('p000002', 'a1', { A: 1 }, 'Zwei'), para('p000003', 'a2', { A: 1 }, 'Drei')]
    pairs.push([sceneOf([{ ...b0[0], runs: [{ text: 'Eins (Laptop)' }], v: { A: 2 } }, b0[1], b0[2]]), sceneOf([b0[0], b0[1], { ...b0[2], runs: [{ text: 'Drei (Tablet)' }], v: { A: 1, B: 1 } }, para('p000004', 'a3', { B: 1 }, 'Vier')])])
    pairs.push([sceneOf([para('p000001', 'a0', { A: 2 }, 'Sie ging.')]), sceneOf([para('p000001', 'a0', { A: 1, B: 1 }, 'Sie rannte.')])])
    pairs.push([sceneOf([para('p000001', 'a0', { A: 1, B: 1 }, 'Behalten')]), sceneOf([{ ...para('p000001', 'a0', { A: 2 }, ''), deleted: true }])])
    pairs.push([sceneOf([para('p000001', 'a0', { A: 1, B: 1 }, 'Behalten')]), sceneOf([{ ...para('p000001', 'a0', { A: 2, B: 1 }, ''), deleted: true }])])
    pairs.push([sceneOf([para('p000001', 'a0', { A: 1 }, 'Gleich')]), sceneOf([para('p000001', 'a0', { A: 1 }, 'Anders')])])
    pairs.push([sceneOf([para('p000001', 'a0', { A: 1, B: 2 }, 'Gleich')]), sceneOf([para('p000001', 'a0', { B: 3, A: 0 + 1 }, 'Gleich')])])
    pairs.push([sceneOf([para('p000001', 'a5', { A: 2 }, 'Verschoben')]), sceneOf([para('p000001', 'a0', { A: 1, C: 1 }, 'Verschoben')])])
    pairs.push([sceneOf([para('p000001', 'a0', { A: 3 }, 'x', { style: 'quote', align: 'center' })], { footnotes: { note000001: { id: 'note000001', runs: [{ text: 'links' }] } } }), sceneOf([para('p000001', 'a0', { A: 2, B: 1 }, 'x', { lang: 'en-US', breakBefore: 'page' })], { footnotes: { note000001: { id: 'note000001', runs: [{ text: 'rechts' }] }, note000002: { id: 'note000002', runs: [] } }, comments: { comment001: { id: 'comment001', author: 'B', at: 'now', text: 'Hm' } } })])
    // Three devices: the conflict copy already exists on one side.
    const once = merge.mergeScenes(sceneOf([para('p000001', 'a0', { A: 2 }, 'Links')]), sceneOf([para('p000001', 'a0', { A: 1, B: 1 }, 'Rechts')])).scene
    pairs.push([once, sceneOf([para('p000001', 'a0', { A: 1, B: 1 }, 'Rechts')])])
    pairs.push([once, sceneOf([para('p000001', 'a0', { A: 1, C: 1 }, 'Dritter')])])
    // Fuzz: a shared base, random edits, deletes, inserts and moves on both sides.
    let rng = 12345
    const random = (limit) => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng % limit }
    const words = ['Wind', 'über', 'dem', 'Meer', 'night', 'café', 'Œuvre', '👍🏽', 'Straße', 'ÄÖÜ', '“quote”', 'x\ny']
    for (let round = 0; round < 60; round += 1) {
      const count = 2 + random(8)
      const baseKeys = keys.keysBetween(null, null, count)
      const baseParagraphs = baseKeys.map((key, index) => para(`f${round}p${String(index).padStart(5, '0')}`, key, { A: 1 + random(3) }, `${words[random(words.length)]} ${words[random(words.length)]}`))
      const side = (device) => {
        let list = baseParagraphs.map((paragraph) => ({ ...paragraph, v: { ...paragraph.v } }))
        const edits = 1 + random(4)
        for (let edit = 0; edit < edits; edit += 1) {
          const index = random(list.length)
          const target = list[index]
          const kind = random(6)
          const bump = (paragraph) => ({ ...paragraph, v: { ...paragraph.v, [device]: (paragraph.v[device] ?? 0) + 1 } })
          if (kind <= 1) list[index] = bump({ ...target, runs: runs.insertText(target.runs, 0, `${words[random(words.length)]} `, random(2) ? { b: true } : undefined) })
          else if (kind === 2) list[index] = bump({ ...target, runs: [], deleted: true })
          else if (kind === 3) list.push(bump({ ...para(`f${round}${device}${edit}${String(random(1000)).padStart(3, '0')}`, keys.keyBetween(list.at(-1).key, null), {}, words[random(words.length)]) }))
          else if (kind === 4) list[index] = bump({ ...target, key: keys.keyBetween(null, list[0].key) })
          else list[index] = bump({ ...target, style: random(2) ? 'quote' : 'dialogue', align: 'right' })
        }
        list.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id.localeCompare(y.id)))
        return sceneOf(list)
      }
      pairs.push([side('L'), side('R')])
    }
    // Device ids as sanitize keeps them ([0-9a-z-]).
    const devices = (scene) => JSON.stringify({ ...scene, paragraphs: scene.paragraphs.map((paragraph) => ({ ...paragraph, v: Object.fromEntries(Object.entries(paragraph.v).map(([device, count]) => [device.toLowerCase(), count])) })) })
    const read = (text) => { seed(1); return sanitize.sanitizeScene(JSON.parse(text)) }
    const cases = pairs.map(([left, right]) => {
      const leftText = devices(left)
      const rightText = devices(right)
      const l = read(leftText)
      const r = read(rightText)
      const result = (x, y) => {
        const merged = merge.mergeScenes(x, y)
        return { json: `${JSON.stringify(merged.scene)}\n`, conflicts: merged.conflicts, changedFromLeft: merged.changedFromLeft, changedFromRight: merged.changedFromRight }
      }
      const ab = result(l, r)
      const again = merge.mergeScenes(read(ab.json), r)
      return { left: leftText, right: rightText, leftRight: ab, rightLeft: result(r, l), againRight: `${JSON.stringify(again.scene)}\n` }
    })
    const stamps = []
    const saved = sceneOf([para('p000001', 'a0', { A: 1 }, 'Eins'), para('p000002', 'a1', { A: 1, B: 2 }, 'Zwei'), para('p000003', 'a2', { B: 1 }, 'Drei')])
    const stampCase = (rawCurrent, rawPrevious, writer) => {
      const current = read(devices(rawCurrent))
      const previous = rawPrevious ? read(devices(rawPrevious)) : null
      const out = merge.stampEdits(current, previous, writer.toLowerCase())
      stamps.push({ current: JSON.stringify(current), saved: previous ? JSON.stringify(previous) : null, writer: writer.toLowerCase(), output: JSON.stringify(out), changed: out !== current })
    }
    stampCase(saved, saved, 'A')
    stampCase(sceneOf([{ ...saved.paragraphs[0], runs: [{ text: 'Eins!' }] }, saved.paragraphs[2]]), saved, 'A')
    stampCase(sceneOf([{ ...saved.paragraphs[0], v: { A: 1, C: 4 } }, { ...saved.paragraphs[1], key: 'a05' }, saved.paragraphs[2], para('p000009', 'a3', {}, 'Neu')]), saved, 'C')
    stampCase(sceneOf([{ ...saved.paragraphs[0], v: {} }, saved.paragraphs[1], saved.paragraphs[2]]), saved, 'A')
    stampCase(sceneOf([para('p000001', 'a0', { A: 1 }, 'Eins')]), null, 'Z')
    write('merge.json', { cases, stamps })
  }

  // ── flow ─────────────────────────────────────────────────────────────────
  const lorem = 'Der alte Leuchtturmwärter stieg jeden Abend die hundertzwölf Stufen hinauf, zündete das Licht an und sah hinaus auf das dunkle Wasser, über dem der Wind die Wolken jagte.'
  // The same novel as novel() in check-writing.mjs, with extras the Rust test builds identically (tests/fixtures.rs).
  const novel = ({ chapters, paragraphs, sentence = lorem, size = 'A5', language = 'de', extras = false, page = {} }) => {
    seed(77)
    const created = defaults.newStory({ title: 'Roman', author: 'Autorin', language, size, deviceId: 'dev1', now: new Date(Date.UTC(2026, 10, 15)) })
    const manifest = created.manifest
    manifest.page = { ...manifest.page, ...page }
    manifest.binder = []
    if (extras) manifest.styles.first = { ...manifest.styles.first, dropCap: 3 }
    const scenes = new Map()
    let counter = 0
    for (let chapter = 0; chapter < chapters; chapter += 1) {
      const chapterNode = { id: `chapter${String(chapter).padStart(6, '0')}`, kind: 'chapter', title: `Kapitel ${chapter + 1}`, children: [] }
      const parts = extras && chapter % 3 === 1 ? 2 : 1
      for (let part = 0; part < parts; part += 1) {
        const scene = { format: 'fanotes-story-scene-v1', id: `scene${String(chapter).padStart(5, '0')}${part}`, paragraphs: [] }
        const count = parts === 2 ? Math.ceil(paragraphs / 2) : paragraphs
        const sceneKeys = keys.keysBetween(null, null, count)
        for (let index = 0; index < count; index += 1) {
          counter += 1
          const text = `${sentence} ${sentence.slice(0, (counter * 37) % sentence.length)}`
          let style = index === 0 ? 'first' : 'body'
          let paragraphRuns = [{ text }]
          if (extras) {
            if (counter % 41 === 0) {
              const id = `note${String(counter).padStart(6, '0')}`
              paragraphRuns = [{ text: text.slice(0, 40) }, { text: '', m: { fn: id } }, { text: text.slice(40) }]
              scene.footnotes = { ...(scene.footnotes ?? {}), [id]: { id, runs: [{ text: `Anmerkung ${counter}: ${sentence.slice(0, counter % 120)}` }] } }
            }
            if (counter % 29 === 0) paragraphRuns = [{ text: 'Kapitälchen und ' }, { text: 'Hochgestellt', m: { sup: true } }, { text: ' fett', m: { b: true } }, { text: ` ${text}`, m: { sc: true } }]
            if (counter % 23 === 0) style = 'dialogue'
            if (counter % 31 === 0) style = 'heading'
            if (counter % 37 === 0) style = 'list'
            if (counter % 43 === 0) style = 'quote'
            if (counter % 47 === 0) paragraphRuns = [{ text: `Zeile eins\nZeile zwei ${text}` }]
            if (counter % 53 === 0) paragraphRuns = [{ text: `${'Donaudampfschifffahrtsgesellschaftskapitän'.repeat(3)} ${text}` }]
            if (counter % 59 === 0) paragraphRuns = [{ text: `Größer ${text.slice(0, 60)}`, m: { size: 16 } }]
          }
          const paragraph = { id: `para${String(counter).padStart(8, '0')}`, key: sceneKeys[index], v: { A: 1 }, style, runs: paragraphRuns }
          if (extras && counter % 67 === 0) paragraph.breakBefore = 'page'
          if (extras && counter % 71 === 0) paragraph.align = 'center'
          if (extras && counter % 73 === 0) paragraph.lang = 'en-US'
          scene.paragraphs.push(paragraph)
        }
        scenes.set(scene.id, scene)
        chapterNode.children.push({ id: scene.id, kind: 'scene', title: 'Szene' })
      }
      manifest.binder.push(chapterNode)
    }
    return { manifest, scenes }
  }
  const footnoteRunsOf = (scenes) => {
    const notes = new Map()
    for (const scene of scenes.values()) for (const [id, note] of Object.entries(scene.footnotes ?? {})) notes.set(id, note.runs)
    return (id) => notes.get(id) ?? null
  }
  const blockJson = (blocks) => blocks.map(({ paragraph: _p, ...rest }) => rest)
  {
    const small = novel({ chapters: 3, paragraphs: 4, extras: true })
    const manifest = structuredClone(small.manifest)
    seed(5)
    const extra = defaults.emptyScene('dev1', 'first', 'Im Ordner.')
    small.scenes.set(extra.id, extra)
    manifest.binder.push({ id: 'partnode01', kind: 'part', title: 'Teil', children: [{ id: 'folder0001', kind: 'folder', title: 'F', children: [{ id: extra.id, kind: 'scene', title: 'x' }, { id: 'missing001', kind: 'scene', title: 'fehlt' }] }] })
    manifest.binder.push({ id: 'excluded01', kind: 'chapter', title: 'Weg', exclude: true, children: [] })
    const withPart = structuredClone(manifest)
    withPart.styles.part = { ...withPart.styles.chapter, id: 'part' }
    write('flow.json', { cases: [manifest, withPart].map((raw) => sanitize.sanitizeManifest(raw)).map((entry) => ({ manifest: JSON.stringify(entry), scenes: JSON.stringify([...small.scenes.values()]), blocks: JSON.stringify(blockJson(flow.buildFlow(entry, small.scenes))) })) })
  }

  // ── linebreak ────────────────────────────────────────────────────────────
  {
    const styles = defaults.defaultStyles(false)
    const cases = []
    const add = (name, input) => {
      const style = linebreak.resolveStyle({ ...styles[input.style ?? 'body'], ...(input.styleOverrides ?? {}) }, { align: input.align, afterBreak: input.afterBreak })
      const hyphenator = input.hyphenate ? hyphenators[input.hyphenate] : null
      const numbers = input.footnoteNumbers ?? null
      const layout = linebreak.layoutParagraph({ runs: input.runs, style, width: input.width, measurer, hyphenator, hyphenate: Boolean(input.hyphenate), ...(numbers ? { footnoteNumber: (id) => numbers[id] ?? '?' } : {}) })
      const carets = []
      for (let offset = 0; offset <= layout.textLength; offset += Math.max(1, Math.floor(layout.textLength / 9))) {
        const line = linebreak.lineAt(layout, offset)
        const x = linebreak.caretX(layout, line, offset, measurer)
        carets.push([offset, line, linebreak.lineAt(layout, offset, true), x, linebreak.offsetAtX(layout, line, x + 0.7, measurer)])
      }
      cases.push({ name, input: { ...input, style: undefined, styleOverrides: undefined }, style, layout, carets })
    }
    const text = (value) => [{ text: value }]
    add('justified', { runs: text(lorem), width: 300 })
    add('left', { runs: text(lorem), width: 300, align: 'left' })
    add('center', { runs: text(lorem), width: 250, align: 'center' })
    add('right', { runs: text(lorem), width: 250, align: 'right' })
    add('hyphen de', { runs: text('Am Ufer stand die Donaudampfschifffahrtsgesellschaft mit ihren Kapitänen, „Leuchtturmwärter“! Erzählungen.'), width: 260, hyphenate: 'de', styleOverrides: { indentFirst: 0 } })
    add('hyphen en', { runs: text('Unquestionably the representatives of international organizations communicated extraordinarily.'), width: 200, hyphenate: 'en-US' })
    add('hyphen gb', { runs: text('The university’s characterisation of philosophical encyclopaedias was however incomprehensible.'), width: 180, hyphenate: 'en-GB' })
    add('forced breaks', { runs: text('Zeile eins\nZeile zwei\n\nnach Leerzeile\n'), width: 400, align: 'left' })
    add('empty', { runs: [], width: 400 })
    add('empty center', { runs: [], width: 400, align: 'center' })
    add('long word', { runs: text('x'.repeat(200)), width: 100, styleOverrides: { indentFirst: 0 } })
    add('list', { runs: text(lorem), width: 300, style: 'list' })
    add('drop cap', { runs: text(`„${lorem}`), width: 300, style: 'first', styleOverrides: { dropCap: 3 }, afterBreak: true })
    add('drop cap upper', { runs: [{ text: '' , m: { fn: 'note000001' } }, { text: `(eine ${lorem}` }], width: 300, style: 'first', styleOverrides: { dropCap: 2, uppercase: true }, afterBreak: true, footnoteNumbers: { note000001: '7' } })
    add('small caps', { runs: [{ text: 'Kleine Kapitälchen für Straße und ÄRGER, ', m: { sc: true } }, { text: 'normal ' }, { text: 'ŉ ǆ 1x', m: { sc: true } }], width: 220 })
    add('uppercase', { runs: text('Großbuchstaben: straße ǆ ŉ'), width: 200, styleOverrides: { uppercase: true } })
    add('marks', { runs: [{ text: 'fett ', m: { b: true } }, { text: 'kursiv ', m: { i: true } }, { text: 'hoch', m: { sup: true } }, { text: 'tief', m: { sub: true } }, { text: ' gross', m: { size: 18 } }, { text: ' klein', m: { size: 7, font: 'courier' } }, { text: '', m: { fn: 'note000001' } }, { text: ' Ende mit Fussnote', m: { fn: 'note000002' } }, { text: ' Rest des Absatzes, der noch weitergeht und weitergeht.' }], width: 200, footnoteNumbers: { note000001: '1', note000002: '2' } })
    add('break after', { runs: text('Bindestrich-Wörter und/oder Gedanken–strich sowie—Geviert und - allein -- doppelt /Schrägstrich/ und Nicht trennbares Leerzeichen\tTab'), width: 120, align: 'left' })
    add('spaces', { runs: text('  viele    Leerzeichen   zwischen \t Wörtern  '), width: 150 })
    add('emoji', { runs: text('Emoji 👍🏽 und 𝔄𝔅 Fraktur und 中文字符 gemischt mit Text, der umbricht.'), width: 120 })
    add('narrow', { runs: text(lorem), width: 30, hyphenate: 'de' })
    add('indents', { runs: text(lorem), width: 300, style: 'quote' })
    add('epigraph', { runs: text(lorem), width: 300, style: 'epigraph' })
    add('hyphen punctuation', { runs: text('Wir sahen Leuchtturmwärterinnen, Donaudampfschiffe; Kapitänsmützen! „Unabhängigkeitserklärungen“ und Hans’ Fischernetze.'), width: 140, hyphenate: 'de', align: 'left' })
    for (let width = 60; width <= 420; width += 40) add(`width ${width}`, { runs: text(`${lorem} ${lorem.toUpperCase()}`), width, hyphenate: 'de' })
    write('linebreak.json', { cases })
  }

  // ── hyphenation word lists ───────────────────────────────────────────────
  {
    const lists = {
      de: ['Leuchtturmwärter', 'Donaudampfschifffahrtsgesellschaft', 'Kapitänen', 'Straße', 'Schifffahrt', 'Erzählungen', 'Unabhängigkeitserklärung', 'Häuser', 'Bäckerei', 'Rhythmus', 'Mädchen', 'Zucker', 'Wasser', 'hinauf', 'Wolken', 'Fernsehturm', 'Bindestrich-Wörter', 'Hans’', 'O\'Neill', 'ÄÖÜäöü', 'abc', 'abcd', 'abcde', 'Ein ganzer Satz mit Leuchtturmwärtern.', '<b>Wort</b>Bäckerei', 'Bäc­kerei', 'MAJUSKELN', 'Ölförderung', '12345', 'Wort123Wort', 'ǅungla', 'Œuvre', 'Αλφάβητο', ''],
      'en-us': ['hyphenation', 'associate', 'associates', 'declination', 'Representatives', 'international', 'extraordinarily', 'university', 'communicated', 'organizations', 'table', 'project', 'record', 'present', 'Unquestionably', 'philosophical', 'encyclopaedia', 'it’s', 'rock-and-roll', 'A sentence of incomprehensible words.', 'cafés', ''],
      'en-gb': ['university', 'universities', 'however', 'characterisation', 'philosophical', 'encyclopaedias', 'incomprehensible', 'colour', 'organisation', 'programme', 'theatre', 'Representatives', ''],
    }
    const hyph = { de: hyphenators.de, 'en-us': hyphenators['en-US'], 'en-gb': hyphenators['en-GB'] }
    // A larger German and English list from the lorem texts and the dictionaries, for coverage.
    const dictWords = (path, limit, every) => readFileSync(join(appRoot, 'node_modules', path), 'utf8').split('\n').map((line) => line.split('/')[0]).filter((word) => word.length >= 5).filter((_, index) => index % every === 0).slice(0, limit)
    lists.de.push(...dictWords('dictionary-de/index.dic', 4000, 19))
    lists['en-us'].push(...dictWords('dictionary-en/index.dic', 3000, 17))
    lists['en-gb'].push(...dictWords('dictionary-en-gb/index.dic', 2000, 23))
    const out = {}
    for (const [language, words] of Object.entries(lists)) out[language] = words.map((word) => [word, hyph[language](word)])
    write('hyphen.json', out)
  }

  // ── pagination ───────────────────────────────────────────────────────────
  const fullLayout = (result) => ({
    pages: result.pages,
    layouts: result.layouts,
    blockPages: result.blockPages,
    pageWidth: result.pageWidth,
    pageHeight: result.pageHeight,
    contentWidth: result.contentWidth,
    footnoteNumbers: [...result.footnoteNumbers],
    headerKey: result.headerKey,
  })
  const briefPages = (result) => result.pages.map((page) => [page.number, page.side, page.blank ? 1 : 0, page.chapterTitle, page.header, page.footer, page.content, page.lines.map((line) => [line.blockIndex, line.lineIndex, line.x, line.y]), page.dropCaps.map((cap) => [cap.blockIndex, cap.x, cap.y]), page.footnotes.map((note) => [note.id, note.number, note.x, note.y, fnv(canonical(note.layout))])])
  const options = (scenes) => ({ measurer, hyphenators, footnoteRuns: footnoteRunsOf(scenes) })
  {
    const stories = [
      { name: 'short', chapters: 3, paragraphs: 30, page: { header: { left: '{title}', center: '', right: '{chapter}' }, footer: { left: '', center: '{page}', right: '' } } },
      { name: 'extras', chapters: 6, paragraphs: 20, extras: true, page: { chapterStartsRight: true, header: { left: '{title} – {subtitle}', center: '{pages}', right: '{chapter} {author} {nope}' } } },
      { name: 'right pages', chapters: 3, paragraphs: 1, page: { chapterStartsRight: true } },
      { name: 'manuscript', chapters: 2, paragraphs: 12, size: 'manuscript', language: 'en-US', extras: true },
      { name: 'no widows', chapters: 2, paragraphs: 25, size: 'pocket', extras: true, page: { widowsOrphans: false, hideOnChapterStart: false, mirror: false, pageNumberStart: 0 } },
      { name: 'A4 en', chapters: 2, paragraphs: 25, size: 'A4', language: 'en-GB', extras: true, page: { hyphenate: true, pageNumberStart: 4 } },
    ]
    const cases = stories.map((spec) => {
      const { manifest, scenes } = novel(spec)
      const result = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), new paginate.LayoutCache(), options(scenes))
      const layout = fullLayout(result)
      return { spec, manifest: JSON.stringify(manifest), pages: result.pages.length, briefPages: briefPages(result), layoutHashes: result.layouts.map((entry) => fnv(canonical(entry))), blockPages: result.blockPages, headerKey: result.headerKey, footnoteNumbers: layout.footnoteNumbers, geometry: [layout.pageWidth, layout.pageHeight, layout.contentWidth], firstLayouts: spec.name === 'extras' ? result.layouts.slice(0, 12) : [] }
    })
    // 300+ pages: pages in brief, every layout as a hash of its canonical JSON.
    const big = { chapters: 15, paragraphs: 120, extras: true, page: { chapterStartsRight: true } }
    const { manifest, scenes } = novel(big)
    const started = performance.now()
    const result = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), new paginate.LayoutCache(), options(scenes))
    const bigCase = { spec: big, manifest: JSON.stringify(manifest), pages: result.pages.length, briefPages: briefPages(result), layoutHashes: result.layouts.map((layout) => fnv(canonical(layout))), blockPages: result.blockPages, headerKey: result.headerKey }
    console.log(`  big story: ${result.pages.length} pages in ${(performance.now() - started).toFixed(0)} ms`)

    // Incremental: 120 recorded edits; each step's incremental result (and its re-paginated page count).
    const incremental = []
    {
      const { manifest: m, scenes: s } = novel({ chapters: 6, paragraphs: 25, extras: true, page: { chapterStartsRight: true, header: { left: '{title}', center: '{pages}', right: '{chapter}' } } })
      const cache = new paginate.LayoutCache()
      let previous = paginate.layoutManuscript(m, flow.buildFlow(m, s), cache, options(s))
      let rngState = 7
      const random = (limit) => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState % limit }
      for (let step = 0; step < 120; step += 1) {
        const sceneIds = [...s.keys()]
        const withNotes = sceneIds.filter((id) => Object.keys(s.get(id).footnotes ?? {}).length)
        const noteEdit = step % 10 === 9 && withNotes.length > 0
        let scene = s.get(sceneIds[random(sceneIds.length)])
        if (noteEdit) scene = s.get(withNotes[(step - 9) / 10 % withNotes.length])
        const paragraphs = scene.paragraphs.slice()
        const index = random(paragraphs.length)
        const target = paragraphs[index]
        const kind = random(6)
        let edit
        if (noteEdit) {
          // A footnote body edit: its page has to be laid out again (4944bb44).
          const noteIds = Object.keys(scene.footnotes)
          const id = noteIds[step % noteIds.length]
          const note = scene.footnotes[id]
          const appended = ' Eine längere Anmerkung mit mehr Worten.'.repeat(1 + (step % 4))
          edit = { op: 'footnote', id, text: appended }
          s.set(scene.id, { ...scene, footnotes: { ...scene.footnotes, [id]: { ...note, runs: runs.insertText(note.runs, runs.runsText(note.runs).length, appended) } } })
        } else if (kind <= 2) {
          const textValue = runs.runsText(target.runs)
          const at = random(textValue.length + 1)
          const inserted = ' neue Worte'.repeat(1 + random(kind === 2 ? 12 : 2))
          edit = { op: 'insert', at, text: inserted }
          paragraphs[index] = { ...target, runs: runs.insertText(target.runs, at, inserted) }
        } else if (kind === 3 && paragraphs.length > 3) {
          edit = { op: 'remove' }
          paragraphs.splice(index, 1)
        } else if (kind === 4) {
          const next = paragraphs[index + 1]?.key ?? null
          const id = `new${step}x${random(99999)}`
          edit = { op: 'add', id, key: keys.keyBetween(target.key, next) }
          paragraphs.splice(index + 1, 0, { id, key: edit.key, v: {}, style: 'body', runs: [{ text: 'Ein eingefügter Absatz.' }] })
        } else {
          const textValue = runs.runsText(target.runs)
          const to = Math.min(textValue.length, 1 + random(120))
          edit = { op: 'cut', to }
          paragraphs[index] = { ...target, runs: runs.deleteRange(target.runs, 0, to) }
        }
        if (edit.op !== 'footnote') s.set(scene.id, { ...scene, paragraphs })
        const blocks = flow.buildFlow(m, s)
        const next = paginate.layoutManuscript(m, blocks, cache, options(s), previous)
        const full = paginate.layoutManuscript(m, blocks, new paginate.LayoutCache(), options(s))
        if (step === 0) incremental.push({ manifest: JSON.stringify(m), spec: { chapters: 6, paragraphs: 25, extras: true } })
        incremental.push({ scene: scene.id, index, ...edit, pages: next.pages.length, repaginated: next.stats.repaginatedPages, hash: fnv(canonical(briefPages(next))), blockPages: fnv(canonical(next.blockPages)), sameAsFull: canonical(briefPages(next)) === canonical(briefPages(full)) })
        previous = next
      }
    }
    write('paginate.json', { cases, big: bigCase, incremental })
  }

  // ── timing (FixedMeasurer, the same story the Rust bench uses) ───────────
  {
    const spec = { chapters: 27, paragraphs: 120, extras: true, page: { chapterStartsRight: true } }
    const { manifest, scenes } = novel(spec)
    const runsOnce = []
    let result
    for (let round = 0; round < 5; round += 1) {
      const started = performance.now()
      result = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), new paginate.LayoutCache(), options(scenes))
      runsOnce.push(performance.now() - started)
    }
    const cache = new paginate.LayoutCache()
    let previous = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), cache, options(scenes))
    const keystrokes = []
    for (let round = 0; round < 20; round += 1) {
      const middle = scenes.get('scene000130')
      scenes.set(middle.id, { ...middle, paragraphs: middle.paragraphs.map((paragraph, index) => (index === 50 ? { ...paragraph, runs: runs.insertText(paragraph.runs, 10, 'x') } : paragraph)) })
      const started = performance.now()
      previous = paginate.layoutManuscript(manifest, flow.buildFlow(manifest, scenes), cache, options(scenes), previous)
      keystrokes.push(performance.now() - started)
    }
    const median = (list) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)]
    meta.timing = { spec, pages: result.pages.length, fullMedianMs: median(runsOnce), fullRunsMs: runsOnce.map((value) => Math.round(value)), keystrokeMedianMs: median(keystrokes), repaginatedPages: previous.stats.repaginatedPages }
    console.log(`  timing: ${result.pages.length} pages, full ${median(runsOnce).toFixed(0)} ms, keystroke ${median(keystrokes).toFixed(2)} ms`)
  }
  write('meta.json', meta)
} finally {
  await vite.close()
}
