import assert from 'node:assert/strict'
import fs from 'node:fs'

const port = process.argv[2] ?? '9337'
const screenshotPath = process.argv[3]
const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const page = pages.find((entry) => entry.type === 'page')
assert.ok(page?.webSocketDebuggerUrl, 'Kein laufendes FaNotes-Fenster gefunden.')
const scrollOnly = process.env.FANOTES_GLYPHENWERK_SCROLL_ONLY === '1'

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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

await call('Runtime.enable')
await call('Page.enable')
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await evaluate(`Boolean(document.querySelector('button[title="GlyphenWerk"]'))`)) break
  await wait(150)
}
assert.equal(await evaluate(`Boolean(document.querySelector('button[title="GlyphenWerk"]'))`), true)
await evaluate(`document.querySelector('button[title="GlyphenWerk"]').click(); true`)

let result
for (let attempt = 0; attempt < 50; attempt += 1) {
  result = await evaluate(`(() => {
    const frame = document.querySelector('.glyphenwerk-frame')
    const child = frame?.contentDocument
    return {
      workspace: Boolean(document.querySelector('.glyphenwerk-workspace')),
      status: document.querySelector('.glyphenwerk-sync-state')?.textContent?.trim() ?? '',
      childTitle: child?.title ?? '',
      childReady: Boolean(child?.querySelector('.main-nav')),
      navigation: [...(child?.querySelectorAll('.main-nav button') ?? [])].map((button) => button.textContent?.trim()),
      connected: child?.querySelector('.local-status')?.textContent?.trim() ?? '',
      frameWidth: frame?.getBoundingClientRect().width ?? 0,
      frameHeight: frame?.getBoundingClientRect().height ?? 0,
      childWidth: child?.documentElement?.clientWidth ?? 0,
      childScrollWidth: child?.documentElement?.scrollWidth ?? 0,
      hostTheme: [...(document.querySelector('.app-shell')?.classList ?? [])].find((name) => name.startsWith('theme-'))?.slice(6) ?? '',
      childTheme: child?.documentElement.dataset.fanotesTheme ?? '',
      hostPanel: getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--panel').trim(),
      childPanel: child?.documentElement.style.getPropertyValue('--fanotes-panel').trim() ?? '',
    }
  })()`)
  if (result.childReady && (scrollOnly || /Beispiele direkt in FaNotes aktiv/u.test(result.status))) break
  await wait(150)
}

assert.equal(result.workspace, true)
assert.equal(result.childReady, true)
assert.deepEqual(result.navigation, ['Erfassen', 'Erkennung testen', 'Sammlung', 'Exportieren'])
assert.match(result.connected, /Direkt mit FaNotes verbunden/u)
if (!scrollOnly) assert.match(result.status, /Beispiele direkt in FaNotes aktiv/u)
assert.ok(result.frameWidth > 600 && result.frameHeight > 400, 'GlyphenWerk füllt den FaNotes-Arbeitsbereich nicht aus.')
assert.equal(result.childScrollWidth, result.childWidth, 'GlyphenWerk erzeugt in FaNotes eine horizontale Scrollleiste.')
assert.equal(result.childTheme, result.hostTheme, 'GlyphenWerk übernimmt das aktive FaNotes-Theme nicht.')
assert.equal(result.childPanel, result.hostPanel, 'GlyphenWerk übernimmt die FaNotes-Oberflächenfarben nicht.')
assert.match(
  await evaluate(`getComputedStyle(document.querySelector('.glyphenwerk-frame').contentDocument.querySelector('.drawing-canvas')).touchAction`),
  /^(?:manipulation|.*pan-y.*)$/u,
  'Die GlyphenWerk-Zeichenfläche muss Trackpad-/Touch-Scrollen erlauben, auch nachdem ein Stift verwendet wurde.',
)
const inputPoint = await evaluate(`(() => {
  const frame = document.querySelector('.glyphenwerk-frame')
  const child = frame.contentWindow
  child.scrollTo(0, 0)
  const frameBox = frame.getBoundingClientRect()
  const canvasBox = frame.contentDocument.querySelector('.drawing-canvas').getBoundingClientRect()
  return {
    x: frameBox.left + canvasBox.left + canvasBox.width * .5,
    y: frameBox.top + canvasBox.top + Math.min(canvasBox.height * .5, 160),
    scrollHeight: child.document.documentElement.scrollHeight,
    clientHeight: child.document.documentElement.clientHeight,
  }
})()`)
assert.ok(inputPoint.scrollHeight > inputPoint.clientHeight, 'Die eingebettete GlyphenWerk-Seite braucht für den Trackpad-Test einen echten Scrollbereich.')
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputPoint.x, y: inputPoint.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: .55 })
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: inputPoint.x + 18, y: inputPoint.y + 12, button: 'left', buttons: 1, pointerType: 'pen', force: .62 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputPoint.x + 18, y: inputPoint.y + 12, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 })
await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: inputPoint.x, y: inputPoint.y, deltaX: 0, deltaY: 420 })
await wait(220)
assert.ok(
  await evaluate(`document.querySelector('.glyphenwerk-frame').contentWindow.scrollY`) > 0,
  'Nach einer Wacom-Stifteingabe muss ein Trackpad-Wheel-Ereignis GlyphenWerk weiterhin scrollen.',
)
if (scrollOnly) {
  socket.close()
  console.log('GlyphenWerk-Eingabetest: Wacom-Stift-Capture beendet, Trackpad-Scrollen bleibt aktiv.')
  process.exit(0)
}

