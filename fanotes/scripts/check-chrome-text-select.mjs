import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  CHROME_CONTROL_SELECTOR,
  CHROME_FIELD_SELECTOR,
  CHROME_LABEL_SELECTOR,
  CHROME_SELECT_SUPPRESS_CLASS,
  TOP_CHROME_SELECTORS,
  installChromeTextSelect,
  shouldSuppressChromeSelect,
} = await server.ssrLoadModule('/src/lib/chromeTextSelect.ts')

const closest = (hits) => ({
  closest(selector) {
    return Object.prototype.hasOwnProperty.call(hits, selector) ? hits[selector] : null
  },
})

const runLogic = () => {
  const label = closest({
    [CHROME_FIELD_SELECTOR]: null,
    [CHROME_LABEL_SELECTOR]: true,
    [CHROME_CONTROL_SELECTOR]: null,
  })
  assert.equal(shouldSuppressChromeSelect(label), false)
  assert.equal(shouldSuppressChromeSelect({ nodeType: 3, parentElement: label }), false)

  const field = closest({ [CHROME_FIELD_SELECTOR]: true })
  assert.equal(shouldSuppressChromeSelect(field), false)

  const control = closest({
    [CHROME_FIELD_SELECTOR]: null,
    [CHROME_LABEL_SELECTOR]: true,
    [CHROME_CONTROL_SELECTOR]: true,
  })
  assert.equal(shouldSuppressChromeSelect(control), true)
  assert.equal(shouldSuppressChromeSelect(closest({})), true)
  assert.equal(shouldSuppressChromeSelect(null), true)

  const classes = new Set()
  let flushed = 0
  let raf = null
  const root = {
    classList: {
      toggle(name, force) {
        const on = Boolean(force)
        if (on) classes.add(name)
        else classes.delete(name)
        return on
      },
      remove(name) { classes.delete(name) },
      contains(name) { return classes.has(name) },
    },
    get offsetWidth() { flushed += 1; return 1 },
  }
  const owner = {
    documentElement: root,
    defaultView: { requestAnimationFrame(fn) { raf = fn; return 1 } },
    addEventListener(type, fn) { owner.listeners[type] = fn },
    removeEventListener(type) { delete owner.listeners[type] },
    listeners: {},
  }
  const stop = installChromeTextSelect(owner)
  owner.listeners.pointerdown({ button: 0, target: closest({}) })
  assert.equal(classes.has(CHROME_SELECT_SUPPRESS_CLASS), true)
  assert.ok(flushed >= 1)
  owner.listeners.pointerdown({ button: 0, target: label })
  assert.equal(classes.has(CHROME_SELECT_SUPPRESS_CLASS), false)
  owner.listeners.pointerdown({ button: 0, target: closest({}) })
  owner.listeners.pointerup()
  assert.equal(classes.has(CHROME_SELECT_SUPPRESS_CLASS), true)
  raf()
  assert.equal(classes.has(CHROME_SELECT_SUPPRESS_CLASS), false)
  owner.listeners.pointerdown({ button: 2, target: closest({}) })
  assert.equal(classes.has(CHROME_SELECT_SUPPRESS_CLASS), false)
  stop()
  assert.equal(owner.listeners.pointerdown, undefined)

  const suppressStart = css.indexOf('html.is-suppress-chrome-select')
  assert.ok(suppressStart >= 0)
  const suppress = css.slice(suppressStart, css.indexOf('.toolbar-button {', suppressStart))
  for (const selector of TOP_CHROME_SELECTORS) assert.ok(suppress.includes(selector), selector)
  assert.match(suppress, /user-select:\s*none/)
  assert.doesNotMatch(suppress, /pdf-note-text-layer|\.cm-content|#fff|#f1f2f6|249,\s*249,\s*252/)
  assert.match(appSource, /installChromeTextSelect\(\)/)
  assert.match(css, /(?<!is-inking )\.pdf-note-text-layer :is\(span, br\) \{[^}]*user-select:\s*text/)
  const ribbonStart = css.indexOf('.toolbar-context .pdf-note-toolbar {')
  const ribbonEnd = css.indexOf('.toolbar-group {', ribbonStart)
  assert.doesNotMatch(css.slice(ribbonStart, ribbonEnd), /is-suppress-chrome-select/)
}

const center = (box, dx = 0.5, dy = 0.5) => ({
  x: box.x + box.width * dx,
  y: box.y + box.height * dy,
})

const browserSelect = async (bundle) => {
  const dir = mkdtempSync(join(tmpdir(), 'fanotes-chrome-select-'))
  const htmlPath = join(dir, 'fixture.html')
  const profile = join(dir, 'profile')
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css.replaceAll('</style', '<\\/style')}
#pad { width: 90px; height: 32px; }
#page { width: 160px !important; text-align: left !important; }
#sheet { position: relative; height: 64px; margin: 20px; }
#glyph { left: 8px; top: 10px; color: #111 !important; font-size: 20px !important; }
#doc { margin: 16px; font-size: 18px; }
</style></head><body>
<nav class="ribbon"><div class="ribbon-brand"><span id="mark-f">F</span><strong id="brand">FaNotes</strong></div>
<button type="button" id="ribbon-btn">Notizen</button></nav>
<div class="editor-toolbar is-type"><div class="toolbar-context">
<header class="pdf-note-toolbar" id="bar">
<span class="pdf-note-identity"><strong id="name">Kapitel.pdf</strong><small id="pages">12 Seiten</small></span>
<div id="pad"></div>
<span class="pdf-note-pager"><input id="page" value="Seite 12"><span id="count">/ 12</span></span>
<button type="button" id="mark">Markieren</button>
</header></div></div>
<p id="doc">Document sentence stays selectable.</p>
<div id="sheet"><div class="pdf-note-text-layer"><span id="glyph">Glyphword</span></div></div>
<script type="module">
${bundle}
installChromeTextSelect()
</script>
</body></html>`
  writeFileSync(htmlPath, html)
  const chrome = spawn('/usr/bin/chromium', [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1200,800',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chromium debug port missing\n${stderr}`)), 15000)
    chrome.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      const match = stderr.match(/127\.0\.0\.1:(\d+)\//)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    chrome.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`chromium exited ${code}\n${stderr}`))
    })
  })
  const openPage = async () => {
    const url = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`file://${htmlPath}`)}`
    let response = await fetch(url, { method: 'PUT' })
    if (!response.ok) response = await fetch(url, { method: 'GET' })
    if (!response.ok) throw new Error(`json/new ${response.status}`)
    return response.json()
  }
  try {
    const page = await openPage()
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', () => reject(new Error('devtools socket failed')))
    })
    let nextId = 0
    const pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !pending.has(message.id)) return
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Runtime.evaluate', {
      expression: 'new Promise((resolve) => { if (document.readyState === "complete") resolve(0); else window.addEventListener("load", () => resolve(0), { once: true }) })',
      awaitPromise: true,
    })
    const evalJson = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const boxes = await evalJson(`(() => {
      const box = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      return JSON.stringify({
        name: box('name'), doc: box('doc'), pad: box('pad'), page: box('page'), glyph: box('glyph'), brand: box('brand'),
      })
    })()`)
    const rects = JSON.parse(boxes)
    const drag = async (from, to) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
      for (let step = 1; step <= 6; step += 1) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + (to.x - from.x) * step / 6,
          y: from.y + (to.y - from.y) * step / 6,
          button: 'left',
          buttons: 1,
        })
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
      await evalJson('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(0))))')
    }
    const selection = () => evalJson('getSelection().toString()')
    const clear = () => evalJson('getSelection().removeAllRanges(); document.getElementById("page").blur(); 0')
    const suppressed = () => evalJson(`document.documentElement.classList.contains(${JSON.stringify(CHROME_SELECT_SUPPRESS_CLASS)})`)

    await clear()
    await drag(center(rects.doc), center(rects.name))
    const fromDocument = await selection()
    assert.ok(fromDocument.includes('selectable'), fromDocument)
    assert.ok(!fromDocument.includes('Kapitel'), fromDocument)
    assert.ok(!fromDocument.includes('FaNotes'), fromDocument)
    assert.equal(await suppressed(), false)

    await clear()
    await drag(center(rects.pad), center(rects.name))
    const fromPad = await selection()
    assert.ok(!fromPad.includes('Kapitel'), fromPad)

    await clear()
    await drag(
      { x: rects.name.x + 1, y: rects.name.y + rects.name.height / 2 },
      { x: rects.name.x + rects.name.width - 1, y: rects.name.y + rects.name.height / 2 },
    )
    const fromLabel = await selection()
    assert.match(fromLabel, /Kapitel|apitel/)
    assert.equal(await suppressed(), false)

    await clear()
    await drag(
      { x: rects.brand.x + 1, y: rects.brand.y + rects.brand.height / 2 },
      { x: rects.brand.x + rects.brand.width - 1, y: rects.brand.y + rects.brand.height / 2 },
    )
    const fromBrand = await selection()
    assert.match(fromBrand, /FaNotes|aNote/)

    await clear()
    await drag(center(rects.glyph), center(rects.name))
    const fromGlyph = await selection()
    assert.match(fromGlyph, /Glyph|selectable/)
    assert.ok(!fromGlyph.includes('Kapitel'), fromGlyph)
    assert.ok(!fromGlyph.includes('FaNotes'), fromGlyph)

    await clear()
    const inputBox = rects.page
    const inputProbe = await evalJson(`(() => {
      const field = document.getElementById('page')
      const style = getComputedStyle(field)
      const rect = field.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width * 0.2, rect.y + rect.height / 2)
      return JSON.stringify({
        width: rect.width,
        align: style.textAlign,
        userSelect: style.userSelect,
        hit: hit ? (hit.id || hit.tagName) : null,
        suppressed: document.documentElement.classList.contains(${JSON.stringify(CHROME_SELECT_SUPPRESS_CLASS)}),
      })
    })()`)
    await drag(center(inputBox, 0.05), center(inputBox, 0.95))
    const field = await evalJson(`(() => {
      const field = document.getElementById('page')
      return JSON.stringify({ start: field.selectionStart, end: field.selectionEnd, text: field.value.slice(field.selectionStart, field.selectionEnd) })
    })()`)
    const picked = JSON.parse(field)
    assert.ok(picked.end > picked.start, JSON.stringify({ picked, inputProbe }))
    assert.ok(picked.text.length > 0, JSON.stringify(picked))

    ws.close()
    return { fromDocument, fromPad, fromLabel, fromBrand, fromGlyph, field: picked.text }
  } finally {
    if (chrome.exitCode === null) chrome.kill('SIGTERM')
    await new Promise((resolve) => {
      if (chrome.exitCode !== null) resolve()
      else {
        chrome.once('exit', resolve)
        setTimeout(() => {
          if (chrome.exitCode === null) chrome.kill('SIGKILL')
          resolve()
        }, 2000)
      }
    })
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })
    } catch {
      // A locked profile directory must not hide the selection result.
    }
  }
}

try {
  runLogic()
  runLogic()
  const transformed = await server.transformRequest('/src/lib/chromeTextSelect.ts')
  assert.ok(transformed?.code?.includes('shouldSuppressChromeSelect'))
  const browser = await browserSelect(transformed.code)
  console.log(JSON.stringify(browser))
  console.log('chrome-text-select ok')
} finally {
  await server.close()
}
