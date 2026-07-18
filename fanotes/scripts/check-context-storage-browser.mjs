import assert from 'node:assert/strict'

const port = process.argv[2] ?? '9336'
const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const page = pages.find((entry) => entry.type === 'page')
assert.ok(page?.webSocketDebuggerUrl, 'Kein Chromium-Tab für den Kontextspeichertest gefunden.')

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

await call('Runtime.enable')
await new Promise((resolve) => setTimeout(resolve, 800))
const expression = String.raw`(async () => {
  const database = await import('/src/lib/handwritingDb.ts')
  const catalog = await import('/@fs/srv/codex-web/workspaces/2026-07-13-codex-cli-4878977b/src/data/catalog.ts')
  await database.clearHandwritingTraining()
  const label = catalog.BASE_CATALOG.find((entry) => entry.char === 'e')
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, 256, 256)
  context.strokeStyle = '#111'
  context.lineWidth = 18
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(70, 128)
  context.quadraticCurveTo(128, 52, 186, 128)
  context.quadraticCurveTo(128, 204, 70, 128)
  context.stroke()
  const token = {
    id: 'context-storage-test',
    strokes: [{
      baseWidth: 3.5,
      pressureEnabled: true,
      points: [
        { x: 0.28, y: 0.5, t: 1, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' },
        { x: 0.5, y: 0.28, t: 2, pressure: 0.7, tiltX: 0, tiltY: 0, pointerType: 'pen' },
        { x: 0.72, y: 0.5, t: 3, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' },
      ],
    }],
    imageData: canvas.toDataURL('image/png'),
    bbox: [0.28, 0.28, 0.44, 0.22],
    labelId: label.id,
    char: label.char,
    name: label.name,
    latex: label.latex,
    confidence: 54,
    alternatives: [],
    visualLabelId: 'latin_lower_o',
    visualConfidence: 58,
    context: { word: 'test', knownWord: true, changed: true, scoreMargin: 1.1, autoLearn: true },
  }
  const first = await database.learnFromContextualRecognition(token ? [token] : [], 'de', catalog.BASE_CATALOG)
  const stored = await database.getHandwritingSamples()
  const second = await database.learnFromContextualRecognition([token], 'de', catalog.BASE_CATALOG)
  const afterDuplicate = await database.getHandwritingSamples()
  await database.clearHandwritingTraining()
  return {
    first,
    second,
    storedCount: stored.length,
    duplicateCount: afterDuplicate.length,
    sessionId: stored[0]?.sessionId,
    labelId: stored[0]?.labelId,
  }
})()`
const evaluated = await call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
})
socket.close()

if (evaluated.exceptionDetails) {
  throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text)
}
const result = evaluated.result.value
assert.equal(result.first.learnedSamples, 1)
assert.equal(result.first.contextualCorrections, 1)
assert.equal(result.storedCount, 1)
assert.equal(result.sessionId, 'fanotes-context-de')
assert.equal(result.labelId, 'latin_lower_e')
assert.equal(result.second.learnedSamples, 0)
assert.equal(result.duplicateCount, 1)
console.log('Kontextspeicherprüfung erfolgreich: sicheres Beispiel gespeichert, korrekt markiert und bei Wiederholung dedupliziert.')
