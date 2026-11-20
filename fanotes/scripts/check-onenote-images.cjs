'use strict'

// Embedded OneNote images are stored in the vault's asset folder and referenced so they display.

const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const { importOneNotePages, disposeSession } = require('../electron/onenote-importer.cjs')
const { makeSession, page, paragraph, solidPng, tempVault } = require('./fixtures/onenote/synthetic.cjs')

const img = (src, alt = '') => `<div class="outline-element" style="margin-left: 0px;"><img alt="${alt}" src="${src}" style="max-width: 600px;" /></div>\n`

void (async () => {
  const red = solidPng(8, 6, [220, 30, 30])
  const blue = solidPng(4, 4, [20, 40, 220])
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)])
  const session = await makeSession([
    {
      title: 'Bilder',
      section: ['Abschnitt'],
      body: [
        paragraph('Vor den Bildern'),
        img('red.png', 'Rotes Bild'),
        img('copy-of-red.png', 'Dasselbe Bild'),
        img('sub/blue%20one.png', 'Blau [mit] Klammern'),
        img('photo.jpg', 'Foto'),
        img('fake.png', 'Kein PNG'),
        img('missing.png', 'Fehlt'),
        img('../../outside.png', 'Draußen'),
        img('https://example.com/x.png', 'Extern'),
        img('data:image/png;base64,AAAA', 'Inline'),
        img('vector.svg', 'SVG'),
        paragraph('Nach den Bildern'),
      ].join(''),
      files: { 'red.png': red, 'copy-of-red.png': red, 'sub/blue one.png': blue, 'photo.jpg': jpeg, 'fake.png': Buffer.from('this is not a png'), 'vector.svg': Buffer.from('<svg/>') },
    },
  ])
  await fsp.writeFile(path.join(session.outputRoot, '..', 'outside.png'), red)
  const vault = tempVault()
  try {
    const result = await importOneNotePages({ session, pageIds: ['p0'], destination: { physical: vault, logical: '' }, vaultRoot: vault })
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
    assert.equal(result.imageCount, 4, 'two png, the duplicate and the jpeg are stored; the rest is refused')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /6 Bild/u)

    const note = await fsp.readFile(path.join(vault, 'Abschnitt', 'Bilder.md'), 'utf8')
    const references = [...note.matchAll(/^!\[([^\]\n]*)\]\((\.fanotes\/assets\/onenote\/[0-9a-f]{24}\.(?:png|jpg))\)$/gmu)]
    assert.equal(references.length, 4, note)
    assert.equal(references[0][2], references[1][2], 'the same bytes reuse one stored file')
    assert.notEqual(references[0][2], references[2][2])
    assert.equal(references[2][1], 'Blau mit Klammern', 'brackets in alt text are removed so the image stays one line')
    for (const reference of references) {
      const stored = await fsp.readFile(path.join(vault, ...reference[2].split('/')))
      assert.ok(stored.length > 8)
    }
    assert.ok((await fsp.readFile(path.join(vault, ...references[0][2].split('/')))).equals(red), 'bytes are stored unchanged')
    assert.equal(fs.readdirSync(path.join(vault, '.fanotes', 'assets', 'onenote')).length, 3, 'three distinct files')
    assert.doesNotMatch(note, /https:|data:image|outside|\.svg/u, 'refused images leave no reference behind')
    assert.ok(note.indexOf('Vor den Bildern') < note.indexOf('Rotes Bild') && note.indexOf('Rotes Bild') < note.indexOf('Nach den Bildern'), 'images keep their place in the text')
    assert.equal(fs.existsSync(path.join(vault, 'Abschnitt', 'Bilder.famd')), false, 'no ink, so no .famd companion')

    // The editor draws a whole-line vault image with the same pattern the importer writes.
    const editor = await fsp.readFile(path.join(__dirname, '..', 'src', 'components', 'MarkdownEditor.tsx'), 'utf8')
    assert.match(editor, /class ImageWidget extends WidgetType/u)
    assert.match(editor, /readAssetDataUrl\(relative\)/u)
    const pattern = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/u
    assert.ok(pattern.test(references[0][0]))
  } finally {
    await disposeSession(session)
    await fsp.rm(vault, { recursive: true, force: true })
  }
  console.log('OneNote-Bilder geprüft: Speicherung per Hash, Verweise, abgelehnte Quellen, Reihenfolge und Editor-Darstellung.')
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
