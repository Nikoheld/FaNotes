// Class and room timetables: parser (synthetic text), storage, the real poppler/qpdf pipeline
// on a synthetic PDF, and the HTTP routes. All data is synthetic.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const syncDir = await mkdtemp(join(tmpdir(), 'timetables-sync-'))
process.env.FANOTES_SYNC_DIR = syncDir

const { handleSyncRequest } = await import('./sync-api.mjs')
const { createSchulnetzRuntime } = await import('./schulnetz-api.mjs')
const { createKantiWebApi, createKantiWebAppRoutes, createKantiWebStore } = await import('./kanti-web-api.mjs')
const { CLASS_CODE, createClassTimetables, expandClassList, expandClassListInfo, isAksaBase, parseTimetableBbox } = await import('./class-timetables.mjs')
const { buildBboxXhtml, buildPdf, SYNTHETIC_PAGES } = await import('./test-fixtures/synthetic-timetable-pdf.mjs')

const have = (tool) => { try { execFileSync(tool, ['-v'], { stdio: 'ignore' }); return true } catch (error) { return error?.code !== 'ENOENT' } }
const entryText = (slot) => slot.entries.map((e) => `${e.subject}|${e.teacher}|${e.room}|${e.footnote}`).join(';')
const slotOf = (cls, day, start) => cls.slots.find((s) => s.day === day && s.start === start)
const BBOX = buildBboxXhtml(SYNTHETIC_PAGES)

test('parser places centred single and double lessons, stacks and side-by-side entries by coordinates', () => {
  const parsed = parseTimetableBbox(BBOX)
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.semester, 'SJ 2026-27')
  assert.deepEqual(parsed.classes.map((c) => [c.code, c.teacher, c.page]), [['G26A', 'Anna Muster', 1], ['G26D', 'Peter Probe', 2], ['I26B', 'Eva Beispiel', 3]])
  const a = parsed.classes[0]
  assert.equal(a.slots.length, 8)
  // Double lesson (centred between two labels) with two stacked half-class entries and a marker on the first.
  assert.deepEqual(slotOf(a, 1, '07:45'), { day: 1, start: '07:45', end: '09:20', entries: [
    { subject: 'spf', teacher: 'BauAn', room: 'Telli', footnote: '1' },
    { subject: 'spm', teacher: 'SolSi', room: 'Telli', footnote: '' },
  ] })
  // Six lines centred on one label stay a single lesson (45 minutes); subjects may contain a space.
  assert.equal(slotOf(a, 1, '10:30').end, '11:15')
  assert.equal(entryText(slotOf(a, 1, '10:30')), 'Amos 1.2|GreTo|036|2;Amos 1.1|SanAn|025|')
  assert.equal(entryText(slotOf(a, 2, '07:45')), 'abt|KapCh|228|')
  assert.equal(slotOf(a, 2, '08:35'), undefined)
  assert.equal(slotOf(a, 2, '12:15').end, '13:50')
  // Side by side entries stay separate, left to right; three of them fit one lesson.
  assert.equal(entryText(slotOf(a, 4, '07:45')), 'eng-Sem2|KapCh|227|;Heng-Sem1|KapCh|227|')
  assert.equal(entryText(slotOf(a, 4, '09:30')), 'deu|PfeMa|516|;fra|ZimJu|507|;wir|LauMi|035|')
  // An entry without teacher and room keeps its marker; entities in the XHTML are decoded.
  assert.equal(entryText(slotOf(a, 5, '12:15')), 'sit|||3')
  assert.equal(entryText(slotOf(a, 3, '14:00')), 'B&W|HugTi|T49|')
  assert.equal(a.slots.every((slot) => slot.entries.length > 0), true)
  assert.equal(parsed.classes[1].slots.find((slot) => slot.day === 2 && slot.start === '13:05').end, '14:45')
  assert.equal(parsed.classes[2].slots.length, 2)
})

