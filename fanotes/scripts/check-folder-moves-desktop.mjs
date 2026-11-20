// Folder tree moves in the real desktop app (Electron under Xvfb): a folder or note
// dropped onto a collapsed folder moves into it (also a nested one, with the
// hover auto-expand), and a folder moved into a nested folder stays in the tree.
// Needs a built renderer (`vite build`) and xvfb-run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Playwright is not an app dependency: set PLAYWRIGHT_CORE to its entry file, or install it next to the app.
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-folder-moves-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'A', 'B', 'Deep')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
for (const dir of ['C', 'D/E', 'G', 'H/Inner', 'I', 'J', 'K']) fs.mkdirSync(path.join(vault, dir), { recursive: true })
fs.writeFileSync(path.join(vault, 'C', 'c.md'), '# c\n')
fs.writeFileSync(path.join(vault, 'Loose.md'), '# loose\n')
fs.writeFileSync(path.join(vault, 'Loose2.md'), '# loose2\n')
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const external = path.join(temporary, 'external')
fs.mkdirSync(path.join(external, 'Sub'), { recursive: true }); fs.mkdirSync(path.join(vault, 'A', 'Linked'), { recursive: true })
fs.writeFileSync(path.join(userData, 'folder-locations.json'), JSON.stringify({ version: 1, vaults: { [path.resolve(vault)]: { 'A/Linked': [external] } } }))
const port = 19_300 + Math.floor(Math.random() * 400)
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', executable, root, `--remote-debugging-port=${port}`, '--no-sandbox'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const results = []
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` → ${String(detail).slice(0, 240)}` : ''}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const read = (name) => fs.readFileSync(path.join(vault, name), 'utf8')
const files = () => fs.readdirSync(vault).sort()
const copiesOf = (stem) => files().filter((file) => file.startsWith(`${stem} (Konflikt`))
const until = async (check, timeout = 15_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return true; await sleep(150) }
  return false
}

