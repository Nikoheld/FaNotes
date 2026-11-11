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
const { createClassTimetables, expandClassList, isAksaBase, parseTimetableText } = await import('./class-timetables.mjs')
const { buildPdf, SYNTHETIC_PAGES } = await import('./test-fixtures/synthetic-timetable-pdf.mjs')

const fixture = (name) => readFile(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8')
const have = (tool) => { try { execFileSync(tool, ['-v'], { stdio: 'ignore' }); return true } catch (error) { return error?.code !== 'ENOENT' } }
const entryText = (slot) => slot.entries.map((e) => `${e.subject}|${e.teacher}|${e.room}|${e.footnote}`).join(';')
const slotOf = (cls, day, start) => cls.slots.find((s) => s.day === day && s.start === start)

test('parser reads classes, teachers, cells, half classes, footnotes and rooms from layout text', async () => {
  const parsed = parseTimetableText(await fixture('synthetic-layout.txt'))
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.semester, 'SJ 2026-27')
  assert.deepEqual(parsed.classes.map((c) => [c.code, c.teacher, c.page]), [['G26A', 'ZimLu', 1], ['G26D', 'PfeMa', 2], ['G26B', 'KelAn', 3]])
  const a = parsed.classes[0]
  assert.equal(entryText(slotOf(a, 1, '07:45')), 'deu|ZimLu|516|')
  assert.equal(entryText(slotOf(a, 2, '07:45')), 'Heng-Sem1|WeiSa|Telli|')
  assert.equal(entryText(slotOf(a, 3, '10:30')), 'Heng-Sem1|WeiSa|Wed_A|;Heng-Sem2|OttPa|305|')
  assert.equal(entryText(slotOf(a, 4, '11:25')), 'Amos 1.2|BauAn|210|')
  assert.equal(entryText(slotOf(a, 2, '08:35')), 'spf|||1')
  assert.equal(a.slots.length, 8)
  assert.deepEqual(parsed.footnotes.map((f) => [f.page, f.nr, f.teacher, f.subject, f.room, f.classes.join(',')]), [
    [1, '1', 'BauAn', 'spf', 'Telli', 'G26A,G26B,G26F,G26G,G26K,G26L'],
    [2, '1', 'BauAn', 'spf', 'Telli', 'G26D'],
  ])
  // Rooms: own cells plus footnote entries for every listed class.
  const telli = parsed.rooms.Telli
  assert.ok(telli.some((e) => e.class === 'G26A' && e.day === 2 && e.start === '07:45' && e.end === '08:35' && e.subject === 'Heng-Sem1'))
  assert.deepEqual(telli.filter((e) => e.start === '08:35' && e.day === 2).map((e) => e.class), ['G26A', 'G26B', 'G26F', 'G26G', 'G26K', 'G26L'])
  assert.ok(telli.some((e) => e.class === 'G26D' && e.day === 2 && e.start === '13:05' && e.end === '14:00'))
  assert.equal(parsed.rooms['516'].length, 4)
  assert.deepEqual(Object.keys(parsed.rooms).sort(), ['207', '208', '210', '212', '305', '516', 'T49', 'Telli', 'Wed_A'])
})

test('parser assigns shifted columns to the nearest day', async () => {
  const parsed = parseTimetableText(await fixture('synthetic-layout-shifted.txt'))
  assert.deepEqual(parsed.warnings, [])
  const d = parsed.classes[0]
  assert.equal(d.code, 'G26D')
  assert.equal(entryText(slotOf(d, 2, '08:35')), 'phy|LanFr|T49|')
  assert.equal(entryText(slotOf(d, 3, '07:45')), 'Heng-Sem2|OttPa|305|')
})

