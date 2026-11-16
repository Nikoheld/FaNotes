// Writing mode export and import: PDF read back with pdf.js (pages, lines, footnotes, outline),
// DOCX round trip and well-formed XML, EPUB structure, Markdown/text golden files, imports.
// Run: node scripts/check-writing-export.mjs [filter]   (UPDATE_GOLDEN=1 rewrites the golden files)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const sax = require('sax')
const JSZip = require('jszip')
const pdfjs = await import(path.join(appRoot, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const goldenDir = path.join(appRoot, 'scripts/fixtures/writing-export')
const filter = process.argv[2] ?? ''
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
const load = (file) => vite.ssrLoadModule(file)
const results = []
const test = async (name, body) => {
  if (filter && !name.includes(filter)) return
  try {
    await body()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error])
  }
}
const loadFont = async (file) => new Uint8Array(fs.readFileSync(path.join(appRoot, 'public/writing/fonts', file)))
const now = new Date('2026-11-15T12:00:00Z')

/** Well-formed XML (strict SAX parser, independent of the importer's parser). */
const assertWellFormed = (xml, label) => {
  const parser = sax.parser(true)
  parser.onerror = (error) => { throw new Error(`${label}: ${error.message.split('\n')[0]}`) }
  parser.write(xml).close()
}

