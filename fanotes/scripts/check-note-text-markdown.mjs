// Regression check for Markdown in keyboard text boxes ("Textfeld").
// Part 1: pure logic and the rendered markup (server render, no browser).
// Part 2: real Chromium via playwright-core: rendered while idle, raw while
//         editing, checkbox toggle, and the export clone shows the rendering.
//         Skipped with FANOTES_SKIP_BROWSER=1 or when no browser exists.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'spa',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
})
await server.listen()

// ---- Part 1: logic -------------------------------------------------------
const md = await server.ssrLoadModule('/src/lib/noteTextMarkdown.ts')
assert.equal(md.toggleNoteTextTask('- [ ] eins\n- [x] zwei', 1), '- [x] eins\n- [x] zwei')
assert.equal(md.toggleNoteTextTask('- [ ] eins\n- [x] zwei', 2), '- [ ] eins\n- [ ] zwei')
assert.equal(md.toggleNoteTextTask('Text\n  1. [X] tief', 2), 'Text\n  1. [ ] tief')
assert.equal(md.toggleNoteTextTask('> * [ ] zitiert', 1), '> * [x] zitiert')
assert.equal(md.toggleNoteTextTask('kein [ ] Task', 1), 'kein [ ] Task', 'only list task markers flip')
assert.equal(md.toggleNoteTextTask('- [ ] eins', 5), '- [ ] eins', 'a stale line number is a no-op')
assert.equal(md.openableNoteTextLink('https://example.org/a b'), 'https://example.org/a%20b')
assert.equal(md.openableNoteTextLink('mailto:a@example.org'), 'mailto:a@example.org')
assert.equal(md.openableNoteTextLink('javascript:alert(1)'), null)
assert.equal(md.openableNoteTextLink('file:///etc/passwd'), null)
assert.equal(md.openableNoteTextLink('Notiz.md'), null)

const { NoteTextFieldMarkdown } = await server.ssrLoadModule('/src/components/NoteTextFieldMarkdown.tsx')
const render = (text) => renderToStaticMarkup(createElement(NoteTextFieldMarkdown, { text, onToggleTask: () => {}, onOpenLink: () => {} }))

const html = render([
  '# Titel',
  '## Unter',
  'Ein **fetter** und *kursiver* Satz mit `code` und [Link](https://example.org).',
  '',
  '- Punkt',
  '- [ ] offen',
  '- [x] erledigt',
  '',
  '1. eins',
  '2. zwei',
].join('\n'))
assert.match(html, /<h1>Titel<\/h1>/u)
assert.match(html, /<h2>Unter<\/h2>/u)
assert.match(html, /<strong>fetter<\/strong>/u)
assert.match(html, /<em>kursiver<\/em>/u)
assert.match(html, /<code>code<\/code>/u)
assert.match(html, /<a href="https:\/\/example.org\/"[^>]*>Link<\/a>/u)
assert.match(html, /<ul[^>]*>[\s\S]*<li>Punkt<\/li>/u)
assert.match(html, /<ol>[\s\S]*<li>eins<\/li>[\s\S]*<li>zwei<\/li>/u)
assert.match(html, /role="checkbox" aria-checked="false"[^>]*>[\s\S]*offen/u)
assert.match(html, /role="checkbox" aria-checked="true"[^>]*>[\s\S]*erledigt/u)
assert.doesNotMatch(html, /<input/u, 'task boxes are toggle buttons, not disabled inputs')

// Text written before Markdown support keeps its look.
const legacy = render('Zeile eins\nZeile zwei\n    eingerückt\n<b>nicht fett</b> & 3 < 4')
assert.match(legacy, /Zeile eins<br\/>\s*Zeile zwei<br\/>/u, 'a single line break stays a line break')
assert.doesNotMatch(legacy, /<pre/u, 'indentation never makes a code block')
assert.doesNotMatch(legacy, /<b>/u, 'raw HTML is never interpreted')
assert.match(legacy, /&lt;b&gt;nicht fett&lt;\/b&gt; &amp; 3 &lt; 4/u, 'raw HTML stays visible as text')
const unsafe = render('[x](javascript:alert(1)) ![bild](https://example.org/a.png)')
assert.doesNotMatch(unsafe, /javascript:/u)
assert.doesNotMatch(unsafe, /<img/u, 'text boxes never load images')
console.log('text box markdown logic ok')

