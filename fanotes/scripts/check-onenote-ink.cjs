'use strict'

// OneNote ink (the SVG one2html writes) -> famd ink strokes, positioned as fractions of the page.
// Source note: the only OneNote source the importer reads is a binary notebook converted by
// one2html, whose SVG has no pressure. There is no Graph/InkML/ISF source.

const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { buildInkDocument, convertOneNotePage, flattenPath, parseColor } = require('../electron/onenote-convert.cjs')
const { importOneNotePages, disposeSession } = require('../electron/onenote-importer.cjs')
const { parseFamd } = require('../electron/famd.cjs')
const { inkPath, inkSvg, makeSession, page, paragraph, tempVault } = require('./fixtures/onenote/synthetic.cjs')

const near = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`)

// Path data: relative/absolute, implicit repeats, curves, several subpaths.
{
  const paths = flattenPath('M 10 10 l 5 0 0 5 L 30 30 H 40 V 50 M 100 100 c 10 0 10 10 0 10 Q 120 120 130 100 z')
  assert.equal(paths.length, 2)
  assert.deepEqual(paths[0].slice(0, 4), [[10, 10], [15, 10], [15, 15], [30, 30]])
  assert.deepEqual(paths[0].at(-1), [40, 50])
  assert.ok(paths[1].length > 10, 'curves are flattened to segments')
  assert.deepEqual(paths[1].at(-1), [100, 100], 'z closes back to the start')
  assert.deepEqual(flattenPath('garbage'), [])
}
assert.deepEqual(parseColor('WindowText'), { color: '#000000', alpha: 1 })
assert.deepEqual(parseColor('rgb(255, 0, 128)'), { color: '#ff0080', alpha: 1 })
assert.equal(parseColor('none'), null)

// The page as one2html writes it: svg positioned at the page, viewBox origin = position.
{
  const svg = inkSvg({ left: 48.87, top: 1457.88, width: 633, height: 83, paths: [inkPath('M 51 1498 l 10 -20 20 30', { width: 1 }), inkPath('M 300 1500 L 400 1500', { stroke: 'rgb(255,0,0)', width: 3 })] })
  // one2html puts the SVG beside the text containers, directly in the body.
  const result = convertOneNotePage(page({ title: 'Tinte', body: paragraph('Text') }).replace('</body>', `${svg}</body>`))
  assert.equal(result.strokes.length, 2)
  assert.deepEqual(result.strokes[0].points, [[51, 1498], [61, 1478], [81, 1508]], 'positions are page pixels, not offset twice')
  assert.equal(result.strokes[0].color, '#000000')
  assert.equal(result.strokes[1].color, '#ff0000')
  assert.equal(result.strokes[1].width, 3)
  const ink = buildInkDocument(result.strokes, { title: 'Tinte' })
  assert.equal(ink.sourceWidth, 900)
  assert.equal(ink.sourceHeight, Math.ceil(1508 + 144) > 1273 ? Math.ceil(1508 + 144) : 1273)
  const first = ink.strokes[0].points[0]
  near(first.x, 51 / ink.sourceWidth, 'x fraction')
  near(first.y, 1498 / ink.sourceHeight, 'y fraction')
  assert.equal(ink.strokes[0].pressureEnabled, false, 'no pressure in the source: width stays constant')
  assert.equal(ink.strokes[0].purpose, 'handwriting')
  assert.equal(ink.strokes[1].baseWidth, 3)
}

// An SVG inside a positioned container is offset by that container, as CSS places it.
{
  const nested = convertOneNotePage(page({ title: 'Nested', body: inkSvg({ left: 10, top: 20, width: 100, height: 100, paths: [inkPath('M 10 20 L 20 30')] }) }))
  assert.deepEqual(nested.strokes[0].points, [[58, 135], [68, 145]])
}

// A scaled SVG, a group transform and a highlighter (translucent) stroke.
{
  const scaled = `<svg style="position: absolute; left: 100px; top: 50px; width: 200px; height: 100px;" viewBox="0 0 100 50"><g transform="translate(10 5)">${inkPath('M 0 0 L 10 10', { width: 2 })}</g>${inkPath('M 0 40 L 100 40', { stroke: '#ffee00', width: 8, opacity: '0.40' })}</svg>`
  const result = convertOneNotePage(page({ title: 'Skaliert', body: '' }).replace('</body>', `${scaled}</body>`))
  assert.equal(result.strokes.length, 2)
  assert.deepEqual(result.strokes[0].points, [[120, 60], [140, 80]], 'viewBox scale 2 and translate apply')
  assert.equal(result.strokes[0].width, 4, 'stroke width scales with the viewBox')
  assert.deepEqual(result.strokes[1].points, [[100, 130], [300, 130]])
  const ink = buildInkDocument(result.strokes)
  assert.equal(ink.strokes[1].purpose, 'art')
  assert.equal(ink.strokes[1].brush, 'highlighter')
  near(ink.strokes[1].opacity, 0.4, 'opacity', 1e-9)
  assert.equal(ink.strokes[1].color, '#ffee00')
}

// Icons (checkboxes) are not ink; inline handwriting inside text is.
{
  const icon = '<span class="note-tag-icon icon-0 -checkbox" role="checkbox" aria-checked="false"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 3h16v18H4z"/></svg></span>'
  const inline = `<span class="ink-text"><svg style="height: 20px; width: 50px;" viewBox="0 0 50 20">${inkPath('M 1 1 L 20 10')}</svg></span>`
  const result = convertOneNotePage(page({ title: 'Mix', body: paragraph(`${icon}Text ${inline}`) }))
  assert.equal(result.strokes.length, 1)
  assert.doesNotMatch(result.markdown, /svg|path|ink-text/u)
  assert.equal(buildInkDocument([]), null, 'no ink, no document')
  assert.equal(convertOneNotePage(page({ title: 'Ohne', body: paragraph('Nur Text') })).strokes.length, 0)
}

// Import: ink lands in a .famd companion with a v2 payload that the app's own reader parses back.
void (async () => {
  const session = await makeSession([
    { title: 'Mit Tinte', section: ['S'], html: page({ title: 'Mit Tinte', pageId: '{INK}', body: paragraph('Hallo') }).replace('</body>', `${inkSvg({ left: 0, top: 0, width: 400, height: 400, paths: [inkPath('M 60 220 l 30 15 30 -15', { width: 2 })] })}</body>`) },
    { title: 'Ohne Tinte', section: ['S'], body: paragraph('Nur Text') },
  ])
  const vault = tempVault()
  try {
    const result = await importOneNotePages({ session, pageIds: ['p0', 'p1'], destination: { physical: vault, logical: 'Ziel' }, vaultRoot: vault })
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
    assert.equal(result.inkPages, 1)
    assert.equal(result.strokeCount, 1)
    const withInk = result.imported.find((entry) => entry.title === 'Mit Tinte')
    assert.equal(withInk.ink, true)
    const dir = path.join(vault, 'S')
    const text = await fsp.readFile(path.join(dir, 'Mit Tinte.famd'), 'utf8')
    assert.match(text, /<!-- fanotes-famd:v2 chars=\d+ crc=[0-9a-f]{8} -->/u)
    const parsed = parseFamd(text)
    assert.equal(parsed.payload.ink.strokes.length, 1)
    const points = parsed.payload.ink.strokes[0].points
    assert.equal(points.length, 3)
    const width = parsed.payload.ink.sourceWidth
    const height = parsed.payload.ink.sourceHeight
    near(points[1].x * width, 90, 'x restored from the packed fraction', 0.01)
    near(points[1].y * height, 235, 'y restored from the packed fraction', 0.01)
    assert.equal(parsed.payload.ink.strokes[0].baseWidth, 2)
    const md = await fsp.readFile(path.join(dir, 'Mit Tinte.md'), 'utf8')
    assert.equal(parsed.markdown.trim(), md.trim(), 'the .famd carries the same text as the .md')
    assert.doesNotMatch(md + text.slice(0, text.indexOf('<!-- fanotes-famd')), /fanotes-onenote|<!--/u, 'no marker in the visible text')
    await assert.rejects(fsp.access(path.join(dir, 'Ohne Tinte.famd')), 'a page without ink gets no .famd')
  } finally {
    await disposeSession(session)
    await fsp.rm(vault, { recursive: true, force: true })
  }

  // The real fixture notebook carries one handwritten stroke.
  const { scanOneNote } = require('../electron/onenote-importer.cjs')
  if (process.platform === 'linux') {
    const root = path.resolve(__dirname, '..')
    const scanned = await scanOneNote({ inputPath: path.join(__dirname, 'fixtures', 'onenote', 'Open Notebook.onetoc2'), one2html: path.join(root, 'resources', 'onenote', 'linux', 'one2html'), sevenZip: path.join(root, 'resources', 'onenote', 'linux', '7za') })
    try {
      assert.equal(scanned.pages.filter((entry) => entry.hasInk).length, 1)
    } finally {
      await disposeSession(scanned)
    }
  }
  console.log('OneNote-Ink geprüft: SVG-Pfade, Skalierung, Farben, Textmarker, Seitenbruchteile und .famd v2 (ohne Druck, da die Quelle keinen liefert).')
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
