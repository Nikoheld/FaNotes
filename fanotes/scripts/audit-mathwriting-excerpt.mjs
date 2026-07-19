import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(appRoot, '..')
const datasetRoot = path.resolve(process.env.FANOTES_MATHWRITING_ROOT?.trim() || '')
const split = process.env.FANOTES_MATHWRITING_SPLIT?.trim() || 'train'
const reserved = split === 'valid' || split === 'test'
const sampleLimit = Math.max(1, Math.min(100, Number(process.env.FANOTES_MATHWRITING_LIMIT) || 12))
const wallTimeoutMs = Math.max(30_000, Math.min(240_000, Number(process.env.FANOTES_MATHWRITING_TIMEOUT_MS) || 150_000))
const renderedWidth = Math.max(240, Math.min(840, Number(process.env.FANOTES_MATHWRITING_WIDTH) || 760))
const renderedHeight = Math.max(100, Math.min(500, Number(process.env.FANOTES_MATHWRITING_HEIGHT) || 260))

assert.ok(process.env.FANOTES_MATHWRITING_ROOT, 'FANOTES_MATHWRITING_ROOT muss auf den offiziellen MathWriting-Ausschnitt zeigen.')
assert.ok(
  ['train', 'valid', 'test', 'symbols', 'synthetic'].includes(split),
  'FANOTES_MATHWRITING_SPLIT muss train, valid, test, symbols oder synthetic sein.',
)
assert.ok(fs.statSync(datasetRoot).isDirectory(), `MathWriting-Verzeichnis nicht gefunden: ${datasetRoot}`)
if (reserved) {
  assert.equal(
    process.env.FANOTES_MATHWRITING_ALLOW_RESERVED,
    '1',
    `${split} ist reserviert. Für eine einmalige aggregierte Kontrolle FANOTES_MATHWRITING_ALLOW_RESERVED=1 setzen.`,
  )
}

const decodeXml = (value) => value
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'")
  .replaceAll('&amp;', '&')

const normalizeStrokes = (traces) => {
  const points = traces.flat()
  const minX = Math.min(...points.map((point) => point[0]))
  const maxX = Math.max(...points.map((point) => point[0]))
  const minY = Math.min(...points.map((point) => point[1]))
  const maxY = Math.max(...points.map((point) => point[1]))
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  // The app recognizer receives page-space ink, not a formula stretched to
  // the complete 900x560 selection canvas. Keep realistic Word-like formula
  // dimensions while preserving the original aspect ratio exactly.
  const scale = Math.min(renderedWidth / width, renderedHeight / height)
  const offsetX = (900 - width * scale) / 2
  const offsetY = (560 - height * scale) / 2
  return traces.map((trace) => ({
    points: trace.map(([x, y, t]) => ({
      x: (offsetX + (x - minX) * scale) / 900,
      y: (offsetY + (y - minY) * scale) / 560,
      t,
      pressure: 0.5,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'pen',
    })),
    baseWidth: 3,
    pressureEnabled: true,
    color: '#111827',
  }))
}

const parseInkml = (filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  assert.ok(source.length <= 8 * 1024 * 1024, `InkML-Datei ist unerwartet gross: ${filename}`)
  const expected = /<annotation\s+type="normalizedLabel">([\s\S]*?)<\/annotation>/u.exec(source)?.[1]
    || /<annotation\s+type="label">([\s\S]*?)<\/annotation>/u.exec(source)?.[1]
  const id = /<annotation\s+type="sampleId">([a-f0-9]{8,64})<\/annotation>/u.exec(source)?.[1]
    || path.basename(filename, '.inkml')
  assert.ok(expected, `Formellabel fehlt: ${filename}`)
  const traces = [...source.matchAll(/<trace\s+id="\d+">([\s\S]*?)<\/trace>/gu)].map((match) => (
    match[1].trim().split(/\s*,\s*/u).map((point) => {
      const values = point.trim().split(/\s+/u).map(Number)
      assert.ok(values.length >= 2 && values.slice(0, 3).every(Number.isFinite), `Ungültiger Trace in ${filename}`)
      return [values[0], values[1], values[2] ?? 0]
    })
  )).filter((trace) => trace.length)
  assert.ok(traces.length && traces.length <= 2_048, `Ungültige Stroke-Anzahl in ${filename}`)
  assert.ok(traces.reduce((sum, trace) => sum + trace.length, 0) <= 200_000, `Zu viele Punkte in ${filename}`)
  return { id, expected: decodeXml(expected), strokes: normalizeStrokes(traces) }
}

