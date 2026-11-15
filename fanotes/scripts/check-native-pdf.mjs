// Native PDF rasters (WP8): the renderer side of `fanotes-native:pdf-*`.
// A host with `pdfNative` (Tauri) paints natively only behind the flag and
// otherwise leaves the page to pdf.js; a host without it (Electron, web,
// Android) keeps `renderPdfPage` exactly as before.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
const envOn = process.env.VITE_FANOTES_NATIVE_PDF === '1'
const setFlag = (on) => (on ? storage.set('fanotes.native-pdf', '1') : storage.delete('fanotes.native-pdf'))

const request = (extra = {}) => ({
  path: 'Mathe/Buch.pdf', pageIndex: 3, pixelWidth: 2, pixelHeight: 1, pagePixelWidth: 2, pagePixelHeight: 1,
  originX: 0, originY: 0, rotation: 90, slot: '7:base', ...extra,
})

const previousWindow = globalThis.window
try {
  // --- Tauri: capability present ---------------------------------------------
  {
    const { rasterizePdfPage, cancelPdfRaster } = await server.ssrLoadModule('/src/lib/pdfiumRaster.ts')
    const calls = []
    let failNext = null
    globalThis.window = {
      fanotes: {
        renderPdfPage: async () => { calls.push(['legacy']); return { unavailable: true } },
        pdfNative: {
          open: async (args) => { calls.push(['open', args]); return { doc: 11, pageCount: 9, reused: false } },
          render: async (args) => {
            calls.push(['render', args])
            if (failNext) { const error = failNext; failNext = null; throw error }
            return new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]).buffer
          },
          cancel: async (args) => { calls.push(['cancel', args]); return 1 },
          pageSizes: async () => [],
          close: async () => undefined,
        },
      },
    }
    if (!envOn) {
      setFlag(false)
      assert.equal(await rasterizePdfPage(request()), null, 'flag off: pdf.js paints the page')
      cancelPdfRaster('7:base')
      assert.deepEqual(calls, [], 'flag off: neither the native commands nor the parity channel are used')
    }
    setFlag(true)
    const bitmap = await rasterizePdfPage(request({ password: 'geheim' }))
    assert.ok(bitmap instanceof Uint8ClampedArray)
    assert.deepEqual([...bitmap], [1, 2, 3, 255, 4, 5, 6, 255])
    assert.deepEqual(calls[0], ['open', { path: 'Mathe/Buch.pdf', password: 'geheim' }])
    assert.deepEqual(calls[1], ['render', {
      doc: 11, pageIndex: 3, pixelWidth: 2, pixelHeight: 1, pagePixelWidth: 2, pagePixelHeight: 1,
      originX: 0, originY: 0, rotation: 90, slot: '7:base',
    }], 'the window goes to the host as planned, with its painter slot and no path or password')
    await rasterizePdfPage(request({ password: 'geheim' }))
    assert.equal(calls.filter(([name]) => name === 'open').length, 1, 'a document is opened once per path')
    failNext = new Error('Das PDF ist nicht geöffnet.')
    assert.ok(await rasterizePdfPage(request({ password: 'geheim' })), 'an evicted document is opened again once')
    assert.equal(calls.filter(([name]) => name === 'open').length, 2)
    failNext = new Error('Die PDF-Rasteranfrage wurde abgebrochen.')
    assert.equal(await rasterizePdfPage(request({ password: 'geheim' })), null, 'a superseded window is dropped')
    failNext = new Error('broken')
    assert.equal(await rasterizePdfPage(request({ password: 'geheim' })), null, 'a failed window falls back to pdf.js')
    assert.equal(await rasterizePdfPage(request({ pixelWidth: 3 })), null, 'a size that does not match the bytes is refused')
    cancelPdfRaster('7:detail')
    await Promise.resolve()
    assert.deepEqual(calls.at(-1), ['cancel', { slot: '7:detail' }])
    assert.equal(calls.some(([name]) => name === 'legacy'), false, 'Tauri never uses the base64 parity channel for paint')
  }

  // --- Electron / web: no capability -----------------------------------------
  {
    server.moduleGraph.invalidateAll()
    const { rasterizePdfPage, cancelPdfRaster } = await server.ssrLoadModule('/src/lib/pdfiumRaster.ts')
    const seen = []
    globalThis.window = {
      fanotes: {
        renderPdfPage: async (args) => { seen.push(args); return { width: 2, height: 1, rgba: new Uint8Array([9, 9, 9, 255, 8, 8, 8, 255]) } },
      },
    }
    setFlag(true)
    const bitmap = await rasterizePdfPage(request())
    assert.deepEqual([...bitmap], [9, 9, 9, 255, 8, 8, 8, 255], 'Electron keeps its PDFium sidecar path')
    assert.deepEqual(Object.keys(seen[0]).sort(), [
      'originX', 'originY', 'pageIndex', 'pagePixelHeight', 'pagePixelWidth', 'path', 'pixelHeight', 'pixelWidth', 'rotation',
    ], 'the Electron request is the same fields as before (no slot)')
    cancelPdfRaster('7:base')
    globalThis.window = { fanotes: {} }
    assert.equal(await rasterizePdfPage(request()), null, 'web: pdf.js paints')
  }
} finally {
  globalThis.window = previousWindow
}

// --- wiring ------------------------------------------------------------------
const painter = readFileSync(join(here, '../src/lib/pdfPagePainter.ts'), 'utf8')
assert.match(painter, /slot: layer\.slot,/u, 'each window names its painter layer')
assert.match(painter, /if \(layer\.pending\) cancelPdfRaster\(layer\.slot\)/u, 'a dropped layer cancels its queued native window')
const bridge = readFileSync(join(here, '../src-tauri/src/fanotes-api.js'), 'utf8')
for (const command of ['open', 'page-sizes', 'render', 'cancel', 'close']) {
  assert.match(bridge, new RegExp(`'fanotes-native:pdf-${command}'`, 'u'), `bridge exposes pdf-${command}`)
}
const commands = readFileSync(join(here, '../src-tauri/src/native/pdf.rs'), 'utf8')
assert.match(commands, /Response::new\(bitmap\.rgba\.clone\(\)\)/u, 'windows travel as raw bytes, not base64')

await server.close()
console.log(`native-pdf ok${envOn ? ' (flag on)' : ''}`)
