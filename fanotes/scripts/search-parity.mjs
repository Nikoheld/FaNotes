// Search parity between the TypeScript document search and the desktop's
// native index (crates/fanotes-index).
//
//   node scripts/search-parity.mjs --write   regenerate the fixture vault, its page-text
//                                            sidecars and the golden results
//   node scripts/search-parity.mjs           check: the TS search still gives the golden results
//   node scripts/search-parity.mjs bench --vault DIR [--queries FILE] [--out FILE]
//                                            TS index build time and query latency for WP6
//
// The TS side is the real code: listSearchDocuments, createBrowserExtractor
// (pdf.js text layer, transcripts, worksheets, annotations, page-text sidecar
// writes), storySearchUnits and DocIndex.search. Documents are added in UTF-16
// path order, units in extraction order; `cargo test -p fanotes-index --test
// parity` builds the Rust index from the same vault and must return the same
// results (same hits, order, scores, snippets).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const fixtureRoot = path.join(here, 'fixtures/search-parity')
const fixtureVault = path.join(fixtureRoot, 'vault')
const expectedFile = path.join(fixtureRoot, 'expected.json')
const args = process.argv.slice(2)
const mode = args[0] === 'bench' ? 'bench' : args.includes('--write') ? 'write' : 'check'
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const CREATED_AT = '2026-11-15T00:00:00.000Z'

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, ws: false },
  resolve: { alias: [{ find: /^pdfjs-dist$/u, replacement: path.join(appRoot, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs') }] },
})

// ---------- fixture vault ----------

const write = (relative, content) => {
  const file = path.join(fixtureVault, ...relative.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const famdV1 = (markdown, ink) => {
  const json = JSON.stringify({ schema: 'fanotes-famd-v1', updatedAt: '2026-11-01T10:00:00.000Z', ink, worksheets: [] })
  return `${markdown}\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}

const inkWith = (transcript) => ({ schemaVersion: 1, title: 'Handschrift', strokes: [{ points: [{ x: 0.1, y: 0.2, t: 1 }, { x: 0.3, y: 0.2, t: 2 }] }], searchTranscript: transcript })

// A small PDF with Helvetica text (WinAnsi), one content stream per page.
const pdfBytes = (pages) => {
  const escape = (text) => [...text].map((char) => {
    const code = char.charCodeAt(0)
    if (char === '(' || char === ')' || char === '\\') return `\\${char}`
    if (code > 126) return `\\${code.toString(8).padStart(3, '0')}`
    return char
  }).join('')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '']
  const kids = []
  for (const lines of pages) {
    const pageId = objects.length + 1
    const contentId = pageId + 1
    kids.push(`${pageId} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`)
    const body = lines.length ? `BT /F1 11 Tf 14 TL 56 780 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET` : ''
    objects.push(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`)
  }
  const fontId = objects.length + 1
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${index + 1} 0 obj\n${object.replaceAll('FONT 0 R', `${fontId} 0 R`)}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const random = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const WORDS = [
  'Zelle', 'Zellkern', 'Zellmembran', 'Mitose', 'Photosynthese', 'Chlorophyll', 'Licht', 'Energie', 'Lageenergie', 'Bewegungsenergie',
  'Geschwindigkeit', 'Höhe', 'Größe', 'Straße', 'Übung', 'Prüfung', 'Mädchen', 'Bäume', 'Gewässer', 'Fluss', 'Flüsse', 'Grüße',
  'Aufsatz', 'Gedicht', 'Erörterung', 'Integral', 'Ableitung', 'Funktion', 'Gleichung', 'Vektor', 'Matrix', 'Wahrscheinlichkeit',
  'Revolution', 'Französisch', 'Englisch', 'Grammatik', 'Vokabeln', 'Säure', 'Base', 'Molekül', 'Atom', 'Elektron', 'Spannung',
  'cell', 'nucleus', 'membrane', 'energy', 'velocity', 'equation', 'essay', 'poem', 'chapter', 'river', 'mountain', 'history',
  'acid', 'molecule', 'naïve', 'café', 'résumé', 'Zürich', 'München', 'Köln', 'Genève', 'über', 'unter', 'und', 'oder', 'the', 'and',
]

const generateVault = (modules) => {
  fs.rmSync(fixtureVault, { recursive: true, force: true })
  write('Willkommen.md', '# Willkommen\n\nDiese Notiz erklärt die Suche: Straße, STRASSE und strasse sind gleich. Übung = Uebung.\n')
  write('Hausaufgaben.md', '# Hausaufgaben\n\nGeheimes Schulnetz Photosynthese\n')
  write('Kalender.md', '# Kalender\n\nPrüfung Photosynthese\n')
  write('.trash/Alt.md', 'Photosynthese im Papierkorb\n')
  write('.fanotes/notes-cache.json', '{"Photosynthese":1}')
  write('Biologie/Zelle.md', '# Zelle\n\nEine Übersicht über die Zelle und ihre Organellen. Der Zellkern steuert die Zelle.\n\nDie Photo-\nsynthese findet im Chloroplasten statt. Soft­hyphen und ﬁnden.\n')
  write('Biologie/Photosynthese.md', '# Photosynthese\n\nPflanzen brauchen Licht, Wasser und CO₂. Chlorophyll ist grün.\n<!-- fanotes-ink:abc123 -->\n')
  write('Biologie/Photosynthese.famd', famdV1('# Photosynthese', inkWith('0.1200\tPhotosynthese braucht Licht\n0.4500\tChlorophyll absorbiert Rot\n0.8100\tGlucose entsteht')))
  write('Biologie/Mitose.famd', famdV1('# Mitose\n\nPhasen: Prophase, Metaphase, Anaphase, Telophase.', inkWith('Zellteilung ohne Position\nZweite Zeile Chromosomen\r\nDritte Zeile')))
  write('Deutsch/Aufsatz.md', '# Aufsatz\n\nÜber die Straße gehen wir zur Übung. Die Größe der Straße ist gemessen.\r\nMünchen und Muenchen, Köln und Koeln.\n')
  write('Deutsch/Gedicht.md', '# Gedicht\n\n"Grüße aus Zürich" – ein Gedicht über Flüsse, Bäume und Gewässer. Naïve Café-Szene, Résumé.\n')
  write('English/Essay.md', '# Essay\n\nThe river flows through the mountain valley. Energy and velocity: the essay about history.\n')
  write('English/Poem.md', '# Poem\n\nA poem about the river and the mountain. 🌊 Waves and émotions.\n')
  const long = Array.from({ length: 900 }, (_, index) => `Satz ${index + 1}: Die Integralrechnung und die Ableitung einer Funktion.${index % 7 === 0 ? '\n' : ' '}`).join('')
  write('Mathe/Analysis.md', `# Analysis\n\n${long}\nEnde mit Wahrscheinlichkeit.\n`)
  write('Mathe/Notizen.md', '# Notizen\n\nVektor und Matrix.\n')
  write('Physik/Notizen.md', '# Notizen\n\nSpannung und Elektron.\n')
  write('Chemie/Notizen.md', '# Notizen\n\nSäure und Base.\n')
  // Worksheets: an image sheet with typed boxes, a PDF sheet, and a marker without data.
  write('Chemie/Labor.md', '# Labor\n\nVersuch mit Säure.\n<!-- fanotes-worksheet:ws_saeure -->\n<!-- fanotes-worksheet:ws_pdfblatt -->\n<!-- fanotes-worksheet:ws_fehlt -->\n')
  const sheet = (id, extension, kind, mimeType, title, texts) => {
    write(`.fanotes/worksheets/${id}.${extension}`, 'x')
    write(`.fanotes/worksheets/${id}.json`, JSON.stringify({
      schemaVersion: 1, id, title, kind, mimeType,
      sourceRelativePath: `.fanotes/worksheets/${id}.${extension}`, dataRelativePath: `.fanotes/worksheets/${id}.json`,
      createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z',
      textBoxes: texts.map((text, index) => ({ id: `b${index}`, page: 1, x: 0.1, y: 0.1 + index * 0.1, width: 0.5, fontSize: 14, text })),
      highlights: [],
    }))
  }
  sheet('ws_saeure', 'png', 'image', 'image/png', 'Säuren und Basen', ['pH-Wert messen', '', 'Indikator Lackmus'])
  sheet('ws_pdfblatt', 'pdf', 'pdf', 'application/pdf', 'Arbeitsblatt Moleküle', ['Atom und Elektron'])
  // PDFs: text layer, hyphenation across lines, a scan with shared OCR text, duplicates, annotations.
  write('Physik/Energie.pdf', pdfBytes([
    ['Kapitel 1. Die Lageenergie hängt von der Höhe ab.', 'Die Größe der Kraft ist gemessen.'],
    ['Kapitel 2. Bewegungsenergie und Geschwindig-', 'keit eines Körpers auf der Straße.'],
    ['Kapitel 3. Energieerhaltung im geschlossenen System.'],
  ]))
  write('Physik/Energie.famd', famdV1('Anmerkung: Prüfung über Lageenergie am Montag.', null))
  for (const name of ['Kopie 1', 'Kopie 2']) write(`Biologie/${name}.pdf`, pdfBytes([['Arbeitsblatt Photosynthese mit Chlorophyll und Licht.']]))
  write('Biologie/Buch.pdf', pdfBytes([['Wiederholung Photosynthese Kapitel'], ['Wiederholung Photosynthese Kapitel'], ['Mitochondrien sind Kraftwerke der Zelle.']]))
  const scan = pdfBytes([[], ['Die Französische Revolution begann 1789 in Paris.']])
  write('Geschichte/Scan.pdf', scan)
  // Page 1 is a scan: its OCR text comes from a sidecar another client wrote.
  write(`.fanotes/page-text/${createHash('Geschichte/Scan.pdf')}.json`, `${JSON.stringify({
    format: 'fanotes-page-text-v1', path: 'Geschichte/Scan.pdf', size: scan.length, stamp: modules.pdfOcr.pdfByteStamp(new Uint8Array(scan)),
    pageCount: 2, producer: 'kanti-plus', ocrEngine: 'tesseract', createdAt: CREATED_AT,
    pages: [{ page: 1, source: 'ocr', status: 'ok', text: 'Ständeversammlung in Versailles\nDer dritte Stand', confidence: 0.72 }],
  })}\n`)
  write('English/Reader.pdf', pdfBytes([['The membrane of the cell protects the nucleus.', 'Molecule and acid in the history chapter.']]))
  // Stories.
  const paragraph = (id, key, text, extra = {}) => ({ id, key, v: { dev: 1 }, style: 'body', runs: [{ text }], ...extra })
  write('Schreiben/Roman.story/story.json', JSON.stringify({
    format: 'fanotes-story-v1', id: 'story1', title: 'Roman', language: 'de',
    binder: [{ id: 'kap1', kind: 'chapter', title: 'Erstes Kapitel', children: [{ id: 'szene0001', kind: 'scene', title: 'Anfang' }, { id: 'szene0002', kind: 'scene', title: 'Sturm' }] }],
  }))
  write('Schreiben/Roman.story/scenes/szene0002.json', JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'szene0002', paragraphs: [
    paragraph('p3', 'a2', 'Der Sturm zog über den Fluss.'),
    paragraph('p2', 'a1', 'Die Bäume bogen sich im Wind.'),
    paragraph('p4', 'a3', 'Gelöschter Absatz über Geheimnisse.', { deleted: true }),
  ] }))
  write('Schreiben/Roman.story/scenes/szene0001.json', JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'szene0001', paragraphs: [
    { id: 'p1', key: 'a0', v: {}, style: 'first', runs: [{ text: 'Es war einmal ein ' }, { text: 'Mädchen', m: { i: true } }, { text: ' in Köln.\r\nSie mochte Grüße.' }] },
  ] }))
  write('Schreiben/Roman.story/scenes/lose0003.json', JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'lose0003', paragraphs: [paragraph('q1', '', 'Eine lose Szene über die Prüfung.')] }))
  write('Schreiben/Roman.story/scenes/kaputt0004.json', '{ kaputt')
  write('Schreiben/Novel.story/story.json', JSON.stringify({ format: 'fanotes-story-v1', id: 'story2', title: 'Novel', language: 'en-US', binder: [{ id: 'sceneaa01', kind: 'scene', title: 'One' }] }))
  write('Schreiben/Novel.story/scenes/sceneaa01.json', JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'sceneaa01', paragraphs: [paragraph('e1', 'a0', 'The mountain river and the café in Genève.')] }))
  // A generated corpus: many documents, shared titles in different folders, ties.
  const next = random(20261115)
  const pick = () => WORDS[Math.floor(next() * WORDS.length)]
  for (let index = 0; index < 90; index += 1) {
    const folder = ['Korpus/A', 'Korpus/B', 'Korpus/C'][index % 3]
    const title = index % 10 === 0 ? 'Zusammenfassung' : `${pick()} ${index}`
    const words = Array.from({ length: 20 + Math.floor(next() * 80) }, pick).join(' ')
    write(`${folder}/${title}.md`, `# ${title}\n\n${words}.\n`)
  }
}