test('parser reads the footnote table in three column groups with continuations and compressed class lists', () => {
  const parsed = parseTimetableBbox(BBOX)
  const rows = parsed.footnotes.map((f) => [f.page, f.nr, f.teacher, f.subject, f.room, f.classes.join(','), Boolean(f.classesTruncated)])
  assert.deepEqual(rows.slice(0, 5), [
    [1, '1', 'BauAn', 'spf', 'Telli', 'G26A', false],
    [1, '1', 'SolSi', 'spm', 'Telli', 'G26A,G26B,G26I', false],
    [1, '2', 'GreTo', 'Amos 1.2', '036', 'G26A,G26B,G26K', false],
    [1, '2', 'SanAn', 'Amos 1.1', '025', 'G26A,G26B,G26K', false],
    [1, '3', '', 'sit', '', 'G23D,G23L,G24B,G24D,G24E,G24K,G24L,G25B,G25K,G25L,G26A', true],
  ])
  assert.deepEqual(rows.slice(5).map((row) => row.slice(0, 3)), [[2, '1', 'BauAn'], [2, '2', 'LanFr'], [2, '2', 'RotEv']])
  assert.deepEqual(parsed.footnotes[6].classes, ['G26D', 'G26E'])
  assert.equal('classesTruncated' in parsed.footnotes[0], false)
})

test('rooms merge the same lesson across class pages and add footnote classes at the marker slot', () => {
  const parsed = parseTimetableBbox(BBOX)
  // spf/BauAn/Telli: G26A page (double lesson, marker 1 lists G26A) and G26D page (a different slot).
  assert.deepEqual(parsed.rooms.Telli.filter((e) => e.day === 1), [
    { day: 1, start: '07:45', end: '09:20', subject: 'spf', teacher: 'BauAn', class: 'G26A' },
    { day: 1, start: '07:45', end: '09:20', subject: 'spm', teacher: 'SolSi', class: 'G26A' },
    { day: 1, start: '07:45', end: '09:20', subject: 'spm', teacher: 'SolSi', class: 'G26B' },
    { day: 1, start: '07:45', end: '09:20', subject: 'spm', teacher: 'SolSi', class: 'G26I' },
  ])
  assert.deepEqual(parsed.rooms.Telli.filter((e) => e.day === 2).map((e) => [e.start, e.end, e.class]), [['13:05', '14:45', 'G26D']])
  // Footnote 2 (marker on Monday 10:30) puts the half classes of G26B and G26K into rooms 036 and 025 too.
  assert.deepEqual(parsed.rooms['036'].map((e) => [e.subject, e.class]), [['Amos 1.2', 'G26A'], ['Amos 1.2', 'G26B'], ['Amos 1.2', 'G26K']])
  assert.deepEqual(parsed.rooms.Wed_A.map((e) => [e.day, e.start, e.end, e.class]), [[5, '11:25', '12:10', 'G26D']])
  assert.deepEqual(Object.keys(parsed.rooms).sort(), ['025', '035', '036', '207', '212', '227', '228', '305', '505', '507', '516', 'T49', 'Telli', 'Wed_A'])
  // The same lesson in two pages is listed once per class.
  const twice = parseTimetableBbox(buildBboxXhtml([SYNTHETIC_PAGES[0], { ...SYNTHETIC_PAGES[0], code: 'G26B', footnotes: [] }]))
  assert.equal(twice.rooms['227'].filter((e) => e.subject === 'eng-Sem2').length, 2)
  assert.equal(new Set(twice.rooms['227'].map((e) => `${e.day}${e.start}${e.subject}${e.class}`)).size, twice.rooms['227'].length)
})

test('parser warns with counts only and never throws on odd input', () => {
  for (const input of [undefined, null, '', '<page></page>', 'x'.repeat(5000), '<page width="1" height="1"><word xMin="a" yMin="1" xMax="2" yMax="3">q</word></page>']) {
    const parsed = parseTimetableBbox(input)
    assert.ok(Array.isArray(parsed.classes) && Array.isArray(parsed.warnings))
  }
  const odd = parseTimetableBbox(buildBboxXhtml([
    SYNTHETIC_PAGES[2],
    { ...SYNTHETIC_PAGES[0], code: 'G26X', omit: ['header'] },
    { ...SYNTHETIC_PAGES[0], code: 'G26Y', omit: ['code'] },
    { ...SYNTHETIC_PAGES[0], code: 'G26Z', omit: ['labels'] },
    SYNTHETIC_PAGES[2],
    // Entries far from every lesson centre are not placed; markers with no footnote row are counted.
    { code: 'G26U', teacher: 'Un Bekannt', cells: [{ day: 1, row: 11.5, tracks: [[['mat', 'KelAn', '207']]] }, { day: 2, row: 1, tracks: [[['deu', 'ZimLu', '516', '7']]] }], footnotes: [] },
  ]))
  assert.deepEqual(odd.classes.map((c) => c.code), ['I26B', 'G26U'])
  assert.deepEqual(odd.warnings, [
    '2 pages without a weekday header or time rows',
    '1 pages without a class code',
    '1 pages repeating a class',
    '1 entries not placed in a lesson',
    '1 footnote markers without a footnote row',
  ])
  assert.ok(odd.warnings.every((w) => !/deu|mat|KelAn|G26/u.test(w)))
})

