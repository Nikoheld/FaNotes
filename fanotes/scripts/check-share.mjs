import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Public share: one note or every note in a folder, copy versus live, stop,
// the settings page that lists the link, and the browser viewer.

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const viewerPath = fileURLToPath(new URL('../public/share/index.html', import.meta.url))
const viewerHtml = readFileSync(viewerPath, 'utf8')
const scratch = process.env.FANOTES_SHARE_SCRATCH || ''
const writeScratch = (name, text) => {
  if (scratch) writeFileSync(join(scratch, name), text)
}

if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { language: 'de-CH', languages: ['de-CH'] }
}
if (typeof globalThis.window === 'undefined') {
  const storage = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)) },
    },
    fanotes: {},
    requestAnimationFrame: (callback) => { callback(); return 0 },
    location: { origin: 'http://127.0.0.1' },
    document: { documentElement: { lang: '', dataset: {} }, querySelector: () => null },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
}
if (typeof globalThis.document === 'undefined') globalThis.document = globalThis.window.document

const recorded = []
const store = new Map()

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
})

const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/share' || url.pathname === '/share/' || url.pathname === '/share/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(viewerHtml)
    return
  }
  const match = /^\/api\/v1\/share\/([^/]+)$/u.exec(url.pathname)
  if (!match) {
    response.statusCode = 404
    response.end('missing')
    return
  }
  const id = decodeURIComponent(match[1])
  if (request.method === 'PUT') {
    const body = await readBody(request)
    recorded.push({ method: 'PUT', url: request.url, body })
    store.set(id, body)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, id }))
    return
  }
  if (request.method === 'DELETE') {
    recorded.push({ method: 'DELETE', url: request.url, body: '' })
    const current = store.get(id)
    if (current) {
      const payload = JSON.parse(current)
      payload.stopped = true
      payload.notes = []
      store.set(id, JSON.stringify(payload))
    }
    response.setHeader('content-type', 'application/json')
    response.end('{}')
    return
  }
  if (request.method === 'GET') {
    const current = store.get(id)
    const payload = current ? JSON.parse(current) : null
    if (!payload || payload.stopped) {
      response.statusCode = 410
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ stopped: true, notes: [] }))
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(current)
    return
  }
  response.statusCode = 405
  response.end()
})

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const address = httpServer.address()
const port = typeof address === 'object' && address ? address.port : 0
const origin = `http://127.0.0.1:${port}`

const vite = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const noteText = (payload) => (payload?.notes ?? []).map((note) => `${note.title}\n${note.content}`).join('\n')

let chromium = null
let chromiumProfile = ''