// ---------- the TS side ----------

const walkTree = (root, relative = '') => {
  const entries = []
  for (const dirent of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (dirent.name.startsWith('.') || dirent.isSymbolicLink()) continue
    const child = relative ? `${relative}/${dirent.name}` : dirent.name
    const info = fs.lstatSync(path.join(root, child))
    if (dirent.isDirectory() && /\.story$/iu.test(dirent.name)) {
      entries.push({ name: dirent.name, relativePath: child, kind: 'file', extension: 'story', modifiedAt: info.mtime.toISOString() })
    } else if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, relativePath: child, kind: 'folder', children: walkTree(root, child) })
    } else if (dirent.isFile()) {
      const extension = path.extname(dirent.name).slice(1).toLocaleLowerCase('en-US')
      if (['md', 'markdown', 'famd', 'pdf'].includes(extension)) entries.push({ name: dirent.name, relativePath: child, kind: 'file', extension, size: info.size, modifiedAt: info.mtime.toISOString() })
    }
  }
  // `omitFamdCompanions` of electron/main.cjs.
  const stem = (name) => path.basename(name, path.extname(name)).normalize('NFC').toLocaleLowerCase('de-DE')
  const stems = new Set(entries.filter((entry) => entry.kind === 'file' && ['md', 'markdown', 'pdf'].includes(entry.extension)).map((entry) => stem(entry.name)))
  return entries.filter((entry) => entry.kind !== 'file' || entry.extension !== 'famd' || !stems.has(stem(entry.name)))
}