const files = fs.readdirSync(path.join(datasetRoot, split))
  .filter((filename) => filename.endsWith('.inkml'))
  .sort()
  .slice(0, sampleLimit)
assert.equal(files.length, sampleLimit, `Nur ${files.length} MathWriting-Beispiele in ${split} verfügbar.`)
const entries = files.map((filename) => parseInkml(path.join(datasetRoot, split, filename)))

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-mathwriting-audit-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
const dataPath = path.join(temporary, 'entries.json')
const entryPath = path.join(temporary, 'entry.ts')
let chromium

const terminateChromiumTree = (signal) => {
  if (!chromium?.pid || chromium.exitCode !== null || chromium.signalCode !== null) return
  try {
    if (process.platform === 'win32') chromium.kill(signal)
    else process.kill(-chromium.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

try {
  fs.writeFileSync(dataPath, JSON.stringify(entries))
  fs.writeFileSync(entryPath, [
    `import entries from ${JSON.stringify(pathToFileURL(dataPath).href)}`,
    `import { runMathWritingExternalAudit } from ${JSON.stringify(pathToFileURL(path.join(appRoot, 'scripts/fixtures/mathwriting-external-harness.ts')).href)}`,
    'const encode = (value) => {',
    '  const bytes = new TextEncoder().encode(value)',
    "  let binary = ''",
    '  for (const byte of bytes) binary += String.fromCharCode(byte)',
    '  return btoa(binary)',
    '}',
    'try {',
    '  const result = await runMathWritingExternalAudit(entries)',
    '  document.body.innerHTML = `<pre id="result">${encode(JSON.stringify(result))}</pre>`',
    '} catch (error) {',
    '  document.body.innerHTML = `<pre id="error">${encode(String(error?.stack || error))}</pre>`',
    '}',
  ].join('\n'))
  await build({
    root: workspaceRoot,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: { entry: entryPath, formats: ['es'], fileName: () => 'audit.js' },
    },
  })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./audit.js"></script></body></html>')
  chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=640', '--allow-file-access-from-files',
    `--user-data-dir=${profile}`, '--virtual-time-budget=120000', '--dump-dom',
    pathToFileURL(path.join(output, 'index.html')).href,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminateChromiumTree('SIGTERM')
      setTimeout(() => terminateChromiumTree('SIGKILL'), 2_000).unref()
      reject(new Error(`MathWriting-Audit überschritt ${wallTimeoutMs} ms.`))
    }, wallTimeoutMs)
    chromium.once('error', reject)
    chromium.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  assert.equal(exitCode, 0, `Chromium konnte den MathWriting-Audit nicht ausführen: ${stderr.slice(-2_000)}`)
  const browserError = /<pre id="error">([A-Za-z0-9+/=]+)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(browserError, undefined, browserError ? Buffer.from(browserError, 'base64').toString('utf8') : undefined)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, `Kein MathWriting-Ergebnis: ${stdout.slice(-2_000)}`)
  const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  const summary = {
    source: 'Google MathWriting 2024 excerpt',
    split,
    reserved,
    renderedWidth,
    renderedHeight,
    samples: result.samples,
    exact: result.exact,
    exactRate: result.exactRate,
    characters: result.characters,
    edits: result.edits,
    characterErrorRate: result.characterErrorRate,
  }
  if (!reserved && process.env.FANOTES_MATHWRITING_DETAILS === '1') summary.rows = result.rows
  console.log(JSON.stringify(summary, null, 2))
} finally {
  terminateChromiumTree('SIGKILL')
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
