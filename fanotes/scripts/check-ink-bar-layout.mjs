import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2]
if (outDir) mkdirSync(outDir, { recursive: true })

const pageCss = readFileSync(join(root, 'src/styles.css'), 'utf8')
  .replaceAll('</style', '<\\/style')
  .replaceAll('</script', '<\\/script')
const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const start = board.indexOf('const drawingBoardStyles = `')
const end = board.indexOf('`\n', start + 30)
if (start < 0 || end < 0) throw new Error('drawingBoardStyles not found')
const boardCss = board.slice(start + 'const drawingBoardStyles = `'.length, end)
  .replaceAll('</style', '<\\/style')
  .replaceAll('</script', '<\\/script')

const icon = '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16" stroke="currentColor" stroke-width="2"/></svg>'
const colors = ['#191c24', '#3d52d5', '#7654d6', '#d74769', '#df7627', '#138d75']
const chips = colors.map((color, index) => (
  `<button type="button" class="${index === 1 ? 'is-active' : ''}" style="--ink-color:${color}" aria-label="Farbe ${color}"></button>`
)).join('')
const tool = (label, active = false) => (
  `<button type="button" class="${active ? 'is-active' : ''}" aria-label="${label}">${icon} <span class="lw-tool-label">${label}</span></button>`
)

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${pageCss}
${boardCss}
body.bar-fixture { min-width: 0; margin: 0; }
.bar-fixture .app-body { grid-template-columns: minmax(0, 1fr); }
</style></head><body class="bar-fixture">
<div class="app-shell">
  <nav class="ribbon" aria-label="Hauptnavigation"><div class="ribbon-brand"><span>F</span><strong>FaNotes</strong></div></nav>
  <div class="app-body"><main class="workspace">
    <div class="tabs-bar"><b>Notiz</b></div>
    <div class="editor-toolbar is-ink">
      <div class="mode-switch" role="group" aria-label="Eingabemodus">
        <button type="button">${icon}<span>Tastatur</span></button>
        <button type="button" class="is-active">${icon}<span>Stift</span></button>
      </div>
      <div class="toolbar-context"><div class="ink-toolbar-slot">
        <div class="lw-draw-toolbar is-docked-chrome" aria-label="Zeichenwerkzeuge">
          <div class="lw-draw-toolgroup lw-segmented">
            ${tool('Schreiben', true)}
            ${tool('Zeichnen')}
            ${tool('Radierer')}
            ${tool('Verschieben')}
            ${tool('Lineal')}
            ${tool('Geodreieck')}
            ${tool('Zirkel')}
            ${tool('Figuren')}
            ${tool('Stift+Hand')}
          </div>
          <div class="lw-draw-toolgroup lw-segmented lw-writing-actions">
            ${tool('Text → Handschrift')}
          </div>
          <div class="lw-pen-strip" data-ink-surface="pen-strip" aria-label="Stift">
            <div class="lw-draw-toolgroup lw-colors" aria-label="Stiftfarbe">${chips}<label class="lw-color-custom"><input type="color" value="#3d52d5"><span></span></label></div>
            <label class="lw-draw-range"><span>Breite</span><input type="range" min="1" max="18" step="0.5" value="18.5" aria-label="Breite"><output>18.5 px</output></label>
          </div>
          <label class="lw-paper-select"><span class="sr-only">Papierart</span><select aria-label="Papierart"><option>Leer</option><option>Gepunktet</option><option>Häuschen</option><option selected>Millimeter</option><option>Kariert</option><option>Liniert</option></select><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></label>
          <div class="lw-draw-toolgroup lw-view-controls">
            <button type="button" class="lw-draw-icon" aria-label="Herauszoomen">${icon}</button>
            <button type="button" class="lw-draw-icon" aria-label="Hineinzoomen">${icon}</button>
            <button type="button" class="lw-draw-icon" aria-label="Drehen links">${icon}</button>
            <button type="button" class="lw-draw-icon" aria-label="Drehen rechts">${icon}</button>
            <button type="button" class="lw-draw-subtle lw-view-reset">600% · 180°</button>
          </div>
          <div class="lw-draw-toolgroup lw-history">
            <button type="button" class="lw-draw-icon" aria-label="Rückgängig">${icon}</button>
            <button type="button" class="lw-draw-icon" aria-label="Wiederholen">${icon}</button>
            <button type="button" class="lw-draw-icon" aria-label="Alles löschen">${icon}</button>
          </div>
          <div class="lw-draw-toolgroup lw-ink-actions">
            <button type="button" class="lw-draw-subtle" aria-label="Lasso">${icon} <span class="lw-tool-label">Lasso</span></button>
            <button type="button" class="lw-draw-subtle">Verschieben</button>
          </div>
        </div>
      </div></div>
    </div>
    <div class="editor-stage"><div class="editor-stage-main">note</div></div>
  </main></div>