try {
  const share = await vite.ssrLoadModule('/src/lib/sync/share.ts')
  const api = await vite.ssrLoadModule('/src/lib/sync/api.ts')
  const page = await vite.ssrLoadModule('/src/components/ShareSettingsPage.tsx')
  const settingsModule = await vite.ssrLoadModule('/src/components/SettingsModal.tsx')
  const defaults = await vite.ssrLoadModule('/src/defaults.ts')
  assert.equal(share.SHARE_API_PATH, '/api/v1/share')
  assert.notEqual(share.SHARE_API_PATH, api.SYNC_API_PATH)
  assert.equal(page.shareStopControl, share.stopShare)

  const sharePort = share.createFetchSharePort()
  const oneEntries = await share.loadShareEntries(
    [{ relativePath: 'Hallo.md', kind: 'file', extension: 'md' }],
    async () => '# Hallo\n\nGuten Tag aus der Notiz',
  )
  const note = await share.publishShare({
    entries: oneEntries,
    rootPath: 'Hallo.md',
    mode: 'copy',
    port: sharePort,
    origin,
    now: '2026-10-26T12:00:00.000Z',
  })
  assert.ok(note.record.link.length > 0, 'share link is empty')
  assert.match(note.record.link, /\/share\/\?id=/u)
  assert.equal(recorded.at(-1).body, note.request.body)
  assert.match(note.request.body, /Guten Tag aus der Notiz/)
  assert.match(note.request.url, /\/api\/v1\/share\//u)
  assert.doesNotMatch(note.request.url, /\/api\/v1\/sync/u)
  const noteRead = await share.readShare({ id: note.record.id, port: sharePort, origin, entries: oneEntries })
  assert.match(noteText(noteRead), /Hallo/)
  assert.match(noteText(noteRead), /Guten Tag aus der Notiz/)

  const folderEntries = await share.loadShareEntries([
    {
      relativePath: 'Schule',
      kind: 'folder',
      children: [{
        relativePath: 'Schule/Mathe',
        kind: 'folder',
        children: [
          { relativePath: 'Schule/Mathe/Aufgabe.md', kind: 'file', extension: 'md' },
          {
            relativePath: 'Schule/Mathe/Uebung',
            kind: 'folder',
            children: [{ relativePath: 'Schule/Mathe/Uebung/Blatt.md', kind: 'file', extension: 'md' }],
          },
        ],
      }],
    },
    { relativePath: 'Schule/Mathe-Extra', kind: 'folder', children: [{ relativePath: 'Schule/Mathe-Extra/Neben.md', kind: 'file', extension: 'md' }] },
    { relativePath: 'Andere.md', kind: 'file', extension: 'md' },
  ], async (path) => ({
    'Schule/Mathe/Aufgabe.md': '# Aufgabe\n\nIntegral von x',
    'Schule/Mathe/Uebung/Blatt.md': '# Blatt\n\nVerschachtelte Uebung',
    'Schule/Mathe-Extra/Neben.md': '# Neben\n\nNICHT-TEILEN-AUSSEN',
    'Andere.md': '# Andere\n\nAUSSEN-NOTIZ',
  })[path])
  const folder = await share.publishShare({
    entries: folderEntries,
    rootPath: 'Schule/Mathe',
    mode: 'copy',
    port: sharePort,
    origin,
    now: '2026-10-26T12:01:00.000Z',
  })
  assert.match(folder.request.body, /Integral von x/)
  assert.match(folder.request.body, /Verschachtelte Uebung/)
  assert.doesNotMatch(folder.request.body, /NICHT-TEILEN-AUSSEN/)
  assert.doesNotMatch(folder.request.body, /AUSSEN-NOTIZ/)
  const folderRead = await share.readShare({ id: folder.record.id, port: sharePort, origin, entries: folderEntries })
  assert.equal(folderRead.notes.length, 2)
  assert.match(noteText(folderRead), /Integral von x/)
  assert.match(noteText(folderRead), /Verschachtelte Uebung/)
  assert.doesNotMatch(noteText(folderRead), /NICHT-TEILEN-AUSSEN/)
  assert.doesNotMatch(noteText(folderRead), /AUSSEN-NOTIZ/)

  const original = [{ path: 'Tagebuch.md', kind: 'file', content: '# Tagebuch\n\nErster Satz' }]
  const edited = [{ path: 'Tagebuch.md', kind: 'file', content: '# Tagebuch\n\nSpaeter geaendert' }]
  const copy = await share.publishShare({ entries: original, rootPath: 'Tagebuch.md', mode: 'copy', port: sharePort, origin })
  const copyRead = await share.readShare({ id: copy.record.id, port: sharePort, origin, entries: edited })
  assert.match(noteText(copyRead), /Erster Satz/)
  assert.doesNotMatch(noteText(copyRead), /Spaeter geaendert/)
  const live = await share.publishShare({ entries: original, rootPath: 'Tagebuch.md', mode: 'live', port: sharePort, origin })
  const liveRead = await share.readShare({ id: live.record.id, port: sharePort, origin, entries: edited })
  assert.match(noteText(liveRead), /Spaeter geaendert/)
  await share.refreshLiveShares({ entries: edited, directory: live.directory, port: sharePort, origin, now: '2026-10-26T12:02:00.000Z' })
  const liveStored = await share.readShare({ id: live.record.id, port: sharePort, origin })
  assert.match(noteText(liveStored), /Spaeter geaendert/)
  const copyStored = await share.readShare({ id: copy.record.id, port: sharePort, origin })
  assert.match(noteText(copyStored), /Erster Satz/)
  assert.doesNotMatch(noteText(copyStored), /Spaeter geaendert/)

  const settings = {
    ...defaults.defaultSettingsForPlatform('linux'),
    shareMode: 'copy',
    shareRecent: share.serializeShareDirectory(note.directory),
  }
  const html = renderToStaticMarkup(createElement(settingsModule.SettingsModal, {
    platform: 'linux',
    settings,
    vaultPath: '/vault',
    initialSection: 'share',
    onChange: () => undefined,
    onClose: () => undefined,
    onSelectVault: () => undefined,
    updateState: {
      status: 'idle',
      supported: true,
      currentVersion: '0',
      latestVersion: null,
      publishedAt: null,
      releaseNotes: [],
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      error: null,
      block: null,
      checkedAt: null,
      installationKind: 'appimage',
      autoCheckUpdates: false,
      autoDownloadUpdates: false,
      installUpdatesOnQuit: false,
      updateChannel: 'stable',
    },
    onCheckUpdate: async () => undefined,
    onDownloadUpdate: async () => undefined,
    onInstallUpdate: async () => undefined,
    onResetSettings: () => undefined,
    onResetAppData: async () => undefined,
  }))
  const nav = html.slice(html.indexOf('aria-label="Einstellungsbereiche"'), html.indexOf('reset-settings'))
  const groups = [...nav.matchAll(/<div class="settings-nav-group"><small>([^<]+)<\/small>/gu)].map((match) => match[1].replaceAll('&amp;', '&'))
  const sections = [...nav.matchAll(/<span><b>[^<]+<\/b>/gu)].length
  const placeholder = html.match(/placeholder="([^"]+)"/u)?.[1] ?? ''
  assert.deepEqual(groups, ['Aussehen & Schreiben', 'Stift & Arbeitsbereich', 'FaNotes & System'])
  assert.equal(sections, 11)
  assert.equal(placeholder, 'Einstellungen suchen')
  assert.match(html, /id="settings-share"/u)
  assert.doesNotMatch(html, /id="settings-editor"/u)
  assert.match(html, /<b>Hallo<\/b>/u)
  assert.match(html, new RegExp(`data-share-stop="${note.record.id}"`, 'u'))
  const settingsLog = [
    `groups ${groups.join('|')}`,
    `sections ${sections}`,
    `searchPlaceholder ${placeholder}`,
    `listed Hallo`,
    `stopControl shareStopControl`,
    `shareId ${note.record.id}`,
  ].join('\n')
  writeScratch('share-settings.log', `${settingsLog}\nshare-settings ok\n`)
  console.log(settingsLog)

  const viewed = await openViewer(note.record.link, 'Guten Tag aus der Notiz')
  if (viewed.launched) {
    assert.equal(viewed.errors.length, 0, `page errors: ${viewed.errors.join(' | ')}`)
    assert.match(viewed.text, /Hallo/)
    assert.match(viewed.text, /Guten Tag aus der Notiz/)
    if (scratch && viewed.screenshot) writeFileSync(join(scratch, 'share-view.png'), viewed.screenshot)
  }

  const stopped = await page.shareStopControl({ id: note.record.id, port: sharePort, origin, directory: note.directory })
  assert.equal(stopped.shares.find((item) => item.id === note.record.id)?.stopped, true)
  assert.ok(recorded.some((request) => request.method === 'DELETE' && request.url.includes(note.record.id)))
  const afterStop = await share.readShare({ id: note.record.id, port: sharePort, origin, entries: oneEntries })
  assert.equal(afterStop, null)

  if (viewed.launched) {
    const stoppedView = await reloadViewer(viewed, 'Diese Freigabe wurde beendet.')
    assert.equal(stoppedView.errors.length, 0, `stopped page errors: ${stoppedView.errors.join(' | ')}`)
    assert.match(stoppedView.text, /Diese Freigabe wurde beendet/)
    assert.doesNotMatch(stoppedView.text, /Guten Tag aus der Notiz/)
    assert.doesNotMatch(stoppedView.text, /Hallo/)
  }

  const hostLog = await probeHost(share)
  writeScratch('share-host.log', hostLog)
  console.log(hostLog.trim())
  console.log(JSON.stringify({
    link: note.record.link,
    folderNotes: folderRead.notes.map((item) => item.path),
    copyKeepsOriginal: true,
    liveShowsEdit: true,
    stopped: true,
    settingsSections: sections,
    placeholder,
    viewer: viewed.launched ? 'shown' : 'launch-failed',
  }))
  console.log('share-check ok')
  if (viewed?.socket) viewed.socket.close()
} finally {
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500)
      chromium.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  if (chromiumProfile) rmSync(chromiumProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await vite.close()
  httpServer.close()
}

