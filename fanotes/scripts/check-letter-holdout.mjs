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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-letter-holdout-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')
let server

const round = (value) => Math.round(value * 1000) / 1000

try {
  await build({
    root: workspace,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(root, 'scripts/fixtures/letter-holdout-harness.ts'),
        formats: ['es'],
        fileName: () => 'harness.js',
      },
    },
  })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./harness.js"></script></body></html>')
  server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      .replace(/^\/+|\.\./gu, '') || 'index.html'
    const target = path.join(output, relative)
    if (!target.startsWith(output) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Type', path.extname(target) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
    fs.createReadStream(target).pipe(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=1024',
    `--user-data-dir=${profile}`, '--virtual-time-budget=120000',
    '--dump-dom', `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  assert.equal(await new Promise((resolve) => chromium.on('close', resolve)), 0, stderr.slice(-2000))
  const error = /<pre id="error">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(error, undefined, error)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, stdout.slice(-1500))
  const report = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<'))
  assert.ok(report.clean.accuracy >= 0.98, `Isolated letters with a matching sample stayed under 98%: ${JSON.stringify(report.clean)}`)
  assert.ok(report.clean.precision >= 0.98, JSON.stringify(report.clean))
  assert.ok(report.clean.recall >= 0.98, JSON.stringify(report.clean))
  if (report.scribble.predicted) {
    throw new Error(`An unseen scribble was given a letter: ${JSON.stringify(report.scribble)}`)
  }
  const withheldOk = report.withheldQ.predicted === 'q' || report.withheldQ.status.every((status) => status === 'undecidable')
  assert.ok(withheldOk, `A letter without a GlyphenWerk sample invented a label: ${JSON.stringify(report.withheldQ)}`)
  assert.equal(report.rerecognizedQ, 'q', `Re-recognition ignored the new q sample: ${report.rerecognizedQ}`)
  assert.ok(
    report.lineCer.after <= report.lineCer.before + 0.001,
    `Connected-line CER regressed: ${JSON.stringify(report.lineCer)}`,
  )
  assert.deepEqual(report.sharpSReading, ['S', 't', 'r', 'a', 'ß', 'e'])
  assert.deepEqual(report.expandedSharpS, ['S', 't', 'r', 'a', 's', 's', 'e'])
  const summary = {
    stage: report.stage,
    isolatedWithSample: {
      beforeMisleadingSlice: {
        precision: round(report.misleadingLine.before.precision),
        recall: round(report.misleadingLine.before.recall),
        accuracy: round(report.misleadingLine.before.accuracy),
      },
      after: {
        precision: round(report.clean.precision),
        recall: round(report.clean.recall),
        accuracy: round(report.clean.accuracy),
      },
      afterMisleadingLine: {
        precision: round(report.misleadingLine.after.precision),
        recall: round(report.misleadingLine.after.recall),
        accuracy: round(report.misleadingLine.after.accuracy),
      },
    },
    lineCer: {
      reader: 'offline geometric recognizer; TrOCR line decoding is unchanged and not re-scored here',
      before: round(report.lineCer.before),
      after: round(report.lineCer.after),
      iamBefore: round(report.lineCer.iamBefore),
      iamAfter: round(report.lineCer.iamAfter),
    },
    isolatedCount: report.clean.truePositive + report.clean.falseNegative,
    lines: report.lines,
    withheldQ: report.withheldQ,
    scribble: report.scribble,
    wideWave: report.wideWave,
    rerecognizedQ: report.rerecognizedQ,
    misses: [
      ...report.lines.filter((entry) => entry.afterCer > 0).map((entry) => ({
        name: entry.name,
        truth: entry.truth,
        recognized: entry.after,
        cer: round(entry.afterCer),
      })),
      ...(report.wideWave?.predicted ? [{
        name: 'wide-wave',
        truth: null,
        recognized: report.wideWave.predicted,
        cer: null,
      }] : []),
    ],
    misleadingMisses: report.misleadingLine.after.misses.slice(0, 12),
  }
  const reportPath = path.join(root, 'docs/letter-holdout-report.json')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
}