const codeUnitOrder = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

const load = async () => ({
  famd: await server.ssrLoadModule('/src/lib/famd.ts'),
  extract: await server.ssrLoadModule('/src/lib/docSearch/extract.ts'),
  story: await server.ssrLoadModule('/src/lib/docSearch/story.ts'),
  docIndex: await server.ssrLoadModule('/src/lib/docSearch/docIndex.ts'),
  pageText: await server.ssrLoadModule('/src/lib/docSearch/pageText.ts'),
  pdfOcr: await server.ssrLoadModule('/src/lib/pdfOcr.ts'),
})

/** Builds the TS index of `root` exactly like the desktop renderer reads it. */
const buildTsIndex = async (modules, root, { pdfs = true } = {}) => {
  const { famd, extract, story, docIndex, pageText } = modules
  const file = (relative) => path.join(root, ...relative.split('/'))
  const written = new Map()
  const api = {
    platform: 'linux',
    getTree: async () => walkTree(root),
    readFile: async (relative) => famd.stripFamdPayload(fs.readFileSync(file(relative), 'utf8')),
    readAssetBytes: async (relative) => new Uint8Array(fs.readFileSync(file(relative))),
    readFamdInk: async () => null,
    // The companion's ink object as stored (with `searchTranscript`), the contract extract.ts reads.
    readNoteCompanion: async (relative) => {
      const companion = file(famd.companionNotePath(relative, '.famd'))
      if (!fs.existsSync(companion)) return null
      return { ink: famd.parseFamd(fs.readFileSync(companion, 'utf8')).payload?.ink ?? null }
    },
    readWorksheet: async (id) => JSON.parse(fs.readFileSync(file(`.fanotes/worksheets/${id}.json`), 'utf8')),
    readPageText: async (relative) => {
      const sidecar = file(`.fanotes/page-text/${createHash(relative)}.json`)
      if (!fs.existsSync(sidecar)) return null
      const record = pageText.sanitizePageTextRecord(JSON.parse(fs.readFileSync(sidecar, 'utf8')))
      return record && record.path === relative && record.size === fs.statSync(file(relative)).size ? record : null
    },
    writePageText: async (record) => { written.set(record.path, { ...record, createdAt: CREATED_AT }); return record },
  }
  globalThis.window = { fanotes: api, setTimeout, clearTimeout }
  globalThis.document = { baseURI: `file://${path.join(appRoot, 'node_modules/pdfjs-dist/')}/` }
  const extractor = extract.createBrowserExtractor({ api, recognize: async () => '', producer: 'fanotes-parity' })
  const tree = await api.getTree()
  const sources = extract.listSearchDocuments(tree).filter((source) => pdfs || source.kind !== 'pdf')
  const stories = []
  const findStories = (entries) => { for (const entry of entries) { if (entry.kind === 'folder') findStories(entry.children); else if (entry.extension === 'story') stories.push(entry.relativePath) } }
  findStories(tree)
  const all = [...sources.map((source) => ({ ...source })), ...stories.map((storyPath) => ({ path: storyPath, title: storyPath.split('/').pop().replace(/\.[^.]+$/u, ''), kind: 'story' }))]
  all.sort((left, right) => codeUnitOrder(left.path, right.path))
  const index = new docIndex.DocIndex()
  const unitsByDoc = []
  for (const source of all) {
    let units = []
    if (source.kind === 'story') {
      const folder = file(source.path)
      const files = []
      const collect = (relative) => {
        for (const dirent of fs.readdirSync(path.join(folder, relative), { withFileTypes: true })) {
          const child = relative ? `${relative}/${dirent.name}` : dirent.name
          if (dirent.isDirectory()) collect(child)
          else if (dirent.isFile()) files.push({ name: child, text: fs.readFileSync(path.join(folder, child), 'utf8') })
        }
      }
      collect('')
      const manifest = files.find((entry) => entry.name === 'story.json')?.text ?? null
      units = story.storySearchUnits(source.path, manifest, files)
    } else {
      const committed = []
      await extractor.extract(source, {
        resumePage: 1,
        ocrBudget: 8,
        shouldStop: () => false,
        pause: async () => {},
        previousUnits: () => committed,
        issue: () => {},
        commit: async (batch) => { committed.push(...batch.filter((unit) => unit.path === source.path)) },
      })
      units = committed
    }
    index.setDoc({ path: source.path, title: source.title, kind: source.kind === 'pdf' ? 'pdf' : 'note', fingerprint: '', extractor: 1, status: 'indexed', attempts: 0, issues: [], ocrPages: 0, updatedAt: 0 })
    for (const unit of units) index.addUnit(unit)
    unitsByDoc.push({ path: source.path, units })
  }
  return { index, unitsByDoc, written }
}

