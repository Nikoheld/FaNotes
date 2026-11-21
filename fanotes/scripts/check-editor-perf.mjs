// Performance regression check for the Linux QA findings QA-003, 006, 035, 036.
// Launches the built renderer in Electron (Xvfb) with a temp profile and a generated large note, then
// measures (CDP Input.insertText / key presses, PerformanceObserver longtask, key -> 2nd rAF latency):
//   typing   key -> 2nd rAF latency while typing into a large note        (QA-006)
//   insert   time until the frame after inserting / pasting 50 KB, 200 KB (QA-003)
//   toggle   longest main-thread task per settings switch toggle          (QA-035)
//   open     longest main-thread task when opening a small note / PDF     (QA-036)
//   node scripts/check-editor-perf.mjs                 assert generous thresholds (skips without xvfb/dist/playwright)
//   FANOTES_PERF_LINES=50000 FANOTES_PERF_REPORT=1     the QA size and the full numbers (for before/after)
// Needs a built renderer (`vite build`), xvfb-run and playwright-core (PLAYWRIGHT_CORE).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim()
const skip = (why) => { console.log(`editor perf: skipped (${why})`); process.exit(0) }
if (process.env.FANOTES_SKIP_BROWSER === '1') skip('FANOTES_SKIP_BROWSER=1')
if (!xvfb) skip('no xvfb-run')
if (!fs.existsSync(electron)) skip('no electron')
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) skip('no dist/ (run vite build)')
let playwright
try { playwright = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core') } catch { skip('no playwright-core; set PLAYWRIGHT_CORE') }
const chromium = playwright.chromium ?? playwright.default.chromium

const lines = Number(process.env.FANOTES_PERF_LINES || 30_000)
const report = process.env.FANOTES_PERF_REPORT === '1'
const scale = Number(process.env.FANOTES_PERF_SLACK || 1) // multiply every threshold on slow machines
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-perf-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'Biologie')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

// Generated large note: headings, tags, wiki links, task lists, code fences and plain prose.
const big = []
for (let index = 0; index < lines; index += 1) {
  const kind = index % 40
  if (kind === 0) big.push(`## Abschnitt ${index / 40}`)
  else if (kind === 1) big.push(`Ein Absatz mit #tag${index % 97} und [[Notiz ${index % 31}]] sowie \`inline code\` und **fett** Text zum Testen.`)
  else if (kind === 2) big.push('- [ ] Aufgabe ' + index)
  else if (kind === 3) big.push('```js')
  else if (kind === 4) big.push(`const value${index} = ${index} // #nicht-ein-tag`)
  else if (kind === 5) big.push('```')
  else big.push(`Zeile ${index}: lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.`)
}
fs.writeFileSync(path.join(vault, 'Biologie', 'Gross.md'), `${big.join('\n')}\n`)
// Many small notes, like a real vault (indexing, tag and search state, tree size).
fs.mkdirSync(path.join(vault, 'Viele'), { recursive: true })
for (let index = 0; index < Number(process.env.FANOTES_PERF_NOTES || 80); index += 1) {
  fs.writeFileSync(path.join(vault, 'Viele', `Notiz ${index}.md`), `# Notiz ${index}\n\n${big.slice(0, 200).join('\n')}\n`)
}
fs.writeFileSync(path.join(vault, 'Biologie', 'Klein.md'), '# Klein\n\nEine kleine Notiz mit #tag und [[Gross]].\n\n- eins\n- zwei\n')
const makePdf = (pages) => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>']
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`)
  objects.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`)
  const fontId = 3 + pages * 2
  for (let i = 0; i < pages; i += 1) {
    const text = `BT /F1 24 Tf 40 760 Td (Seite ${i + 1}) Tj 0 -40 Td (Lorem ipsum dolor sit amet) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`)
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
fs.writeFileSync(path.join(vault, 'Biologie', 'Blatt.pdf'), makePdf(5))
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, diagnosticsNoticeSeen: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const probe = () => {
  window.__longTasks = []
  try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration)) }).observe({ type: 'longtask', buffered: true }) } catch { /* unsupported */ }
  window.__keyLatency = []
  document.addEventListener('keydown', (event) => {
    const stamp = event.timeStamp
    requestAnimationFrame(() => requestAnimationFrame(() => window.__keyLatency.push(Math.round(performance.now() - stamp))))
  }, true)
}