test('parser never throws on odd input and counts what it skipped', async () => {
  for (const input of [undefined, null, '', '\f\f', 'x'.repeat(5000), '\u0000\u0001 G26A\nMontag Dienstag Mittwoch Donnerstag Freitag\n7:45 deu']) {
    const parsed = parseTimetableText(input)
    assert.ok(Array.isArray(parsed.classes) && Array.isArray(parsed.warnings))
  }
  const odd = parseTimetableText(await fixture('synthetic-layout-odd.txt'))
  assert.equal(odd.classes.length, 1)
  assert.equal(odd.classes[0].code, 'G26X')
  assert.equal(entryText(slotOf(odd.classes[0], 1, '07:45')), 'deu|ZimLu|516|')
  assert.ok(odd.warnings.length >= 3)
  assert.ok(odd.warnings.some((w) => w.includes('no class code')))
  // Warnings carry page numbers, never page text.
  assert.ok(odd.warnings.every((w) => /^page \d+: /u.test(w) && !w.includes('deu') && !w.includes('kaputt')))
  assert.equal(odd.footnotes.length, 1)
})

test('class lists expand compact letters and prefer known two-letter classes', () => {
  assert.deepEqual(expandClassList('G26A, G26BFGKL'), ['G26A', 'G26B', 'G26F', 'G26G', 'G26K', 'G26L'])
  assert.deepEqual(expandClassList('G26BFG', new Set(['G26FG'])), ['G26B', 'G26FG'])
  assert.deepEqual(expandClassList('G26FM G25S'), ['G26FM', 'G25S'])
  assert.deepEqual(expandClassList('x'), [])
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
    const text = await fixture('synthetic-layout.txt')
    const calls = []
    let tick = 0
    const store = createClassTimetables({ root, run: fakeRun(text, calls), log: () => {}, now: () => new Date(Date.UTC(2026, 10, 11, 8, 0, tick++)) })
    assert.deepEqual(await store.summary(), { available: false })
    assert.equal(await store.classPdf('G26A'), null)

    const result = await store.ingest(PDF)
    assert.deepEqual([result.classes, result.rooms, result.warnings], [3, 9, []])
    // No shell, arguments only; the page number selects the page.
    assert.deepEqual(calls.find((c) => c[0] === 'pdftotext').slice(0, 2), ['pdftotext', '-layout'])
    assert.ok(calls.some((c) => c[0] === 'qpdf' && c.includes('--empty') && c.includes('--pages') && c[4] === '2'))
    assert.ok(calls.some((c) => c[0] === 'pdftoppm' && c.includes('-r') && c.includes('110') && c.includes('-singlefile')))

    const summary = await store.summary()
    assert.equal(summary.available, true)
    assert.deepEqual(summary.classes.map((c) => c.code), ['G26A', 'G26B', 'G26D'])
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
    const manyPages = createClassTimetables({ root, log: () => {}, run: fakeRun('x\f'.repeat(201), []) })
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
    assert.match(execFileSync('pdftotext', ['-layout', split, '-'], { encoding: 'utf8' }), /G26D/u)
    const room = await store.room('Telli')
    assert.ok(room.entries.some((e) => e.class === 'G26D' && e.subject === 'spf'))
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
  const text = await fixture('synthetic-layout.txt')
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
    assert.deepEqual([body.classes, body.rooms, body.warnings], [3, 9, []])
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
    assert.deepEqual(summary.classes.map((c) => c.code), ['G26A', 'G26B', 'G26D'])
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

    for (const path of ['/timetables', '/timetables/class/G26D.pdf', '/timetables/room/Telli']) assert.equal((await other.call(path)).status, 404, path)

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
    assert.equal((await otherBrowser.call('GET', `/connections/${otherBrowser.id}/timetables`)).status, 404)
    assert.equal((await otherBrowser.call('GET', `/connections/${otherBrowser.id}/timetables/class/G26D.png`)).status, 404)
    // No session: no timetables.
    const anonymous = await fetch(`${env.base}/api/v1/kanti-web/connections/${browser.id}/timetables`, { headers: { 'X-Forwarded-Host': WEB } })
    assert.equal(anonymous.status, 401)
  } finally {
    await env.close()
  }
})