let browser
try {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break } catch { await sleep(250) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-500)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.url().startsWith('devtools')) ?? null
    if (!page) await sleep(250)
  }
  assert.ok(page, 'no renderer page')
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })


  const treePaths = async () => page.evaluate(async () => {
    const out = []
    const walk = (entries) => entries.forEach((e) => { out.push(e.relativePath); if (e.children) walk(e.children) })
    walk(await window.fanotes.getTree())
    return out
  })
  const rowPaths = () => page.locator('.file-tree__entry-button[data-path]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-path')))
  const row = (p) => page.locator(`.file-tree__entry-button[data-path="${p}"]`)
  const expandedOf = (p) => page.locator(`.file-tree__row:has(.file-tree__entry-button[data-path="${p}"])`).locator('xpath=..').getAttribute('aria-expanded')
  const onDisk = (rel) => fs.existsSync(path.join(vault, rel))
  const rowsHave = async (rel) => (await rowPaths()).includes(rel)
  const ensureOpen = async (p) => { await row(p).waitFor(); if (await expandedOf(p) !== 'true') await row(p).click() }
  const settled = async (cond, ms = 8000) => until(cond, ms)
  await ensureOpen('A')

  // 13a. Mouse drag of a note onto a CLOSED folder.
  ok('D starts closed', await expandedOf('D') === 'false')
  await row('Loose.md').dragTo(row('D'))
  ok('note dropped on a closed folder moves into it', await settled(() => onDisk('D/Loose.md') && !onDisk('Loose.md')))

  // 14a. Folder moved into a nested folder (A/B, depth 2) stays in the tree, on screen and after a rescan.
  await row('A/B').waitFor()
  await row('C').dragTo(row('A/B'))
  ok('folder moved into a nested folder (disk)', await settled(() => onDisk('A/B/C/c.md')))
  ok('moved folder shows in the tree', await settled(() => rowsHave('A/B/C')))
  await sleep(2500)
  ok('moved folder still shows after the watcher rescan', await rowsHave('A/B/C'))
  const full = await treePaths()
  ok('getTree lists the moved folder', full.includes('A/B/C') && full.includes('A/B/C/c.md'))

  // 14b. Open folders keep their state when they move (paths are remapped).
  await ensureOpen('D')
  await ensureOpen('D/E')
  await row('D').dragTo(row('A/B/Deep'))
  ok('open folder moved two levels down', await settled(() => onDisk('A/B/Deep/D/E')))
  ok('its sub folder row is visible (expanded state remapped)', await settled(() => rowsHave('A/B/Deep/D/Loose.md')))

  // 13b. Hover auto-expand after ~600 ms (native drag events), then drop on the opened folder.
  const dragEvents = (from, to, wait) => page.evaluate(async ({ from, to, wait }) => {
    const find = (p) => document.querySelector(`.file-tree__entry-button[data-path="${CSS.escape(p)}"]`)
    const source = find(from)
    const target = find(to).closest('.file-tree__row')
    const dataTransfer = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    const over = () => target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
    over()
    const early = new Promise((resolve) => setTimeout(resolve, 500))
    await early
    over()
    const openEarly = target.closest('li').getAttribute('aria-expanded')
    await new Promise((resolve) => setTimeout(resolve, wait))
    over()
    const openLate = target.closest('li').getAttribute('aria-expanded')
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
    return { openEarly, openLate }
  }, { from, to, wait })
  const hover = await dragEvents('G', 'H', 400)
  ok('hovering a closed folder does not open it before ~600 ms', hover.openEarly === 'false', hover.openEarly)
  ok('hovering a closed folder for ~600 ms opens it', hover.openLate === 'true', hover.openLate)
  ok('the drop after the hover moved the folder', await settled(() => onDisk('H/G')))

  ok('the tree caught up after the drop', await settled(() => rowsHave('H/G')))
  await sleep(6000) // let the success toast leave the sidebar corner (it would cover the drop point)

  // 13c. Touch (the app's finger drag layer): hold, drag onto a closed folder, release.
  // A pen drags natively like a mouse, which the checks above cover.
  for (const pointerType of ['touch']) {
    const [name, dest] = ['I', 'J']
    const hasBefore = await expandedOf(dest)
    await page.evaluate(async ({ name, dest, pointerType }) => {
      const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const find = (p) => document.querySelector(`.file-tree__entry-button[data-path="${CSS.escape(p)}"]`)
      const source = find(name)
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
      const from = box(source)
      const init = (point) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType, isPrimary: true, clientX: point.x, clientY: point.y, button: 0, buttons: 1 })
      source.dispatchEvent(new PointerEvent('pointerdown', init(from)))
      await sleepMs(320)
      const to = box(find(dest).closest('.file-tree__row'))
      for (let step = 1; step <= 4; step += 1) {
        const point = { x: from.x + (to.x - from.x) * step / 4, y: from.y + (to.y - from.y) * step / 4 }
        document.elementFromPoint(point.x, point.y)?.dispatchEvent(new PointerEvent('pointermove', init(point)))
        await sleepMs(30)
      }
      document.elementFromPoint(to.x, to.y)?.dispatchEvent(new PointerEvent('pointerup', init(to)))
    }, { name, dest, pointerType })
    ok(`${pointerType} drag onto a closed folder moves into it`, await settled(() => onDisk(`${dest}/${name}`)), hasBefore)
  }

  // 13d. A touch that moves before the hold is a scroll, not a drag.
  const before = fs.readdirSync(vault).sort().join(',')
  await page.evaluate(async () => {
    const source = document.querySelector('.file-tree__entry-button[data-path="Loose2.md"]')
    const r = source.getBoundingClientRect()
    const init = (y) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: r.left + 20, clientY: y, button: 0, buttons: 1 })
    source.dispatchEvent(new PointerEvent('pointerdown', init(r.top + 8)))
    source.dispatchEvent(new PointerEvent('pointermove', init(r.top + 60)))
    await new Promise((resolve) => setTimeout(resolve, 600))
    source.dispatchEvent(new PointerEvent('pointerup', init(r.top + 60)))
  })
  await sleep(800)
  ok('a swipe over the list does not move anything', fs.readdirSync(vault).sort().join(',') === before)

  // 14c. Linked folders: a folder dropped on a linked folder, and folders two levels inside one, stay visible.
  await ensureOpen('A')
  fs.mkdirSync(path.join(vault, 'M'))
  await row('M').waitFor()
  await row('M').dragTo(row('A/Linked'))
  ok('folder moved into a linked folder lands in the linked location', await settled(() => fs.existsSync(path.join(external, 'M'))))
  ok('and not into the empty stub in the vault', !onDisk('A/Linked/M'))
  const linked = await treePaths()
  ok('it shows under the linked folder', linked.includes('A/Linked/M'))
  fs.mkdirSync(path.join(external, 'Sub', 'Deep1', 'Deep2'), { recursive: true })
  await sleep(2500)
  const deep = await treePaths()
  ok('folders two levels inside a linked folder show up', deep.includes('A/Linked/Sub/Deep1') && deep.includes('A/Linked/Sub/Deep1/Deep2'), deep.filter((p) => p.startsWith('A/Linked')).join(' '))
  const fast = await page.evaluate(async () => { const out = []; const walk = (list) => list.forEach((e) => { out.push(e.relativePath); if (e.children) walk(e.children) }); walk(await window.fanotes.getFastTree()); return out })
  ok('the fast tree agrees', fast.includes('A/Linked/Sub/Deep1/Deep2'))
} catch (error) {
  ok('run finished', false, `${error.stack}\n${output.slice(-800)}`)
} finally {
  await browser?.close().catch(() => undefined)
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await sleep(800)
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  fs.rmSync(temporary, { recursive: true, force: true })
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.some((pass) => !pass) ? 1 : 0)
