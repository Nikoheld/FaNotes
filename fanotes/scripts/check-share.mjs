import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const siteRoot = fileURLToPath(new URL('../../fanotes-site/', import.meta.url))
const siteViewerPath = join(siteRoot, 'public', 'share', 'index.html')
const serverSource = readFileSync(join(siteRoot, 'server.mjs'), 'utf8')
assert.equal(readFileSync(siteViewerPath, 'utf8'), viewerHtml, 'the site must serve the shipped share viewer')
const shareRoute = serverSource.indexOf('handleShareRequest(request, response, url)')
const getGuard = serverSource.indexOf('Nur GET und HEAD sind erlaubt.')
assert.ok(shareRoute >= 0 && getGuard >= 0 && shareRoute < getGuard, 'share route must run before the GET/HEAD guard')

const serverTemp = mkdtempSync(join(tmpdir(), 'fanotes-share-server-'))
const shareDir = join(serverTemp, 'shares')
const enrollmentPath = join(serverTemp, 'enrollment-token')
mkdirSync(shareDir, { recursive: true })
writeFileSync(enrollmentPath, randomBytes(36).toString('base64url'), { mode: 0o600 })
const sitePort = 18400 + Math.floor(Math.random() * 800)
const origin = `http://127.0.0.1:${sitePort}`
let childOutput = ''
const siteServer = spawn(process.execPath, [join(siteRoot, 'server.mjs')], {
  cwd: siteRoot,
  env: {
    ...process.env,
    FANOTES_HOST: '127.0.0.1',
    FANOTES_PORT: String(sitePort),
    FANOTES_PUBLIC_ORIGIN: origin,
    FANOTES_SHARE_DIR: shareDir,
    FANOTES_BACKUP_DIR: join(serverTemp, 'backups'),
    FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH: enrollmentPath,
    FANOTES_ANALYTICS_DIR: join(serverTemp, 'analytics'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
siteServer.stdout.on('data', (chunk) => { childOutput += chunk })
siteServer.stderr.on('data', (chunk) => { childOutput += chunk })

const vite = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForSite = async () => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (siteServer.exitCode !== null) throw new Error(`share server exited ${siteServer.exitCode}\n${childOutput}`)
    if (childOutput.includes('FaNotes website listening')) return
    await wait(100)
  }
  throw new Error(`share server did not listen\n${childOutput}`)
}

const noteText = (payload) => (payload?.notes ?? []).map((note) => `${note.title}\n${note.content}`).join('\n')

let chromium = null
let chromiumProfile = ''

try {
  await waitForSite()
  const share = await vite.ssrLoadModule('/src/lib/sync/share.ts')
  const api = await vite.ssrLoadModule('/src/lib/sync/api.ts')
  const page = await vite.ssrLoadModule('/src/components/ShareSettingsPage.tsx')
  const settingsModule = await vite.ssrLoadModule('/src/components/SettingsModal.tsx')
  const defaults = await vite.ssrLoadModule('/src/defaults.ts')
  assert.equal(share.SHARE_API_PATH, '/api/v1/share')
  assert.notEqual(share.SHARE_API_PATH, api.SYNC_API_PATH)
  assert.equal(page.shareStopControl, share.stopShare)

  const localExchanges = []
  const directPort = share.createFetchSharePort()
  const sharePort = {
    async exchange(request) {
      const response = await directPort.exchange(request)
      localExchanges.push({ method: request.method, status: response.status, url: request.url })
      assert.ok(response.status !== 405, `${request.method} ${request.url} was refused by the share server`)
      assert.doesNotMatch(response.body, /Nur GET und HEAD sind erlaubt/u)
      return response
    },
  }
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
  assert.equal(note.record.link, `${origin}/share/?id=${encodeURIComponent(note.record.id)}`)
  const storedNote = readFileSync(join(shareDir, `${note.record.id}.json`), 'utf8')
  assert.match(storedNote, /Guten Tag aus der Notiz/)
  const servedViewer = await fetch(`${origin}/share/?id=${encodeURIComponent(note.record.id)}`)
  assert.equal(servedViewer.status, 200)
  assert.equal(await servedViewer.text(), viewerHtml)
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
  const storedFolder = readFileSync(join(shareDir, `${folder.record.id}.json`), 'utf8')
  assert.match(storedFolder, /Integral von x/)
  assert.match(storedFolder, /Verschachtelte Uebung/)
  assert.doesNotMatch(storedFolder, /NICHT-TEILEN-AUSSEN/)
  assert.doesNotMatch(storedFolder, /AUSSEN-NOTIZ/)
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
  const copyFile = readFileSync(join(shareDir, `${copy.record.id}.json`), 'utf8')
  const liveFile = readFileSync(join(shareDir, `${live.record.id}.json`), 'utf8')
  assert.match(copyFile, /Erster Satz/)
  assert.doesNotMatch(copyFile, /Spaeter geaendert/)
  assert.match(liveFile, /Spaeter geaendert/)
  await assertLiveRefreshTimer(share, sharePort, origin)

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
    const folderView = await reloadViewer({ ...viewed, link: folder.record.link }, 'Verschachtelte Uebung')
    assert.equal(folderView.errors.length, 0, `folder page errors: ${folderView.errors.join(' | ')}`)
    assert.match(folderView.text, /Integral von x/)
    assert.match(folderView.text, /Verschachtelte Uebung/)
    assert.doesNotMatch(folderView.text, /NICHT-TEILEN-AUSSEN/)
    assert.doesNotMatch(folderView.text, /AUSSEN-NOTIZ/)
  }

  const stopped = await page.shareStopControl({ id: note.record.id, port: sharePort, origin, directory: note.directory })
  assert.equal(stopped.shares.find((item) => item.id === note.record.id)?.stopped, true)
  const stoppedResponse = await fetch(`${origin}/api/v1/share/${note.record.id}`)
  assert.equal(stoppedResponse.status, 410)
  const afterStop = await share.readShare({ id: note.record.id, port: sharePort, origin, entries: oneEntries })
  assert.equal(afterStop, null)

  if (viewed.launched) {
    const stoppedView = await reloadViewer(viewed, 'Diese Freigabe wurde beendet.')
    assert.equal(stoppedView.errors.length, 0, `stopped page errors: ${stoppedView.errors.join(' | ')}`)
    assert.match(stoppedView.text, /Diese Freigabe wurde beendet/)
    assert.doesNotMatch(stoppedView.text, /Guten Tag aus der Notiz/)
    assert.doesNotMatch(stoppedView.text, /Hallo/)
  }

  const putStatuses = localExchanges.filter((exchange) => exchange.method === 'PUT').map((exchange) => exchange.status)
  assert.ok(putStatuses.length > 0, 'the shipped client did not PUT a share')
  assert.ok(putStatuses.every((status) => status === 200), `local PUT statuses ${putStatuses.join(',')}`)
  const hostLog = [
    `status ${putStatuses[0]}`,
    `link ${note.record.link}`,
    `puts ${putStatuses.join(',')}`,
  ].join('\n')
  writeScratch('share-host.log', `${hostLog}\n`)
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
    cloud: 'server.mjs',
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
  if (siteServer && siteServer.exitCode === null) {
    siteServer.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500)
      siteServer.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  rmSync(serverTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await vite.close()
}

async function assertLiveRefreshTimer(share, sharePort, origin) {
  const calls = []
  const recordingPort = {
    async exchange(request) {
      calls.push({ method: request.method, body: request.body })
      return sharePort.exchange(request)
    },
  }
  const published = await share.publishShare({
    entries: [{ path: 'Timer.md', kind: 'file', content: '# Timer\n\nVorher' }],
    rootPath: 'Timer.md',
    mode: 'live',
    port: sharePort,
    origin,
  })
  const recent = share.serializeShareDirectory(published.directory)
  share.queueLiveShareRefresh({
    settingsRecent: () => recent,
    loadEntries: async () => [{ path: 'Timer.md', kind: 'file', content: '# Timer\n\nNachher-Timer' }],
    port: recordingPort,
    origin,
  })
  await wait(2500)
  assert.ok(calls.some((call) => call.method === 'PUT' && call.body.includes('Nachher-Timer')))
  const updated = await share.readShare({ id: published.record.id, port: sharePort, origin })
  assert.match(noteText(updated), /Nachher-Timer/)

  const currentShare = await share.publishShare({
    entries: [{ path: 'Aktuell.md', kind: 'file', content: '# Aktuell\n\nOriginal-Timer' }],
    rootPath: 'Aktuell.md',
    mode: 'live',
    port: sharePort,
    origin,
  })
  let current = share.serializeShareDirectory(currentShare.directory)
  calls.length = 0
  share.queueLiveShareRefresh({
    settingsRecent: () => current,
    loadEntries: async () => [{ path: 'Aktuell.md', kind: 'file', content: '# Aktuell\n\nDARF-NICHT-HOCH' }],
    port: recordingPort,
    origin,
  })
  current = share.serializeShareDirectory(share.markShareStopped(currentShare.directory, currentShare.record.id))
  await wait(2500)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'timer must read the directory when it fires')
  const untouched = await share.readShare({ id: currentShare.record.id, port: sharePort, origin })
  assert.match(noteText(untouched), /Original-Timer/)
  assert.doesNotMatch(noteText(untouched), /DARF-NICHT-HOCH/)

  const stopping = await share.publishShare({
    entries: [{ path: 'Stopp.md', kind: 'file', content: '# Stopp\n\nBleibt-weg' }],
    rootPath: 'Stopp.md',
    mode: 'live',
    port: sharePort,
    origin,
  })
  const stale = share.serializeShareDirectory(stopping.directory)
  calls.length = 0
  share.queueLiveShareRefresh({
    settingsRecent: () => stale,
    loadEntries: async () => [{ path: 'Stopp.md', kind: 'file', content: '# Stopp\n\nWIEDER-DA' }],
    port: recordingPort,
    origin,
  })
  await share.stopShare({ id: stopping.record.id, port: recordingPort, origin, directory: stopping.directory })
  await wait(2500)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'stop must cancel the pending live refresh')
  assert.ok(calls.some((call) => call.method === 'DELETE'))
  assert.equal(await share.readShare({ id: stopping.record.id, port: sharePort, origin }), null)
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
