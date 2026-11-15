// End-to-end check of WP8 in the real Tauri webview (WebKitGTK on Linux).
//
//   xvfb-run -a node scripts/check-native-pdf-webview.mjs <fanotes-tauri binary> [--out results.json] [--pages 200]
//
// Runs where the Tauri shell runs (the Linux build container). The binary must
// be a dev build (`cargo build -p fanotes-tauri --no-default-features`): it
// loads `devUrl` (http://127.0.0.1:5174), where this script serves a probe page
// instead of the app. The page then talks to the real `window.fanotes` bridge
// and the real `fanotes-native:pdf-*` commands, and reports:
//   1. the wasm viewport raster against drawInkStroke in this webview,
//      including the putImageData upload path;
//   2. a native PDFium page against the pdf.js raster of the same page;
//   3. first-page time and scroll frame times over a generated PDF, with
//      pdf.js and with native rasters (flag off / on), through the real
//      pdfPagePainter in a `.unified-note-view` scroller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createViteServer } from 'vite'

const binary = process.argv[2]
if (!binary) {
  console.error('usage: check-native-pdf-webview.mjs <fanotes-tauri> [--out file] [--pages N]')
  process.exit(2)
}
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : fallback
}
const outFile = option('--out', null)
const pageTotal = Number(option('--pages', '200'))

