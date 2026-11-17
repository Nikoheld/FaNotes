// Playwright smoke test for the "Fehler & Wünsche" panel with a mocked server (route interception).
// Usage: node scripts/check-work-requests-browser.mjs [screenshot.png]
// Env: FANOTES_PLAYWRIGHT (path to playwright-core), FANOTES_CHROMIUM (browser binary).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const playwrightPath = process.env.FANOTES_PLAYWRIGHT ?? 'playwright-core'
const { chromium } = createRequire(import.meta.url)(playwrightPath)
const screenshotPath = process.argv[2]

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ executablePath: process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu'] })

try {
  const page = await browser.newPage({ viewport: { width: 980, height: 800 } })
  const posts = []
  // Shapes follow fanotes-site/work-requests-api.mjs: epoch-ms times, `step`, `approved`, `cancelled`, `pr`.
  const requests = [{ id: 'req-1', type: 'bug', title: 'Stift springt', description: 'Beim Schreiben springt der Stift.', priority: 'normal', status: 'working', percent: 40, step: 'Fehler wird untersucht', pr: null, reason: '', approved: false, cancelled: false, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000, lastSeq: 3 }]
  const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/v1/requests**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace('/api/v1/requests', '') || '/'
    assert.equal(req.headers().authorization, 'Bearer test-token', 'session token is sent')
    if (path === '/capabilities') return route.fulfill(json({ enabled: true }))
    if (path === '/' && req.method() === 'POST') {
      const body = req.postDataJSON(); posts.push(body)
      const created = { id: 'req-2', type: body.type, title: body.title, description: body.description, priority: body.priority, status: 'queued', percent: 0, step: '', pr: null, reason: '', approved: false, cancelled: false, createdAt: 1_700_000_100_000, updatedAt: 1_700_000_100_000, lastSeq: 1 }
      requests.unshift(created)
      return route.fulfill(json({ request: created }, 201))
    }
    if (path === '/') return route.fulfill(json({ requests }))
    if (path.endsWith('/events')) return route.fulfill({ status: 502, body: 'no stream' }) // forces the polling fallback
    if (path.endsWith('/approve')) { Object.assign(requests.find((r) => r.id === 'req-1'), { status: 'merged', approved: true }); posts.push({ approve: true }); return route.fulfill(json({ ok: true })) }
    if (path.endsWith('/cancel')) { posts.push({ cancel: true }); return route.fulfill(json({ ok: true })) }
    if (path.endsWith('/messages')) { posts.push({ message: req.postDataJSON().text }); return route.fulfill(json({ ok: true })) }
    const id = path.slice(1)
    const request = requests.find((r) => r.id === id)
    return route.fulfill(request ? json({ request }) : json({ error: 'nicht gefunden' }, 404))
  })

  await page.goto(`${origin}/scripts/work-requests-harness/index.html`)
  const dialog = page.getByRole('dialog', { name: 'Fehler & Wünsche' })
  await dialog.waitFor()

  // Tab "Neu": validation then send with screenshot + logs
  const send = dialog.getByRole('button', { name: 'Anfrage senden' })
  assert.equal(await send.isDisabled(), true)
  await dialog.getByRole('radio', { name: 'Funktion' }).click()
  await dialog.getByLabel('Titel').fill('Dunkles Thema für Karteikarten')
  await dialog.getByLabel('Was soll FaNotes können?').fill('Die Karteikarten sollen im dunklen Modus lesbar sein.')
  await dialog.getByRole('button', { name: 'Screenshot anhängen' }).click()
  await dialog.getByAltText('Screenshot-Vorschau').waitFor()
  await dialog.getByLabel('Protokoll der letzten fünf Minuten anhängen').check()
  await send.click()
  await dialog.getByText('Dunkles Thema für Karteikarten').first().waitFor()
  assert.equal(posts[0].type, 'feature')
  assert.match(posts[0].screenshot, /^iVBOR/u, 'raw base64, no data: prefix')
  assert.ok(posts[0].logs === undefined || typeof posts[0].logs === 'string', 'logs are sent as text')

  // Detail of the new request is shown (queued -> cancel + message available, no approve)
  assert.equal(await dialog.getByRole('button', { name: 'Übernehmen' }).count(), 0)
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()
  await page.waitForFunction(() => true)
  assert.ok(posts.some((p) => p.cancel))

  // List with status chips, then live progress through the polling fallback
  await dialog.getByRole('button', { name: 'Zurück' }).click()
  await dialog.locator('.wr-item', { hasText: 'Stift springt' }).locator('.wr-chip', { hasText: 'In Arbeit' }).waitFor()
  await dialog.locator('.wr-item', { hasText: 'Stift springt' }).click()
  await dialog.getByText('Fehler wird untersucht').waitFor()
  const first = requests.find((r) => r.id === 'req-1')
  Object.assign(first, { step: 'Tests laufen', percent: 70, status: 'waiting_for_you' })
  first.pr = { number: 99, url: 'https://github.com/Nikoheld/FaNotes/pull/99', ci: 'success' }
  await dialog.getByText('Tests laufen').waitFor({ timeout: 9000 })
  const prLink = dialog.getByRole('link', { name: /Änderung #99 · Prüfung: bestanden/u })
  await prLink.waitFor()
  assert.equal(await prLink.getAttribute('href'), 'https://github.com/Nikoheld/FaNotes/pull/99')
  assert.equal(await dialog.getByRole('progressbar').getAttribute('aria-valuenow'), '70')
  if (screenshotPath) await page.screenshot({ path: screenshotPath })

  // Message, then approve
  await dialog.getByRole('button', { name: 'Nachricht' }).click()
  await dialog.getByLabel('Nachricht an Claude').fill('Bitte auch den Hellmodus prüfen.')
  await dialog.getByRole('button', { name: 'Senden' }).click()
  await page.waitForFunction(() => true)
  assert.ok(posts.some((p) => p.message === 'Bitte auch den Hellmodus prüfen.'))
  await dialog.getByRole('button', { name: 'Übernehmen' }).click()
  await dialog.locator('.wr-chip', { hasText: 'Übernommen' }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Übernehmen' }).count(), 0)
  console.log('work-requests-browser ok')
} finally {
  await browser.close()
  await server.close()
}