const port = 19_900 + Math.floor(Math.random() * 90)
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', electron, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const watchdog = setTimeout(() => {
  console.error(`watchdog: editor perf check did not finish\n${output.slice(-1500)}`)
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
  process.exit(1)
}, Number(process.env.FANOTES_PERF_WATCHDOG_MS) || 8 * 60_000)

// FANOTES_PERF_PROFILE=1 prints the top self-time functions per phase (use an unminified build for readable names).
const profiling = process.env.FANOTES_PERF_PROFILE === '1'
const profileStart = (cdp) => profiling ? cdp.send('Profiler.enable').then(() => cdp.send('Profiler.setSamplingInterval', { interval: 500 })).then(() => cdp.send('Profiler.start')) : null
const profileStop = async (cdp, label) => {
  if (!profiling) return
  const { profile } = await cdp.send('Profiler.stop')
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const self = new Map(); const total = new Map()
  const name = (id) => { const f = byId.get(id).callFrame; return `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}` }
  profile.samples.forEach((id, index) => {
    const dt = profile.timeDeltas[index] || 0
    self.set(name(id), (self.get(name(id)) || 0) + dt)
    const seen = new Set()
    for (let at = id; at !== undefined; at = parent.get(at)) { const key = name(at); if (!seen.has(key)) { seen.add(key); total.set(key, (total.get(key) || 0) + dt) } }
  })
  const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`)
  console.log(`PROFILE ${label} self:\n  ${top(self, 14).join('\n  ')}\nPROFILE ${label} inclusive:\n  ${top(total, 30).join('\n  ')}`)
}
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0 }
const max = (values) => values.reduce((a, b) => Math.max(a, b), 0)
const results = {}
let browser = null
let failure = null
try {
  const deadline = Date.now() + 60_000
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited: ${output.slice(-400)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  await page.addInitScript(probe)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    page.evaluate(() => location.reload()).catch(() => {})
    if (await page.waitForFunction(() => Array.isArray(window.__longTasks), null, { timeout: 20_000 }).then(() => true, () => false)) break
  }
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })
  await sleep(4000)
  const cdp = await page.context().newCDPSession(page)
  // The one-time diagnostics notice covers the file tree on a fresh profile.
  const notice = page.locator('.send-data-notice .secondary-button', { hasText: 'OK' })
  if (await notice.isVisible().catch(() => false)) await notice.click()
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))
  const takeTasks = () => page.evaluate(() => window.__longTasks.splice(0))
  const openRow = async (text) => {
    const row = page.locator('.file-tree__row', { hasText: text }).first()
    for (let attempt = 0; attempt < 3 && !(await row.isVisible().catch(() => false)); attempt += 1) {
      await page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Biologie' }).first().click()
      await row.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    }
    await row.click()
  }

  // The large note stays open as a tab for everything below (the QA sweep had it open too).
  await openRow('Gross')
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Abschnitt 0'), null, { timeout: 60_000 })
  await sleep(4000)

  // QA-035: settings switches.
  await page.keyboard.press('Control+,')
  await page.waitForSelector('.toggle[role="switch"]', { timeout: 10_000 })
  await sleep(1500)
  await takeTasks()
  const named = ['Lesbare Zeilenlänge', 'Bewegung reduzieren']
  const switches = page.locator(named.map((label) => `.toggle[role="switch"][aria-label="${label}"]`).join(', ')).or(page.locator('.toggle[role="switch"]'))
  const count = Math.min(await switches.count(), 6)
  const toggleMax = []
  await profileStart(cdp)
  for (let index = 0; index < count; index += 1) {
    const target = switches.nth(index)
    if (!(await target.isVisible().catch(() => false))) continue
    await target.scrollIntoViewIfNeeded().catch(() => {})
    await takeTasks()
    await target.click()
    await frames(); await sleep(600)
    const tasks = await takeTasks()
    toggleMax.push(tasks.reduce((a, b) => a + b, 0))
    await target.click() // restore
    await sleep(500)
  }
  await profileStop(cdp, 'toggle')
  results.toggleWorst = max(toggleMax)
  results.toggleCount = toggleMax.length
  await page.keyboard.press('Escape')
  await sleep(500)

  // QA-036: opening a small note and a 5-page PDF.
  await takeTasks()
  await profileStart(cdp)
  await openRow('Klein')
  await page.waitForSelector('.cm-content', { timeout: 20_000 })
  await frames(); await sleep(1500)
  results.openNote = max(await takeTasks())
  await profileStop(cdp, 'open note')
  await profileStart(cdp)
  await openRow('Blatt')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pdf-page="1"] canvas')].some((canvas) => canvas.width > 0), null, { timeout: 60_000 })
  await frames(); await sleep(2500)
  results.openPdf = max(await takeTasks())
  await profileStop(cdp, 'open pdf')

  // QA-006 / QA-003: the large note.
  await openRow('Gross')
  await page.waitForSelector('.cm-content', { timeout: 20_000 })
  await sleep(1500)
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+Home')
  await sleep(1500)
  await page.evaluate(() => { window.__keyLatency.length = 0 })
  await profileStart(cdp)
  for (let index = 0; index < 25; index += 1) {
    await page.keyboard.type(index % 7 === 6 ? ' ' : 'abcdefg'[index % 7])
    await sleep(160)
  }
  await sleep(1500)
  await profileStop(cdp, 'typing')
  const latencies = await page.evaluate(() => window.__keyLatency.slice())
  results.typingMedian = median(latencies)
  results.typingWorst = max(latencies)
  results.typingSamples = latencies.length

  const insertSizes = (process.env.FANOTES_PERF_INSERT || '50000,200000,500000').split(',').map(Number)
  // The same text two ways: CDP Input.insertText (Blink edits the DOM, CodeMirror reads the mutation) and a
  // paste event (CodeMirror's own paste handler, what Ctrl+V does). Plain = prose without wiki links.
  const makeText = (size, linky) => {
    const unit = linky ? 'Eingefuegter Text mit #pasted und [[Link]] fuer den Test. ' : 'Eingefuegter Text mit einem Wort fuer den Test, lang und ohne Klammern. '
    const line = `${unit.repeat(17).slice(0, 999)}\n`
    return line.repeat(Math.ceil(size / 1000)).slice(0, size)
  }
  const pasteEvent = (text) => page.evaluate((value) => {
    const target = document.querySelector('.cm-content')
    const data = new DataTransfer()
    data.setData('text/plain', value)
    target.focus()
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
  for (const size of insertSizes) {
    for (const [mode, linky] of [['insert', true], ['paste', false], ['pasteLinks', true]]) {
      const text = makeText(size, linky)
      await takeTasks()
      await profileStart(cdp)
      const started = Date.now()
      if (mode === 'insert') await cdp.send('Input.insertText', { text })
      else await pasteEvent(text)
      await frames()
      results[`${mode}${size / 1000}k`] = Date.now() - started
      await profileStop(cdp, `${mode} ${size / 1000}k`)
      await sleep(800)
    }
  }
  if (report) console.log(JSON.stringify({ lines, bytes: fs.statSync(path.join(vault, 'Biologie', 'Gross.md')).size, ...results, latencies }, null, 2))
} catch (error) {
  failure = error
} finally {
  clearTimeout(watchdog)
  await browser?.close().catch(() => {})
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
  await sleep(800)
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
  fs.rmSync(temporary, { recursive: true, force: true })
}
if (failure) { console.error(failure.stack || failure); console.error(output.slice(-1500)); process.exit(1) }

// Thresholds are generous (several times the numbers measured after the fixes) so a slow runner does not flake;
// before the fixes the 30,000-line typing median was about 150 ms and a 500 KB insertion took more than 10 s.
const limit = (value) => Math.round(value * scale)
assert.ok(results.typingSamples >= 15, `typing samples ${results.typingSamples}`)
assert.ok(results.typingMedian <= limit(100), `typing median ${results.typingMedian} ms (${lines} lines)`)
assert.ok(results.typingWorst <= limit(400), `typing worst ${results.typingWorst} ms (${lines} lines)`)
for (const mode of ['insert', 'paste', 'pasteLinks']) {
  assert.ok(results[`${mode}50k`] <= limit(1500), `${mode} 50 KB ${results[`${mode}50k`]} ms`)
  assert.ok(results[`${mode}200k`] <= limit(3000), `${mode} 200 KB ${results[`${mode}200k`]} ms`)
  assert.ok(results[`${mode}500k`] <= limit(6000), `${mode} 500 KB ${results[`${mode}500k`]} ms`)
}
assert.ok(results.toggleCount >= 2, `only ${results.toggleCount} switches toggled`)
assert.ok(results.toggleWorst <= limit(300), `settings toggle ${results.toggleWorst} ms of long tasks`)
assert.ok(results.openNote <= limit(600), `opening a note blocked ${results.openNote} ms`)
assert.ok(results.openPdf <= limit(900), `opening a PDF blocked ${results.openPdf} ms`)
console.log(`editor perf ok: ${JSON.stringify(results)}`)