try {
  const exporter = await load('/src/writing/export/index.ts')
  const prepareModule = await load('/src/writing/export/prepare.ts')
  const fonts = await load('/src/writing/export/fonts.ts')
  const pdfModule = await load('/src/writing/export/pdf.ts')
  const importer = await load('/src/writing/import/index.ts')
  const defaults = await load('/src/writing/model/defaults.ts')
  const keys = await load('/src/writing/model/keys.ts')
  const flowModule = await load('/src/writing/model/flow.ts')
  const paginate = await load('/src/writing/layout/paginate.ts')
  const measure = await load('/src/writing/layout/measure.ts')

  // ── A story with every feature ─────────────────────────────────────────
  let counter = 0
  const id = (prefix) => `${prefix}${String(++counter).padStart(8, '0')}`
  const lorem = 'Der Leuchtturmwärter stieg die Wendeltreppe hinauf, während draussen der Sturm über die Klippen fegte und die Möwen schrien.'
  const english = 'The lighthouse keeper climbed the spiral stairs while the storm swept over the cliffs outside.'
  const makeStory = () => {
    counter = 0
    const base = defaults.newStory({ title: 'Die Brücke über den Fjord', author: 'Anna Müller', language: 'de-CH', deviceId: 'dev1', now })
    const manifest = structuredClone(base.manifest)
    manifest.id = 'story00000001'
    manifest.subtitle = 'Roman'
    manifest.page = { ...manifest.page, chapterStartsRight: true, mirror: true, header: { left: '{title}', center: '', right: '{chapter}' }, footer: { left: '', center: '{page} / {pages}', right: '' } }
    manifest.styles.first = { ...manifest.styles.first, dropCap: 3 }
    const scenes = new Map()
    const scene = (title, paragraphs, extra = {}) => {
      const sceneId = id('scene')
      const list = keys.keysBetween(null, null, paragraphs.length)
      scenes.set(sceneId, { format: 'fanotes-story-scene-v1', id: sceneId, paragraphs: paragraphs.map((p, index) => ({ id: id('para'), key: list[index], v: { dev1: 1 }, style: p.style ?? (index === 0 ? 'first' : 'body'), runs: p.runs, ...(p.lang ? { lang: p.lang } : {}), ...(p.align ? { align: p.align } : {}), ...(p.breakBefore ? { breakBefore: 'page' } : {}) })), ...extra })
      return { id: sceneId, kind: 'scene', title }
    }
    const plain = (text, style) => ({ runs: [{ text }], ...(style ? { style } : {}) })
    const body = (count, sentence = lorem) => Array.from({ length: count }, (_, index) => plain(`${sentence} ${sentence.slice(0, (index * 37) % sentence.length)}`.trim()))
    const s1 = scene('Ankunft', [
      { runs: [{ text: 'Als sie ankam, war es ' }, { text: 'kalt', m: { b: true } }, { text: ' und ' }, { text: 'still', m: { i: true } }, { text: '. Die ' }, { text: 'Fähre', m: { sc: true } }, { text: ' lag im Hafen' }, { text: '', m: { fn: 'note00000001' } }, { text: ', H' }, { text: '2', m: { sub: true } }, { text: 'O und x' }, { text: '2', m: { sup: true } }, { text: '.' }] },
      { runs: [{ text: 'Ein ' }, { text: 'roter', m: { color: '#b91c1c' } }, { text: ' und ein ' }, { text: 'markierter', m: { hl: '#fde68a' } }, { text: ' Satz mit ' }, { text: 'Verweis', m: { link: 'https://fanotes.ch/' } }, { text: ', ' }, { text: 'unterstrichen', m: { u: true } }, { text: ' und ' }, { text: 'gestrichen', m: { s: true } }, { text: '.' }] },
      { runs: [{ text: 'Ein Kommentar ' }, { text: 'hängt hier', m: { cm: 'comm00000001' } }, { text: '.' }] },
      plain('Erster Punkt der Liste', 'list'),
      plain('Zweiter Punkt der Liste', 'list'),
      { runs: [{ text: english }], lang: 'en-GB' },
      ...body(8),
    ], { footnotes: { note00000001: { id: 'note00000001', runs: [{ text: 'Die Fähre fuhr nur montags.' }] } }, comments: { comm00000001: { id: 'comm00000001', author: 'Lektorin', at: '2026-11-15T10:00:00.000Z', text: 'Klingt gut.' } } })
    const s2 = scene('Nacht', [plain('In der Nacht hörte sie das Meer.'), { runs: [{ text: 'Ein Zitat über den Wind.' }], style: 'quote' }, ...body(6)])
    const s3 = scene('Der Brief', [{ runs: [{ text: 'Der Brief begann mit einer Fussnote' }, { text: '', m: { fn: 'note00000002' } }, { text: '.' }] }, plain('Zwischentitel', 'heading'), ...body(14), { runs: [{ text: 'Nach dem Umbruch.' }], breakBefore: true }])
    s3.extra = null
    scenes.get(s3.id).footnotes = { note00000002: { id: 'note00000002', runs: [{ text: 'Geschrieben im Winter.' }] } }
    const s4 = scene('Rückkehr', [{ runs: [{ text: 'Sie kehrte zurück' }, { text: '', m: { fn: 'note00000003' } }, { text: '.' }] }, ...body(10)])
    scenes.get(s4.id).footnotes = { note00000003: { id: 'note00000003', runs: [{ text: 'Im Frühling.' }] } }
    const hidden = scene('Gestrichen', [plain('GEHEIMER ENTWURF, nicht exportieren.')])
    const trashed = scene('Papierkorb', [plain('IM PAPIERKORB, nicht exportieren.')])
    manifest.binder = [
      { id: 'part00000001', kind: 'part', title: 'Erster Teil', children: [
        { id: 'chap00000001', kind: 'chapter', title: 'Kapitel 1: Ankunft', children: [s1, s2] },
        { id: 'chap00000002', kind: 'chapter', title: 'Kapitel 2: Der Brief', children: [s3, { ...hidden, exclude: true }] },
      ] },
      { id: 'part00000002', kind: 'part', title: 'Zweiter Teil', children: [
        { id: 'chap00000003', kind: 'chapter', title: 'Kapitel 3: Rückkehr', children: [s4] },
      ] },
      { id: 'trashbin', kind: 'folder', title: 'Papierkorb', children: [trashed] },
    ]
    return { manifest, scenes }
  }
  const story = makeStory()
  const files = new fonts.FontFiles(loadFont)
  const options = { loadFont, now }

  const pdfText = async (bytes) => {
    const document = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
    const pages = []
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index)
      const content = await page.getTextContent()
      pages.push({ items: content.items.filter((item) => item.str !== undefined).map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], size: Math.hypot(item.transform[2], item.transform[3]) })), annotations: await page.getAnnotations() })
    }
    return { document, pages }
  }
  const squash = (text) => text.replace(/\s+/gu, ' ').trim()

  await test('PDF: same pages and the same text on every line as the layout', async () => {
    const prepared = prepareModule.prepare(story)
    const { layout, measurer } = await exporter.exportLayout(prepared, files, options)
    const result = await exporter.exportStory(story, 'pdf', { ...options, layout, measurer })
    assert.equal(result.mime, 'application/pdf')
    assert.equal(result.fileName, 'Die Brücke über den Fjord.pdf')
    const fresh = await exporter.exportStory(story, 'pdf', options)
    const { document, pages } = await pdfText(result.bytes)
    assert.equal(document.numPages, layout.pages.length, 'page count')
    assert.equal((await pdfText(fresh.bytes)).document.numPages, layout.pages.length, 'a fresh export lays out the same')
    const PX = 0.75
    const height = layout.pageHeight * PX
    let checked = 0
    layout.pages.forEach((page, pageIndex) => {
      const items = pages[pageIndex].items
      if (page.blank) assert.equal(items.filter((item) => item.str.trim()).length, 0, `page ${pageIndex + 1} is blank`)
      const lineText = (box) => box.pieces.filter((piece) => piece.kind !== 'newline').map((piece) => (piece.kind === 'space' ? ' ' : piece.display + (piece.hyphen ? '-' : ''))).join('')
      const check = (box, x, top) => {
        const band = items.filter((item) => {
          const baseline = (height - item.y) / PX
          return baseline > top + 0.5 && baseline < top + box.height + 0.5 && item.size < box.height * PX
        }).sort((a, b) => a.x - b.x)
        assert.equal(squash(band.map((item) => item.str).join('')).replace(/ /gu, ''), squash(lineText(box)).replace(/ /gu, ''), `page ${pageIndex + 1} line at ${Math.round(top)}`)
        // The first glyph sits where the layout put the line's first piece.
        const first = box.pieces.find((piece) => piece.kind === 'word' && piece.display.trim())
        if (first && band.length) assert.ok(Math.abs(Math.min(...band.map((item) => item.x)) - (x + Math.min(...box.pieces.filter((piece) => piece.kind !== 'newline').map((piece) => piece.x))) * PX) < 1, `x on page ${pageIndex + 1}`)
        checked += 1
      }
      for (const placed of page.lines) {
        const paragraph = layout.layouts[placed.blockIndex]
        const box = paragraph.lines[placed.lineIndex]
        // A drop cap is a bigger glyph: compare the line without it.
        if (paragraph.dropCap && placed.lineIndex < paragraph.dropCap.lines) continue
        check(box, placed.x, placed.y)
      }
      for (const note of page.footnotes) {
        let y = note.y
        for (const box of note.layout.lines) { check(box, page.content.x + box.x, y); y += box.height }
      }
    })
    assert.ok(checked > 120, `${checked} lines checked`)
    // Footnote text on the page of its reference.
    for (const [noteId, text] of [['note00000001', 'Die Fähre fuhr nur montags.'], ['note00000002', 'Geschrieben im Winter.']]) {
      const pageIndex = layout.pages.findIndex((page) => page.footnotes.some((note) => note.id === noteId))
      assert.ok(pageIndex >= 0)
      assert.ok(squash(pages[pageIndex].items.map((item) => item.str).join('')).includes(text.replace(/ /gu, '')) || squash(pages[pageIndex].items.map((item) => item.str).join(' ')).includes(text), `footnote ${noteId} on page ${pageIndex + 1}`)
      const blockIndex = layout.blocks.findIndex((block) => block.runs.some((run) => run.m?.fn === noteId))
      assert.ok(layout.pages[pageIndex].lines.some((line) => line.blockIndex === blockIndex), 'reference on the same page')
    }
    // Chapters on right-hand pages, a blank page before one of them, nothing excluded.
    assert.ok(layout.pages.some((page) => page.blank))
    const all = pages.map((page) => page.items.map((item) => item.str).join('')).join('')
    assert.ok(!all.includes('GEHEIMER') && !all.includes('PAPIERKORB'), 'excluded and trashed scenes left out')
    // Outline, metadata, link.
    const outline = await document.getOutline()
    assert.deepEqual(outline.map((item) => item.title), ['Erster Teil', 'Zweiter Teil'])
    assert.deepEqual(outline[0].items.map((item) => item.title), ['Kapitel 1: Ankunft', 'Kapitel 2: Der Brief'])
    assert.deepEqual(outline[0].items[0].items.map((item) => item.title), ['Ankunft', 'Nacht'])
    const dest = outline[1].items[0].dest
    const target = await document.getPageIndex(dest[0])
    assert.equal(target, layout.blockPages[layout.blocks.findIndex((block) => block.key === 't:chap00000003')], 'bookmark goes to the chapter page')
    const meta = await document.getMetadata()
    assert.equal(meta.info.Title, 'Die Brücke über den Fjord')
    assert.equal(meta.info.Author, 'Anna Müller')
    assert.equal(meta.info.Language, 'de-CH')
    assert.ok(pages.some((page) => page.annotations.some((annotation) => annotation.url === 'https://fanotes.ch/')), 'link annotation')
    const headerPage = layout.pages.findIndex((page) => page.header?.left || page.header?.right)
    assert.ok(squash(pages[headerPage].items.map((item) => item.str).join(' ')).includes(layout.pages[headerPage].footer.center.replace(/ /gu, ' ')), 'footer with page fields')
  })

  await test('PDF: draws the layout\'s pieces (a run of spaces keeps its length, indentation after a break is drawn, hanging spaces are not)', async () => {
    const mini = defaults.newStory({ title: 'Leerzeichen', language: 'de-CH', deviceId: 'dev1', now })
    const long = 'Eingerückt und danach noch ein sehr langer Satz, der umbrechen muss, weil er nicht auf eine Zeile passt, und noch länger, damit es mehrere Zeilen werden.'
    const entries = [
      { text: `Zeile   mit    Lücken.\n      ${long}` },
      { text: 'Anschrift   \nStrasse 1   \nOrt  ', align: 'center' },
      { text: 'Rechts   \nbündig  ', align: 'right' },
      { text: `${long} ${long} Donaudampfschifffahrtsgesellschaft`, align: 'justify' },
    ]
    const order = keys.keysBetween(null, null, entries.length)
    mini.scenes[0].paragraphs = entries.map((entry, index) => ({ id: `para0000000${index + 1}`, key: order[index], v: { dev1: 1 }, style: 'body', runs: [{ text: entry.text }], ...(entry.align ? { align: entry.align } : {}) }))
    const prepared = prepareModule.prepare(mini)
    const { layout, measurer } = await exporter.exportLayout(prepared, files, options)
    const result = await exporter.exportStory(mini, 'pdf', { ...options, layout, measurer })
    const document = await pdfjs.getDocument({ data: result.bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
    // Everything the page draws, in drawing order, as the glyph strings of its text operations.
    const drawn = []
    for (let index = 1; index <= document.numPages; index += 1) {
      const list = await (await document.getPage(index)).getOperatorList()
      list.fnArray.forEach((fn, position) => {
        if (fn === pdfjs.OPS.showText) drawn.push(list.argsArray[position][0].filter((glyph) => glyph && typeof glyph === 'object').map((glyph) => glyph.unicode).join(''))
      })
    }
    const expectedSpaces = []
    let hanging = 0
    let hyphens = 0
    const addLine = (box) => {
      for (const piece of box.pieces) {
        if (piece.hyphen) hyphens += 1
        if (piece.kind !== 'space') continue
        if (piece.hang) hanging += 1
        else expectedSpaces.push(' '.repeat(piece.to - piece.from))
      }
    }
    for (const page of layout.pages) {
      for (const placed of page.lines) addLine(layout.layouts[placed.blockIndex].lines[placed.lineIndex])
      for (const note of page.footnotes) note.layout.lines.forEach(addLine)
    }
    assert.ok(hanging >= 6, `${hanging} hanging spaces in the layout (at soft wraps, before breaks, at the end)`)
    assert.ok(hyphens >= 1, 'a word is hyphenated')
    const drawnSpaces = drawn.filter((text) => /^ +$/u.test(text))
    assert.deepEqual(drawnSpaces, expectedSpaces, 'one glyph per typed space, none for hanging spaces')
    assert.ok(drawnSpaces.includes('   ') && drawnSpaces.includes('    ') && drawnSpaces.includes('      '), 'runs of 3, 4 and the 6 spaces of the indentation')
    assert.equal(drawn.filter((text) => text === '-').length, hyphens, 'one hyphen glyph per hyphenated line')
    // Where the lines start: the first glyph of every line is where the layout put its first word (indentation, centred and right-aligned lines included).
    const { pages } = await pdfText(result.bytes)
    const PX = 0.75
    const height = layout.pageHeight * PX
    let checked = 0
    layout.pages.forEach((page, pageIndex) => {
      for (const placed of page.lines) {
        const box = layout.layouts[placed.blockIndex].lines[placed.lineIndex]
        const first = box.pieces.find((piece) => piece.kind === 'word')
        if (!first || layout.layouts[placed.blockIndex].style.listMarker) continue
        const band = pages[pageIndex].items.filter((item) => {
          const baseline = (height - item.y) / PX
          return item.str.trim() && baseline > placed.y + 0.5 && baseline < placed.y + box.height + 0.5 && item.size < box.height * PX
        })
        assert.ok(band.length, `page ${pageIndex + 1} line at ${Math.round(placed.y)} has text`)
        assert.ok(Math.abs(Math.min(...band.map((item) => item.x)) - (placed.x + first.x) * PX) < 1, `x of the line at ${Math.round(placed.y)} on page ${pageIndex + 1}`)
        checked += 1
      }
    })
    assert.ok(checked >= 12, `${checked} lines checked`)
  })

  await test('PDF: endnotes per chapter and at the end of the book (layout option)', async () => {
    const prepared = prepareModule.prepare(story)
    for (const notes of ['endnotes-chapter', 'endnotes-book']) {
      const { layout } = await exporter.exportLayout(prepared, files, { ...options, notes })
      assert.ok(layout.pages.every((page) => page.footnotes.length === 0), `${notes}: no notes at the page bottom`)
      const noteBlocks = layout.blocks.filter((block) => block.key.startsWith('e:'))
      assert.equal(noteBlocks.length, 3)
      const numbers = [...layout.footnoteNumbers.values()]
      assert.deepEqual(numbers, notes === 'endnotes-chapter' ? ['1', '1', '1'] : ['1', '2', '3'])
      if (notes === 'endnotes-book') assert.equal(layout.blocks.find((block) => block.key === 'n:book')?.chapterStart, true)
      else assert.equal(layout.blocks.filter((block) => block.key.startsWith('n:')).length, 3, 'a notes heading after each chapter with notes')
      const result = await exporter.exportStory(story, 'pdf', { ...options, notes })
      const { document, pages } = await pdfText(result.bytes)
      assert.equal(document.numPages, layout.pages.length)
      assert.ok(squash(pages.map((page) => page.items.map((item) => item.str).join(' ')).join(' ')).includes('Anmerkungen'))
    }
    // The default (editor) layout is unchanged by the option's code path.
    const plain = paginate.layoutManuscript(prepared.manifest, prepared.flow, new paginate.LayoutCache(), { measurer: new measure.FixedMeasurer(), footnoteRuns: prepared.footnoteRuns })
    assert.equal(plain.blocks, prepared.flow, 'no blocks added without the option')
    assert.ok(plain.pages.some((page) => page.footnotes.length))
  })

  await test('PDF: one chapter', async () => {
    const result = await exporter.exportStory(story, 'pdf', { ...options, scope: 'chapter', chapterId: 'chap00000002' })
    const { document, pages } = await pdfText(result.bytes)
    assert.equal(result.fileName, 'Die Brücke über den Fjord - Kapitel 2 Der Brief.pdf')
    const text = squash(pages.map((page) => page.items.map((item) => item.str).join(' ')).join(' '))
    assert.ok(text.includes('Zwischentitel') && !text.includes('Ankunft'))
    assert.ok(document.numPages >= 2)
  })

  // ── DOCX ───────────────────────────────────────────────────────────────
  const docxParts = async (bytes) => {
    const zip = await JSZip.loadAsync(bytes)
    const out = {}
    for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) out[name] = await zip.file(name).async('string')
    return out
  }
  const normalizeRuns = (runs, footnotes) => runs.map((run) => {
    const { fn, cm, ...marks } = run.m ?? {}
    return { text: run.text, ...(Object.keys(marks).length ? { m: marks } : {}), ...(fn ? { fn: footnotes(fn) } : {}), ...(cm ? { cm: true } : {}) }
  })
  const paragraphsOf = (project) => {
    const prepared = prepareModule.prepare(project)
    const footnote = (fid) => prepared.footnotes.get(fid)?.runs.map((run) => run.text).join('')
    return prepared.flow.filter((block) => block.ref.kind === 'para').map((block) => ({ style: block.style, lang: block.lang ?? null, align: block.align ?? null, breakBefore: block.breakBefore ?? null, runs: normalizeRuns(block.runs, footnote) }))
  }

  await test('DOCX: well-formed parts, and export → import gives the same paragraphs, styles and marks', async () => {
    for (const notes of ['footnotes', 'endnotes-chapter', 'endnotes-book']) {
      const result = await exporter.exportStory(story, 'docx', { ...options, notes })
      const parts = await docxParts(result.bytes)
      for (const [name, xml] of Object.entries(parts)) if (/\.(xml|rels)$/u.test(name)) assertWellFormed(xml, `${notes} ${name}`)
      assert.ok(parts[notes === 'footnotes' ? 'word/footnotes.xml' : 'word/endnotes.xml'])
      assert.ok(parts['word/comments.xml'].includes('Klingt gut.'))
      assert.ok(parts['word/document.xml'].includes('w:type w:val="oddPage"'), 'chapters on odd pages')
      assert.ok(parts['word/footer1.xml'].includes('NUMPAGES') && parts['word/header1.xml'].includes('STYLEREF'))
      assert.ok(parts['word/settings.xml'].includes('<w:mirrorMargins/>') && parts['word/settings.xml'].includes('<w:autoHyphenation/>'))
      assert.ok(parts['word/document.xml'].includes('<w:lang w:val="en-GB"/>'))
      assert.ok(!parts['word/document.xml'].includes('GEHEIMER') && !parts['word/document.xml'].includes('PAPIERKORB'))
      const imported = await importer.importStory(result.bytes, result.fileName, { deviceId: 'dev2', now })
      assert.deepEqual(paragraphsOf(imported), paragraphsOf(story), `${notes}: paragraphs`)
      const titles = (nodes) => nodes.map((node) => [node.kind, node.title, titles(node.children ?? [])])
      const exported = prepareModule.exportedBinder(story.manifest.binder)
      const strip = (nodes) => nodes.map((node) => [node.kind, node.kind === 'scene' ? '' : node.title, strip(node.children ?? [])])
      assert.deepEqual(strip(imported.manifest.binder), strip(exported), 'parts, chapters and scenes')
      assert.equal(imported.manifest.title, story.manifest.title)
      assert.equal(imported.manifest.author, 'Anna Müller')
      assert.equal(imported.manifest.language, 'de-CH')
      for (const styleId of ['body', 'first', 'chapter', 'quote', 'list']) {
        const { name: _a, ...left } = imported.manifest.styles[styleId]
        const { name: _b, ...right } = story.manifest.styles[styleId]
        assert.deepEqual(left, right, `style ${styleId}: ${JSON.stringify(Object.fromEntries(Object.keys({ ...left, ...right }).filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).map((key) => [key, [left[key], right[key]]])))}`)
      }
      const page = imported.manifest.page
      assert.equal(page.mirror, true)
      assert.equal(page.chapterStartsRight, true)
      assert.equal(page.size, 'A5')
      const comments = imported.scenes.flatMap((scene) => Object.values(scene.comments ?? {}))
      assert.deepEqual(comments.map((comment) => [comment.author, comment.text]), [['Lektorin', 'Klingt gut.']])
      for (const scene of imported.scenes) {
        assert.ok(scene.paragraphs.every((paragraph) => paragraph.id && paragraph.key && paragraph.v.dev2 === 1))
        assert.deepEqual(scene.paragraphs.map((paragraph) => paragraph.key), [...scene.paragraphs.map((paragraph) => paragraph.key)].sort())
      }
    }
    const titled = await exporter.exportStory(story, 'docx', { ...options, sceneTitles: true })
    const back = await importer.importStory(titled.bytes, 'x.docx', { deviceId: 'dev2' })
    const sceneTitles = (nodes) => nodes.flatMap((node) => (node.kind === 'scene' ? [node.title] : sceneTitles(node.children ?? [])))
    assert.deepEqual(sceneTitles(back.manifest.binder), ['Ankunft', 'Nacht', 'Der Brief', 'Rückkehr'])
  })

  await test('DOCX: LibreOffice conversion (if installed)', async () => {
    let soffice = null
    for (const candidate of ['soffice', 'libreoffice']) {
      try { execFileSync('which', [candidate], { stdio: 'pipe' }); soffice = candidate; break } catch { /* not here */ }
    }
    if (!soffice) {
      console.log('      (LibreOffice is not installed here: DOCX → PDF page-count comparison skipped)')
      return
    }
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'wm-docx-'))
    const result = await exporter.exportStory(story, 'docx', options)
    fs.writeFileSync(path.join(dir, 'story.docx'), result.bytes)
    execFileSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'story.docx')], { stdio: 'pipe', timeout: 120_000 })
    const converted = await pdfText(new Uint8Array(fs.readFileSync(path.join(dir, 'story.pdf'))))
    const prepared = prepareModule.prepare(story)
    const { layout } = await exporter.exportLayout(prepared, files, options)
    console.log(`      LibreOffice: ${converted.document.numPages} pages, layout: ${layout.pages.length}`)
    assert.ok(Math.abs(converted.document.numPages - layout.pages.length) <= layout.pages.length * 0.25)
  })

  // ── EPUB ───────────────────────────────────────────────────────────────
  await test('EPUB: mimetype first and stored, well-formed XHTML, nav and note links resolve', async () => {
    for (const notes of ['footnotes', 'endnotes-chapter', 'endnotes-book']) {
      const result = await exporter.exportStory(story, 'epub', { ...options, notes, sceneTitles: notes === 'footnotes', embedFonts: notes === 'endnotes-book' })
      const bytes = Buffer.from(result.bytes)
      assert.equal(bytes.readUInt32LE(0), 0x04034b50)
      assert.equal(bytes.readUInt16LE(8), 0, 'mimetype stored')
      assert.equal(bytes.readUInt16LE(28), 0, 'no extra field')
      assert.equal(bytes.toString('latin1', 30, 30 + bytes.readUInt16LE(26)), 'mimetype')
      assert.equal(bytes.toString('latin1', 38, 58), 'application/epub+zip')
      const zip = await JSZip.loadAsync(result.bytes)
      const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
      const text = {}
      for (const name of names) if (/\.(xhtml|opf|ncx|xml)$/u.test(name)) { text[name] = await zip.file(name).async('string'); assertWellFormed(text[name], `${notes} ${name}`) }
      const opf = text['OEBPS/content.opf']
      for (const match of opf.matchAll(/href="([^"]+)"/gu)) assert.ok(names.includes(`OEBPS/${match[1]}`), `manifest item ${match[1]}`)
      assert.ok(opf.includes('<dc:language>de-CH</dc:language>') && opf.includes('Anna Müller') && opf.includes('properties="nav"'))
      const ids = (file) => new Set([...text[file].matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]))
      const resolve = (from, href) => {
        const [file, anchor] = href.split('#')
        const target = file ? path.posix.normalize(path.posix.join(path.posix.dirname(from), file)) : from
        assert.ok(names.includes(target), `${from} → ${href}: file`)
        if (anchor) assert.ok(ids(target).has(anchor), `${from} → ${href}: anchor`)
      }
      for (const match of text['OEBPS/nav.xhtml'].matchAll(/<a [^>]*href="([^"]+)"/gu)) resolve('OEBPS/nav.xhtml', match[1])
      for (const match of text['OEBPS/toc.ncx'].matchAll(/src="([^"]+)"/gu)) resolve('OEBPS/toc.ncx', match[1])
      let noterefs = 0
      for (const name of names.filter((entry) => entry.endsWith('.xhtml'))) {
        for (const match of text[name].matchAll(/<a [^>]*href="([^"]+)"/gu)) {
          if (/^https?:/u.test(match[1])) continue
          resolve(name, match[1])
          noterefs += 1
        }
      }
      assert.ok(noterefs >= 6, `${notes}: note links and back links`)
      assert.ok(text['OEBPS/nav.xhtml'].includes('Kapitel 3: Rückkehr'))
      const all = Object.values(text).join('')
      assert.ok(!all.includes('GEHEIMER') && !all.includes('PAPIERKORB'))
      if (notes === 'endnotes-book') assert.ok(names.includes('OEBPS/fonts/Literata-Regular.ttf') && names.includes('OEBPS/text/notes.xhtml'))
    }
  })

  // ── Markdown and text ──────────────────────────────────────────────────
  await test('Markdown and plain text match the golden files', async () => {
    fs.mkdirSync(goldenDir, { recursive: true })
    for (const [format, file] of [['md', 'story.md'], ['txt', 'story.txt']]) {
      const result = await exporter.exportStory(story, format, options)
      const text = new TextDecoder().decode(result.bytes)
      const golden = path.join(goldenDir, file)
      if (process.env.UPDATE_GOLDEN || !fs.existsSync(golden)) fs.writeFileSync(golden, text)
      assert.equal(text, fs.readFileSync(golden, 'utf8'), `${file} (UPDATE_GOLDEN=1 to accept a deliberate change)`)
    }
  })

  await test('Markdown round trip keeps chapters, scenes, emphasis and footnotes', async () => {
    const result = await exporter.exportStory(story, 'md', options)
    const back = await importer.importStory(result.bytes, 'story.md', { deviceId: 'dev2' })
    const original = paragraphsOf(story).map((paragraph) => ({ ...paragraph, style: ['first', 'body'].includes(paragraph.style) ? 'body' : paragraph.style, lang: null, align: null, breakBefore: null, runs: paragraph.runs.filter((run) => run.text || run.fn).map((run) => { const m = { ...(run.m ?? {}) }; for (const key of ['sc', 'color', 'hl', 'lang', 'font', 'size']) delete m[key]; return { text: run.text, ...(Object.keys(m).length ? { m } : {}), ...(run.fn ? { fn: run.fn } : {}) } }) }))
    const merge = (runs) => runs.reduce((out, run) => { const last = out.at(-1); if (last && !run.fn && !last.fn && JSON.stringify(last.m) === JSON.stringify(run.m)) last.text += run.text; else out.push({ ...run }); return out }, [])
    const imported = paragraphsOf(back).map((paragraph) => ({ ...paragraph, style: ['first', 'body'].includes(paragraph.style) ? 'body' : paragraph.style, runs: merge(paragraph.runs.map((run) => ({ ...run }))) }))
    assert.deepEqual(imported, original.map((paragraph) => ({ ...paragraph, runs: merge(paragraph.runs) })))
    assert.equal(back.manifest.title, story.manifest.title)
    assert.equal(back.manifest.language, 'de-CH')
    const strip = (nodes) => nodes.map((node) => [node.kind, node.kind === 'scene' ? '' : node.title, strip(node.children ?? [])])
    assert.deepEqual(strip(back.manifest.binder), strip(prepareModule.exportedBinder(story.manifest.binder)), 'parts, chapters and scenes')
  })

  // ── Imports of files from elsewhere ───────────────────────────────────
  await test('import: a Word document with German heading styles, footnote, page break and scene marker', async () => {
    const zip = new JSZip()
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    zip.file('word/styles.xml', `<?xml version="1.0"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="Überschrift 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Zitat"><w:name w:val="Quote"/></w:style></w:styles>`)
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/" TargetMode="External"/></Relationships>')
    zip.file('word/footnotes.xml', `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Grüsse aus Zürich.</w:t></w:r></w:p></w:footnote></w:footnotes>`)
    const p = (text, style, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}</w:pPr>${extra}${text ? `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>` : ''}</w:p>`
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${p('Mein Märchen', 'Titel')}${p('Erstes Kapitel', 'berschrift1')}${p('Es war einmal ein Bär.')}<w:p><w:r><w:t xml:space="preserve">Er ass </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Äpfel</w:t></w:r><w:r><w:rPr><w:i/><w:lang w:val="en-US"/></w:rPr><w:t xml:space="preserve"> and pies</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:hyperlink r:id="rId9"><w:r><w:t xml:space="preserve"> Link</w:t></w:r></w:hyperlink></w:p>${p('* * *')}${p('Zweite Szene beginnt.')}${p('', '', '<w:r><w:br w:type="page"/></w:r>')}${p('Nach der Seite.')}${p('Ein Zitat.', 'Zitat')}${p('Zweites Kapitel', 'berschrift1')}${p('Ende.')}</w:body></w:document>`)
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const story2 = await importer.importStory(bytes, 'märchen.docx', { deviceId: 'dev3' })
    assert.equal(story2.manifest.title, 'Mein Märchen')
    assert.equal(story2.manifest.language, 'de')
    assert.deepEqual(story2.manifest.binder.map((node) => [node.kind, node.title, node.children.length]), [['chapter', 'Erstes Kapitel', 2], ['chapter', 'Zweites Kapitel', 1]])
    const first = story2.scenes.find((scene) => scene.id === story2.manifest.binder[0].children[0].id)
    assert.equal(first.paragraphs[0].style, 'first')
    const runs = first.paragraphs[1].runs
    assert.deepEqual(runs.slice(0, 3), [{ text: 'Er ass ' }, { text: 'Äpfel', m: { b: true } }, { text: ' and pies', m: { i: true, lang: 'en-US' } }])
    assert.equal(first.footnotes[runs[3].m.fn].runs[0].text, 'Grüsse aus Zürich.')
    assert.deepEqual(runs[4], { text: ' Link', m: { link: 'https://example.org/' } })
    const second = story2.scenes.find((scene) => scene.id === story2.manifest.binder[0].children[1].id)
    assert.deepEqual(second.paragraphs.map((paragraph) => [paragraph.style, paragraph.runs[0]?.text, paragraph.breakBefore ?? null]), [['first', 'Zweite Szene beginnt.', null], ['body', 'Nach der Seite.', 'page'], ['quote', 'Ein Zitat.', null]])
  })

  await test('import: Markdown (German) and text (German and English chapter headings)', async () => {
    const md = '---\ntitle: "Über Berge"\nauthor: Jörg\n---\n\n# Kapitel 1\n\nSie lief **schnell** und *leise* über die Brücke.[^a]\nZeile zwei.\n\n* * *\n\n> Ein Zitat\n\n# Kapitel 2\n\n## Am Morgen\n\nDer Tag begann mit ~~Regen~~ Sonne, siehe [Karte](https://example.org/map).\n\n[^a]: Die alte Brücke.\n'
    const a = await importer.importStory(new TextEncoder().encode(md), 'berge.md', { deviceId: 'dev4' })
    assert.equal(a.manifest.title, 'Über Berge')
    assert.equal(a.manifest.author, 'Jörg')
    assert.equal(a.manifest.language, 'de')
    assert.deepEqual(a.manifest.binder.map((node) => [node.title, node.children.map((scene) => scene.title)]), [['Kapitel 1', ['Szene 1', 'Szene 2']], ['Kapitel 2', ['Am Morgen']]])
    const s1 = a.scenes[0]
    assert.deepEqual(s1.paragraphs[0].runs.slice(0, 5), [{ text: 'Sie lief ' }, { text: 'schnell', m: { b: true } }, { text: ' und ' }, { text: 'leise', m: { i: true } }, { text: ' über die Brücke.' }])
    assert.equal(s1.footnotes[s1.paragraphs[0].runs[5].m.fn].runs[0].text, 'Die alte Brücke.')
    assert.equal(a.scenes[1].paragraphs[0].style, 'quote')
    assert.deepEqual(a.scenes[2].paragraphs[0].runs.filter((run) => run.m).map((run) => run.m), [{ s: true }, { link: 'https://example.org/map' }])

    const de = 'Die Reise\n\nvon Jörg Bär\n\nProlog\n\nEs regnete über Zürich, und die Strassen glänzten.\n\nKapitel 1\n\nSie öffnete die Tür.\n\n***\n\nSpäter am Abend.\n\nKapitel 2: Heimkehr\n\nEnde gut, alles gut.\n'
    const b = await importer.importStory(new TextEncoder().encode(de), 'reise.txt', { deviceId: 'dev4' })
    assert.equal(b.manifest.title, 'Die Reise')
    assert.equal(b.manifest.author, 'Jörg Bär')
    assert.deepEqual(b.manifest.binder.map((node) => [node.title, node.children.length]), [['Prolog', 1], ['Kapitel 1', 2], ['Kapitel 2: Heimkehr', 1]])
    const en = 'CHAPTER I\r\n\r\nIt was a bright cold day in April, and the clocks were striking\r\nthirteen. Winston Smith, his chin nuzzled into his breast in an\r\neffort to escape the vile wind, slipped quickly through the doors.\r\n\r\nChapter Two\r\n\r\nThe hallway smelt of boiled cabbage and old rag mats.\r\n'
    const c = await importer.importStory(new TextEncoder().encode(en), 'novel.txt', { deviceId: 'dev4' })
    assert.equal(c.manifest.language, 'en-US')
    assert.deepEqual(c.manifest.binder.map((node) => node.title), ['CHAPTER I', 'Chapter Two'])
    assert.ok(c.scenes[0].paragraphs[0].runs[0].text.startsWith('It was a bright cold day in April, and the clocks were striking thirteen. Winston'), 'hard-wrapped lines joined')
    const latin1 = Uint8Array.from([...'Kapitel 1\n\nGr\xfcsse aus M\xfcnchen und Gen\xe8ve.'].map((char) => char.charCodeAt(0)))
    const d = await importer.importStory(latin1, 'alt.txt', { deviceId: 'dev4' })
    assert.equal(d.scenes[0].paragraphs[0].runs[0].text, 'Grüsse aus München und Genève.', 'Windows-1252 fallback')
  })

  // ── Performance ───────────────────────────────────────────────────────
  await test('PDF of a ~600-page novel: time and memory', async () => {
    const big = structuredClone({ manifest: story.manifest, scenes: [...story.scenes.values()] })
    big.manifest.binder = []
    big.scenes = []
    const sentence = `${lorem} ${english}`
    for (let chapter = 0; chapter < 32; chapter += 1) {
      const sceneId = `bigscene${String(chapter).padStart(6, '0')}`
      const list = keys.keysBetween(null, null, 85)
      big.scenes.push({ format: 'fanotes-story-scene-v1', id: sceneId, paragraphs: list.map((key, index) => ({ id: `bigp${chapter}x${index}`, key, v: { A: 1 }, style: index ? 'body' : 'first', runs: [{ text: `${sentence} ${sentence.slice(0, (index * 37) % sentence.length)}` }] })) })
      big.manifest.binder.push({ id: `bigchap${String(chapter).padStart(6, '0')}`, kind: 'chapter', title: `Kapitel ${chapter + 1}`, children: [{ id: sceneId, kind: 'scene', title: 'Szene' }] })
    }
    global.gc?.()
    const before = process.memoryUsage()
    const started = performance.now()
    let peak = 0
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 50)
    const prepared = prepareModule.prepare(big)
    const { layout, measurer } = await exporter.exportLayout(prepared, files, options)
    const laidOut = performance.now()
    const bytes = await pdfModule.writePdf({ prepared, layout, files, measurer, now })
    clearInterval(timer)
    const done = performance.now()
    peak = Math.max(peak, process.memoryUsage().rss)
    const words = big.scenes.reduce((sum, scene) => sum + scene.paragraphs.reduce((total, paragraph) => total + paragraph.runs[0].text.split(/\s+/u).length, 0), 0)
    console.log(`      ${layout.pages.length} pages, ${words} words: layout ${Math.round(laidOut - started)} ms, PDF ${Math.round(done - laidOut)} ms, ${(bytes.length / 1048576).toFixed(1)} MB, RSS ${Math.round(before.rss / 1048576)} → peak ${Math.round(peak / 1048576)} MB`)
    assert.ok(layout.pages.length >= 550, `${layout.pages.length} pages`)
    const { document } = await pdfText(bytes)
    assert.equal(document.numPages, layout.pages.length)
  })
} finally {
  await vite.close()
}

for (const [status, name, error] of results) {
  console.log(`${status}  ${name}`)
  if (error) console.log(`      ${String(error?.stack ?? error).split('\n').slice(0, process.env.VERBOSE ? 200 : 8).join('\n      ')}`)
}
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
