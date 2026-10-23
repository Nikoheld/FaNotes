import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url)
const board = readFileSync(new URL('../src/components/PdfNoteView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/lib/pdfTextSelection.ts', import.meta.url), 'utf8')

assert.match(board, /includeMarkedContent: true/)
assert.match(board, /disableNormalization: true/)
assert.match(board, /textHost\.style\.width = '100%'/)
assert.match(board, /bindPdfTextSelection\(textHost\)/)
assert.match(css, /\.pdf-note-text-layer \.endOfContent \{[^}]*inset:\s*100% 0 0/)
assert.match(css, /\.pdf-note-text-layer\.selecting \.endOfContent \{[^}]*top:\s*0/)
assert.match(source, /className = 'endOfContent'/)

const contract = css.indexOf('/* pdf.js TextLayer contract')
const layerStart = css.lastIndexOf('.pdf-note-text-layer {', contract)
const layerCss = css.slice(layerStart, css.indexOf('\n.pdf-note-sidebar {', contract))
const browserSource = `${source
  .replace(/\/\*\*[\s\S]*?\*\//g, '')
  .replace(/export const /g, 'const ')
  .replace(/: HTMLElement \| null/g, '')
  .replace(/: HTMLElement/g, '')
  .replace(/: Selection/g, '')
  .replace(/: Node \| null/g, '')
  .replace(/: AbortController \| null/g, '')
  .replace(/: Range \| null/g, '')
  .replace(/let range: Range/g, 'let range')
  .replace(/<HTMLElement(?:, HTMLElement)?>/g, '')}
window.bindPdfTextSelection = bindPdfTextSelection
window.releasePdfTextSelection = releasePdfTextSelection
`

const dir = mkdtempSync(join(tmpdir(), 'fanotes-pdf-select-'))
const htmlPath = join(dir, 'fixture.html')
const profile = join(dir, 'profile')
const html = `<!doctype html>
<meta charset="utf-8">
<style>
${layerCss}
#page { position: relative; width: 480px; height: 280px; margin: 24px; }
#a { left: 24px; top: 28px; --font-height: 32px; }
#b { left: 24px; top: 180px; --font-height: 32px; }
</style>
<div id="page"><div id="layer" class="pdf-note-text-layer"><span id="a">Hello</span><span id="b">World</span></div></div>
<script>${browserSource.replaceAll('</script', '<\\/script')}</script>`
writeFileSync(htmlPath, html)

const chrome = spawn('/usr/bin/chromium', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disable-extensions',
  '--window-size=900,700',
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

const send = (socket, method, params = {}) => {
  const id = send.next
  send.next += 1
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    }
    socket.addEventListener('message', onMessage)
  })
}
send.next = 1

const evaluate = async (socket, expression) => {
  const result = await send(socket, 'Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    throw new Error(details.exception?.description || details.text || JSON.stringify(details))
  }
  return result.result.value
}

try {
  const page = await openPage()
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', () => reject(new Error('devtools socket failed')))
  })
  await send(socket, 'Runtime.enable')
  await send(socket, 'Page.enable')
  await new Promise((resolve) => setTimeout(resolve, 200))

  const boxes = await evaluate(socket, `(() => {
    const box = (id) => {
      const rect = document.getElementById(id).getBoundingClientRect()
      return { x: rect.x + 4, y: rect.y + rect.height / 2, right: rect.right, top: rect.top, bottom: rect.bottom }
    }
    const page = document.getElementById('page').getBoundingClientRect()
    return { a: box('a'), b: box('b'), pageRight: page.right - 12, pageBottom: page.bottom - 8 }
  })()`)
  assert.ok(boxes.a.bottom + 8 < boxes.b.top, `the two glyph runs need a gap ${JSON.stringify(boxes)}`)

  const drag = async () => {
    await evaluate(socket, 'document.getSelection().removeAllRanges()')
    const points = [
      { x: boxes.a.x, y: boxes.a.y },
      { x: boxes.pageRight, y: boxes.a.y },
      { x: boxes.pageRight, y: boxes.pageBottom },
    ]
    await send(socket, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: points[0].x, y: points[0].y })
    await send(socket, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: points[0].x, y: points[0].y, button: 'left', clickCount: 1,
    })
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      for (let step = 1; step <= 8; step += 1) {
        await send(socket, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + (to.x - from.x) * step / 8,
          y: from.y + (to.y - from.y) * step / 8,
          button: 'left',
          buttons: 1,
        })
      }
    }
    const last = points[points.length - 1]
    const during = await evaluate(socket, 'document.getSelection().toString()')
    await send(socket, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1,
    })
    const after = await evaluate(socket, 'document.getSelection().toString()')
    return { during, after }
  }

  const loose = await drag()
  await evaluate(socket, 'bindPdfTextSelection(document.getElementById("layer"))')
  const limited = await drag()
  const kept = `${limited.during}\n${limited.after}`
  assert.match(loose.during + loose.after, /World/, 'the gap drag has to be able to jump before the limit is on')
  assert.doesNotMatch(kept, /World/, `limited selection jumped: ${JSON.stringify(limited)}`)
  assert.match(kept, /Hello/)
  console.log(JSON.stringify({ loose, limited }))
  console.log('pdf text selection ok')
  socket.close()
} finally {
  chrome.kill('SIGTERM')
  rmSync(dir, { recursive: true, force: true })
}
