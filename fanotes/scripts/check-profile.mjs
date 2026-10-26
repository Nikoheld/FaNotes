import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Unique username, public activity overview, settings switch, and the
// /user/<name> page served by fanotes-site/server.mjs.

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const siteRoot = fileURLToPath(new URL('../../fanotes-site/', import.meta.url))
const scratch = process.env.FANOTES_PROFILE_SCRATCH || ''
const writeScratch = (name, text) => {
  if (scratch) writeFileSync(join(scratch, name), text)
}
const pageName = (name) => join(appRoot, 'public', 'user', name)
const sitePage = (name) => join(siteRoot, 'public', 'user', name)
for (const name of ['index.html', 'profile.css', 'profile.js']) {
  assert.equal(readFileSync(sitePage(name), 'utf8'), readFileSync(pageName(name), 'utf8'), `${name} must match on the site`)
}
const viewerHtml = readFileSync(pageName('index.html'), 'utf8')
const viewerScript = readFileSync(pageName('profile.js'), 'utf8')
const viewerStyle = readFileSync(pageName('profile.css'), 'utf8')
assert.doesNotMatch(viewerHtml, /<style[\s>]/u)
assert.doesNotMatch(viewerHtml, /<script(?![^>]*\bsrc=)/u)
assert.match(viewerHtml, /src="\/user\/profile\.js"/u)
assert.match(viewerHtml, /href="\/user\/profile\.css"/u)
assert.match(viewerScript, /profile-joined/u)
assert.match(viewerStyle, /#0b0b12/u)
assert.match(viewerStyle, /#a795ff/u)

const serverSource = readFileSync(join(siteRoot, 'server.mjs'), 'utf8')
const serviceSource = readFileSync(join(siteRoot, 'deploy', 'fanotes-site.service'), 'utf8')
const profileRoute = serverSource.indexOf('handleProfileRequest(request, response, url)')
const getGuard = serverSource.indexOf('Nur GET und HEAD sind erlaubt.')
assert.ok(profileRoute >= 0 && getGuard >= 0 && profileRoute < getGuard, 'profile route must run before the GET/HEAD guard')
assert.match(serviceSource, /Environment=FANOTES_PROFILE_DIR=\/var\/lib\/fanotes-profiles/u)
assert.match(serviceSource, /ReadWritePaths=\/var\/lib\/fanotes-profiles/u)

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

const serverTemp = mkdtempSync(join(tmpdir(), 'fanotes-profile-server-'))
const profileDir = join(serverTemp, 'profiles')
const enrollmentPath = join(serverTemp, 'enrollment-token')
mkdirSync(profileDir, { recursive: true })
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
    FANOTES_PROFILE_DIR: profileDir,
    FANOTES_SHARE_DIR: join(serverTemp, 'shares'),
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
    if (siteServer.exitCode !== null) throw new Error(`profile server exited ${siteServer.exitCode}\n${childOutput}`)
    if (childOutput.includes('FaNotes website listening')) return
    await wait(100)
  }
  throw new Error(`profile server did not listen\n${childOutput}`)
}

let chromium = null
let chromiumProfile = ''

