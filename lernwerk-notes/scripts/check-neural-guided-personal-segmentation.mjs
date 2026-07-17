import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.resolve(root, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-guided-segmentation-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')

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
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./harness.js"></script></body></html>')
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=1024',
    '--allow-file-access-from-files', `--user-data-dir=${profile}`, '--virtual-time-budget=30000',
    '--dump-dom', pathToFileURL(path.join(output, 'index.html')).href,
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
  assert.equal(result.phraseIntegratedText.toLocaleLowerCase('de'), 'test test', JSON.stringify(result))
  assert.equal(result.phraseIntegratedTokenCount, 8, JSON.stringify(result))
  assert.ok(result.preferredHypothesisSizes.includes(4), JSON.stringify(result))
  console.log(`Neuronengeführte persönliche Segmentierung: ${result.unguided} → ${result.guided} → ${result.integratedText} (${result.integratedSource}) mit ${result.integratedTokenCount} Zeichen.`)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
}
