// Regression checks for the Linux QA findings QA-002 (image paths), QA-004 (Ctrl+Shift+Z redo),
// QA-005 (rich HTML paste) and QA-018 (generated heading follows a rename).
// The browser part reuses scripts/table-harness (the real MarkdownEditor); skipped with FANOTES_SKIP_BROWSER=1.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root, appType: 'spa', logLevel: 'error', cacheDir: mkdtempSync(join(tmpdir(), 'fanotes-linux-editor-vite-')),
  server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
})
await server.listen()
try {
  const paths = await server.ssrLoadModule('/src/lib/noteImagePaths.ts')
  assert.deepEqual(paths.imageCandidates('img.png', 'Assets/Note.md'), ['Assets/img.png', 'img.png'], 'note folder first, vault root as fallback')
  assert.deepEqual(paths.imageCandidates('../x/img.png', 'Assets/Note.md'), ['x/img.png'])
  assert.deepEqual(paths.imageCandidates('/Assets/img.png', 'Deep/er/Note.md'), ['Assets/img.png'], 'leading slash is vault-root absolute')
  assert.deepEqual(paths.imageCandidates('Assets/img.png', 'Note.md'), ['Assets/img.png'])
  assert.deepEqual(paths.imageCandidates('../../secret.png', 'A/Note.md'), [], 'cannot climb out of the vault')
  assert.deepEqual(paths.imageCandidates('../../secret.png', 'Note.md'), [])
  assert.equal(paths.isLocalImageSource('https://x/y.png'), false)
  assert.equal(paths.isLocalImageSource('//host/share/y.png'), false)
  assert.equal(paths.isLocalImageSource('../a/b.JPG'), true)

  const heading = await server.ssrLoadModule('/src/lib/autoHeading.ts')
  assert.equal(heading.retitleGeneratedHeading('# Unbenannte Notiz\n\ntext', 'Unbenannte Notiz', 'Physik'), '# Physik\n\ntext')
  assert.equal(heading.retitleGeneratedHeading('# Untitled note\r\n\r\nx', 'Untitled note', 'Physik'), '# Physik\r\n\r\nx')
  assert.equal(heading.retitleGeneratedHeading('# My own title\n', 'Unbenannte Notiz', 'Physik'), null, 'a heading the user wrote stays')
  assert.equal(heading.retitleGeneratedHeading('# Unbenannte Notiz', 'Unbenannte Notiz', 'Unbenannte Notiz'), null)

  const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
  const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
  if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
    console.log('linux editor pure checks ok; browser part skipped')
  } else {
    const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)
    const base = `http://127.0.0.1:${server.httpServer.address().port}/scripts/table-harness/index.html`
    const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    try {
      const page = await (await browser.newContext()).newPage()
      const text = () => page.evaluate(() => window.__text())
      const paste = async (html, plain = 'plain text') => {
        await page.evaluate(({ html: h, plain: p }) => {
          const data = new DataTransfer()
          if (h) data.setData('text/html', h)
          data.setData('text/plain', p)
          const target = document.querySelector('.cm-content')
          target.focus()
          target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        }, { html, plain })
      }
      const fresh = async () => {
        await page.goto(`${base}?content=`, { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('.cm-content')
        await page.focus('.cm-content')
      }

      // QA-005
      await fresh()
      await paste('<h2>Titel</h2><p>Ein <b>fetter</b> und <i>schiefer</i> Text mit <a href="https://example.org/a_b">Link</a>, <s>weg</s> und <code>x*y</code>.</p><ul><li>eins</li><li>zwei<ul><li>innen</li></ul></li></ul><ol><li>a</li><li>b</li></ol><blockquote><p>Zitat</p></blockquote><pre>l1\nl2</pre><script>alert(1)</script><img src=x onerror="alert(2)">')
      const rich = await text()
      for (const part of ['## Titel', 'Ein **fetter** und *schiefer* Text mit [Link](https://example.org/a_b), ~~weg~~ und `x*y`.', '- eins\n- zwei\n  - innen', '1. a\n2. b', '> Zitat', '```\nl1\nl2\n```']) {
        assert.ok(rich.includes(part), `rich paste has ${JSON.stringify(part)}: ${JSON.stringify(rich)}`)
      }
      assert.ok(!/alert|onerror|script/u.test(rich), 'script and handlers are stripped')
      await fresh()
      await paste('<meta charset="utf-8"><div><span style="font-weight:700">Word</span> <span style="font-style:italic">kursiv</span></div><p class=MsoListParagraph style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·</span>Punkt A</p><p class=MsoListParagraph style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o</span>Unterpunkt</p>')
      const word = await text()
      assert.ok(word.includes('**Word** *kursiv*') && word.includes('- Punkt A\n  - Unterpunkt'), `word paste: ${JSON.stringify(word)}`)
      await fresh()
      await paste('<span style="color:red">just styled</span>', 'just styled')
      assert.equal(await text(), 'just styled', 'HTML without structure keeps the plain-text paste')
      await fresh()
      await page.keyboard.press('Control+Shift+V')
      await paste('<b>fett</b>', 'fett')
      assert.equal(await text(), 'fett', 'Ctrl+Shift+V pastes the plain text, not **fett**')

      // QA-004
      await fresh()
      await page.keyboard.type('alpha')
      await page.waitForTimeout(700)
      await page.keyboard.type(' beta')
      await page.keyboard.press('Control+z')
      const undone = await text()
      assert.ok(undone.length < 'alpha beta'.length, `undo: ${JSON.stringify(undone)}`)
      await page.keyboard.press('Control+Shift+Z')
      assert.equal(await text(), 'alpha beta', 'Ctrl+Shift+Z redoes')
      await page.keyboard.press('Control+z')
      await page.keyboard.press('Control+y')
      assert.equal(await text(), 'alpha beta', 'Ctrl+Y still redoes')
    } finally {
      await browser.close()
    }
  }
  console.log('linux editor checks ok')
} finally {
  await server.close()
}
