'use strict'

// Pages with ink keep the OneNote layout: text blocks and images are positioned in the ink's
// coordinate space, so a stroke written under a block still overlaps it after import.

const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { importOneNotePages, disposeSession } = require('../electron/onenote-importer.cjs')
const { parseFamd } = require('../electron/famd.cjs')
const { inkPath, inkSvg, makeSession, page, paragraph, solidPng, tempVault } = require('./fixtures/onenote/synthetic.cjs')

const container = (left, top, width, inner) => `<div class="container-outline" style="left: ${left}px; max-width: ${width}px; position: absolute; top: ${top}px;">${inner}</div>`
const withExtras = (title, extras) => page({ title, pageId: `{${title}}`, body: '' }).replace('</body>', `${extras}</body>`)

void (async () => {
  const ink = inkSvg({ left: 0, top: 0, width: 1400, height: 1800, paths: [
    inkPath('M 130 410 L 200 418 L 260 412', { width: 2 }), // under the first block
    inkPath('M 700 1010 L 760 1020', { width: 2 }), // under the far block
  ] })
  const html = withExtras('Frei', [
    container(120, 400, 420, paragraph('Erster Textblock mit etwas mehr Text, der umbricht.')),
    container(650, 1000, 300, paragraph('Weit rechts unten') + `<div class="outline-element"><img alt="Bild" src="p.png" style="max-width: 200px;" /></div>`),
    ink,
  ].join(''))
  const session = await makeSession([
    { title: 'Frei', section: ['S'], html, files: { 'p.png': solidPng(100, 50, [200, 0, 0]) } },
    { title: 'Fliessend', section: ['S'], body: paragraph('Nur Text') },
  ])
  const vault = tempVault()
  try {
    const result = await importOneNotePages({ session, pageIds: ['p0', 'p1'], destination: { physical: vault, logical: '' }, vaultRoot: vault })
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
    assert.equal(result.layoutPages, 1)

    const famd = parseFamd(await fsp.readFile(path.join(vault, 'S', 'Frei.famd'), 'utf8'))
    const { ink: doc, textFields, annotations } = famd.payload
    const W = doc.sourceWidth
    const H = doc.sourceHeight
    assert.ok(W >= 650 + 300 && H >= 1000, 'the page is sized to the content')
    assert.equal(textFields.length, 3, 'title plus two blocks')
    const block = (needle) => textFields.find((field) => field.text.includes(needle))
    const first = block('Erster')
    const far = block('Weit rechts')
    near(first.x * W, 120)
    near(first.y * H, 400)
    near(far.x * W, 650)
    near(far.y * H, 1000)

    // A stroke drawn under a block overlaps it: its points fall inside the field's box.
    const inside = (field, point) => point.x >= field.x && point.x <= field.x + field.width && point.y >= field.y && point.y <= field.y + 60 / H
    assert.ok(doc.strokes[0].points.every((point) => inside(first, point)), 'stroke 1 lies on the first block')
    assert.ok(doc.strokes[1].points.every((point) => inside(far, point)), 'stroke 2 lies on the far block')
    assert.ok(!doc.strokes[0].points.some((point) => inside(far, point)))

    // The picture sits below its block, at the block's x, in the same space.
    const picture = annotations.find((item) => item.kind === 'image')
    assert.ok(picture, 'positioned image')
    near(picture.x * W, 650)
    assert.ok(picture.y * H > far.y * H, 'below the text it follows')
    near(picture.w * W, 100)
    assert.equal(picture.locked, true)

    // The .md of an ink page keeps only the title; the flowing page stays plain Markdown.
    assert.equal(await fsp.readFile(path.join(vault, 'S', 'Frei.md'), 'utf8'), '# Frei\n')
    assert.equal(await fsp.readFile(path.join(vault, 'S', 'Fliessend.md'), 'utf8'), '# Fliessend\n\nNur Text\n')
    await assert.rejects(fsp.access(path.join(vault, 'S', 'Fliessend.famd')))
  } finally {
    await disposeSession(session)
    await fsp.rm(vault, { recursive: true, force: true })
  }
  console.log('OneNote-Layout geprüft: Textblöcke, Bild und Tinte teilen einen Koordinatenraum, Seitengröße und fließende Seiten ohne Tinte.')
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1.5, `${actual} != ${expected}`)
}