</div>
</body></html>`

const dir = join(tmpdir(), `fanotes-ink-bar-${process.pid}-${Date.now()}`)
mkdirSync(dir, { recursive: true })
const htmlPath = join(dir, 'fixture.html')
const profile = join(dir, 'profile')
writeFileSync(htmlPath, html)

const chrome = spawn('/usr/bin/chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  '--window-size=1280,800', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`chromium debug port missing\n${stderr}`)), 15000)
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
    const match = stderr.match(/127\.0\.0\.1:(\d+)\//)
    if (match) { clearTimeout(timer); resolve(match[1]) }
  })
  chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chromium exited ${code}\n${stderr}`)) })
})

const openPage = async () => {
  const url = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`file://${htmlPath}`)}`
  let response = await fetch(url, { method: 'PUT' })
  if (!response.ok) response = await fetch(url, { method: 'GET' })
  if (!response.ok) throw new Error(`json/new ${response.status}`)
  return response.json()
}

const expression = `(() => {
  const spread = (style) => {
    const shadow = style.boxShadow
    if (!shadow || shadow === 'none') return 0
    let extra = 0
    for (const part of shadow.split(/,(?![^(]*\\))/)) {
      if (part.includes('inset')) continue
      const lengths = [...part.matchAll(/(-?[\\d.]+)px/g)].map((match) => Number(match[1]))
      const x = lengths[0] || 0
      const y = lengths[1] || 0
      const blur = lengths[2] || 0
      const spr = lengths[3] || 0
      extra = Math.max(extra, Math.abs(x) + blur + spr, Math.abs(y) + blur + spr)
    }
    const outline = parseFloat(style.outlineWidth) || 0
    if (style.outlineStyle && style.outlineStyle !== 'none') extra = Math.max(extra, outline)
    return extra
  }
  const box = (node) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const extra = spread(style)
    return {
      left: rect.left - extra, top: rect.top - extra,
      right: rect.right + extra, bottom: rect.bottom + extra,
      width: rect.width, height: rect.height, extra,
      label: node.getAttribute('aria-label') || node.className || node.tagName,
      text: (node.innerText || '').trim().slice(0, 40),
    }
  }
  const hits = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
  const visible = (node) => {
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const chips = [...document.querySelectorAll('.lw-colors > button, .lw-color-custom')].filter(visible).map(box)
  const texts = [...document.querySelectorAll('.editor-toolbar output, .editor-toolbar .mode-switch span, .editor-toolbar .lw-view-reset, .editor-toolbar select, .editor-toolbar .lw-ink-actions .lw-draw-subtle')]
    .filter(visible)
    .filter((node) => (node.innerText || node.value || '').trim())
    .map(box)
  const pairs = []
  for (let i = 0; i < chips.length; i += 1) {
    for (let j = i + 1; j < chips.length; j += 1) if (hits(chips[i], chips[j])) pairs.push(['chip', chips[i].label, chips[j].label])
    for (const text of texts) if (hits(chips[i], text)) pairs.push(['text', chips[i].label, text.text || text.label])
  }
  const clipped = []
  for (const node of document.querySelectorAll('.lw-draw-toolbar button, .lw-draw-toolbar output, .lw-draw-toolbar select')) {
    if (!visible(node)) continue
    if (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1) {
      clipped.push({ label: node.getAttribute('aria-label') || node.className || node.tagName, scroll: node.scrollWidth, client: node.clientWidth, text: (node.innerText || node.value || '').trim().slice(0, 24) })
    }
    const svg = node.querySelector('svg')
    if (!svg) continue
    const glyph = svg.getBoundingClientRect()
    const host = node.getBoundingClientRect()
    if (glyph.width > 0 && (glyph.left < host.left - 0.5 || glyph.right > host.right + 0.5 || glyph.top < host.top - 0.5 || glyph.bottom > host.bottom + 0.5)) {
      clipped.push({ label: node.getAttribute('aria-label') || 'icon', scroll: Math.round(glyph.width), client: Math.round(host.width), text: 'svg' })
    }
  }
  const icons = [...document.querySelectorAll('.lw-draw-toolbar button')]
    .filter((node) => visible(node) && node.querySelector('svg') && !(node.innerText || '').trim())
    .map((node) => ({ label: node.getAttribute('aria-label') || node.className, width: node.getBoundingClientRect().width }))
  const shown = (selector) => {
    const node = document.querySelector(selector)
    if (!node) return null
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return {
      display: style.display,
      width: Math.round(rect.width * 10) / 10,
      scroll: node.scrollWidth,
      client: node.clientWidth,
      text: (node.tagName === 'SELECT' ? (node.selectedOptions[0]?.text || '') : (node.innerText || node.value || '')).trim().slice(0, 40),
    }
  }
  const dock = document.querySelector('.lw-draw-toolbar').getBoundingClientRect()
  const kids = [...document.querySelector('.lw-draw-toolbar').children].filter((node) => node.getBoundingClientRect().width > 0)
  const gaps = []
  for (let i = 1; i < kids.length; i += 1) gaps.push(kids[i].getBoundingClientRect().left - kids[i - 1].getBoundingClientRect().right)
  const chrome = document.querySelector('.editor-toolbar').getBoundingClientRect()
  const strip = document.querySelector('.lw-pen-strip').getBoundingClientRect()
  const paperSelect = document.querySelector('.lw-paper-select select')
  const paperChevron = document.querySelector('.lw-paper-select svg')
  const glyphCanvas = document.createElement('canvas').getContext('2d')
  const paperGlyph = (label) => {
    const option = [...paperSelect.options].find((item) => item.text === label)
    option.selected = true
    const rect = paperSelect.getBoundingClientRect()
    const style = getComputedStyle(paperSelect)
    glyphCanvas.font = style.font
    const textLeft = rect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0)
    const textRight = textLeft + glyphCanvas.measureText(label).width
    const textBox = {
      left: textLeft,
      top: rect.top + (parseFloat(style.borderTopWidth) || 0),
      right: textRight,
      bottom: rect.bottom - (parseFloat(style.borderBottomWidth) || 0),
    }
    const icon = paperChevron.getBoundingClientRect()
    const iconBox = { left: icon.left, top: icon.top, right: icon.right, bottom: icon.bottom }
    return {
      label,
      gap: Math.round((icon.left - textRight) * 10) / 10,
      hit: hits(textBox, iconBox),
      iconW: Math.round(icon.width * 10) / 10,
      iconH: Math.round(icon.height * 10) / 10,
    }
  }
  const paperGlyphs = ['Gepunktet', 'Millimeter', 'Häuschen'].map(paperGlyph)
  paperSelect.querySelector('option[selected], option').selected = false
  ;[...paperSelect.options].find((item) => item.text === 'Millimeter').selected = true
  const output = document.querySelector('output')
  const word = [...document.querySelectorAll('.lw-ink-actions .lw-draw-subtle')].find((node) => (node.innerText || '').includes('Verschieben'))
  return {
    pairs,
    clipped,
    icons,
    gaps: gaps.map((gap) => Math.round(gap * 10) / 10),
    chipCount: chips.length,
    chipExtra: chips.map((chip) => chip.extra),
    hiddenChips: [...document.querySelectorAll('.lw-colors > button')].filter((node) => getComputedStyle(node).display === 'none').length,
    output: { text: (output.innerText || '').trim(), scroll: output.scrollWidth, client: output.clientWidth },
    word: word ? { text: word.innerText.trim(), width: Math.round(word.getBoundingClientRect().width), scroll: word.scrollWidth, client: word.clientWidth } : null,
    groups: kids.length,
    paper: shown('.lw-paper-select select'),
    paperGlyphs,
    reset: shown('.lw-view-reset'),
    modeLabel: shown('.mode-switch button span'),
    dock: { top: dock.top, bottom: dock.bottom, h: dock.height },
    chrome: { top: chrome.top, bottom: chrome.bottom, h: chrome.height },
    strip: { h: strip.height },
    vertical: dock.top + 1 < chrome.top || dock.bottom - 1 > chrome.bottom,
    noteMeta: Boolean(document.querySelector('.note-meta-bar')),
    statusbar: Boolean(document.querySelector('.statusbar, footer.statusbar')),
  }
})()`

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
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  const measure = async (width) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
    await send('Runtime.evaluate', {
      expression: 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(0))))',
      awaitPromise: true,
    })
    const raw = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (raw.exceptionDetails) throw new Error(JSON.stringify(raw.exceptionDetails))
    return raw.result.value
  }
  const wide = await measure(1280)
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (outDir) writeFileSync(join(outDir, 'ink-bar-layout.png'), Buffer.from(shot.data, 'base64'))
  const narrow = await measure(860)
  const dense = await measure(640)
  ws.close()

  const report = { wide, narrow, dense }
  console.log(JSON.stringify(report))
  for (const [name, sample] of [['wide', wide], ['narrow', narrow], ['dense', dense]]) {
    assert.deepEqual(sample.pairs, [], `${name} overlaps ${JSON.stringify(sample.pairs)}`)
    assert.deepEqual(sample.clipped, [], `${name} clipped ${JSON.stringify(sample.clipped)}`)
    assert.equal(sample.vertical, false, `${name} dock escapes the editor toolbar`)
    assert.equal(sample.noteMeta, false)
    assert.equal(sample.statusbar, false)
    assert.equal(sample.chipCount, 7, name)
    assert.equal(sample.hiddenChips, 0, name)
    assert.ok(sample.chipExtra.every((extra) => extra === 0), `${name} chip ring ${sample.chipExtra}`)
    assert.equal(sample.output.text, '18.5 px')
    assert.ok(sample.output.scroll <= sample.output.client + 1, `${name} readout ${JSON.stringify(sample.output)}`)
    assert.ok(sample.chrome.h <= 32 && sample.chrome.h >= 28, `${name} chrome ${sample.chrome.h}`)
    assert.ok(sample.dock.h <= 32 && sample.dock.h >= 24, `${name} dock ${sample.dock.h}`)
    assert.ok(sample.strip.h > 0 && sample.strip.h <= sample.dock.h + 0.5, `${name} strip ${sample.strip.h} dock ${sample.dock.h}`)
    assert.ok(sample.icons.length >= 12, `${name} icons ${sample.icons.length}`)
    for (const iconButton of sample.icons) {
      assert.ok(iconButton.width <= 24.5, `${name} ${iconButton.label} is ${iconButton.width}px`)
    }
    assert.equal(sample.groups, 7, `${name} groups`)
    assert.equal(sample.gaps.length, 6, `${name} gaps ${sample.gaps}`)
    const gapMin = Math.min(...sample.gaps)
    const gapMax = Math.max(...sample.gaps)
    assert.ok(gapMin >= 2 && gapMax <= 6 && gapMax - gapMin <= 1.5, `${name} gaps ${sample.gaps}`)
    assert.equal(sample.paper?.text, 'Millimeter')
    assert.notEqual(sample.paper.display, 'none')
    assert.ok(sample.paper.width > 40 && sample.paper.scroll <= sample.paper.client + 1, JSON.stringify(sample.paper))
    assert.deepEqual(sample.paperGlyphs.map((glyph) => glyph.label), ['Gepunktet', 'Millimeter', 'Häuschen'])
    for (const glyph of sample.paperGlyphs) {
      assert.equal(glyph.hit, false, `${name} ${glyph.label} meets the chevron`)
      assert.ok(glyph.gap >= 2, `${name} ${glyph.label} gap ${glyph.gap}`)
      assert.ok(Math.abs(glyph.iconW - 14) <= 0.5 && Math.abs(glyph.iconH - 14) <= 0.5, JSON.stringify(glyph))
    }
    assert.equal(sample.reset?.text, '600% · 180°')
    assert.notEqual(sample.reset.display, 'none')
    assert.ok(sample.reset.scroll <= sample.reset.client + 1, JSON.stringify(sample.reset))
    assert.notEqual(sample.modeLabel?.display, 'none', `${name} mode label`)
    assert.ok(sample.modeLabel.scroll <= sample.modeLabel.client + 1, JSON.stringify(sample.modeLabel))
    assert.equal(sample.word?.text, 'Verschieben')
    assert.ok(sample.word.width > 40 && sample.word.scroll <= sample.word.client + 1, JSON.stringify(sample.word))
  }
  console.log('ink-bar-layout ok')
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
    // A locked profile must not hide the layout result.
  }
}
