// Shared harness for desktop flow checks: Electron under Xvfb with a temp profile, a synthetic vault,
// playwright-core over CDP, and scripts/electron-test-stub.cjs standing in for the native dialogs.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const electronBinary = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const loadPlaywright = async () => {
  const module = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
  return (module.chromium ?? module.default.chromium)
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const until = async (check, what, timeout = 15_000, step = 150) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(step)
  }
}

/** A multi-page PDF: one text line per page, sizes like '[0 0 595 842]'. */
export const makePdf = (boxes = ['[0 0 595 842]', '[0 0 842 595]'], label = 'Seite') => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${boxes.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${boxes.length} >>`]
  boxes.forEach((box, index) => {
    const text = `BT /F1 24 Tf 40 60 Td (${label} ${index + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${3 + boxes.length * 2} 0 R >> >> >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A temp HOME/config/vault. `extraSettings` are merged into the app settings. */
export const createProfile = (prefix, extraSettings = {}) => {
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix))
  const profile = {
    temporary,
    home: path.join(temporary, 'home'),
    configHome: path.join(temporary, 'config'),
    runtime: path.join(temporary, 'runtime'),
    vault: path.join(temporary, 'home', 'Notizen'),
    userData: path.join(temporary, 'config', 'FaNotes'),
    downloads: path.join(temporary, 'downloads'),
    dialogs: path.join(temporary, 'dialogs.json'),
  }
  for (const directory of [profile.home, profile.configHome, profile.runtime, profile.vault, profile.userData, profile.downloads]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(profile.userData, 'config.json'), `${JSON.stringify({
    version: 3,
    vaultPath: profile.vault,
    settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true, ...extraSettings },
    onboarding: { version: 1, completed: true },
  }, null, 2)}\n`, { mode: 0o600 })
  profile.answerDialogs = (answers) => fs.writeFileSync(profile.dialogs, JSON.stringify(answers))
  profile.dispose = () => fs.rmSync(temporary, { recursive: true, force: true })
  return profile
}

export const launch = (profile) => {
  const port = 19_300 + Math.floor(Math.random() * 600)
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electronBinary, '-r', path.join(root, 'scripts', 'electron-test-stub.cjs'), root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
    env: { ...process.env, HOME: profile.home, XDG_CONFIG_HOME: profile.configHome, XDG_RUNTIME_DIR: profile.runtime, FANOTES_TEST_DIALOGS: profile.dialogs },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  return { child, port, output: () => output }
}

export const connect = async (app) => {
  const chromium = await loadPlaywright()
  let browser = null
  const deadline = Date.now() + 90_000
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${app.port}`) } catch { await sleep(300) }
    if (app.child.exitCode !== null) throw new Error(`Electron exited: ${app.output().slice(-400)}`)
  }
  if (!browser) throw new Error('Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 160 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('no renderer page')
  page.on('pageerror', (error) => console.log('pageerror', String(error).slice(0, 200)))
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 90_000 })
  return { browser, page }
}

/** Quits the way a user does (so debounced settings and session writes are flushed), then makes sure the process is gone. */
export const quit = async (app, page) => {
  await page?.evaluate(() => { void window.fanotes.requestClose?.() }).catch(() => {})
  for (let tries = 0; tries < 60 && app.child.exitCode === null; tries += 1) await sleep(250)
}

export const stop = async (app, browser) => {
  await browser?.close().catch(() => {})
  try { process.kill(-app.child.pid, 'SIGTERM') } catch { /* gone */ }
  await sleep(800)
}

export const createReporter = () => {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push(Boolean(pass))
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` -> ${String(detail).slice(0, 300)}` : ''}`)
    return Boolean(pass)
  }
  return { ok, failed: () => results.filter((value) => !value).length, count: () => results.length }
}

/** Runs `trigger` (which starts a renderer download) and saves the file playwright captured into profile.downloads. */
export const captureDownload = async (page, profile, trigger) => {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), trigger()])
  const target = path.join(profile.downloads, download.suggestedFilename())
  await download.saveAs(target)
  return target
}

