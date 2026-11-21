// The live co-editing binding in real Chromium: three MarkdownEditors (two writers, one read-only reader) on one shared
// note through an in-page relay. Concurrent typing, remote cursors with names, per-user undo, the editor reporting merged
// text for autosave, external (file watcher) content updates without loops or duplicates, and read-only receiving.
// Skipped with FANOTES_SKIP_BROWSER=1 or without a browser.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('live collaboration editor check skipped (no chromium / playwright-core)')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  cacheDir: mkdtempSync(join(tmpdir(), 'fanotes-live-vite-')),
  server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
})
await server.listen()
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 700 }, locale: 'en-US' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/live-collab-harness/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__ready === true && document.querySelectorAll('.cm-editor').length === 3, null, { timeout: 30_000 })
  // The live extension is added after a dynamic import; wait until the first editor reports the shared text and is bound.
  const focusEditor = (name) => page.evaluate((who) => { const index = window.__peers.findIndex((peer) => peer.name === who); window.__views()[index].focus() }, name)
  const text = (index) => page.evaluate((i) => window.__text(i), index)
  const same = async (what) => {
    await page.waitForFunction(() => { const [a, b, c] = [0, 1, 2].map((i) => window.__text(i)); return a === b && b === c }, null, { timeout: 5000 }).catch(() => undefined)
    const [a, b, c] = [await text(0), await text(1), await text(2)]
    assert.equal(b, a, `${what}: Ben matches Anna`)
    assert.equal(c, a, `${what}: the reader matches too`)
    return a
  }
  await page.waitForTimeout(800)
  assert.equal(await same('joined'), 'Titel\n\nErster Absatz.\n')

  // Typing in one editor appears in the others (real keyboard events).
  await focusEditor('Anna_F')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Anna tippt. ')
  await page.waitForFunction(() => window.__text(1).includes('Anna tippt. ') && window.__text(2).includes('Anna tippt. '), null, { timeout: 3000 })
  const arrived = await page.evaluate(() => { const start = performance.now(); return start })
  void arrived

  // Concurrent edits in the same tick from both writers merge without loss.
  await page.evaluate(() => {
    const [a, b] = window.__views()
    a.dispatch({ changes: { from: 0, insert: 'AAA ' }, userEvent: 'input.type' })
    b.dispatch({ changes: { from: b.state.doc.length, insert: ' BBB' }, userEvent: 'input.type' })
  })
  const merged = await same('concurrent')
  assert.ok(merged.startsWith('AAA Titel'), merged)
  assert.ok(merged.endsWith(' BBB'), merged)
  assert.equal(merged.split('AAA').length - 1, 1)
  assert.equal(merged.split('BBB').length - 1, 1)

  // The editor reports merged text to the app (autosave) exactly as for local typing.
  await page.waitForTimeout(300)
  const bChanges = await page.evaluate(() => window.__changes(1))
  assert.ok(bChanges.some((value) => value.startsWith('AAA Titel')), 'Ben\'s editor reported Anna\'s edit to the app')

  // Remote cursor with a name appears in the other editor.
  await focusEditor('Ben_K')
  await page.keyboard.press('Control+Home')
  await page.waitForSelector('[data-peer="Anna_F"] .cm-ySelectionCaret', { timeout: 3000 })
  const label = await page.textContent('[data-peer="Anna_F"] .cm-ySelectionCaret .cm-ySelectionInfo')
  assert.equal(label?.trim(), 'Ben_K', 'the other person\'s caret carries their username')
  await page.waitForSelector('[data-peer="Cleo_R"] .cm-ySelectionCaret', { timeout: 3000 })

  // Undo is per user: Anna's undo removes only Anna's last edit.
  await page.evaluate(() => {
    const [a, b] = window.__views()
    a.dispatch({ changes: { from: a.state.doc.length, insert: ' ANNA-LAST' }, userEvent: 'input.type' })
    b.dispatch({ changes: { from: 0, insert: 'BEN-LAST ' }, userEvent: 'input.type' })
  })
  await same('before undo')
  await focusEditor('Anna_F')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(400)
  const afterUndo = await same('after undo')
  assert.ok(!afterUndo.includes('ANNA-LAST'), 'Anna\'s own edit was undone')
  assert.ok(afterUndo.includes('BEN-LAST'), 'Ben\'s edit survived Anna\'s undo')

  // The reader receives live text but cannot change anything.
  assert.equal(await page.getAttribute('[data-peer="Cleo_R"] .cm-content', 'contenteditable'), 'false', 'a read-only editor is not editable')
  assert.equal(await page.getAttribute('[data-peer="Ben_K"] .cm-content', 'contenteditable'), 'true')
  // Even a programmatic edit on a reader never leaves the device.
  await page.evaluate(() => { const view = window.__views()[2]; view.dispatch({ changes: { from: 0, insert: 'READER-ATTEMPT' } }) })
  await page.waitForTimeout(400)
  assert.ok(!(await text(0)).includes('READER-ATTEMPT') && !(await text(1)).includes('READER-ATTEMPT'), 'a read-only edit is never sent')
  await page.evaluate(() => { const view = window.__views()[2]; view.dispatch({ changes: { from: 0, to: 'READER-ATTEMPT'.length, insert: '' } }) })

  // A file-watcher style update of the content prop that equals the live text changes nothing (no loop, no duplicate).
  const posts = await page.evaluate(() => window.__posts())
  await page.evaluate(() => window.__setContent(1, window.__text(1)))
  await page.waitForTimeout(400)
  assert.equal(await text(1), afterUndo)
  assert.equal(await page.evaluate(() => window.__posts()), posts, 'echoing the editor\'s own text back sends nothing')
  // An external change (a pulled file) becomes one ordinary edit that reaches the others exactly once.
  await page.evaluate(() => window.__setContent(1, `${window.__text(1)}\nVon der Datei.`))
  await page.waitForFunction(() => window.__text(0).endsWith('Von der Datei.'), null, { timeout: 3000 })
  const final = await same('file update')
  assert.equal(final.split('Von der Datei.').length - 1, 1)

  // Idle: nothing is sent while nobody types.
  const idle = await page.evaluate(() => window.__posts())
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => window.__posts()), idle, 'no traffic while idle')

  assert.deepEqual(errors, [], 'no page errors')
  console.log('live collaboration editor checks passed')
} finally {
  await browser.close()
  await server.close()
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref()
}