// ---- Part 2: browser -----------------------------------------------------
const chromium = process.env.FANOTES_CHROMIUM ?? '/usr/bin/chromium'
const playwrightEntry = process.env.PLAYWRIGHT_CORE ?? '/srv/agents/fanotes/.site-redesign-tools/node_modules/playwright-core/index.mjs'
if (process.env.FANOTES_SKIP_BROWSER === '1' || !existsSync(chromium) || !existsSync(playwrightEntry)) {
  console.log('browser part skipped (no chromium / playwright-core)')
  await server.close()
  process.exit(0)
}
const { chromium: browserType } = await import(pathToFileURL(playwrightEntry).href)

const buildPdf = () => {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const stream = 'BT /F1 24 Tf 60 760 Td (Seite 1) Tj ET'
  objs[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>'
  objs[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const pdfPath = join(mkdtempSync(join(tmpdir(), 'fanotes-text-md-')), 'Markdown.pdf')
writeFileSync(pdfPath, buildPdf())

const address = server.httpServer.address()
const base = `http://127.0.0.1:${address.port}/?web`
const browser = await browserType.launch({ executablePath: chromium, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
const shot = (name) => process.env.FANOTES_SHOT_DIR ? page.screenshot({ path: join(process.env.FANOTES_SHOT_DIR, name) }) : null
const settle = (ms = 350) => page.waitForTimeout(ms)
const TOOL = 'button.toolbar-button[aria-label="Insert text field"]'
const state = () => page.evaluate(() => {
  const area = document.querySelector('[data-note-text-field]')
  const box = area?.closest('.note-text-field')
  const view = box?.querySelector('.note-text-field-render')
  return {
    value: area?.value,
    focused: document.activeElement === area,
    selected: box?.classList.contains('is-selected') ?? false,
    rendered: box?.classList.contains('is-rendered') ?? false,
    areaVisible: area ? getComputedStyle(area).opacity !== '0' : false,
    viewVisible: view ? getComputedStyle(view).display !== 'none' : false,
    h1: view?.querySelector('h1')?.textContent ?? null,
    strong: view?.querySelector('strong')?.textContent ?? null,
    em: view?.querySelector('em')?.textContent ?? null,
    code: view?.querySelector('code')?.textContent ?? null,
    link: view?.querySelector('a[href]')?.getAttribute('href') ?? null,
    bullets: view?.querySelectorAll('ul > li:not(.note-text-md-task)').length ?? 0,
    numbered: view?.querySelectorAll('ol > li').length ?? 0,
    checks: [...(view?.querySelectorAll('.note-text-md-check') ?? [])].map((node) => node.getAttribute('aria-checked')),
  }
})

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const startupSelector = '.first-run-continue, .pdf-import-button'
  await page.waitForSelector(startupSelector, { timeout: 45_000 }).catch(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(startupSelector, { timeout: 90_000 })
  })
  for (let step = 0; step < 6 && await page.locator('.first-run-continue').count(); step += 1) {
    await page.locator('.first-run-continue').first().click()
    await settle(900)
  }
  await page.waitForSelector('button.pdf-import-button', { timeout: 90_000 })
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button.pdf-import-button').first().click()])
  await chooser.setFiles(pdfPath)
  await page.waitForSelector('[data-pdf-page="1"]', { timeout: 40_000 })
  await settle(2500)

  await page.locator(TOOL).click()
  await page.waitForSelector('[data-pdf-page="1"]', { timeout: 20_000 })
  const rect = await page.evaluate(() => {
    const r = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await page.mouse.click(rect.x + rect.w * 0.2, rect.y + rect.h * 0.2)
  await settle()
  const source = '# Titel\nEin **fett** und *kursiv* mit `code` und [Web](https://example.org)\n\n- Punkt\n- [ ] Aufgabe\n\n1. eins\n2. zwei'
  // type line by line: Enter inside the box must stay a newline
  for (const [index, line] of source.split('\n').entries()) {
    if (index) await page.keyboard.press('Enter')
    if (line) await page.keyboard.type(line)
  }
  await settle()
  let now = await state()
  assert.equal(now.value, source, 'the box keeps the raw Markdown')
  assert.equal(now.selected && now.areaVisible && !now.viewVisible, true, 'editing shows the Markdown source')
  await shot('text-md-editing.png')

  await page.keyboard.press('Escape')
  await settle()
  now = await state()
  assert.equal(now.rendered && now.viewVisible && !now.areaVisible, true, 'a finished box shows the rendering')
  assert.equal(now.h1, 'Titel', 'user text is never run through the UI translator')
  assert.equal(now.strong, 'fett')
  assert.equal(now.em, 'kursiv')
  assert.equal(now.code, 'code')
  assert.equal(now.link, 'https://example.org/')
  assert.equal(now.bullets, 1)
  assert.equal(now.numbered, 2)
  assert.deepEqual(now.checks, ['false'])
  await shot('text-md-rendered.png')

  // ticking the task flips the source, without opening the box for typing
  await page.locator('.note-text-md-check').click()
  await settle()
  now = await state()
  assert.ok(now.value.includes('- [x] Aufgabe'), 'the checkbox writes back to the Markdown')
  assert.deepEqual(now.checks, ['true'])
  assert.equal(now.selected, false, 'a tick does not start an edit')

  // the export clone carries the rendering even while the box is being edited
  await page.locator('.note-text-field-render h1').click()
  await settle()
  now = await state()
  assert.equal(now.selected && now.focused && now.areaVisible, true, 'a click on the text opens the editor')
  const exported = await page.evaluate(async () => {
    const { snapshotCloneForCheck } = await import('/src/lib/canvasSnapshot.ts')
    const clone = snapshotCloneForCheck(document.querySelector('.note-text-field'))
    const view = clone.querySelector('.note-text-field-render')
    return {
      raw: clone.textContent.includes('# Titel'),
      textarea: clone.querySelector('textarea, [data-note-text-field]') !== null,
      view: view?.style.display ?? null,
      h1: clone.querySelector('h1')?.textContent ?? null,
      strong: clone.querySelector('strong')?.style.fontWeight ?? null,
      bullet: clone.querySelector('ul > li:not(.note-text-md-task)')?.style.listStyleType ?? null,
      task: clone.querySelector('li.note-text-md-task')?.style.listStyleType ?? null,
    }
  })
  assert.equal(exported.raw, false, 'the export never shows the raw Markdown')
  assert.equal(exported.view, 'block')
  assert.equal(exported.h1, 'Titel')
  assert.equal(exported.strong, '700')
  assert.equal(exported.bullet, 'disc')
  assert.equal(exported.task, 'none')

  // a reload keeps the Markdown and shows it rendered
  await page.keyboard.press('Escape')
  await settle(1500)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.file-tree__entry-button', { timeout: 90_000 })
  await page.locator('.file-tree__entry-button', { hasText: 'Markdown' }).first().click()
  await page.waitForSelector('.note-text-field-render h1', { timeout: 60_000 })
  await settle(800)
  now = await state()
  assert.equal(now.rendered, true)
  assert.deepEqual(now.checks, ['true'], 'the ticked task survives a reload')
  assert.deepEqual(pageErrors, [], 'no page errors')
  console.log('text box markdown browser check ok')
} catch (error) {
  await shot('text-md-failure.png')
  throw error
} finally {
  await browser.close()
  await server.close()
}