test('class lists expand the compressed notation', () => {
  assert.deepEqual(expandClassList('G26A, G26BFGKL'), ['G26A', 'G26B', 'G26F', 'G26G', 'G26K', 'G26L'])
  assert.deepEqual(expandClassList('G26ADL'), ['G26A', 'G26D', 'G26L'])
  assert.deepEqual(expandClassList('G26ABI'), ['G26A', 'G26B', 'G26I'])
  assert.deepEqual(expandClassList('G23DL4B4D4E4K4L5B5K5L6A..'), ['G23D', 'G23L', 'G24B', 'G24D', 'G24E', 'G24K', 'G24L', 'G25B', 'G25K', 'G25L', 'G26A'])
  assert.deepEqual(expandClassListInfo('G23DL4B4..').truncated, true)
  assert.deepEqual(expandClassListInfo('G23DL4').classes, ['G23D', 'G23L'])
  assert.deepEqual(expandClassListInfo('G26ABI').truncated, false)
  // Other schools' prefixes, glued lists, and trailing noise.
  assert.deepEqual(expandClassList('I26AW26AC 1-6,10-19'), ['I26A', 'W26A', 'W26C'])
  // Known multi-letter classes win over single letters.
  assert.deepEqual(expandClassList('G26BFG', new Set(['G26FG'])), ['G26B', 'G26FG'])
  assert.deepEqual(expandClassList('G26FM G25S'), ['G26F', 'G26M', 'G25S'])
  assert.deepEqual(expandClassList('G26FM G25S', new Set(['G26FM'])), ['G26FM', 'G25S'])
  assert.deepEqual(expandClassList('x'), [])
  assert.ok(['G26A', 'G26FM', 'I26A', 'W25C', 'G22S'].every((code) => CLASS_CODE.test(code)))
  assert.ok(['G26', 'g26a', 'G26ABCD', 'GG26A', 'G26A/../', '../G26A'].every((code) => !CLASS_CODE.test(code)))
  assert.equal(isAksaBase('https://www.schulnetz-ag.ch/aksa'), true)
  assert.equal(isAksaBase('https://www.schulnetz-ag.ch/aksa/'), true)
  assert.equal(isAksaBase('https://www.schulnetz-ag.ch/kska'), false)
  assert.equal(isAksaBase(''), false)
})

const fakeRun = (text, calls) => async (command, args) => {
  calls.push([command, ...args])
  if (command === 'pdftotext') return { stdout: text }
  if (command === 'qpdf') await writeFile(args.at(-1), `%PDF-fake ${args[3]}`)
  if (command === 'pdftoppm') await writeFile(`${args.at(-1)}.png`, Buffer.from('png'))
  return { stdout: '' }
}
const PDF = Buffer.from('%PDF-1.4\nsynthetic\n')

