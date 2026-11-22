// Background OCR indexing: content-addressed cache, bounded concurrency, the low-priority OCR host and
// "search results stay identical" on the synthetic vault (scripts/ocr-index-fixture.mjs).
// Run from fanotes/: node scripts/check-ocr-index-cache.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { buildOcrIndexVault, FIXTURE_WORDS } from './ocr-index-fixture.mjs'

const require = createRequire(import.meta.url)
const { createCanvas } = require('@napi-rs/canvas')
const host = require('../electron/ocr-host.cjs')
const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const results = []
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]) } catch (error) { results.push([name, false, error]) }
}

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-check-ocr-index-'))
try {
  const cache = await server.ssrLoadModule('/src/lib/docSearch/ocrCache.ts')
  const orientation = await server.ssrLoadModule('/src/lib/docSearch/ocrOrientation.ts')
  const { DocIndex } = await server.ssrLoadModule('/src/lib/docSearch/docIndex.ts')

  // ---- synthetic vault: scanned pages as bitmaps (100 dpi keeps the check fast) ----
  const vault = path.join(tmp, 'vault')
  const manifest = await buildOcrIndexVault(vault, { textPdfs: 2, scannedPdfs: 3, mixedPdfs: 2, copies: 2, inkNotes: 20, scanLines: 6, scanDpi: 100, scanPages: 2 })
  assert.equal(manifest.inkNotes, 20)
  // Page images are rendered the way the fixture does; the same text on two paths gives the same bitmap.
  const { GlobalFonts } = require('@napi-rs/canvas')
  GlobalFonts.registerFromPath('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'CheckSans')
  const page = (lines) => {
    const canvas = createCanvas(827, 1169)
    const context = canvas.getContext('2d')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, 827, 1169)
    context.fillStyle = '#111'
    context.font = '15px CheckSans'
    lines.forEach((line, index) => context.fillText(line, 80, 120 + index * 32))
    const data = context.getImageData(0, 0, 827, 1169).data
    return { pixels: new Uint8ClampedArray(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), width: 827, height: 1169 }
  }
  const word = (n) => FIXTURE_WORDS[n % FIXTURE_WORDS.length]
  const scans = Array.from({ length: 8 }, (_, p) => ['Kopfzeile Heft', ...Array.from({ length: 6 }, (_, l) => `${word(p + l)} ${word(p * 3 + l)} ${word(p + 2 * l + 1)} ${word(l * 7 + p)}`)])
  const pages = scans.map(page)
  // A copy of a scanned PDF: the same pages again under other documents.
  const documents = [
    ...pages.map((bitmap, index) => ({ path: `PDF/Scan-${index}.pdf`, bitmap })),
    { path: 'PDF/Kopie-0.pdf', bitmap: pages[0] },
    { path: 'Archiv/Scan-1.pdf', bitmap: pages[1] },
  ]

  // Deterministic stand-in for the engine: a pure function of the line's pixels, so any cache
  // that returns the wrong line shows up as different text.
  const makeEngine = () => {
    const state = { calls: 0 }
    const recognize = async (pixels, width, height) => {
      state.calls += 1
      let hash = 2166136261
      for (let index = 0; index < pixels.length; index += 7) hash = Math.imul(hash ^ pixels[index], 16777619) >>> 0
      return `${word(hash)} ${word(hash >>> 8)} ${word(hash >>> 16)} z${width}x${height}`
    }
    return { state, recognize }
  }
  const memoryStore = () => {
    const pagesMap = new Map(); const linesMap = new Map()
    return { getPage: async (k) => pagesMap.get(k), putPage: async (k, v) => { pagesMap.set(k, v) }, getLine: async (k) => linesMap.get(k), putLine: async (k, v) => { linesMap.set(k, v) }, close() {}, size: () => [pagesMap.size, linesMap.size] }
  }
  const run = async (docs, store, engine, concurrency = 1) => {
    const out = new Map()
    for (const doc of docs) {
      const copy = { ...doc.bitmap, pixels: doc.bitmap.pixels.slice() }
      out.set(doc.path, await cache.recognizePageCached({ bitmap: copy, recognize: engine.recognize, store, engine: 'test-engine', prepare: orientation.preparePageLocal, concurrency }))
    }
    return out
  }
  const toIndex = (outputs) => {
    const index = new DocIndex()
    for (const [docPath, result] of outputs) {
      index.setDoc({ path: docPath, title: docPath, kind: 'pdf', fingerprint: 'f', extractor: 1, status: 'indexed', attempts: 0, issues: [], ocrPages: 1, updatedAt: 0 })
      index.addUnit({ id: `${docPath}#pdf-page:1`, path: docPath, kind: 'pdf-page', page: 1, source: 'ocr', confidence: result.confidence, text: result.text })
    }
    return index
  }
  const queries = [...FIXTURE_WORDS.slice(0, 12).map((w) => w.toLowerCase()), 'kopfzeile', 'zelle membran', 'z827x', 'energie atom']
  const answers = (index) => JSON.stringify(queries.map((q) => index.search(q).map((r) => [r.path, r.page, r.matches, r.snippet.text])))

  const plainEngine = makeEngine()
  const plain = await run(documents, null, plainEngine)
  const plainCalls = plainEngine.state.calls
  assert.ok(plainCalls > 40, `plain run reads many lines (${plainCalls})`)

  await test('cache on, cold: page text and search answers are identical to no cache', async () => {
    const engine = makeEngine()
    const store = memoryStore()
    const cached = await run(documents, store, engine)
    for (const [key, value] of plain) assert.deepEqual({ text: cached.get(key).text, confidence: cached.get(key).confidence }, { text: value.text, confidence: value.confidence }, key)
    assert.equal(answers(toIndex(cached)), answers(toIndex(plain)))
    assert.ok(queries.some((q) => toIndex(plain).search(q).length > 0), 'queries find something')
  })

  await test('copies and moved PDFs are free; repeated header lines are read once', async () => {
    const engine = makeEngine()
    const store = memoryStore()
    await run(documents, store, engine)
    // 8 distinct pages + 2 copies: the copies add no work at all, the shared header line is read once.
    assert.ok(engine.state.calls < plainCalls * 0.8, `cold with duplicates: ${engine.state.calls} vs ${plainCalls} calls`)
  })

  await test('second pass (restart) reads nothing, results unchanged', async () => {
    const engine = makeEngine()
    const store = memoryStore()
    const first = await run(documents, store, engine)
    const before = engine.state.calls
    const second = await run(documents, store, engine)
    assert.equal(engine.state.calls, before, 'no recognition on the second pass')
    assert.equal(answers(toIndex(second)), answers(toIndex(first)))
  })

  await test('an edited page re-reads only its changed lines', async () => {
    const engine = makeEngine()
    const store = memoryStore()
    await run(documents.slice(0, 1), store, engine)
    const before = engine.state.calls
    const edited = page([...scans[0].slice(0, 6), 'Neue Zeile Ableitung Integral'])
    await run([{ path: 'PDF/Scan-0.pdf', bitmap: edited }], store, engine)
    const extra = engine.state.calls - before
    assert.ok(extra >= 1 && extra <= 2, `only the new line is read (${extra})`)
  })

  await test('the engine id is part of the key: another engine does not see the text', async () => {
    const store = memoryStore()
    const engine = makeEngine()
    await cache.recognizePageCached({ bitmap: { ...pages[0], pixels: pages[0].pixels.slice() }, recognize: engine.recognize, store, engine: 'engine-a', prepare: orientation.preparePageLocal })
    const before = engine.state.calls
    await cache.recognizePageCached({ bitmap: { ...pages[0], pixels: pages[0].pixels.slice() }, recognize: engine.recognize, store, engine: 'engine-b', prepare: orientation.preparePageLocal })
    assert.ok(engine.state.calls > before)
  })

  await test('a stopped page is not remembered', async () => {
    const store = memoryStore()
    const engine = makeEngine()
    let stop = false
    const slow = async (...args) => { const r = await engine.recognize(...args); stop = true; return r }
    await cache.recognizePageCached({ bitmap: { ...pages[2], pixels: pages[2].pixels.slice() }, recognize: slow, store, engine: 'e', prepare: orientation.preparePageLocal, shouldStop: () => stop })
    assert.equal(store.size()[0], 0)
  })

  await test('a page that read as blank is not remembered', async () => {
    const store = memoryStore()
    const blank = { pixels: new Uint8ClampedArray(827 * 1169 * 4).fill(255), width: 827, height: 1169 }
    await cache.recognizePageCached({ bitmap: blank, recognize: async () => '', store, engine: 'e', prepare: orientation.preparePageLocal })
    assert.equal(store.size()[0], 0)
  })

  await test('parallel line reading keeps order and gives the same text, bounded by the limit', async () => {
    let active = 0; let peak = 0
    const engine = makeEngine()
    const bounded = async (...args) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); const out = await engine.recognize(...args); active -= 1; return out }
    const parallel = await run(documents.slice(0, 4), null, { recognize: bounded, state: engine.state }, 2)
    for (const doc of documents.slice(0, 4)) assert.equal(parallel.get(doc.path).text, plain.get(doc.path).text)
    assert.ok(peak <= 2 && peak >= 2, `peak concurrency ${peak}`)
  })

  await test('pause hook runs before each recognition that is not cached', async () => {
    const store = memoryStore()
    const engine = makeEngine()
    let paused = 0
    const args = { bitmap: { ...pages[3], pixels: pages[3].pixels.slice() }, recognize: engine.recognize, store, engine: 'p', prepare: orientation.preparePageLocal, pause: async () => { paused += 1 } }
    await cache.recognizePageCached(args)
    assert.equal(paused, engine.state.calls)
    const calls = engine.state.calls
    await cache.recognizePageCached({ ...args, bitmap: { ...pages[3], pixels: pages[3].pixels.slice() } })
    assert.equal(engine.state.calls, calls)
    assert.equal(paused, calls)
  })

  // ---- the OCR host: worker bound, priority, protocol, idle shutdown, no polling ----
  await test('worker count is bounded to half the cores, never all', () => {
    const GB = 1024 ** 3
    assert.equal(host.workerCount(NaN, 8, 16 * GB), 2)
    assert.equal(host.workerCount(NaN, 8, 8 * GB), 1, 'under 12 GB')
    assert.equal(host.workerCount(NaN, 8, 16 * GB, true), 1, 'on battery')
    assert.equal(host.workerCount(NaN, 8, 16 * GB, false, 2 * GB), 1, 'little free memory')
    assert.equal(host.workerCount(NaN, 8, 16 * GB, false, 6 * GB), 2, 'enough free memory')
    assert.equal(host.workerCount(4, 16, 32 * GB, true), 1)
    assert.equal(host.workerCount(NaN, 8), host.workerCount(NaN, 8, os.totalmem()))
    assert.equal(host.workerCount(NaN, 4, 16 * GB), 2)
    assert.equal(host.workerCount(NaN, 2, 16 * GB), 1)
    assert.equal(host.workerCount(NaN, 1, 16 * GB), 1)
    assert.equal(host.workerCount(4, 16, 32 * GB), 4)
    assert.equal(host.workerCount(4, 4, 32 * GB), 2)
    assert.equal(host.workerCount(9, 64, 64 * GB), 4)
    for (const cores of [1, 2, 3, 4, 6, 8, 12, 16, 32]) assert.ok(host.workerCount(NaN, cores, 32 * GB) <= Math.max(1, cores / 2))
  })

  await test('host: lowers its process priority, answers requests, closes when idle', async () => {
    const child = spawn('sleep', ['30'])
    try {
      const ipc = new EventEmitter()
      const sent = []
      let destroyed = false
      const contents = new EventEmitter()
      Object.assign(contents, { getOSProcessId: () => child.pid, setWindowOpenHandler() {}, send: (channel, id, payload) => sent.push([channel, id, payload]) })
      const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed, destroy() { destroyed = true; win.emit('closed') }, loadURL: async () => {}, loadFile: async () => {} })
      const instance = host.createOcrHost({ BrowserWindow: class {}, ipcMain: ipc, pagePath: () => 'x', devUrl: () => null, preload: 'p', configuredWorkers: () => NaN, keepAliveMs: () => 30, createWindow: () => win })
      const pending = instance.recognize({ pixels: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 })
      await new Promise((r) => setTimeout(r, 10))
      ipc.emit('fanotes-ocr-host', { sender: contents }, host.CHANNEL_READY, 0, null)
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(sent.length, 1)
      ipc.emit('fanotes-ocr-host', { sender: {} }, host.CHANNEL_RESULT, sent[0][1], { text: 'fremd' })
      ipc.emit('fanotes-ocr-host', { sender: contents }, host.CHANNEL_RESULT, sent[0][1], { text: 'Hallo Welt' })
      assert.equal(await pending, 'Hallo Welt')
      if (process.platform === 'linux') {
        const raw = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8')
        const nice = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[16])
        assert.ok(nice > 0, `nice ${nice}`)
      }
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(destroyed, true, 'host closed after the keep-alive')
      await assert.rejects(instance.recognize({ pixels: new Uint8ClampedArray(4), width: 1, height: 1 }), /ungültig/)
    } finally { child.kill() }
  })

  await test('no polling: the indexer gate and the host use events and one-shot timers only', () => {
    const service = fs.readFileSync(new URL('../src/lib/docSearch/service.ts', import.meta.url), 'utf8')
    const hostSource = fs.readFileSync(new URL('../electron/ocr-host.cjs', import.meta.url), 'utf8')
    for (const source of [service, hostSource]) assert.ok(!/setInterval/u.test(source))
    assert.ok(!/LOW_BATTERY_RECHECK/u.test(service))
    assert.ok(/addEventListener\('chargingchange'/u.test(service))
    assert.ok(/PRIORITY_BELOW_NORMAL/u.test(hostSource))
  })
} finally {
  await server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

let failed = 0
for (const [name, ok, error] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) { failed += 1; console.log('      ', error?.stack?.split('\n').slice(0, 4).join('\n       ')) }
}
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exitCode = 1