import { createHash as sha } from 'node:crypto'
const createHash = (relative) => sha('sha256').update(relative).digest('hex').slice(0, 32)

const QUERIES = [
  'strasse', 'Straße', 'STRASSE', 'strass', 'uebung', 'Übung', 'ubung', 'muenchen', 'München', 'koln', 'grosse', 'größe strasse',
  'photosynthese', 'photo', 'Photosynthese Licht', 'chlorophyll', 'chlorophyll rot', 'glucose', 'zellteilung', 'chromosomen', 'dritte zeile',
  'zelle', 'zell', 'zellkern', 'organellen', 'finden', 'softhyphen', 'lageenergie', 'hoehe lageenergie', 'bewegung', 'geschwindigkeit',
  'energie', 'ergie', 'kraft', 'montag', 'prüfung', 'revolution', 'französische revolution 1789', 'paris', 'membrane', 'nucleus', 'acid history',
  'kopie', 'arbeitsblatt', 'wiederholung', 'mitochondrien', 'säure', 'saeure', 'lackmus', 'ph wert', 'molekule', 'elektron', 'atom',
  'notizen', 'mathe notizen', 'vektor', 'integralrechnung', 'ableitung funktion', 'wahrscheinlichkeit', 'satz 899', 'analysis',
  'sturm', 'baume wind', 'mädchen köln', 'grüsse', 'geheimnisse', 'lose szene', 'roman', 'novel', 'genève', 'geneve cafe', 'cafe', 'naive', 'resume',
  'river', 'mountain river', 'the', 'and the', 'essay', 'poem waves', 'emotions', 'zürich', 'zurich', 'flusse', 'gewasser',
  '"die größe"', 'die größe der', 'e = m·c²', 'co2', 'a', 'z', 'x y', 'schreiben', 'biologie', 'korpus', 'zusammenfassung', 'zusammen b',
  'nichtvorhanden', 'photosynthese nichtvorhanden', 'eins zwei drei vier fünf sechs sieben acht neun zehn', 'hausaufgaben', 'kalender', 'papierkorb',
]