/** Clicks a file row in the tree, expanding `folder` first when the row is hidden. */
export const openFile = async (page, name, folder = null) => {
  const row = page.locator('.file-tree__row:not([data-kind="folder"])', { hasText: name }).first()
  // Give a tree that is re-rendering a moment before treating the row as hidden: a click on an expanded folder would collapse it.
  let shown = await row.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)
  for (let attempt = 0; attempt < 2 && folder && !shown; attempt += 1) {
    await page.locator('.file-tree__row[data-kind="folder"]', { hasText: folder }).first().click()
    shown = await row.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)
  }
  await row.click({ timeout: 10_000 })
}

export const waitPdfRendered = (page, pageNumber = 1) => page.waitForFunction((number) => [...document.querySelectorAll(`[data-pdf-page="${number}"] canvas`)].some((canvas) => canvas.width > 0), pageNumber, { timeout: 60_000 })

/** Dismisses the first-run diagnostics notice so it never covers a click target. */
export const dismissNotices = async (page) => {
  await page.locator('button:has-text("Ausschalten")').first().click({ timeout: 2500 }).catch(() => {})
}

export const SYNC_HOST = 'fanotes.fasrv.ch'

/**
 * The real fanotes-site/server.mjs on a spare local port with temp data directories. The desktop renderer
 * only knows the public sync origin, so `routeSyncTo` forwards those requests (playwright route) to the local server.
 * Never touches the production server.
 */
const freePort = (start) => new Promise((resolve) => {
  const tryPort = async (port) => {
    const { createServer } = await import('node:net')
    const probe = createServer()
    probe.once('error', () => tryPort(port + 1))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)))
  }
  void tryPort(start)
})

export const startSite = async (profileBase, preferredPort = Number(process.env.FANOTES_FLOW_SITE_PORT) || 18_996) => {
  const port = await freePort(preferredPort)
  const { spawn: spawnChild } = await import('node:child_process')
  const data = fs.mkdtempSync(path.join(profileBase, 'site-'))
  const dirs = Object.fromEntries(['sync', 'mcp', 'shares', 'backups', 'analytics'].map((name) => [name, path.join(data, name)]))
  Object.values(dirs).forEach((directory) => fs.mkdirSync(directory, { recursive: true }))
  const enrollment = path.join(data, 'enrollment-token')
  fs.writeFileSync(enrollment, randomBytes(36).toString('base64url'), { mode: 0o600 })
  const origin = `http://127.0.0.1:${port}`
  const child = spawnChild(process.execPath, [path.join(root, '..', 'fanotes-site', 'server.mjs')], {
    cwd: path.join(root, '..', 'fanotes-site'),
    env: {
      ...process.env,
      FANOTES_HOST: '127.0.0.1',
      FANOTES_PORT: String(port),
      FANOTES_PUBLIC_ORIGIN: origin,
      FANOTES_SYNC_DIR: dirs.sync,
      FANOTES_MCP_DIR: dirs.mcp,
      FANOTES_SHARE_DIR: dirs.shares,
      FANOTES_BACKUP_DIR: dirs.backups,
      FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH: enrollment,
      FANOTES_ANALYTICS_DIR: dirs.analytics,
      FANOTES_SYNC_REGISTER_PER_HOUR: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  await until(() => { if (child.exitCode !== null) throw new Error(`site exited: ${output.slice(-400)}`); return output.includes('listening') }, 'site server start', 30_000)
  return {
    origin,
    data,
    output: () => output,
    stop: async () => { child.kill('SIGTERM'); await sleep(300); fs.rmSync(data, { recursive: true, force: true }) },
  }
}

/** Sends every request the page makes to https://fanotes.fasrv.ch to the local site instead. */
export const routeSyncTo = async (page, site) => {
  await page.context().route((url) => url.hostname === SYNC_HOST, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    try {
      const response = await fetch(`${site.origin}${url.pathname}${url.search}`, {
        method: request.method(),
        headers: Object.fromEntries(Object.entries(request.headers()).filter(([name]) => !['host', 'origin', 'referer', 'content-length'].includes(name.toLowerCase()) && !name.startsWith(':'))),
        body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer() ?? undefined,
      })
      const headers = Object.fromEntries(response.headers.entries())
      delete headers['content-encoding']
      delete headers['content-length']
      await route.fulfill({ status: response.status, headers: { ...headers, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' }, body: Buffer.from(await response.arrayBuffer()) })
    } catch (error) {
      await route.abort('connectionrefused')
    }
  })
}
