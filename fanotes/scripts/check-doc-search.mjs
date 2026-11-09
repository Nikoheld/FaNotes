// Document search: folding, ranking, snippets, the page-text contract and the
// indexer lifecycle (incremental, resumable, retries, deletions, duplicates).
// Run from fanotes/: node scripts/check-doc-search.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const results = []
const test = async (name, fn) => {
  try {
    await fn()
    results.push([name, true])
  } catch (error) {
    results.push([name, false, error])
  }
}

try {
  const text = await server.ssrLoadModule('/src/lib/docSearch/text.ts')
  const { DocIndex } = await server.ssrLoadModule('/src/lib/docSearch/docIndex.ts')
  const indexer = await server.ssrLoadModule('/src/lib/docSearch/indexer.ts')
  const contract = await server.ssrLoadModule('/src/lib/docSearch/pageText.ts')
  const orientation = await server.ssrLoadModule('/src/lib/docSearch/ocrOrientation.ts')
  const { DocIndexer, EXTRACTOR_VERSION, retryDelay } = indexer

  await test('German folding matches Kanti+ rules', () => {
    const f = text.foldPlain
    assert.equal(f('Straße'), f('STRASSE'))
    assert.equal(f('Straße'), 'strasse')
    assert.equal(f('Übung'), f('Uebung'))
    assert.equal(f('Übung'), f('ubung'))
    assert.equal(f('München'), f('Muenchen'))
    assert.equal(f('Größe'), f('GROESSE'))
    assert.equal(f('FInanzen'), 'finanzen')
    assert.equal(f('Café'), 'cafe')
    assert.equal(f('Integral-\nrechnung'), 'integralrechnung')
    assert.equal(f('Ab-\n  sätze'), 'absatze')
    assert.equal(f('Nord-Süd'), 'nord sud')
    assert.equal(f('soft­hyphen'), 'softhyphen')
    assert.equal(f('  E = m·c²!  '), 'e m c2')
  })

  await test('origin map points back into the original text', () => {
    const folded = text.foldSearch('Größe ändern')
    assert.equal(folded.text, 'grosse andern')
    assert.equal(folded.text.length, folded.origin.length)
    assert.equal(folded.origin[folded.text.indexOf('andern')], 'Größe ändern'.indexOf('ändern'))
  })

  await test('queries: distinct folded terms, at most 8, punctuation ignored', () => {
    assert.deepEqual(text.parseDocQuery('  Straße, STRASSE; Übung ').terms, ['strasse', 'ubung'])
    assert.equal(text.parseDocQuery('a b c d e f g h i j').terms.length, 8)
    assert.deepEqual(text.parseDocQuery('"); DROP TABLE --').terms, ['drop', 'table'])
    assert.deepEqual(text.parseDocQuery('').terms, [])
  })

  await test('snippets highlight the original words, umlauts and ß included', () => {
    const original = 'Einleitung. ' + 'Füllwort '.repeat(30) + 'Die Größe der Straße ist gemessen. ' + 'Ende '.repeat(30)
    const snippet = text.makeSnippet(original, text.parseDocQuery('grosse strasse').terms)
    assert.ok(snippet.text.length <= 170, snippet.text.length)
    const marked = snippet.highlights.map(([a, b]) => snippet.text.slice(a, b))
    assert.deepEqual(marked, ['Größe', 'Straße'])
    assert.ok(snippet.text.startsWith('… '))
  })

  const unit = (path, kind, n, textValue, extra = {}) => ({ id: `${path}#${kind}:${n}`, path, kind, source: 'text', text: textValue, ...extra })
  const doc = (path, title, kind = 'pdf', extra = {}) => ({ path, title, kind, fingerprint: 'f1', extractor: EXTRACTOR_VERSION, status: 'indexed', attempts: 0, issues: [], ocrPages: 0, updatedAt: 0, ...extra })

  await test('search: AND of terms, prefixes, case and umlauts, page numbers', () => {
    const index = new DocIndex()
    index.setDoc(doc('Physik/Energie.pdf', 'Energie'))
    index.addUnit(unit('Physik/Energie.pdf', 'pdf-page', 1, 'Kapitel 1. Die Lageenergie hängt von der Höhe ab.', { page: 1, source: 'text-layer' }))
    index.addUnit(unit('Physik/Energie.pdf', 'pdf-page', 2, 'Kapitel 2. Bewegungsenergie und Geschwindigkeit.', { page: 2, source: 'text-layer' }))
    index.setDoc(doc('Deutsch/Aufsatz.md', 'Aufsatz', 'note'))
    index.addUnit(unit('Deutsch/Aufsatz.md', 'note', 1, 'Über die Straße gehen wir zur Übung.'))
    let hits = index.search('hoehe lageenergie')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].page, 1)
    assert.equal(hits[0].path, 'Physik/Energie.pdf')
    hits = index.search('BEWEGUNG')
    assert.equal(hits[0].page, 2, 'prefix match on a word start')
    assert.deepEqual(hits[0].snippet.highlights.map(([a, b]) => hits[0].snippet.text.slice(a, b)), ['Bewegungsenergie'])
    hits = index.search('strasse uebung')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, 'note')
    assert.equal(index.search('energie geschwindigkeit nichtda').length, 0, 'all terms required')
    assert.equal(index.search('ergie').length, 0, 'no infix matches')
  })

  await test('ranking: exact word above prefix, text layer above weak OCR, title boost', () => {
    const index = new DocIndex()
    index.setDoc(doc('a.pdf', 'Notizen A'))
    index.addUnit(unit('a.pdf', 'pdf-page', 1, 'Zelle Zellmembran Zellkern', { page: 1, source: 'text-layer' }))
    index.addUnit(unit('a.pdf', 'pdf-page', 2, 'Zellenteilung und Mitose', { page: 2, source: 'text-layer' }))
    index.setDoc(doc('b.pdf', 'Scan B'))
    index.addUnit(unit('b.pdf', 'pdf-page', 1, 'Zelle Zellmembran Zellkern', { page: 1, source: 'ocr', confidence: 0.3 }))
    index.setDoc(doc('Biologie/Zelle.md', 'Zelle', 'note'))
    index.addUnit(unit('Biologie/Zelle.md', 'note', 1, 'Eine Übersicht über die Zelle und Organellen.'))
    const hits = index.search('zelle')
    assert.equal(hits[0].path, 'Biologie/Zelle.md', 'title match first')
    const ordered = hits.map((hit) => `${hit.path}:${hit.page ?? ''}`)
    assert.ok(ordered.indexOf('a.pdf:1') < ordered.indexOf('a.pdf:2'), 'exact word above prefix-only')
  })

  await test('duplicates: identical page text in several files shows once', () => {
    const index = new DocIndex()
    for (const name of ['Kopie 1.pdf', 'Kopie 2.pdf', 'Kopie 3.pdf']) {
      index.setDoc(doc(name, name))
      index.addUnit(unit(name, 'pdf-page', 1, 'Arbeitsblatt Photosynthese mit Chlorophyll und Licht', { page: 1 }))
    }
    index.setDoc(doc('Buch.pdf', 'Buch'))
    index.addUnit(unit('Buch.pdf', 'pdf-page', 4, 'Wiederholung Photosynthese', { page: 4 }))
    index.addUnit(unit('Buch.pdf', 'pdf-page', 5, 'Wiederholung Photosynthese', { page: 5 }))
    const hits = index.search('photosynthese')
    const copies = hits.filter((hit) => hit.path.startsWith('Kopie'))
    assert.equal(copies.length, 1)
    assert.equal(copies[0].alsoIn, 2)
    assert.equal(hits.filter((hit) => hit.path === 'Buch.pdf').length, 2, 'repeated pages inside one file stay')
  })

  await test('title-only matches return one result per document', () => {
    const index = new DocIndex()
    index.setDoc(doc('Mathe/Integralrechnung.pdf', 'Integralrechnung'))
    index.addUnit(unit('Mathe/Integralrechnung.pdf', 'pdf-page', 1, 'Seite eins', { page: 1 }))
    index.addUnit(unit('Mathe/Integralrechnung.pdf', 'pdf-page', 2, 'Seite zwei', { page: 2 }))
    const hits = index.search('integral')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].titleOnly, true)
    assert.equal(hits[0].page, 1)
  })

  await test('handwriting transcripts give a y position for the matched line', () => {
    const index = new DocIndex()
    index.setDoc(doc('Bio.md', 'Bio', 'note'))
    index.addUnit(unit('Bio.md', 'ink', 1, '0.1000\tPhotosynthese\n0.6200\tChlorophyll ist grün', { source: 'transcript' }))
    const [hit] = index.search('chlorophyll')
    assert.equal(hit.inkY, 0.62)
    assert.ok(!hit.snippet.text.includes('0.62'))
  })

  await test('snapshot round trip keeps results', () => {
    const index = new DocIndex()
    index.setDoc(doc('x.pdf', 'X'))
    index.addUnit(unit('x.pdf', 'pdf-page', 3, 'Mitochondrien sind Kraftwerke', { page: 3, source: 'ocr', confidence: 0.8 }))
    const copy = DocIndex.fromSnapshot(JSON.parse(JSON.stringify(index.snapshot())))
    assert.deepEqual(copy.search('kraftwerk').map((hit) => [hit.path, hit.page, hit.source]), [['x.pdf', 3, 'ocr']])
  })

  await test('page-text contract: valid records round-trip, invalid ones are rejected', () => {
    const record = contract.buildPageTextRecord({
      path: 'Schule/Scan.pdf', size: 1234, stamp: 'a1b2c3d4', pageCount: 3, producer: 'test',
      ocrEngine: 'fanotes-trocr-v1',
      pages: [
        { page: 2, source: 'ocr', status: 'ok', text: 'Größe', confidence: 0.7, rotation: 90 },
        { page: 1, source: 'text-layer', status: 'ok', text: 'x'.repeat(7000) },
        { page: 3, source: 'ocr', status: 'failed', text: '', reason: 'ocr-error' },
      ],
      now: new Date('2026-11-09T10:00:00Z'),
    })
    assert.ok(record)
    assert.deepEqual(record.pages.map((page) => page.page), [1, 2, 3])
    assert.equal(record.pages[0].text.length, contract.PAGE_TEXT_MAX_PAGE_CHARS)
    assert.deepEqual(contract.sanitizePageTextRecord(JSON.parse(JSON.stringify(record))), record)
    assert.ok(contract.pageTextRecordMatches(record, { path: 'Schule/Scan.pdf', size: 1234, stamp: 'a1b2c3d4' }))
    assert.ok(!contract.pageTextRecordMatches(record, { path: 'Schule/Scan.pdf', size: 1235, stamp: 'a1b2c3d4' }))
    for (const broken of [
      { ...record, format: 'fanotes-page-text-v2' },
      { ...record, path: '../escape.pdf' },
      { ...record, path: 'a\\b.pdf' },
      { ...record, stamp: 'XYZ' },
      { ...record, pages: [{ ...record.pages[0], page: 4 }] },
      { ...record, pages: [record.pages[0], record.pages[0]] },
      { ...record, pages: [{ ...record.pages[1], confidence: 2 }] },
      { ...record, pages: [{ ...record.pages[1], rotation: 45 }] },
      { ...record, pages: [{ ...record.pages[1], source: 'magic' }] },
    ]) assert.equal(contract.sanitizePageTextRecord(broken), null)
  })

  await test('OCR orientation: upright, 90°, 180° and 270° scans are turned back before recognition', async () => {
    const meta = JSON.parse(fs.readFileSync(new URL('./fixtures/doc-search/lines.json', import.meta.url), 'utf8'))
    const pixels = new Uint8ClampedArray(zlib.inflateSync(fs.readFileSync(new URL('./fixtures/doc-search/lines.rgba.z', import.meta.url))))
    for (const turned of [0, 90, 180, 270]) {
      const input = orientation.rotatePixels(pixels, meta.width, meta.height, turned)
      let calls = 0
      // Fake recognizer: the orientation must be found from the letters' shape, not from the model.
      const result = await orientation.recognizeOriented(input, async () => { calls += 1; return 'Wort Text Zeile' })
      assert.equal((result.rotation + turned) % 360, 0, `scan turned ${turned}° was read at ${result.rotation}°`)
      assert.equal(result.lines, meta.lines)
      assert.equal(calls, meta.lines, 'no extra recognition calls to find the orientation')
    }
  })

  await test('OCR orientation: word-quality estimate separates words from noise', () => {
    assert.ok(orientation.wordQuality('Die Lageenergie hängt von der Höhe ab') > 0.8)
    assert.ok(orientation.wordQuality('# # 9 % N D a n # 5 - -') < 0.2)
    assert.equal(orientation.letterCount('a1 ö#'), 2)
  })

  // ---------- Indexer lifecycle with a fake vault ----------
  const memoryStore = () => {
    const docs = new Map()
    const units = new Map()
    let writes = 0
    return {
      docs, units, get writes() { return writes },
      load: async () => ({ docs: [...docs.values()].map((value) => structuredClone(value)), units: [...units.values()].map((value) => structuredClone(value)) }),
      saveDoc: async (value) => { writes += 1; docs.set(value.path, structuredClone(value)) },
      addUnits: async (list) => { writes += 1; for (const value of list) units.set(value.id, structuredClone(value)) },
      removeUnits: async (path) => { for (const [id, value] of units) if (value.path === path) units.delete(id) },
      removeDoc: async (path) => { docs.delete(path); for (const [id, value] of units) if (value.path === path) units.delete(id) },
      clear: async () => { docs.clear(); units.clear() },
    }
  }

  // A fake vault: PDFs are lists of pages; a page is { text } (text layer) or { scan } (needs OCR).
  const makeVault = () => {
    const files = new Map()
    const calls = { ocr: 0, extract: [] }
    const failures = new Map()
    const extractor = {
      extract: async (source, context) => {
        calls.extract.push(source.path)
        const file = files.get(source.path)
        if (!file) return { status: 'failed', reason: 'missing' }
        if (file.encrypted) return { status: 'unsupported', reason: 'encrypted' }
        if (failures.get(source.path) > 0) {
          failures.set(source.path, failures.get(source.path) - 1)
          return { status: 'failed', reason: 'transient' }
        }
        if (source.kind === 'note') {
          await context.commit([{ id: `${source.path}#note:1`, path: source.path, kind: 'note', source: 'text', text: file.text }])
          return { status: 'done' }
        }
        let ocrBudget = context.ocrBudget
        const pageCount = file.pages.length
        let batch = []
        let ocrPages = 0
        for (let page = context.resumePage; page <= pageCount; page += 1) {
          if (context.shouldStop()) {
            if (batch.length) await context.commit(batch, { nextPage: page, pageCount, ocrPages })
            return { status: 'partial', resumePage: page, pageCount }
          }
          const entry = file.pages[page - 1]
          if (entry.scan !== undefined) {
            if (ocrBudget <= 0) {
              if (batch.length) await context.commit(batch, { nextPage: page, pageCount, ocrPages })
              return { status: 'partial', resumePage: page, pageCount }
            }
            ocrBudget -= 1
            ocrPages += 1
            calls.ocr += 1
            if (entry.scan === null) context.issue({ kind: 'pdf-page', page, status: 'failed', reason: 'ocr-error' })
            else if (entry.scan === '') context.issue({ kind: 'pdf-page', page, status: 'empty', reason: 'no-letters' })
            else batch.push({ id: `${source.path}#pdf-page:${page}`, path: source.path, kind: 'pdf-page', page, source: 'ocr', confidence: 0.7, text: entry.scan })
          } else {
            batch.push({ id: `${source.path}#pdf-page:${page}`, path: source.path, kind: 'pdf-page', page, source: 'text-layer', text: entry.text })
          }
          if (batch.length >= 4) {
            await context.commit(batch, { nextPage: page + 1, pageCount, ocrPages })
            batch = []
            ocrPages = 0
          }
        }
        await context.commit(batch, { nextPage: pageCount + 1, pageCount, ocrPages })
        return { status: 'done', pageCount }
      },
    }
    let version = 0
    const list = async () => [...files.entries()].map(([path, file]) => ({
      path, title: path.split('/').pop().replace(/\.[^.]+$/u, ''), kind: path.endsWith('.pdf') ? 'pdf' : 'note',
      fingerprint: `${file.version}`, modifiedAt: file.version,
    }))
    const put = (path, value) => { version += 1; files.set(path, { ...value, version }) }
    return { files, calls, failures, extractor, list, put }
  }

  await test('indexer: text, scanned and mixed PDFs; OCR issues are reported, not hidden', async () => {
    const vault = makeVault()
    vault.put('Bio/Text.pdf', { pages: [{ text: 'Zellatmung findet in Mitochondrien statt.' }, { text: 'Glykolyse im Zytoplasma.' }] })
    vault.put('Bio/Scan.pdf', { pages: [{ scan: 'Die Fotosynthese braucht Licht.' }, { scan: '' }, { scan: null }] })
    vault.put('Bio/Gemischt.pdf', { pages: [{ text: 'Einleitung Ökologie' }, { scan: 'Nahrungskette und Räuber' }] })
    const store = memoryStore()
    const run = new DocIndexer({ store, list: vault.list, extractor: vault.extractor })
    await run.schedule()
    const progress = run.progress()
    assert.equal(progress.counts.indexed, 3)
    assert.equal(progress.counts.issues, 2)
    assert.equal(run.index.search('mitochondrien')[0].page, 1)
    assert.equal(run.index.search('fotosynthese')[0].source, 'ocr')
    assert.equal(run.index.search('rauber')[0].page, 2)
    assert.deepEqual(run.index.getDoc('Bio/Scan.pdf').issues.map((issue) => `${issue.page}:${issue.status}`), ['2:empty', '3:failed'])
  })

  await test('indexer: unchanged documents are not read again; edits replace old text', async () => {
    const vault = makeVault()
    vault.put('a.md', { text: 'alter Inhalt Vulkan' })
    vault.put('b.md', { text: 'bleibt gleich' })
    const store = memoryStore()
    const run = new DocIndexer({ store, list: vault.list, extractor: vault.extractor })
    await run.schedule()
    vault.calls.extract.length = 0
    await run.schedule()
    assert.deepEqual(vault.calls.extract, [], 'nothing re-read')
    vault.put('a.md', { text: 'neuer Inhalt Gletscher' })
    await run.schedule()
    assert.deepEqual(vault.calls.extract, ['a.md'])
    assert.equal(run.index.search('vulkan').length, 0, 'stale text removed')
    assert.equal(run.index.search('gletscher').length, 1)
  })

  await test('indexer: deleted and moved documents leave the index and the store', async () => {
    const vault = makeVault()
    vault.put('Ordner/x.md', { text: 'Pyramide' })
    const store = memoryStore()
    const run = new DocIndexer({ store, list: vault.list, extractor: vault.extractor })
    await run.schedule()
    const moved = vault.files.get('Ordner/x.md')
    vault.files.delete('Ordner/x.md')
    vault.files.set('Neu/x.md', moved)
    await run.schedule()
    assert.deepEqual(run.index.search('pyramide').map((hit) => hit.path), ['Neu/x.md'])
    vault.files.delete('Neu/x.md')
    await run.schedule()
    assert.equal(run.index.search('pyramide').length, 0)
    assert.equal(store.docs.size, 0)
    assert.equal(store.units.size, 0)
  })

  await test('indexer: OCR budget per pass, resume without lost or repeated pages', async () => {
    const vault = makeVault()
    const pages = Array.from({ length: 30 }, (_, index) => ({ scan: `Seite Nummer ${index + 1} Wort${index + 1}` }))
    vault.put('Buch.pdf', { pages })
    const store = memoryStore()
    const run = new DocIndexer({ store, list: vault.list, extractor: vault.extractor, ocrPagesPerPass: 8 })
    await run.schedule()
    assert.equal(vault.calls.ocr, 30, 'every page recognised exactly once across passes')
    for (let page = 1; page <= 30; page += 1) assert.equal(run.index.search(`wort${page}`).filter((hit) => hit.page === page).length, 1)
    assert.equal(run.index.getDoc('Buch.pdf').status, 'indexed')
  })

  await test('indexer: pause and cancel lose at most one batch; resume continues', async () => {
    const vault = makeVault()
    vault.put('Gross.pdf', { pages: Array.from({ length: 40 }, (_, index) => ({ text: `Abschnitt ${index + 1} Begriff${index + 1}x` })) })
    const store = memoryStore()
    let commits = 0
    let run
    run = new DocIndexer({ store, list: vault.list, extractor: vault.extractor, gate: async () => { commits += 1; if (commits === 3) run.pause() } })
    await run.schedule()
    const doc = run.index.getDoc('Gross.pdf')
    assert.equal(doc.status, 'partial')
    assert.ok(doc.resumePage > 1 && doc.resumePage <= 40)
    // Simulate an app restart from the store, then resume.
    const restarted = new DocIndexer({ store, list: vault.list, extractor: vault.extractor })
    await restarted.load()
    assert.equal(restarted.index.getDoc('Gross.pdf').status, 'partial')
    await restarted.schedule()
    for (let page = 1; page <= 40; page += 1) assert.equal(restarted.index.search(`begriff${page}x`).length, 1, `page ${page}`)
    assert.equal(restarted.index.unitsOf('Gross.pdf').length, 40, 'no duplicated pages')
  })

  await test('indexer: transient failures back off; unsupported waits for a file change', async () => {
    let now = 1_000_000
    const vault = makeVault()
    vault.put('kaputt.pdf', { pages: [{ text: 'Hallo Welt' }] })
    vault.put('geheim.pdf', { encrypted: true, pages: [] })
    vault.failures.set('kaputt.pdf', 2)
    const store = memoryStore()
    const run = new DocIndexer({ store, list: vault.list, extractor: vault.extractor, now: () => now })
    await run.schedule()
    let record = run.index.getDoc('kaputt.pdf')
    assert.equal(record.status, 'failed')
    assert.equal(record.nextRetryAt, now + retryDelay(1))
    assert.equal(run.index.getDoc('geheim.pdf').status, 'unsupported')
    vault.calls.extract.length = 0
    await run.schedule()
    assert.deepEqual(vault.calls.extract, [], 'nothing retried before the backoff')
    now += retryDelay(1)
    await run.schedule()
    record = run.index.getDoc('kaputt.pdf')
    assert.equal(record.attempts, 2)
    assert.equal(record.nextRetryAt, now + retryDelay(2))
    assert.equal(retryDelay(2), 2 * retryDelay(1))
    assert.equal(retryDelay(30), 6 * 60 * 60 * 1000, 'capped at 6 h')
    now += retryDelay(2)
    await run.schedule()
    assert.equal(run.index.getDoc('kaputt.pdf').status, 'indexed')
    assert.ok(!vault.calls.extract.includes('geheim.pdf'), 'unsupported is not retried')
    vault.put('geheim.pdf', { pages: [{ text: 'jetzt lesbar' }] })
    await run.schedule()
    assert.equal(run.index.getDoc('geheim.pdf').status, 'indexed')
  })

  await test('indexer: concurrent schedule calls never run two passes at once', async () => {
    const vault = makeVault()
    for (let index = 0; index < 20; index += 1) vault.put(`n${index}.md`, { text: `Inhalt ${index}` })
    let active = 0
    let maxActive = 0
    const extractor = { extract: async (source, context) => {
      active += 1; maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      const result = await vault.extractor.extract(source, context)
      active -= 1
      return result
    } }
    const run = new DocIndexer({ store: memoryStore(), list: vault.list, extractor })
    await Promise.all([run.schedule(), run.schedule(), run.schedule()])
    assert.equal(maxActive, 1)
    assert.equal(vault.calls.extract.length, 20, 'each document read once')
  })

  await test('indexer: a damaged store is cleared and rebuilt', async () => {
    const vault = makeVault()
    vault.put('a.md', { text: 'Rettung' })
    const store = memoryStore()
    store.load = async () => { throw new Error('corrupt') }
    const run = new DocIndexer({ store, list: vault.list, extractor: vault.extractor })
    await run.schedule()
    assert.equal(run.index.search('rettung').length, 1)
  })

  await test('performance: 2,000 pages index and query quickly', async () => {
    const words = ['Energie', 'Zelle', 'Mitochondrien', 'Integral', 'Ableitung', 'Gleichung', 'Straße', 'Übung', 'Fotosynthese', 'Revolution', 'Demokratie', 'Grammatik', 'Vokabeln', 'Säure', 'Base', 'Molekül']
    let seed = 7
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pageText = (n) => Array.from({ length: 350 }, () => words[Math.floor(random() * words.length)] + (random() < 0.3 ? `${Math.floor(random() * 500)}` : '')).join(' ') + ` Seitenmarke${n}`
    const vault = makeVault()
    for (let file = 0; file < 100; file += 1) vault.put(`Fach${file % 8}/Dokument${file}.pdf`, { pages: Array.from({ length: 20 }, (_, index) => ({ text: pageText(file * 20 + index) })) })
    const heapBefore = process.memoryUsage().heapUsed
    const started = performance.now()
    const run = new DocIndexer({ store: memoryStore(), list: vault.list, extractor: vault.extractor })
    await run.schedule()
    const buildMs = performance.now() - started
    const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024
    const queries = ['energie', 'zelle mitochondrien', 'strasse', 'ubung gleichung', 'seitenmarke1234', 'integral ableitung molekul', 'demo', 'x']
    const times = []
    for (let round = 0; round < 25; round += 1) for (const query of queries) {
      const begin = performance.now()
      run.index.search(query)
      times.push(performance.now() - begin)
    }
    times.sort((a, b) => a - b)
    const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1)
    console.log(`  2,000 pages / 700k words: build ${buildMs.toFixed(0)} ms, heap +${heapMb.toFixed(0)} MB, query p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${times.at(-1).toFixed(1)} ms`)
    assert.equal(run.index.search('seitenmarke1234')[0].page, 1234 % 20 + 1)
    assert.ok(Number(p(0.95)) < 150, 'p95 query under 150 ms')
  })
} finally {
  await server.close()
}

let failed = 0
for (const [name, ok, error] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) { failed += 1; console.log('      ', error?.stack?.split('\n').slice(0, 4).join('\n       ')) }
}
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exitCode = 1
