// Writing mode in the real desktop app (Electron under Xvfb): create a story
// in the tree, type, save, check the files on disk, reopen; and check that the
// story file channels refuse anything outside a `.story` folder.
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
const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-writing-desktop-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
for (const directory of [home, configHome, runtime, vault, userData, path.join(vault, 'Deutsch')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(vault, 'Deutsch', 'Aufsatz.md'), '# Aufsatz\n')
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
  // Its own process group, so Xvfb and Electron end together with the test.
  detached: true,
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const results = []
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` → ${String(detail).slice(0, 240)}` : ''}`) }

let browser
try {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
    if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${output.slice(-500)}`)
  }
  assert.ok(browser, 'Electron did not open a debugging port')
  let page = null
  for (let tries = 0; tries < 120 && !page; tries += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => !/^devtools|ocr-host|recognition\.html|fanotes-note-export/u.test(candidate.url())) ?? null
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(page, 'no renderer page')
  await page.waitForFunction(() => Boolean(window.fanotes && document.querySelector('.file-tree__row')), null, { timeout: 60_000 })
  ok('the desktop app exposes the story channels', await page.evaluate(() => ['storyRead', 'storyWrite', 'storyList', 'storyCreate'].every((name) => typeof window.fanotes[name] === 'function')))

  // The channels refuse anything that is not inside a .story folder.
  const refusals = await page.evaluate(async () => {
    const attempts = [
      () => window.fanotes.storyWrite('Deutsch/Aufsatz.md', '# überschrieben'),
      () => window.fanotes.storyRead('Deutsch/Aufsatz.md'),
      () => window.fanotes.storyWrite('../ausserhalb.story/story.json', '{}'),
      () => window.fanotes.storyWrite('Fehlt.story/story.json', '{}'),
      () => window.fanotes.storyWrite('X.story/../../Deutsch/Aufsatz.json', '{}'),
      () => window.fanotes.storyList('Deutsch'),
    ]
    const out = []
    for (const attempt of attempts) {
      try { await attempt(); out.push('allowed') } catch { out.push('refused') }
    }
    return out
  })
  ok('story channels refuse paths outside a .story folder', refusals.every((value) => value === 'refused'), refusals.join(','))
  ok('the note next to it is untouched', fs.readFileSync(path.join(vault, 'Deutsch', 'Aufsatz.md'), 'utf8') === '# Aufsatz\n')

  // Create a story from the folder menu and write in it.
  const folder = page.locator('.file-tree__row[data-kind="folder"]', { hasText: 'Deutsch' }).first()
  await folder.hover()
  await folder.locator('button[aria-haspopup="menu"]').click({ force: true })
  await page.locator('.file-tree__context-menu button', { hasText: 'Neue Geschichte' }).click()
  await page.locator('.wm-page').first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(800)
  await page.locator('.wm-page').first().click({ position: { x: 200, y: 320 } })
  await page.keyboard.type('Auf dem Desktop geschrieben.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Zweiter Absatz mit Umlauten: äöü ß.')
  // A footnote and a comment through the in-app dialog (Electron has no window.prompt).
  await page.keyboard.press('Control+Shift+O')
  await page.locator('.wm-dialog textarea').fill('Quelle: eigenes Tagebuch.')
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(400)
  ok('a footnote number appears in the text', await page.evaluate(() => [...document.querySelectorAll('.wm-fn-ref')].some((span) => span.textContent === '1')))
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Control+Shift+M')
  await page.locator('.wm-dialog textarea').fill('Klingt zu brav.')
  await page.locator('.wm-dialog button[type="submit"]').click()
  await page.waitForTimeout(1500)
  const storyDir = path.join(vault, 'Deutsch', 'Neue Geschichte.story')
  ok('the story folder exists on disk', fs.existsSync(path.join(storyDir, 'story.json')))
  const sceneFiles = fs.existsSync(path.join(storyDir, 'scenes')) ? fs.readdirSync(path.join(storyDir, 'scenes')) : []
  const sceneText = sceneFiles.map((file) => fs.readFileSync(path.join(storyDir, 'scenes', file), 'utf8')).join('\n')
  ok('the typed text is saved in the scene file', sceneText.includes('Auf dem Desktop geschrieben.') && sceneText.includes('äöü ß'), sceneFiles.join(','))
  const manifest = JSON.parse(fs.readFileSync(path.join(storyDir, 'story.json'), 'utf8'))
  ok('story.json is a valid manifest', manifest.format === 'fanotes-story-v1' && manifest.binder.length === 1)
  const savedScene = JSON.parse(sceneText.split('\n')[0])
  ok('the footnote and the comment are saved', Object.values(savedScene.footnotes ?? {}).some((note) => note.runs[0]?.text === 'Quelle: eigenes Tagebuch.') && Object.values(savedScene.comments ?? {}).some((comment) => comment.text === 'Klingt zu brav.'))
  ok('edited paragraphs carry a version vector', savedScene.paragraphs.every((paragraph) => Object.values(paragraph.v).every((count) => count >= 1)))

  // Close: the tree shows the story as one document; reopen keeps the text.
  await page.locator('.wm-toolbar button').first().click()
  await page.locator('.wm-root').waitFor({ state: 'detached' })
  await page.waitForTimeout(600)
  if (!(await page.locator('.file-tree__row', { hasText: 'Neue Geschichte' }).count())) await folder.locator('.file-tree__entry-button').click()
  const storyRows = page.locator('.file-tree__row', { hasText: 'Neue Geschichte' })
  ok('the tree lists the story once, not its folder contents', (await storyRows.count()) === 1 && !(await page.locator('.file-tree__row', { hasText: 'scenes' }).count()))
  await storyRows.first().locator('.file-tree__entry-button').click()
  await page.locator('.wm-page').first().waitFor()
  await page.waitForTimeout(600)
  const words = await page.evaluate(() => [...document.querySelectorAll('.wm-line span')].map((span) => span.textContent).join(' '))
  ok('reopened, the text is there', words.includes('Desktop') && words.includes('Umlauten:'), words.slice(0, 160))
  const shots = process.env.WRITING_SHOTS
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-writing.png') })
} catch (error) {
  ok('run finished', false, `${error.stack}\n${output.slice(-800)}`)
} finally {
  await browser?.close().catch(() => undefined)
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await new Promise((resolve) => setTimeout(resolve, 800))
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  fs.rmSync(temporary, { recursive: true, force: true })
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.some((pass) => !pass) ? 1 : 0)