test('ingest stores a version, switches the pointer, keeps three versions and rejects bad input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'timetables-'))
  try {
    const text = BBOX
    const calls = []
    let tick = 0
    const store = createClassTimetables({ root, run: fakeRun(text, calls), log: () => {}, now: () => new Date(Date.UTC(2026, 10, 11, 8, 0, tick++)) })
    assert.deepEqual(await store.summary(), { available: false })
    assert.equal(await store.classPdf('G26A'), null)

    const result = await store.ingest(PDF)
    assert.deepEqual([result.classes, result.rooms, result.warnings], [3, 14, []])
    // No shell, arguments only; the page number selects the page.
    assert.deepEqual(calls.find((c) => c[0] === 'pdftotext').slice(0, 2), ['pdftotext', '-bbox-layout'])
    assert.ok(calls.some((c) => c[0] === 'qpdf' && c.includes('--empty') && c.includes('--pages') && c[4] === '2'))
    assert.ok(calls.some((c) => c[0] === 'pdftoppm' && c.includes('-r') && c.includes('110') && c.includes('-singlefile')))

    const summary = await store.summary()
    assert.equal(summary.available, true)
    assert.deepEqual(summary.classes.map((c) => c.code), ['G26A', 'G26D', 'I26B'])
    assert.ok(summary.rooms.includes('Telli') && !('warnings' in summary))
    assert.equal((await store.classPdf('G26D')).toString().startsWith('%PDF-fake 2'), true)
    assert.equal((await store.classPng('G26D')).toString(), 'png')
    assert.equal(await store.classPdf('G26Z'), null)
    assert.equal(await store.classPdf('../etc/passwd'), null)
    assert.equal((await store.room('Telli')).entries.length > 0, true)
    assert.equal(await store.room('Nowhere'), null)
    assert.equal(await store.room('../x'), null)
    assert.equal(await store.room('__proto__'), null)

    for (let n = 0; n < 4; n += 1) await store.ingest(PDF)
    const versions = (await readdir(store.root)).filter((name) => /^\d{8}T/u.test(name))
    assert.equal(versions.length, 3)
    const pointer = JSON.parse(await readFile(join(store.root, 'current.json'), 'utf8'))
    assert.ok(versions.includes(pointer.version))
    assert.deepEqual((await readdir(store.root)).filter((name) => name.endsWith('.tmp')), [])

    // Bad uploads leave the current version alone and leave no directory behind.
    const before = (await readdir(store.root)).sort()
    await assert.rejects(store.ingest(Buffer.from('not a pdf at all')), { status: 400 })
    await assert.rejects(store.ingest(Buffer.alloc(25 * 1024 * 1024 + 1, 1)), { status: 413 })
    const manyPages = createClassTimetables({ root, log: () => {}, run: fakeRun('<page></page>'.repeat(201), []) })
    await assert.rejects(manyPages.ingest(PDF), { status: 413 })
    const noClasses = createClassTimetables({ root, log: () => {}, run: fakeRun('nothing here\f', []) })
    await assert.rejects(noClasses.ingest(PDF), { status: 422 })
    const broken = createClassTimetables({ root, log: () => {}, run: async (command) => { if (command === 'qpdf') throw new Error('boom'); return { stdout: text } } })
    await assert.rejects(broken.ingest(PDF), { status: 422 })
    assert.deepEqual((await readdir(store.root)).sort(), before)
    assert.equal((await store.summary()).available, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const poppler = have('pdftotext') && have('qpdf') && have('pdftoppm') && have('pdfseparate')
test('real pipeline on a synthetic PDF: pdftotext, qpdf split, pdftoppm PNG', { skip: poppler ? false : 'poppler-utils and qpdf are not installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'timetables-real-'))
  try {
    const store = createClassTimetables({ root, log: () => {} })
    const result = await store.ingest(buildPdf(SYNTHETIC_PAGES))
    assert.equal(result.classes, 3)
    assert.deepEqual(result.warnings, [])
    const pdf = await store.classPdf('G26D')
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    const png = await store.classPng('G26D')
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    const split = join(root, 'check.pdf')
    await writeFile(split, pdf)
    assert.match(execFileSync('pdfinfo', [split], { encoding: 'utf8' }), /Pages:\s+1\b/u)
    assert.match(execFileSync('pdftotext', ['-bbox-layout', split, '-'], { encoding: 'utf8' }), /G26D/u)
    const room = await store.room('Telli')
    assert.ok(room.entries.some((e) => e.class === 'G26D' && e.subject === 'spf'))
    // The real poppler output parses to the same rooms as the coordinate fixture.
    const expected = parseTimetableBbox(BBOX).rooms
    for (const name of ['Telli', '036', 'Wed_A', '227']) assert.deepEqual((await store.room(name)).entries, expected[name], name)
    assert.deepEqual((await store.summary()).rooms.length, Object.keys(expected).length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── HTTP: admin upload and serving ─────────────────────────────────────────

const WEB = 'schulnetz.fasrv.ch'
const ORIGIN = `https://${WEB}`
const TOKEN = 'synthetic-admin-token-0123456789'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const DEVICE = '0123456789abcdef01234567'

const startServer = async ({ adminHash = sha(TOKEN) } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'timetables-http-'))
  const text = BBOX
  const timetables = createClassTimetables({ root, log: () => {}, run: fakeRun(text, []) })
  const store = createKantiWebStore({ root })
  const schulnetz = createSchulnetzRuntime({
    root, key: randomBytes(32), autostart: false, log: () => {}, fetch: async () => { throw new Error('no network') },
    fcmSend: async () => ({ status: 200 }), web: createKantiWebAppRoutes(store), timetables,
  })
  const web = createKantiWebApi({ store, access: schulnetz.webAccess, hosts: [WEB], log: () => {}, timetables, readAdminHash: async () => adminHash })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await handleSyncRequest(request, response, url)) return
    if (await schulnetz.handle(request, response, url)) return
    if (await web.handle(request, response, url)) return
    response.writeHead(404).end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: async () => { await new Promise((done) => server.close(done)); await rm(root, { recursive: true, force: true }) } }
}

const admin = (base, method, { token = TOKEN, origin = ORIGIN, type = 'application/pdf', body, ip } = {}) => fetch(`${base}/api/v1/kanti-web/admin/timetable-pdf`, {
  method,
  headers: { 'X-Forwarded-Host': WEB, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { Origin: origin, 'Content-Type': type } : {}), ...(ip ? { 'X-Real-IP': ip } : {}) },
  body: method === 'POST' ? (body ?? PDF) : undefined,
})

const guest = async (base, baseUrl) => {
  const created = await (await fetch(`${base}/api/v1/schulnetz/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
  const call = (path) => fetch(`${base}/api/v1/schulnetz${path}`, { headers: { 'X-Kanti-Guest': created.accountId, Authorization: `Bearer ${created.token}` } })
  const linked = await fetch(`${base}/api/v1/schulnetz/link`, {
    method: 'PUT',
    headers: { 'X-Kanti-Guest': created.accountId, Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'web', baseUrl, deviceId: DEVICE, userAgent: 'KantiTest', ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic' } }),
  })
  assert.equal(linked.status, 200)
  return { ...created, call }
}

const pairedBrowser = async (base, app) => {
  const jar = {}
  const call = async (method, path, body) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
    const response = await fetch(`${base}/api/v1/kanti-web${path}`, {
      method,
      headers: { 'X-Forwarded-Host': WEB, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      jar[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1)
    }
    return response
  }
  const started = await (await call('POST', '/pair')).json()
  const joined = await fetch(`${base}/api/v1/schulnetz/web-pair`, {
    method: 'POST',
    headers: { 'X-Kanti-Guest': app.accountId, Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: started.code, label: 'Test', finish: true }),
  })
  assert.equal(joined.status, 200)
  assert.equal((await (await call('GET', '/pair')).json()).status, 'approved')
  const session = await (await call('GET', '/session')).json()
  return { call, id: session.connections[0].id }
}

test('admin route: token hash, origin, content type, rate limit, upload and index', async () => {
  const env = await startServer()
  try {
    assert.equal((await admin(env.base, 'POST', { token: '' })).status, 401)
    assert.equal((await admin(env.base, 'POST', { origin: 'https://evil.example' })).status, 403)
    assert.equal((await admin(env.base, 'POST', { type: 'application/json' })).status, 415)
    assert.equal((await admin(env.base, 'GET', { token: 'wrong' })).status, 401)
    assert.equal((await admin(env.base, 'GET')).status, 200)
    assert.deepEqual(await (await admin(env.base, 'GET')).json(), { available: false })
    assert.equal((await admin(env.base, 'POST', { body: Buffer.from('nope, not a pdf') })).status, 400)
    const ok = await admin(env.base, 'POST')
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.deepEqual([body.classes, body.rooms, body.warnings], [3, 14, []])
    const index = await (await admin(env.base, 'GET')).json()
    assert.equal(index.available, true)
    assert.equal(index.classes.length, 3)
    assert.equal((await admin(env.base, 'DELETE', {})).status, 405)
    // Ten wrong tokens from one address, then even the right one is refused (429); another address is not.
    for (let n = 0; n < 10; n += 1) assert.equal((await admin(env.base, 'GET', { token: `bad${n}`, ip: '203.0.113.9' })).status, 401)
    assert.equal((await admin(env.base, 'GET', { ip: '203.0.113.9' })).status, 429)
    assert.equal((await admin(env.base, 'GET', { ip: '203.0.113.10' })).status, 200)
  } finally {
    await env.close()
  }
})

test('admin route answers 503 without a configured token hash', async () => {
  for (const adminHash of [null, '', 'not-hex']) {
    const env = await startServer({ adminHash })
    try {
      assert.equal((await admin(env.base, 'GET')).status, 503)
      assert.equal((await admin(env.base, 'POST')).status, 503)
    } finally {
      await env.close()
    }
  }
})

test('timetables are served only to Alte Kanti identities, in the app and in the browser', async () => {
  const env = await startServer()
  try {
    const aksa = await guest(env.base, 'https://www.schulnetz-ag.ch/aksa')
    const other = await guest(env.base, 'https://www.schulnetz-ag.ch/kska')
    // Nothing uploaded yet.
    assert.deepEqual(await (await aksa.call('/timetables')).json(), { available: false })
    assert.equal((await aksa.call('/timetables/class/G26D.pdf')).status, 404)
    assert.equal((await admin(env.base, 'POST')).status, 200)

    const summary = await (await aksa.call('/timetables')).json()
    assert.equal(summary.available, true)
    assert.deepEqual(summary.classes.map((c) => c.code), ['G26A', 'G26D', 'I26B'])
    const pdf = await aksa.call('/timetables/class/G26D.pdf')
    assert.equal(pdf.status, 200)
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.equal(pdf.headers.get('cache-control'), 'private, max-age=3600')
    assert.equal((await aksa.call('/timetables/class/G26Z.pdf')).status, 404)
    assert.equal((await aksa.call('/timetables/class/..%2F..%2Fcurrent.json')).status, 404)
    assert.equal((await aksa.call('/timetables/class/G26D')).status, 404)
    const room = await (await aksa.call('/timetables/room/Telli')).json()
    assert.equal(room.room, 'Telli')
    assert.ok(room.entries.length > 1)
    assert.equal((await aksa.call('/timetables/room/..%2Fx')).status, 404)
    assert.equal((await aksa.call('/timetables/room/Unknown')).status, 404)

    // Another school: the summary says "nothing here" (no error for the page), the files stay 404.
    const otherSummary = await other.call('/timetables')
    assert.equal(otherSummary.status, 200)
    assert.deepEqual(await otherSummary.json(), { available: false })
    for (const path of ['/timetables/class/G26D.pdf', '/timetables/room/Telli']) assert.equal((await other.call(path)).status, 404, path)

    const browser = await pairedBrowser(env.base, aksa)
    const web = await (await browser.call('GET', `/connections/${browser.id}/timetables`)).json()
    assert.equal(web.available, true)
    const png = await browser.call('GET', `/connections/${browser.id}/timetables/class/G26D.png`)
    assert.equal(png.status, 200)
    assert.equal(png.headers.get('content-type'), 'image/png')
    assert.equal((await browser.call('GET', `/connections/${browser.id}/timetables/class/G26D.pdf`)).status, 404)
    assert.equal((await (await browser.call('GET', `/connections/${browser.id}/timetables/room/Wed_A`)).json()).room, 'Wed_A')
    assert.equal((await browser.call('GET', `/connections/${browser.id}/timetables/room/..%2Fx`)).status, 404)

    const otherBrowser = await pairedBrowser(env.base, other)
    const otherWeb = await otherBrowser.call('GET', `/connections/${otherBrowser.id}/timetables`)
    assert.equal(otherWeb.status, 200)
    assert.deepEqual(await otherWeb.json(), { available: false })
    assert.equal((await otherBrowser.call('GET', `/connections/${otherBrowser.id}/timetables/class/G26D.png`)).status, 404)
    // No session: no timetables.
    const anonymous = await fetch(`${env.base}/api/v1/kanti-web/connections/${browser.id}/timetables`, { headers: { 'X-Forwarded-Host': WEB } })
    assert.equal(anonymous.status, 401)
  } finally {
    await env.close()
  }
})