// --- fixtures ----------------------------------------------------------------
const pdfFrom = (width, height, streams) => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${streams.length} /Kids [${streams.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]
  streams.forEach((stream, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${6 + i * 2} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`)
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const worksheet = (page) => [
  '0.94 0.96 1 rg 12 12 276 40 re f',
  '0.1 0.2 0.6 RG 1.5 w 12 12 276 40 re S',
  `BT /F2 16 Tf 0.1 0.1 0.15 rg 16 176 Td (Arbeitsblatt ${page}: Br\\374che) Tj ET`,
  'BT /F1 9 Tf 0 0 0 rg 16 160 Td (Berechne die Summe und k\\374rze das Ergebnis.) Tj 0 -12 Td (a\\) 3/4 + 1/8 =        b\\) 2/3 + 5/6 =) Tj ET',
  '0.6 0.6 0.6 RG 0.5 w', '16 120 m 200 120 l S', '16 104 m 200 104 l S', '16 88 m 200 88 l S', '16 72 m 200 72 l S',
  '0.85 0.2 0.1 RG 2 w 250 100 m 250 116.6 236.6 130 220 130 c 203.4 130 190 116.6 190 100 c 190 83.4 203.4 70 220 70 c 236.6 70 250 83.4 250 100 c S',
  '0.2 0.6 0.3 rg 236 140 40 24 re f',
  'BT /F1 7 Tf 0.3 0.3 0.3 rg 20 28 Td (Name: ______________   Klasse: ____) Tj ET',
].join('\n')

// A4 pages of dense text, a figure, and a grid: a textbook scan without the scan.
const bookPage = (page) => {
  const lines = [`BT /F2 18 Tf 56 780 Td (Kapitel ${Math.ceil(page / 8)}.${page}) Tj ET`, 'BT /F1 10 Tf 13 TL 56 750 Td']
  for (let line = 0; line < 44; line += 1) {
    lines.push(`(${`Zeile ${line + 1} auf Seite ${page}: Die Ableitung von f\\(x\\) = x^2 ist f'\\(x\\) = 2x, und das Integral ...`.slice(0, 92)}) '`)
  }
  lines.push('ET')
  lines.push('0.8 0.85 0.95 rg 360 60 180 120 re f 0.2 0.3 0.7 RG 1 w')
  for (let x = 0; x <= 180; x += 15) lines.push(`${360 + x} 60 m ${360 + x} 180 l S`)
  for (let y = 0; y <= 120; y += 15) lines.push(`360 ${60 + y} m 540 ${60 + y} l S`)
  lines.push('0.8 0.1 0.1 RG 2 w 360 60 m 420 170 480 70 540 175 c S')
  return lines.join('\n')
}

const work = mkdtempSync(join(tmpdir(), 'fanotes-native-pdf-'))
const vault = join(work, 'vault')
mkdirSync(join(vault, 'Bench'), { recursive: true })
writeFileSync(join(vault, 'Bench', 'Worksheet.pdf'), pdfFrom(300, 200, [worksheet(1)]))
writeFileSync(join(vault, 'Bench', `Book-${pageTotal}.pdf`), pdfFrom(595, 842, Array.from({ length: pageTotal }, (_, i) => bookPage(i + 1))))
const dataHome = join(work, 'data')
const appData = join(dataHome, 'de.fanotes.app')
mkdirSync(appData, { recursive: true, mode: 0o700 })
writeFileSync(join(appData, 'vault-path'), `${vault}\n`)

// --- probe page ----------------------------------------------------------------
const probe = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Native PDF probe</title>
<style>
  html, body { margin: 0; height: 100%; }
  .unified-note-view { position: fixed; inset: 0; overflow: auto; background: #edeff3; }
  .column { width: 820px; margin: 0 auto; padding: 24px 0; }
  .page { position: relative; width: 820px; margin: 0 0 18px; background: white; }
  .page canvas { position: absolute; visibility: hidden; }
</style></head>
<body><div class="unified-note-view"><div class="column"></div></div>
<script type="module">
  const post = (name, value) => fetch('/__probe', { method: 'POST', body: JSON.stringify({ name, value }) })
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const fail = (error) => post('error', String(error && error.stack || error))
  window.addEventListener('error', (event) => fail(event.error || event.message))
  window.addEventListener('unhandledrejection', (event) => fail(event.reason))
  try {
    const { loadVaultPdfBytes, openPdfDocument } = await import('/src/lib/pdfDocument.ts')
    const { createPdfPagePainter } = await import('/src/lib/pdfPagePainter.ts')
    const { drawInkStroke } = await import('/src/lib/inkStrokePaint.ts')
    const { rasterizeInkStrokes } = await import('/src/lib/viewportRaster.ts')
    const api = window.fanotes
    await post('env', {
      ua: navigator.userAgent, bridge: Boolean(api), pdfNative: Boolean(api && api.pdfNative),
      sharedArrayBuffer: typeof SharedArrayBuffer, crossOriginIsolated: self.crossOriginIsolated === true,
      webAssembly: typeof WebAssembly, dpr: devicePixelRatio,
    })

    // 1. wasm viewport raster in this webview
    {
      const W = 360, H = 240
      const wave = (n, amp) => Array.from({ length: n }, (_, i) => { const t = i / (n - 1); return { x: 0.1 + 0.8 * t, y: 0.5 + Math.sin(t * 6.9) * amp, pressure: 0.3 + 0.6 * Math.abs(Math.sin(t * 5)) } })
      const cases = [
        ['handwriting', { points: wave(48, 0.25), baseWidth: 3.5, pressureEnabled: true, color: '#202333', purpose: 'handwriting' }],
        ['marker', { points: wave(36, 0.18), baseWidth: 12, pressureEnabled: true, color: '#3a7bd5', purpose: 'art', brush: 'marker', colorEffect: 'solid', opacity: 1, textureSeed: 11 }],
        ['highlighter', { points: wave(36, 0.18), baseWidth: 22, pressureEnabled: false, color: '#f5d33d', purpose: 'art', brush: 'highlighter', colorEffect: 'solid', opacity: 1, textureSeed: 11 }],
      ]
      const rows = []
      for (const [name, stroke] of cases) {
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
        const context = canvas.getContext('2d')
        drawInkStroke(context, stroke, W, H, 0.55, 1, W, W)
        const js = context.getImageData(0, 0, W, H).data
        const started = performance.now()
        const image = rasterizeInkStrokes([stroke], W, H, { layoutWidth: W, smoothing: 0.55 })
        const rasterMs = performance.now() - started
        const upload = document.createElement('canvas'); upload.width = W; upload.height = H
        const uploadContext = upload.getContext('2d')
        uploadContext.putImageData(new ImageData(image.data, W, H), 0, 0)
        const back = uploadContext.getImageData(0, 0, W, H).data
        let both = 0, either = 0, uploadDiff = 0
        for (let i = 0; i < js.length; i += 4) {
          const a = js[i + 3] >= 64, b = image.data[i + 3] >= 64
          if (a || b) either += 1
          if (a && b) both += 1
          if (image.data[i + 3] === 255) uploadDiff = Math.max(uploadDiff, Math.abs(back[i] - image.data[i]), Math.abs(back[i + 1] - image.data[i + 1]), Math.abs(back[i + 2] - image.data[i + 2]))
        }
        rows.push({ name, iou: either ? both / either : 1, rasterMs, uploadMaxDiff: uploadDiff, painted: both })
      }
      await post('raster', rows)
    }

    // 2. native page against pdf.js
    {
      const path = 'Bench/Worksheet.pdf'
      const { pdf } = await openPdfDocument(await loadVaultPdfBytes(path))
      const page = await pdf.getPage(1)
      const viewport = page.getViewport({ scale: 2 })
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
      const context = canvas.getContext('2d', { alpha: false })
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: context, viewport, intent: 'display' }).promise
      const reference = context.getImageData(0, 0, canvas.width, canvas.height).data
      const opened = await api.pdfNative.open({ path })
      const sizes = await api.pdfNative.pageSizes(opened.doc)
      const started = performance.now()
      const buffer = await api.pdfNative.render({ doc: opened.doc, pageIndex: 0, pixelWidth: canvas.width, pixelHeight: canvas.height, pagePixelWidth: canvas.width, pagePixelHeight: canvas.height, originX: 0, originY: 0, rotation: 0 })
      const renderMs = performance.now() - started
      const native = new Uint8Array(buffer)
      const W = canvas.width, H = canvas.height
      const dark = (data, i) => data[i] + data[i + 1] + data[i + 2] < 384
      const compare = (dx, dy) => {
        let both = 0, either = 0, sum = 0, n = 0
        for (let y = 4; y < H - 4; y += 1) for (let x = 4; x < W - 4; x += 1) {
          const i = (y * W + x) * 4, j = ((y + dy) * W + x + dx) * 4
          const a = dark(reference, i), b = dark(native, j)
          if (a || b) either += 1
          if (a && b) both += 1
          sum += Math.abs(reference[i] - native[j]) + Math.abs(reference[i + 1] - native[j + 1]) + Math.abs(reference[i + 2] - native[j + 2]); n += 3
        }
        return { iou: both / Math.max(1, either), mean: sum / n }
      }
      let best = { dx: 0, dy: 0, ...compare(0, 0) }
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const scored = compare(dx, dy)
        if (scored.iou > best.iou + 0.01) best = { dx, dy, ...scored }
      }
      const cancelled = await api.pdfNative.cancel({ slot: 'probe:none' })
      await post('parity', { bytes: native.byteLength, expected: W * H * 4, width: W, height: H, pageCount: opened.pageCount, sizes, renderMs, ...best, cancelled, aligned: compare(0, 0) })
    }

    // 3. first page and scrolling, pdf.js then native
    const PAGES = ${pageTotal}
    const scroller = document.querySelector('.unified-note-view')
    const column = document.querySelector('.column')
    const bench = async (mode) => {
      if (mode === 'native') localStorage.setItem('fanotes.native-pdf', '1')
      else localStorage.removeItem('fanotes.native-pdf')
      column.textContent = ''
      scroller.scrollTop = 0
      await frame()
      const path = 'Bench/Book-' + PAGES + '.pdf'
      const started = performance.now()
      const { pdf } = await openPdfDocument(await loadVaultPdfBytes(path))
      const ratio = 842 / 595
      const painted = new Set()
      const painters = new Map()
      let firstPage = 0
      const hosts = []
      for (let index = 0; index < PAGES; index += 1) {
        const host = document.createElement('div')
        host.className = 'page'; host.style.height = Math.round(820 * ratio) + 'px'; host.dataset.index = String(index)
        column.appendChild(host); hosts.push(host)
      }
      const mount = (host) => {
        const index = Number(host.dataset.index)
        if (painters.has(index)) return
        const canvases = [0, 1, 2, 3].map(() => host.appendChild(document.createElement('canvas')))
        const painter = createPdfPagePainter({
          host, base: [canvases[0], canvases[1]], detail: [canvases[2], canvases[3]], label: 'Seite ' + (index + 1),
          pdfium: () => ({ path, pageIndex: index }),
          onFirstPaint: () => { painted.add(index); if (index === 0 && !firstPage) firstPage = performance.now() - started },
        })
        painters.set(index, painter)
        void pdf.getPage(index + 1).then((page) => { if (painters.get(index) === painter) { painter.setPage(page, 0); void painter.paint() } })
      }
      const unmount = (host) => {
        const index = Number(host.dataset.index)
        const painter = painters.get(index)
        if (!painter) return
        painters.delete(index); painted.delete(index); painter.dispose()
        host.textContent = ''
      }
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) (entry.isIntersecting ? mount : unmount)(entry.target)
      }, { root: scroller, rootMargin: '900px 0px' })
      hosts.forEach((host) => observer.observe(host))
      while (!firstPage && performance.now() - started < 60000) await frame()
      for (let i = 0; i < 30; i += 1) await frame()
      const deltas = []
      let blank = 0, last = performance.now()
      const step = 140
      const pageSpan = Math.round(820 * ratio) + 18
      while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) {
        scroller.scrollTop += step
        await frame()
        const now = performance.now(); deltas.push(now - last); last = now
        const centre = Math.floor((scroller.scrollTop + scroller.clientHeight / 2 - 24) / pageSpan)
        if (!painted.has(Math.min(PAGES - 1, centre))) blank += 1
      }
      observer.disconnect()
      for (const host of hosts) unmount(host)
      await pdf.destroy()
      deltas.sort((a, b) => a - b)
      const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))]
      return {
        mode, firstPageMs: Math.round(firstPage), frames: deltas.length,
        p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +deltas.at(-1).toFixed(1),
        over50ms: deltas.filter((d) => d > 50).length, blankCentreFrames: blank,
        scrollSeconds: +(deltas.reduce((a, b) => a + b, 0) / 1000).toFixed(1),
      }
    }
    const runs = []
    for (const mode of ['pdfjs', 'native', 'pdfjs', 'native']) runs.push(await bench(mode))
    await post('bench', runs)
    await post('done', true)
  } catch (error) { await fail(error) }