const generatedQueries = () => {
  const next = random(4242)
  const pick = () => WORDS[Math.floor(next() * WORDS.length)]
  const out = []
  for (let index = 0; index < 40; index += 1) {
    const kind = index % 4
    if (kind === 0) out.push(pick())
    else if (kind === 1) out.push(`${pick()} ${pick()}`)
    else if (kind === 2) out.push(pick().slice(0, 3 + Math.floor(next() * 3)))
    else out.push(`${pick().toUpperCase()} ${pick().slice(0, 4)}`)
  }
  return out
}

const copyDir = (from, to) => fs.cpSync(from, to, { recursive: true })

try {
  const modules = await load()
  globalThis.pdfjsWorker = await import(path.join(appRoot, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'))
  if (mode === 'bench') {
    const vault = path.resolve(option('--vault') ?? '')
    const queries = option('--queries') ? JSON.parse(fs.readFileSync(option('--queries'), 'utf8')) : generatedQueries()
    const started = performance.now()
    const { index } = await buildTsIndex(modules, vault, { pdfs: false })
    const buildMs = performance.now() - started
    const times = []
    for (let round = 0; round < 3; round += 1) for (const query of queries) { const at = performance.now(); index.search(query); times.push(performance.now() - at) }
    times.sort((a, b) => a - b)
    const quantile = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))]
    const report = { engine: 'ts', documents: index.documentCount, units: index.unitCount, buildMs: Math.round(buildMs), queryP50Ms: +quantile(0.5).toFixed(3), queryP95Ms: +quantile(0.95).toFixed(3), queries: times.length, rssMb: Math.round(process.memoryUsage().rss / 1048576) }
    if (option('--out')) fs.writeFileSync(option('--out'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report))
  } else {
    if (mode === 'write') generateVault(modules)
    const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-parity-'))
    copyDir(fixtureVault, temporary)
    const { index, unitsByDoc, written } = await buildTsIndex(modules, temporary)
    fs.rmSync(temporary, { recursive: true, force: true })
    // The page-text sidecars are TS output too; the Rust index reads them.
    for (const [pdfPath, record] of written) {
      const relative = `.fanotes/page-text/${createHash(pdfPath)}.json`
      const target = path.join(fixtureVault, ...relative.split('/'))
      if (mode === 'write') write(relative, `${JSON.stringify(record)}\n`)
      else assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).pages, record.pages, `page text of ${pdfPath} changed; run --write`)
    }
    const queries = [...QUERIES, ...generatedQueries()]
    const expected = { format: 'fanotes-search-parity-v1', note: 'Generated by scripts/search-parity.mjs from the TypeScript search. Do not edit.', units: unitsByDoc, queries: queries.map((query) => ({ query, results: index.search(query) })) }
    if (mode === 'write') {
      const lines = (list) => list.map((entry) => JSON.stringify(entry)).join(',\n')
      fs.writeFileSync(expectedFile, `{"format":${JSON.stringify(expected.format)},"note":${JSON.stringify(expected.note)},\n"units":[\n${lines(expected.units)}],\n"queries":[\n${lines(expected.queries)}]}\n`)
      // The scan's OCR page came from Kanti+ originally; keep that input in the fixture.
      console.log(`wrote ${queries.length} queries, ${unitsByDoc.length} documents, ${written.size} page-text sidecars`)
    } else {
      const golden = JSON.parse(fs.readFileSync(expectedFile, 'utf8'))
      assert.deepEqual(JSON.parse(JSON.stringify(expected)), golden, 'TS search results differ from the golden file; run --write and review')
      console.log(`search parity: TS search matches the golden results (${queries.length} queries, ${unitsByDoc.length} documents)`)
    }
  }
} finally {
  await server.close()
}
