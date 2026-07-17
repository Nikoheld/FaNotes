import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createAnalyticsService } from '../analytics.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fanotes-analytics-check-'))

const request = (body, { country = 'CH', address = '203.0.113.42', origin = 'https://fanotes.fasrv.ch' } = {}) => {
  const encoded = Buffer.from(JSON.stringify(body))
  const stream = Readable.from([encoded])
  stream.method = 'POST'
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(encoded.length),
    'cf-ipcountry': country,
    'x-real-ip': address,
    origin,
  }
  return stream
}

try {
  const analytics = await createAnalyticsService({ directory: temporary })
  await analytics.recordPublicEvent(request({ type: 'website_view' }))
  await analytics.recordPublicEvent(request({ type: 'web_app_open' }, { country: 'DE' }))
  await analytics.recordPublicEvent(request({ type: 'desktop_app_open', platform: 'windows', version: '2.32.0' }, { country: 'US' }))
  await analytics.recordDownload({ method: 'GET', headers: { 'cf-ipcountry': 'CH', 'x-real-ip': '198.51.100.7' }, socket: {} }, { artifact: 'windows-installer', version: '2.32.0' })

  const summary = await analytics.summary()
  assert.deepEqual(summary.totals, { websiteViews: 1, webAppOpens: 1, desktopAppOpens: 1, downloads: 1 })
  assert.equal(summary.countries.find(({ country }) => country === 'CH')?.downloads, 1)
  assert.equal(summary.countries.find(({ country }) => country === 'US')?.desktopAppOpens, 1)
  assert.equal(summary.downloadsByArtifact['windows-installer'], 1)
  assert.equal(summary.appOpensByPlatform.windows, 1)
  assert.equal(summary.appOpensByVersion['2.32.0'], 1)
  assert.deepEqual(summary.privacy, { storesIpAddresses: false, storesDeviceIdentifiers: false, storesRawEvents: false, aggregation: 'daily' })

  const stored = await fs.readFile(path.join(temporary, 'aggregates.json'), 'utf8')
  assert.doesNotMatch(stored, /203\.0\.113\.42|198\.51\.100\.7|User-Agent|desktop_app_open/u)
  await assert.rejects(
    analytics.recordPublicEvent(request({ type: 'website_view' }, { origin: 'https://attacker.example' })),
    /Herkunft/u,
  )

  const homepageScript = await fs.readFile(path.join(root, 'public/fanotes-site.js'), 'utf8')
  const dashboard = await fs.readFile(path.join(root, 'public/stats/index.html'), 'utf8')
  assert.match(homepageScript, /website_view/u)
  assert.match(dashboard, /noindex,nofollow,noarchive/u)
  assert.doesNotMatch(dashboard, /https?:\/\/(?!fanotes\.fasrv\.ch)/u)

  console.log('Anonyme Statistikprüfung erfolgreich: Tagesaggregation, Länder, Downloads, Desktop/Web-Starts, Datenschutz und Herkunftsschutz.')
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
