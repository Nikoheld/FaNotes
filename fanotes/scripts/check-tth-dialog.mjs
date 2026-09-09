import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const boardSource = readFileSync(path.join(appRoot, 'src/components/DrawingBoard.tsx'), 'utf8')
const dialogSource = readFileSync(path.join(appRoot, 'src/components/TextToHandwritingDialog.tsx'), 'utf8')
const overlaySource = readFileSync(path.join(appRoot, 'src/lib/overlayInteract.ts'), 'utf8')

const structural = () => {
  assert.match(overlaySource, /DRAWING_MODAL_CHROME_SELECTOR = '\.lw-tth-backdrop, \.lw-tth-dialog'/)
  assert.match(overlaySource, /export const drawingChromeFromHit/)
  assert.match(boardSource, /drawingChromeFromHit/)
  assert.match(boardSource, /if \(hitTestChrome\(event\.clientX, event\.clientY\)\) return/)
  const pointerDown = boardSource.slice(
    boardSource.indexOf('const handlePointerDown'),
    boardSource.indexOf('event.preventDefault()', boardSource.indexOf('User input always wins')),
  )
  assert.match(pointerDown, /hitTestChrome/)
  assert.match(dialogSource, /data-tth-control="font-size"/)
  assert.match(dialogSource, /data-tth-control="line-spacing"/)
  assert.match(dialogSource, /data-tth-control="variation"/)
  assert.match(dialogSource, /onPaste=\{/)
  assert.match(boardSource, /keyTarget\.closest\('\.lw-tth-dialog, \.lw-tth-backdrop'\)/)
  return { chrome: true, paste: true, sliders: true }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const runDialog = async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-tth-dialog-'))
  const output = path.join(temporary, 'dist')
  const profile = path.join(temporary, 'chromium')
  const port = 9_461
  let chromium
  try {
    await build({
      root: appRoot,
      logLevel: 'error',
      configFile: path.join(appRoot, 'vite.config.ts'),
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        outDir: output,
        emptyOutDir: true,
        lib: {
          entry: path.join(appRoot, 'scripts/fixtures/tth-dialog-harness.tsx'),
          formats: ['es'],
          fileName: () => 'harness.js',
        },
      },
    })
    const css = fs.readdirSync(output).find((entry) => entry.endsWith('.css'))
    fs.writeFileSync(
      path.join(output, 'index.html'),
      `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="./${css}">` : ''}</head><body><div id="root"></div><script type="module" src="./harness.js"></script></body></html>`,
    )
    chromium = spawn('chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      pathToFileURL(path.join(output, 'index.html')).href,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    chromium.stderr.on('data', (chunk) => { stderr += chunk })

    let pages
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
        if (pages.some((entry) => entry.type === 'page' && entry.url.includes('index.html'))) break
      } catch {}
      await wait(100)
    }
    const page = pages?.find((entry) => entry.type === 'page' && entry.url.includes('index.html'))
    assert.ok(page?.webSocketDebuggerUrl, `Chromium-Testseite fehlt: ${stderr}`)
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let sequence = 0
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const handler = pending.get(message.id)
      if (!handler) return
      pending.delete(message.id)
      message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result)
    })
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
      }
      return response.result.value
    }
    await call('Runtime.enable')
    let ready = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      ready = await evaluate(`Boolean(document.querySelector('#ready') && document.querySelector('.lw-tth-dialog'))`)
      if (ready) break
      await wait(50)
    }
    assert.equal(ready, true, `Text-zu-Handschrift-Dialog wurde nicht gerendert: ${stderr.slice(0, 800)}`)

    const sliderProbe = await evaluate(`(() => {
      const setNative = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const before = JSON.parse(document.querySelector('[data-tth-preview-options]').getAttribute('data-tth-preview-options'))
      const font = document.querySelector('[data-tth-control="font-size"]')
      const spacing = document.querySelector('[data-tth-control="line-spacing"]')
      const variation = document.querySelector('[data-tth-control="variation"]')
      setNative(font, '55')
      setNative(spacing, '1.80')
      setNative(variation, '0.21')
      const after = JSON.parse(document.querySelector('[data-tth-preview-options]').getAttribute('data-tth-preview-options'))
      return {
        before,
        after,
        outputs: {
          font: document.querySelector('[data-tth-output="font-size"]').textContent,
          spacing: document.querySelector('[data-tth-output="line-spacing"]').textContent,
          variation: document.querySelector('[data-tth-output="variation"]').textContent,
        },
      }
    })()`)
    assert.equal(sliderProbe.after.fontSize, 55)
    assert.equal(sliderProbe.after.lineSpacing, 1.8)
    assert.ok(Math.abs(sliderProbe.after.variation - 0.21) < 0.001)
    assert.notDeepEqual(sliderProbe.before, sliderProbe.after)
    assert.match(sliderProbe.outputs.font, /55/)
    assert.match(sliderProbe.outputs.spacing, /1\.80/)
    assert.match(sliderProbe.outputs.variation, /21%/)

    const pasted = await evaluate(`(async () => {
      const field = document.querySelector('[data-tth-control="text"]')
      field.focus()
      const data = new DataTransfer()
      data.setData('text/plain', 'Pasted handwritten line')
      data.setData('text', 'Pasted handwritten line')
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: data })
      field.dispatchEvent(event)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      return field.value
    })()`)
    assert.equal(pasted, 'Pasted handwritten line')

    const pointer = await evaluate(`(() => {
      const hits = ['font-size', 'line-spacing', 'variation', 'text'].map((name) => {
        const node = document.querySelector('[data-tth-control="' + name + '"]')
        window.__tthPointerRecord.chrome = false
        window.__tthPointerRecord.ink = false
        window.__tthPointerRecord.prevented = false
        const box = node.getBoundingClientRect()
        const event = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: box.left + Math.min(8, box.width / 2),
          clientY: box.top + box.height / 2,
          pointerId: 1,
          pointerType: 'mouse',
        })
        node.dispatchEvent(event)
        return {
          name,
          chrome: Boolean(window.__tthChrome(node)),
          startsInk: window.__tthStartsInk(node),
          prevented: event.defaultPrevented || window.__tthPointerRecord.prevented,
          ink: window.__tthPointerRecord.ink,
        }
      })
      return hits
    })()`)
    for (const hit of pointer) {
      assert.equal(hit.chrome, true, `${hit.name} must be drawing chrome`)
      assert.equal(hit.startsInk, false, `${hit.name} must not start ink`)
      assert.equal(hit.prevented, false, `${hit.name} must not preventDefault`)
      assert.equal(hit.ink, false, `${hit.name} must not start an ink stroke`)
    }

    socket.close()
    return { sliders: true, paste: true, chrome: true, pointer }
  } finally {
    if (chromium && chromium.exitCode === null) {
      const closed = new Promise((resolve) => chromium.once('close', resolve))
      chromium.kill('SIGTERM')
      await Promise.race([closed, wait(2_000)])
    }
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

const firstStructure = structural()
const secondStructure = structural()
assert.deepEqual(firstStructure, secondStructure)
const first = await runDialog()
const second = await runDialog()
assert.equal(first.sliders, second.sliders)
assert.equal(first.paste, second.paste)
console.log(JSON.stringify({ structural: firstStructure, dialog: { sliders: first.sliders, paste: first.paste, chrome: first.chrome } }))