await evaluate(`(async () => {
  const frame = document.querySelector('.glyphenwerk-frame')
  const child = frame.contentWindow
  const canvas = child.document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, 256, 256)
  context.strokeStyle = '#111'
  context.lineWidth = 14
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(54, 48)
  context.lineTo(202, 48)
  context.lineTo(106, 214)
  context.stroke()
  const sample = {
    id: 'fanotes-glyphenwerk-bridge-test',
    labelId: 'digit_7', label: '7', labelName: 'Ziffer 7', latex: '7', category: 'digits',
    writerId: 'browser-test', sessionId: 'glyphenwerk-integration', createdAt: new Date().toISOString(),
    imageData: canvas.toDataURL('image/png'), imageWidth: 256, imageHeight: 256,
    sourceCanvas: { width: 900, height: 560, devicePixelRatio: 1 }, bbox: [0.2, 0.1, 0.6, 0.8],
    strokes: [{ baseWidth: 4, pressureEnabled: true, points: [
      { x: 0.2, y: 0.2, t: 1, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' },
      { x: 0.8, y: 0.2, t: 2, pressure: 0.7, tiltX: 0, tiltY: 0, pointerType: 'pen' },
      { x: 0.42, y: 0.84, t: 3, pressure: 0.65, tiltX: 0, tiltY: 0, pointerType: 'pen' },
    ] }],
    strokeCount: 1, pointCount: 3, schemaVersion: 1,
  }
  await new Promise((resolve, reject) => {
    const open = child.indexedDB.open('glyphenwerk-db', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction('samples', 'readwrite')
      transaction.objectStore('samples').put(sample)
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
  })
  child.location.reload()
  return true
})()`)

let synchronizedCount = ''
for (let attempt = 0; attempt < 60; attempt += 1) {
  synchronizedCount = await evaluate(`document.querySelector('.glyphenwerk-sync-state')?.textContent?.trim() ?? ''`)
  if (/1 Beispiele direkt in FaNotes aktiv/u.test(synchronizedCount)) break
  await wait(150)
}
assert.match(synchronizedCount, /1 Beispiele direkt in FaNotes aktiv/u)
assert.equal(await evaluate(`new Promise((resolve, reject) => {
  const open = indexedDB.open('fanotes-handwriting', 1)
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const database = open.result
    const request = database.transaction('samples', 'readonly').objectStore('samples').get('fanotes-glyphenwerk-bridge-test')
    request.onsuccess = () => { database.close(); resolve(request.result?.labelId ?? null) }
    request.onerror = () => reject(request.error)
  }
})`), 'digit_7')

await evaluate(`(async () => {
  const child = document.querySelector('.glyphenwerk-frame').contentWindow
  await new Promise((resolve, reject) => {
    const open = child.indexedDB.open('glyphenwerk-db', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction('samples', 'readwrite')
      transaction.objectStore('samples').delete('fanotes-glyphenwerk-bridge-test')
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
  })
  child.location.reload()
  return true
})()`)
for (let attempt = 0; attempt < 60; attempt += 1) {
  synchronizedCount = await evaluate(`document.querySelector('.glyphenwerk-sync-state')?.textContent?.trim() ?? ''`)
  if (/0 Beispiele direkt in FaNotes aktiv/u.test(synchronizedCount)) break
  await wait(150)
}
assert.match(synchronizedCount, /0 Beispiele direkt in FaNotes aktiv/u)

await evaluate(`(() => {
  const child = document.querySelector('.glyphenwerk-frame').contentDocument
  ;[...child.querySelectorAll('.main-nav button')].find((button) => button.textContent.includes('Erkennung testen')).click()
  return true
})()`)
await wait(150)
assert.match(await evaluate(`document.querySelector('.glyphenwerk-frame').contentDocument.querySelector('h1')?.textContent ?? ''`), /Text & Mathematik testen/u)
assert.equal(await evaluate(`Boolean(document.querySelector('.glyphenwerk-frame').contentDocument.querySelector('.automatic-mode-pill'))`), true)
assert.equal(await evaluate(`Boolean(document.querySelector('.glyphenwerk-frame').contentDocument.querySelector('.recognition-mode-switch'))`), false)

if (screenshotPath) {
  const capture = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'))
}
socket.close()
console.log('GlyphenWerk-Browsertest: Theme-Brücke, gemeinsame Text-/Mathematikerkennung, Navigation und direkte FaNotes-Verbindung funktionieren.')
