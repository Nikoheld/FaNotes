import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(appRoot, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-personal-audit-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')

try {
  await build({
    root: workspaceRoot,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(appRoot, 'scripts/fixtures/personal-recognition-audit.ts'),
        formats: ['es'],
        fileName: () => 'audit.js',
      },
    },
  })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./audit.js"></script></body></html>')
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files', `--user-data-dir=${profile}`, '--virtual-time-budget=45000',
    '--dump-dom', pathToFileURL(path.join(output, 'index.html')).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolve) => chromium.on('close', resolve))
  assert.equal(exitCode, 0, `Chromium konnte das persönliche Erkennungsaudit nicht ausführen: ${stderr}`)
  const error = /<pre id="error">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(error, undefined, error)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, `Kein Ergebnis des persönlichen Erkennungsaudits: ${stdout.slice(-1500)}`)
  const result = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  console.log(JSON.stringify(result, null, 2))
  if (process.env.FANOTES_RECOGNITION_AUDIT_STRICT === '1') {
    assert.equal(result.failures.length, 0, `Persönliche Holdouts werden verwechselt: ${JSON.stringify(result.failures)}`)
    assert.ok(result.evaluatedSamples >= 100, `Die interne Modellwahl ist nicht breit genug über Klassen geschichtet: ${JSON.stringify(result)}`)
    // The internal score deliberately includes isolated O/0, I/l and other
    // normalization-equivalent glyphs for which no word position or line
    // geometry is available. It is a conservative weight-selection signal,
    // not the end-to-end quality gate. The independent, more aggressively
    // warped holdout below exercises the real segmenter and classifier.
    assert.ok(result.estimatedAccuracy >= 60, `Die interne Modellwahl ist instabil: ${JSON.stringify(result)}`)
    assert.ok(result.accuracy >= 95, `Die vollständige persönliche Erkennung besteht den Holdout nicht: ${JSON.stringify(result)}`)
    assert.ok(result.hintedAccuracy >= 95, `Die längengeführte persönliche Erkennung besteht den Holdout nicht: ${JSON.stringify(result)}`)
  }
} finally {
  fs.rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 100,
  })
}
