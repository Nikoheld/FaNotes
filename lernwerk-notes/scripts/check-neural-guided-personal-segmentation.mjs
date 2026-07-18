import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.resolve(root, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-guided-segmentation-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
let server

try {
  await build({
    root: workspace,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(root, 'scripts/fixtures/neural-guided-personal-segmentation-harness.ts'),
        formats: ['es'],
        fileName: () => 'harness.js',
      },
    },
  })
  fs.cpSync(path.join(root, 'public/spell'), path.join(output, 'spell'), { recursive: true })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./harness.js"></script></body></html>')
  server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      .replace(/^\/+|\.\./gu, '') || 'index.html'
    const target = path.join(output, relative)
    if (!target.startsWith(output) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end()
      return
    }
    const type = path.extname(target) === '.html'
      ? 'text/html; charset=utf-8'
      : path.extname(target) === '.js'
        ? 'text/javascript; charset=utf-8'
        : path.extname(target) === '.json'
          ? 'application/json; charset=utf-8'
          : 'application/octet-stream'
    response.setHeader('Content-Type', type)
    response.setHeader('Content-Length', fs.statSync(target).size)
    fs.createReadStream(target).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=1024',
    `--user-data-dir=${profile}`, '--virtual-time-budget=30000',
    '--dump-dom', `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  assert.equal(await new Promise((resolve) => chromium.on('close', resolve)), 0, stderr)
  const error = /<pre id="error">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(error, undefined, error)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, stdout.slice(-1200))
  const result = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  assert.equal(result.guided.toLocaleLowerCase('de'), 'test', JSON.stringify(result))
  assert.equal(result.guidedTokenCount, 4, JSON.stringify(result))
  assert.equal(result.integratedText.toLocaleLowerCase('de'), 'test', JSON.stringify(result))
  assert.equal(result.integratedTokenCount, 4, JSON.stringify(result))
  assert.deepEqual(
    {
      attempted: result.integratedRasterDecision?.attempted,
      accepted: result.integratedRasterDecision?.accepted,
      connected: result.integratedRasterDecision?.connected,
      text: result.integratedRasterDecision?.text?.toLocaleLowerCase('de'),
    },
    { attempted: true, accepted: true, connected: true, text: 'test' },
    `Die neue verbundene Rastersegmentierung erreicht den produktiven Sicherheitsentscheid nicht: ${JSON.stringify(result)}`,
  )
  assert.equal(
    result.misleadingMathIntegratedText.toLocaleLowerCase('de'),
    'test',
    `Eine falsche Integral-Vermutung darf persönliches Texttraining nicht blockieren: ${JSON.stringify(result)}`,
  )
  assert.equal(result.misleadingMathIntegratedTokenCount, 4, JSON.stringify(result))
  assert.equal(result.phraseIntegratedText.toLocaleLowerCase('de'), 'test test', JSON.stringify(result))
  assert.equal(result.phraseIntegratedTokenCount, 8, JSON.stringify(result))
  assert.equal(result.multiLineIntegratedText.toLocaleLowerCase('de'), 'test\ntest', JSON.stringify(result))
  assert.equal(result.multiLineIntegratedTokenCount, 8, JSON.stringify(result))
  assert.equal(
    result.connectedRasterBands,
    1,
    `Die Regression muss wirklich ein vollständig verbundenes Rasterwort ohne leere Spalte abbilden: ${JSON.stringify(result)}`,
  )
  assert.ok(
    result.connectedRasterTargetCounts.includes(4),
    `Der persönliche Rasterpfad bietet für ein verbundenes Vier-Buchstaben-Wort keine Vierersegmentierung an: ${JSON.stringify(result)}`,
  )
  assert.equal(
    result.connectedRasterPrediction.toLocaleLowerCase('de'),
    'test',
    `Eine falsche Zeilenmodellstelle muss durch vier verbundene persönliche Glyphen korrigiert werden: ${JSON.stringify(result)}`,
  )
  assert.ok(result.preferredHypothesisSizes.includes(4), JSON.stringify(result))
  console.log(`Neuronengeführte persönliche Segmentierung: ${result.unguided} → ${result.guided} → ${result.integratedText} (${result.integratedSource}); verbundenes Raster → ${result.connectedRasterPrediction}.`)
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
}