</script></body></html>`

// --- harness -----------------------------------------------------------------
const results = {}
let finish
const finished = new Promise((resolve) => { finish = resolve })
const vite = await createViteServer({
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5174, strictPort: true, hmr: false },
  plugins: [{
    name: 'native-pdf-probe',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === '/' || request.url === '/index.html') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(probe)
          return
        }
        if (request.url === '/__probe' && request.method === 'POST') {
          let body = ''
          request.on('data', (chunk) => { body += chunk })
          request.on('end', () => {
            const { name, value } = JSON.parse(body)
            results[name] = value
            console.log(`[probe] ${name}: ${JSON.stringify(value).slice(0, 600)}`)
            response.end('ok')
            if (name === 'done' || name === 'error') finish()
          })
          return
        }
        next()
      })
    },
  }],
})
await vite.listen()

const app = spawn(binary, [], {
  env: { ...process.env, XDG_DATA_HOME: dataHome, WEBKIT_DISABLE_COMPOSITING_MODE: process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (chunk) => { appLog = `${appLog}${chunk}`.slice(-4000) })
app.stderr.on('data', (chunk) => { appLog = `${appLog}${chunk}`.slice(-4000) })
const timeout = setTimeout(() => { results.error ??= 'timeout'; finish() }, 15 * 60 * 1000)
app.once('exit', (code) => { results.error ??= `app exited ${code}: ${appLog.slice(-1500)}`; finish() })
await finished
clearTimeout(timeout)
app.kill('SIGTERM')
await vite.close()
if (outFile) writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`)

try {
  assert.equal(results.error, undefined, `probe failed: ${results.error}`)
  assert.equal(results.env.pdfNative, true, 'the Tauri bridge offers pdfNative')
  for (const row of results.raster) {
    assert.ok(row.painted > 0 && row.iou >= 0.95, `${row.name}: wasm raster vs canvas IoU ${row.iou.toFixed(3)}`)
    assert.ok(row.uploadMaxDiff <= 1, `${row.name}: putImageData upload changed opaque pixels by ${row.uploadMaxDiff}`)
  }
  const parity = results.parity
  assert.equal(parity.bytes, parity.expected, 'a native window is width × height × 4 raw bytes')
  assert.deepEqual([parity.dx, parity.dy], [0, 0], 'the native page sits exactly where pdf.js paints it')
  assert.ok(parity.aligned.iou >= 0.8, `native vs pdf.js dark-pixel IoU ${parity.aligned.iou.toFixed(3)}`)
  assert.ok(parity.aligned.mean <= 6, `native vs pdf.js mean channel difference ${parity.aligned.mean.toFixed(2)}`)
  console.log('native-pdf-webview ok')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