async function probeHost(share) {
  try {
    const hostPort = share.createFetchSharePort((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }))
    const result = await share.publishShare({
      entries: [{ path: 'Freigabe-Probe.md', kind: 'file', content: '# Probe\n\nFreigabe-Probe' }],
      rootPath: 'Freigabe-Probe.md',
      mode: 'copy',
      port: hostPort,
    })
    return `status 200\nlink ${result.record.link}\n`
  } catch (error) {
    return `error ${error instanceof Error ? error.message : String(error)}\n`
  }
}

function createCdp(socket, errors) {
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'exception')
    }
    if (!message.id || !pending.has(message.id)) return
    const callback = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    evaluate(expression) {
      return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((result) => {
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
        return result.result.value
      })
    },
  }
}

class LaunchError extends Error {}

async function openViewer(link, expected) {
  const errors = []
  try {
    const debugPort = 23000 + Math.floor(Math.random() * 10000)
    chromiumProfile = mkdtempSync(join(tmpdir(), 'fanotes-share-chrome-'))
    chromium = spawn('/usr/bin/chromium', [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1280,800',
      `--user-data-dir=${chromiumProfile}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let socket
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (chromium.exitCode !== null) throw new LaunchError(`Chromium exited ${chromium.exitCode}`)
      try {
        const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
        const page = pages.find((candidate) => candidate.type === 'page')
        if (page?.webSocketDebuggerUrl) {
          socket = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true })
            socket.addEventListener('error', reject, { once: true })
          })
          break
        }
      } catch { /* still booting */ }
      await wait(80)
    }
    if (!socket) throw new LaunchError('Chromium debugging did not become available.')
    const cdp = createCdp(socket, errors)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: link })
    const text = await waitForText(cdp, expected)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    return { launched: true, link, text, errors, screenshot: Buffer.from(shot.data, 'base64'), cdp, socket }
  } catch (error) {
    if (error instanceof LaunchError || (error instanceof Error && /Chromium|ECONNREFUSED|debugging/u.test(error.message))) {
      const message = error instanceof Error ? error.message : String(error)
      writeScratch('share-view-launch.txt', `${message}\n`)
      console.log(`share-view launch failed: ${message}`)
      return { launched: false, text: '', errors, screenshot: null, cdp: null, socket: null }
    }
    throw error
  }
}

async function reloadViewer(viewed, expected) {
  viewed.errors.length = 0
  await viewed.cdp.send('Page.navigate', { url: viewed.link })
  const text = await waitForText(viewed.cdp, expected)
  return { text, errors: viewed.errors }
}

async function waitForText(cdp, expected) {
  const deadline = Date.now() + 8000
  let text = ''
  while (Date.now() < deadline) {
    text = await cdp.evaluate('document.body ? document.body.innerText : ""')
    if (text.includes(expected)) return text
    await wait(80)
  }
  throw new Error(`Viewer did not show «${expected}». Page text: ${text.slice(0, 500)}`)
}