try {
  await waitForSite()
  const profile = await vite.ssrLoadModule('/src/lib/sync/profile.ts')
  const pageStats = await vite.ssrLoadModule('/src/lib/pageStats.ts')
  const settingsModule = await vite.ssrLoadModule('/src/components/SettingsModal.tsx')
  const card = await vite.ssrLoadModule('/src/components/ProfileSettingsCard.tsx')
  const defaults = await vite.ssrLoadModule('/src/defaults.ts')
  assert.equal(card.profileVisibilityControl, profile.setProfileVisibility)
  assert.equal(profile.PROFILE_API_PATH, '/api/v1/profile')
  assert.equal(profile.PROFILE_VIEW_PATH, '/user/')

  const secret = 'GEHEIMER-NOTIZTEXT-7f3a'
  const joinedAt = '2024-01-15T09:30:00.000Z'
  const ownerA = 'a'.repeat(32)
  const ownerB = 'b'.repeat(32)
  const notes = [
    {
      path: `geheim/${secret}.md`,
      title: `Titel ${secret}`,
      content: `# Titel\n\n${secret}`,
      pageStats: pageStats.parsePageStats({
        createdAt: '2024-03-02T10:00:00.000Z',
        dwellMs: 3_600_000 + 5 * 60_000,
        activeDays: ['2024-03-02', '2024-11-19'],
      }),
    },
    {
      path: 'zweite.md',
      title: 'Zweite',
      content: `${secret}-zweite`,
      pageStats: pageStats.parsePageStats({
        createdAt: '2024-04-01T10:00:00.000Z',
        dwellMs: 90_000,
        activeDays: ['2024-04-01', '2024-03-02'],
      }),
    },
  ]
  const summary = profile.summarizeProfileActivity(notes, joinedAt)
  assert.equal(summary.noteCount, 2)
  assert.equal(summary.dwellMs, 3_990_000)
  assert.equal(summary.durationLabel, pageStats.formatPageDwell(summary.dwellMs))
  assert.equal(summary.durationLabel, '1 h 6 min')
  assert.deepEqual(summary.activeDays, ['2024-03-02', '2024-04-01', '2024-11-19'])
  assert.equal(summary.joinedAt, joinedAt)
  assert.doesNotMatch(JSON.stringify(summary), /GEHEIMER-NOTIZTEXT/u)
  assert.equal(profile.normalizeUsername('FeldNotiz'), 'feldnotiz')
  assert.equal(profile.normalizeUsername('ab'), null)
  assert.equal(profile.normalizeUsername('admin'), null)

  const exchanges = []
  const directPort = profile.createFetchProfilePort()
  const port = {
    async exchange(request) {
      const response = await directPort.exchange(request)
      exchanges.push({ method: request.method, status: response.status, url: request.url, body: request.body })
      assert.notEqual(response.status, 405, `${request.method} ${request.url} was refused`)
      assert.doesNotMatch(response.body, /Nur GET und HEAD sind erlaubt/u)
      assert.doesNotMatch(request.url, /\/api\/v1\/sync/u)
      if (request.body) assert.doesNotMatch(request.body, /GEHEIMER-NOTIZTEXT/u)
      return response
    },
  }

  const beforeEmpty = exchanges.length
  await assert.rejects(
    () => profile.setProfileVisibility({ enabled: true, username: '', ownerId: ownerA, notes, port, origin }),
    (error) => error instanceof profile.ProfileRequestError && error.status === 400,
  )
  assert.equal(exchanges.length, beforeEmpty, 'the toggle must not publish without a username')

  const claimed = await profile.claimUsername({ username: 'FeldNotiz', ownerId: ownerA, joinedAt, port, origin })
  assert.equal(claimed.path, '/user/feldnotiz')
  assert.equal(claimed.link, `${origin}/user/feldnotiz`)
  assert.equal(claimed.joinedAt, joinedAt)
  const again = await profile.claimUsername({
    username: 'feldnotiz',
    ownerId: ownerA,
    joinedAt: '2025-06-01T00:00:00.000Z',
    port,
    origin,
  })
  assert.equal(again.joinedAt, joinedAt, 'joining again keeps the first claim time')
  await assert.rejects(
    () => profile.claimUsername({ username: 'FELDNOTIZ', ownerId: ownerB, joinedAt, port, origin }),
    (error) => error instanceof profile.ProfileRequestError && error.status === 409 && error.taken === true,
  )

  const raced = await Promise.allSettled([
    profile.claimUsername({ username: 'parallelname', ownerId: 'c'.repeat(32), joinedAt, port, origin }),
    profile.claimUsername({ username: 'ParallelName', ownerId: 'd'.repeat(32), joinedAt, port, origin }),
  ])
  const won = raced.filter((result) => result.status === 'fulfilled')
  const lost = raced.filter((result) => result.status === 'rejected')
  assert.equal(won.length, 1, 'one claim of a free name must win')
  assert.equal(lost.length, 1, 'the other account must be refused')
  assert.equal(lost[0].reason?.status, 409)
  assert.equal(won[0].value.path, '/user/parallelname')

  const published = await profile.setProfileVisibility({
    enabled: true,
    username: claimed.username,
    ownerId: ownerA,
    notes,
    port,
    origin,
  })
  assert.equal(published.joinedAt, joinedAt)
  assert.equal(published.noteCount, summary.noteCount)
  assert.equal(published.dwellMs, summary.dwellMs)
  assert.equal(published.durationLabel, summary.durationLabel)
  assert.deepEqual(published.activeDays, summary.activeDays)
  assert.equal(published.path, '/user/feldnotiz')
  const storedText = readFileSync(join(profileDir, 'names', 'feldnotiz.json'), 'utf8')
  const stored = JSON.parse(storedText)
  assert.equal(stored.joinedAt, joinedAt)
  assert.equal(stored.noteCount, summary.noteCount)
  assert.equal(stored.dwellMs, summary.dwellMs)
  assert.equal(stored.durationLabel, summary.durationLabel)
  assert.deepEqual(stored.activeDays, summary.activeDays)
  assert.equal(stored.path, '/user/feldnotiz')
  assert.doesNotMatch(storedText, /GEHEIMER-NOTIZTEXT/u)
  assert.equal(stored.content, undefined)
  assert.equal(stored.title, undefined)
  const readBack = await profile.readPublicProfile({ username: 'feldnotiz', port, origin })
  assert.equal(readBack.joinedAt, joinedAt)
  assert.equal(readBack.noteCount, 2)
  assert.equal(readBack.durationLabel, '1 h 6 min')
  assert.deepEqual(readBack.activeDays, summary.activeDays)

  const servedViewer = await fetch(`${origin}/user/feldnotiz`)
  assert.equal(servedViewer.status, 200)
  assert.equal(await servedViewer.text(), viewerHtml)
  assert.equal(await (await fetch(`${origin}/user/profile.js`)).text(), viewerScript)
  assert.equal(await (await fetch(`${origin}/user/profile.css`)).text(), viewerStyle)

  const require = createRequire(import.meta.url)
  const { sanitizeSettings: sanitizeStoredSettings, SETTINGS_SCHEMA } = require(join(appRoot, 'electron', 'settings-sanitize.cjs'))
  const mainSource = readFileSync(join(appRoot, 'electron', 'main.cjs'), 'utf8')
  assert.match(mainSource, /require\('\.\/settings-sanitize\.cjs'\)/u)
  assert.match(
    mainSource,
    /function sanitizeSettings\(candidate, base = DEFAULT_SETTINGS\) \{\n  return sanitizeStoredSettings\(candidate, base, DEFAULT_SETTINGS\)\n\}/u,
  )
  assert.match(mainSource, /const nextSettings = sanitizeSettings\(settings, previousSettings\)/u)
  assert.match(mainSource, /const sanitized = sanitizeSettings\(settingsCandidate\)/u)
  assert.match(mainSource, /profileOwnerId: ''/u)
  assert.match(mainSource, /profileUsername: ''/u)
  assert.match(mainSource, /profilePublic: false/u)
  assert.deepEqual(SETTINGS_SCHEMA.profileOwnerId, { type: 'string', max: 32 })
  assert.deepEqual(SETTINGS_SCHEMA.profileUsername, { type: 'string', max: 24 })
  assert.deepEqual(SETTINGS_SCHEMA.profilePublic, { type: 'boolean' })
  const desktopDefaults = {
    profileOwnerId: '',
    profileUsername: '',
    profilePublic: false,
  }
  const previousDesktop = sanitizeStoredSettings(desktopDefaults, desktopDefaults, desktopDefaults)
  const savedProfile = sanitizeStoredSettings({
    ...defaults.defaultSettingsForPlatform('linux'),
    profileOwnerId: ownerA,
    profileUsername: 'feldnotiz',
    profilePublic: true,
  }, previousDesktop, desktopDefaults)
  const restartedProfile = sanitizeStoredSettings(savedProfile, desktopDefaults, desktopDefaults)
  assert.equal(restartedProfile.profileOwnerId, ownerA)
  assert.equal(restartedProfile.profileUsername, 'feldnotiz')
  assert.equal(restartedProfile.profilePublic, true)
  const clearedProfile = sanitizeStoredSettings({
    profileOwnerId: '',
    profileUsername: '',
    profilePublic: false,
  }, desktopDefaults, desktopDefaults)
  const clearedRestart = sanitizeStoredSettings(clearedProfile, desktopDefaults, desktopDefaults)
  assert.equal(clearedRestart.profileOwnerId, '')
  assert.equal(clearedRestart.profileUsername, '')
  assert.equal(clearedRestart.profilePublic, false)
  const rejectedProfile = sanitizeStoredSettings({
    profileOwnerId: 'z'.repeat(33),
    profileUsername: 'n'.repeat(25),
    profilePublic: 'yes',
  }, savedProfile, desktopDefaults)
  assert.equal(rejectedProfile.profileOwnerId, ownerA)
  assert.equal(rejectedProfile.profileUsername, 'feldnotiz')
  assert.equal(rejectedProfile.profilePublic, true)

  const settings = {
    ...defaults.defaultSettingsForPlatform('linux'),
    profileOwnerId: restartedProfile.profileOwnerId,
    profileUsername: restartedProfile.profileUsername,
    profilePublic: restartedProfile.profilePublic,
  }
  const html = renderToStaticMarkup(createElement(settingsModule.SettingsModal, {
    platform: 'linux',
    settings,
    vaultPath: '/vault',
    initialSection: 'sync',
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
  assert.match(html, /id="settings-profile"/u)
  assert.match(html, /aria-label="Die öffentliche Aktivitätsübersicht zeigen"/u)
  assert.match(html, /aria-checked="true"/u)
  assert.match(html, /Benutzername festlegen/u)
  const settingsLog = [
    `groups ${groups.join('|')}`,
    `sections ${sections}`,
    `searchPlaceholder ${placeholder}`,
    'toggle Die öffentliche Aktivitätsübersicht zeigen',
    'visibility setProfileVisibility',
    `desktopSanitize ${restartedProfile.profileOwnerId} ${restartedProfile.profileUsername} ${restartedProfile.profilePublic}`,
  ].join('\n')
  writeScratch('profile-settings.log', `${settingsLog}\nprofile-settings ok\n`)
  console.log(settingsLog)

  const viewed = await openViewer(`${origin}/user/feldnotiz`, '1 h 6 min')
  if (viewed.launched) {
    if (scratch && viewed.screenshot) writeFileSync(join(scratch, 'profile-view.png'), viewed.screenshot)
    assert.equal(viewed.errors.length, 0, `page errors: ${viewed.errors.join(' | ')}`)
    assert.match(viewed.text, /2024-01-15T09:30:00\.000Z/u)
    assert.match(viewed.text, /notizen\s+2/iu)
    assert.match(viewed.text, /1 h 6 min/u)
    assert.match(viewed.text, /2024-03-02/u)
    assert.match(viewed.text, /2024-04-01/u)
    assert.match(viewed.text, /2024-11-19/u)
    assert.doesNotMatch(viewed.text, /GEHEIMER-NOTIZTEXT/u)
  }

  const hidden = await profile.setProfileVisibility({
    enabled: false,
    username: 'feldnotiz',
    ownerId: ownerA,
    port,
    origin,
  })
  assert.equal(hidden, null)
  const afterToggle = await profile.readPublicProfile({ username: 'feldnotiz', port, origin })
  assert.equal(afterToggle, null)
  const hiddenResponse = await fetch(`${origin}/api/v1/profile/feldnotiz`)
  assert.equal(hiddenResponse.status, 404)
  const hiddenBody = await hiddenResponse.text()
  assert.doesNotMatch(hiddenBody, /1 h 6 min/u)
  assert.doesNotMatch(hiddenBody, /2024-03-02/u)
  assert.doesNotMatch(hiddenBody, /2024-01-15T09:30:00\.000Z/u)
  assert.doesNotMatch(hiddenBody, /GEHEIMER-NOTIZTEXT/u)
  assert.doesNotMatch(hiddenBody, /"noteCount"/u)
  const withdrawn = readFileSync(join(profileDir, 'names', 'feldnotiz.json'), 'utf8')
  assert.match(withdrawn, /"public":false/u)
  assert.doesNotMatch(withdrawn, /1 h 6 min/u)
  assert.doesNotMatch(withdrawn, /2024-03-02/u)
  assert.doesNotMatch(withdrawn, /GEHEIMER-NOTIZTEXT/u)
  assert.match(withdrawn, /2024-01-15T09:30:00\.000Z/u)

  if (viewed.launched) {
    viewed.errors.length = 0
    await viewed.cdp.send('Page.navigate', { url: `${origin}/user/feldnotiz` })
    const hiddenText = await waitForText(viewed.cdp, 'Diese Übersicht ist nicht öffentlich.')
    assert.equal(viewed.errors.length, 0, `hidden page errors: ${viewed.errors.join(' | ')}`)
    assert.match(hiddenText, /Diese Übersicht ist nicht öffentlich/u)
    assert.doesNotMatch(hiddenText, /1 h 6 min/u)
    assert.doesNotMatch(hiddenText, /2024-03-02/u)
    assert.doesNotMatch(hiddenText, /2024-04-01/u)
    assert.doesNotMatch(hiddenText, /2024-11-19/u)
    assert.doesNotMatch(hiddenText, /2024-01-15T09:30:00\.000Z/u)
    assert.doesNotMatch(hiddenText, /notizen/iu)
    assert.doesNotMatch(hiddenText, /GEHEIMER-NOTIZTEXT/u)
  }
  if (viewed?.socket) viewed.socket.close()

  const putStatuses = exchanges.filter((exchange) => exchange.method === 'PUT').map((exchange) => exchange.status)
  assert.ok(putStatuses.includes(200), 'the shipped client did not claim a username')
  assert.ok(putStatuses.includes(409), 'a second account was not refused')
  assert.ok(putStatuses.every((status) => status === 200 || status === 409), `local PUT statuses ${putStatuses.join(',')}`)
  let hostStatus = 'error'
  let hostError = ''
  try {
    const hostResponse = await fetch('https://fanotes.fasrv.ch/api/v1/profile', {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, action: 'claim', username: 'ab', ownerId: ownerA }),
      signal: AbortSignal.timeout(8000),
    })
    hostStatus = String(hostResponse.status)
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error)
  }
  const hostLog = [
    `local-status ${putStatuses[0]}`,
    `local-link ${claimed.link}`,
    `host-status ${hostStatus}`,
    'host-link none',
    `host-error ${hostError}`,
  ].join('\n')
  writeScratch('profile-host.log', `${hostLog}\n`)
  console.log(hostLog)
  console.log('profile-check ok')
  if (scratch) appendFileSync(join(scratch, 'profile-check.log'), 'profile-check ok\n')
} finally {
  if (chromium && chromium.exitCode === null) {
    try { process.kill(-chromium.pid, 'SIGTERM') } catch { chromium.kill('SIGTERM') }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      chromium.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  if (chromiumProfile) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        rmSync(chromiumProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        break
      } catch (error) {
        if (attempt === 7) throw error
        await wait(250)
      }
    }
  }
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
    const debugPort = 25000 + Math.floor(Math.random() * 10000)
    chromiumProfile = mkdtempSync(join(tmpdir(), 'fanotes-profile-chrome-'))
    chromium = spawn('/usr/bin/chromium', [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1280,860',
      `--user-data-dir=${chromiumProfile}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
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
      writeScratch('profile-view-launch.txt', `${message}\n`)
      console.log(`profile-view launch failed: ${message}`)
      return { launched: false, text: '', errors, screenshot: null, cdp: null, socket: null }
    }
    throw error
  }
}

async function waitForText(cdp, expected) {
  const deadline = Date.now() + 8000
  let text = ''
  while (Date.now() < deadline) {
    text = await cdp.evaluate('document.body ? document.body.innerText : ""')
    if (text.includes(expected)) return text
    await wait(80)
  }
  throw new Error(`Profile page did not show «${expected}». Page text: ${text.slice(0, 700)}`)
}
