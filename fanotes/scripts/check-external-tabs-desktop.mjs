// Open notes against outside changes, in the real desktop app (Electron under Xvfb):
// a note renamed outside FaNotes (the tab follows), deleted (banner, no
// resurrection by autosave, restore), edited with a clean tab (reload) and
// edited with unsaved text (neither side is overwritten; both choices keep a copy).
// Needs a built renderer (`npm run build:web` or `vite build`) and xvfb-run.
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
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-external-tabs-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'Deutsch')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
const notes = { rename: 'Umbenennen', del: 'Loeschen', clean: 'Sauber', mine: 'Meine', theirs: 'Externe', fast: 'Schnell' }
for (const name of Object.values(notes)) fs.writeFileSync(path.join(vault, `${name}.md`), `# ${name}\n\nAnfang ${name}.\n`)
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: { uiLanguage: 'de', autoCheckUpdates: false, autoDownloadUpdates: false, reduceMotion: true },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

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

  const open = async (stem) => {
    await page.locator('.file-tree__row', { hasText: stem }).first().locator('.file-tree__entry-button').click()
    await page.locator('.cm-content', { hasText: `Anfang ${stem}` }).waitFor({ timeout: 15_000 })
  }
  const editorText = () => page.locator('.cm-content').first().innerText()
  const type = async (text) => {
    await page.locator('.cm-content').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(text)
  }
  const waitSaved = (name, needle) => until(() => read(name).includes(needle))

  // 1. Renamed outside: the tab follows the file and the next autosave goes to the new name.
  await open(notes.rename)
  fs.renameSync(path.join(vault, 'Umbenennen.md'), path.join(vault, 'Neuer Name.md'))
  ok('rename: the tab retargets to the new name', await until(async () => (await page.locator('.note-tab-main', { hasText: 'Neuer Name' }).count()) > 0 && (await page.locator('.note-tab-main', { hasText: 'Umbenennen' }).count()) === 0))
  await type(' Nach dem Umbenennen.')
  ok('rename: typing saves into the renamed file', await waitSaved('Neuer Name.md', 'Nach dem Umbenennen.'))
  ok('rename: the old name does not come back', !files().includes('Umbenennen.md'), files().join(','))

  // 2. Deleted outside: banner, text stays, autosave must not recreate the file.
  await open(notes.del)
  // Typed just before the deletion: the autosave timer is still pending when the file vanishes (a paused tab is read-only).
  await type(' Nach dem Loeschen getippt.')
  fs.rmSync(path.join(vault, 'Loeschen.md'))
  ok('delete: the banner appears', await until(async () => (await page.locator('.external-banner.is-deleted').count()) > 0))
  await sleep(3500)
  ok('delete: autosave does not resurrect the file', !files().some((file) => file.startsWith('Loeschen')), files().join(','))
  ok('delete: the typed text stays in the tab', (await editorText()).includes('Nach dem Loeschen getippt.'))
  await page.locator('.external-banner button', { hasText: 'Wiederherstellen' }).click()
  ok('delete: restore writes the tab text back', await waitSaved('Loeschen.md', 'Nach dem Loeschen getippt.'), files().join(','))

  // 3. Edited outside, nothing unsaved: silent reload.
  await open(notes.clean)
  fs.writeFileSync(path.join(vault, 'Sauber.md'), '# Sauber\n\nAnfang Sauber.\nExtern ergaenzt.\n')
  ok('edit, clean tab: the new text is loaded', await until(async () => (await editorText()).includes('Extern ergaenzt.')))
  ok('edit, clean tab: no banner and no copy', (await page.locator('.external-banner').count()) === 0 && !copiesOf('Sauber').length)

  // 4. Edited outside with unsaved text, keep mine.
  await open(notes.mine)
  await type(' Meine Zeile.')
  fs.writeFileSync(path.join(vault, 'Meine.md'), '# Meine\n\nAnfang Meine.\nExterne Zeile A.\n')
  ok('conflict: the banner appears', await until(async () => (await page.locator('.external-banner.is-conflict').count()) > 0))
  await sleep(3000)
  ok('conflict: the file keeps the outside text while undecided', read('Meine.md').includes('Externe Zeile A.') && !read('Meine.md').includes('Meine Zeile.'))
  ok('conflict: the tab keeps the typed text', (await editorText()).includes('Meine Zeile.'))
  await page.locator('.external-banner button', { hasText: 'Meine Fassung behalten' }).click()
  ok('conflict, keep mine: the file holds the typed text', await waitSaved('Meine.md', 'Meine Zeile.'))
  ok('conflict, keep mine: the outside text is kept as a copy', await until(() => copiesOf('Meine').some((file) => read(file).includes('Externe Zeile A.'))), copiesOf('Meine').join(','))

  // 5. Edited outside with unsaved text, load external.
  await open(notes.theirs)
  await type(' Zweite eigene Zeile.')
  fs.writeFileSync(path.join(vault, 'Externe.md'), '# Externe\n\nAnfang Externe.\nExterne Zeile B.\n')
  ok('conflict 2: the banner appears', await until(async () => (await page.locator('.external-banner.is-conflict').count()) > 0))
  await page.locator('.external-banner button', { hasText: 'Externe Fassung laden' }).click()
  ok('conflict, load external: the tab shows the outside text', await until(async () => (await editorText()).includes('Externe Zeile B.')))
  ok('conflict, load external: the typed text is kept as a copy', await until(() => copiesOf('Externe').some((file) => read(file).includes('Zweite eigene Zeile.'))), copiesOf('Externe').join(','))
  ok('conflict, load external: the file still holds the outside text', read('Externe.md').includes('Externe Zeile B.') && !read('Externe.md').includes('Zweite eigene'))

  // 6. Typing right after an outside edit (before any watcher event can be handled): neither side may be lost.
  await open(notes.fast)
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+End')
  fs.writeFileSync(path.join(vault, 'Schnell.md'), '# Schnell\n\nAnfang Schnell.\nExterne Zeile C.\n')
  await page.keyboard.type(' Sofort getippt.')
  await sleep(4000)
  const fast = read('Schnell.md')
  const fastCopies = copiesOf('Schnell').map(read).join('\n')
  const keptOutside = fast.includes('Externe Zeile C.') || fastCopies.includes('Externe Zeile C.')
  const keptTyped = fast.includes('Sofort getippt.') || fastCopies.includes('Sofort getippt.') || (await editorText()).includes('Sofort getippt.')
  ok('first keystroke: the outside edit survives', keptOutside, fast.slice(0, 120))
  ok('first keystroke: the typed text survives', keptTyped)
  ok('first keystroke: the file was not silently overwritten', !(fast.includes('Sofort getippt.') && !fast.includes('Externe Zeile C.') && !fastCopies.includes('Externe Zeile C.')))
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
