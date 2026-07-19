'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const {
  analyzeEnhancedMathDiagnostics,
  cleanEnhancedMathLatex,
  createEnhancedMathService,
} = require('../electron/enhanced-math.cjs')

assert.equal(cleanEnhancedMathLatex('<sos> \\frac{x+1}{2} <eos>'), '\\frac{x+1}{2}')
assert.equal(cleanEnhancedMathLatex('$$ \\sum_{i=1}^{n} i $$'), '\\sum_{i=1}^{n} i')
assert.equal(cleanEnhancedMathLatex('\\frac{x}{2'), '')
assert.equal(cleanEnhancedMathLatex('\\frac{x}{2}}}}'), '\\frac{x}{2}')
assert.equal(cleanEnhancedMathLatex('\\frac{x}}{2}'), '')
assert.equal(cleanEnhancedMathLatex('\\href{https://example.invalid}{x}'), '')
assert.equal(cleanEnhancedMathLatex('x\u0000+y'), '')
const drawingBoardSource = fs.readFileSync(path.resolve(__dirname, '../src/components/DrawingBoard.tsx'), 'utf8')
assert.match(drawingBoardSource, /setTokens\(enhancedMathUsed \? \[\] : recognized\)/u)
assert.match(drawingBoardSource, /tokens\.length && !wholeFormulaResult/u)
assert.match(fs.readFileSync(path.resolve(__dirname, '../packaging/LICENSE-CRISPEMBED-MIT.txt'), 'utf8'), /MIT License/u)
assert.match(fs.readFileSync(path.resolve(__dirname, '../packaging/LICENSE-GGML-MIT.txt'), 'utf8'), /The ggml authors/u)
assert.match(fs.readFileSync(path.resolve(__dirname, '../public/THIRD_PARTY_NOTICES.txt'), 'utf8'), /PosFormer CROHME Q4_K/u)
assert.match(fs.readFileSync(path.resolve(__dirname, './prepare-release.cjs'), 'utf8'), /LICENSE-CRISPEMBED-MIT\.txt/u)
assert.deepEqual(
  analyzeEnhancedMathDiagnostics("step 0: token=74 '\\sqrt' | top5: \\sqrt(8.50) 7(5.00) 1(2.00)\nstep 1: token=18 '7' | top5: 7(6.00) 1(5.75)"),
  { meanTokenMargin: 1.875, weakTokenRatio: 0.5, decodedTokens: 2 },
)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-enhanced-math-check-'))
const runtime = path.join(temporary, process.platform === 'win32' ? 'crispembed.exe' : 'crispembed')
const optimizedRuntime = path.join(temporary, process.platform === 'win32' ? 'crispembed-avx2.exe' : 'crispembed-avx2')
const modelBytes = Buffer.from('bounded-q4-test-model')
const model = {
  id: 'test-math-model',
  filename: 'test-model.gguf',
  size: modelBytes.length,
  sha256: crypto.createHash('sha256').update(modelBytes).digest('hex'),
  url: 'https://models.example.invalid/test-model.gguf',
  homepage: 'https://models.example.invalid/',
  license: 'TEST-ONLY',
}
fs.writeFileSync(runtime, Buffer.alloc(20 * 1024, 1), { mode: 0o700 })
fs.writeFileSync(optimizedRuntime, Buffer.alloc(20 * 1024, 2), { mode: 0o700 })

const headers = new Map([['content-length', String(modelBytes.length)]])
const fetchImpl = async () => ({
  ok: true,
  status: 200,
  url: model.url,
  headers: { get: (name) => headers.get(name.toLocaleLowerCase()) ?? null },
  body: (async function * body() {
    yield modelBytes.subarray(0, 7)
    yield modelBytes.subarray(7)
  })(),
})

let pgmHeader = ''
let spawnCount = 0
const spawnImpl = (executable, args) => {
  spawnCount += 1
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  process.nextTick(() => {
    if (executable === optimizedRuntime) {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', null, 'SIGILL')
      return
    }
    const imagePath = args.at(-1)
    pgmHeader = fs.readFileSync(imagePath).subarray(0, 14).toString('ascii')
    assert.equal(args.includes('--json'), false, 'Der fehlerhafte JSON-Pfad der nativen Laufzeit darf nicht verwendet werden.')
    child.stdout.end('<sos> \\frac{x}{2} <eos>\n')
    child.stderr.end("  step 0: token=53 '\\frac' | top5: \\frac(8.50) -(5.00) =(2.00)\n")
    child.emit('close', 0)
  })
  return child
}

const service = createEnhancedMathService({
  userDataPath: temporary,
  runtimePath: () => [optimizedRuntime, runtime],
  fetchImpl,
  spawnImpl,
  model,
})

;(async () => {
  assert.deepEqual(
    { ...(await service.state()), homepage: undefined },
    {
      supported: true,
      installed: false,
      downloading: false,
      modelId: model.id,
      size: model.size,
      license: model.license,
      homepage: undefined,
    },
  )
  await assert.rejects(service.install({ acceptLicense: false }), /ausdrücklich bestätigt/u)
  const installed = await service.install({ acceptLicense: true })
  assert.equal(installed.installed, true)
  const finalModel = path.join(temporary, 'models', 'enhanced-math', model.filename)
  assert.deepEqual(await fsp.readFile(finalModel), modelBytes)
  assert.equal((await fsp.lstat(finalModel)).isSymbolicLink(), false)
  const result = await service.recognize({
    pixels: new Uint8Array(64 * 48).fill(255),
    width: 64,
    height: 48,
    threads: 4,
  })
  assert.equal(result.latex, '\\frac{x}{2}')
  assert.equal(result.structured, true)
  assert.equal(result.recommended, true)
  assert.equal(result.meanTokenMargin, 3.5)
  assert.equal(result.weakTokenRatio, 0)
  assert.equal(result.decodedTokens, 1)
  assert.equal(spawnCount, 2, 'Ein SIGILL des AVX2-Kindprozesses muss genau einmal auf die x64-Basislaufzeit zurückfallen.')
  assert.match(pgmHeader, /^P5\n64 48\n255\n/u)
  await assert.rejects(
    service.recognize({ pixels: new Uint8Array(3), width: 64, height: 48 }),
    /Formelbild ist ungültig/u,
  )
  console.log('Erweiterte Formelerkennung geprüft: Lizenz-Gate, atomarer Hash-Download, Eingabelimits, PGM-Prozessgrenze und LaTeX-Sanitizing.')
})().finally(() => {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
