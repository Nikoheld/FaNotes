'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const MODEL = Object.freeze({
  id: 'posformer-crohme-q4-k',
  filename: 'posformer-crohme-q4_k.gguf',
  size: 10_316_032,
  sha256: 'd9ff050f50a5bdefd64f0ffcafdd15a19472048aaf22a587a887a05771c74696',
  url: 'https://huggingface.co/cstr/posformer-crohme-GGUF/resolve/main/posformer-crohme-q4_k.gguf',
  homepage: 'https://huggingface.co/cstr/posformer-crohme-GGUF',
  license: 'CC-BY-NC-SA-3.0',
})

const MAX_RUNTIME_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 1024 * 512
const MAX_OUTPUT_BYTES = 64 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const RECOGNITION_TIMEOUT_MS = 30_000

const hashFile = (filename) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filename)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.once('error', reject)
  stream.once('end', () => resolve(hash.digest('hex')))
})

async function checkedRegularFile(filename, minimumSize, maximumSize) {
  const info = await fsp.lstat(filename)
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size < minimumSize
    || info.size > maximumSize
  ) throw new Error('Die lokale Formelmodell-Datei ist ungültig.')
  return info
}

function cleanEnhancedMathLatex(value) {
  if (typeof value !== 'string') return ''
  let cleaned = value
    .normalize('NFC')
    .replace(/<\/?(?:sos|eos|pad)>/giu, '')
    .replace(/^\s*(?:\$\$?|\\\[)/u, '')
    .replace(/(?:\$\$?|\\\])\s*$/u, '')
    .replace(/[\t\r\n]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  if (!cleaned || cleaned.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(cleaned)) return ''
  if (!/[\p{L}\p{N}\\]/u.test(cleaned)) return ''
  if (!/^[\p{L}\p{N}\s\\{}()[\]^_+\-*/=<>.,:;!?%|&'"`~]+$/u.test(cleaned)) return ''
  if (/\\(?:input|include|includegraphics|href|url|html\w*|require)\b/iu.test(cleaned)) return ''
  if (/(\\[A-Za-z]+)(?:\s*\1){12,}/u.test(cleaned)) return ''
  let braces = 0
  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index]
    if ((character === '{' || character === '}') && cleaned[index - 1] === '\\') continue
    if (character === '{') braces += 1
    if (character === '}') braces -= 1
    if (braces < 0) {
      // Greedy sequence decoders occasionally emit one or more redundant
      // closing group braces after an otherwise complete expression. Remove
      // only a suffix made exclusively of those braces; an unmatched brace in
      // the middle still rejects the complete result instead of guessing.
      if (/^[}\s]*$/u.test(cleaned.slice(index))) {
        cleaned = cleaned.slice(0, index).trim()
        braces = 0
        break
      }
      return ''
    }
  }
  return braces === 0 ? cleaned : ''
}

function analyzeEnhancedMathDiagnostics(value) {
  const margins = []
  for (const line of String(value).split(/\r?\n/gu)) {
    const topFive = line.split('top5:')[1]
    if (!topFive) continue
    const scores = [...topFive.matchAll(/\((-?\d+(?:\.\d+)?)\)/gu)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
    if (scores.length >= 2) margins.push(scores[0] - scores[1])
  }
  if (!margins.length) return { meanTokenMargin: 0, weakTokenRatio: 1, decodedTokens: 0 }
  return {
    // These are decoder-logit margins, not a claimed probability. Keeping the
    // raw bounded summaries lets the renderer apply conservative gates without
    // pretending that an uncalibrated score is a percentage confidence.
    meanTokenMargin: Math.max(0, Math.min(32, margins.reduce((sum, margin) => sum + margin, 0) / margins.length)),
    weakTokenRatio: margins.filter((margin) => margin < 0.5).length / margins.length,
    decodedTokens: margins.length,
  }
}

const hasEnhancedMathStructure = (latex) => (
  /\\(?:frac|sqrt|sum|prod|int|oint|lim|limits|overline|underline|matrix)\b|[_^]\s*\{/u.test(latex)
)

function createEnhancedMathService({
  userDataPath,
  runtimePath,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  model = MODEL,
}) {
  if (!path.isAbsolute(userDataPath) || typeof runtimePath !== 'function') {
    throw new Error('Ungültige Formelmodell-Konfiguration.')
  }
  const descriptor = Object.freeze({ ...model })
  if (
    typeof descriptor.id !== 'string'
    || !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(descriptor.id)
    || typeof descriptor.filename !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{2,120}$/u.test(descriptor.filename)
    || !Number.isSafeInteger(descriptor.size)
    || descriptor.size <= 0
    || descriptor.size > 32 * 1024 * 1024
    || !/^[a-f0-9]{64}$/u.test(descriptor.sha256)
    || new URL(descriptor.url).protocol !== 'https:'
  ) throw new Error('Ungültige Formelmodell-Beschreibung.')
  const modelDirectory = path.join(userDataPath, 'models', 'enhanced-math')
  const modelPath = path.join(modelDirectory, descriptor.filename)
  let verifiedModelKey = ''
  let downloadPromise = null
  let recognitionActive = false

  const verifyRuntime = async () => {
    const requested = runtimePath()
    const candidates = (Array.isArray(requested) ? requested : [requested])
      .filter((filename) => typeof filename === 'string' && filename.trim())
      .map((filename) => path.resolve(filename))
    const valid = []
    for (const filename of candidates) {
      try {
        const info = await checkedRegularFile(filename, 16 * 1024, MAX_RUNTIME_BYTES)
        if (process.platform !== 'win32' && (info.mode & 0o111) === 0) continue
        valid.push(filename)
      } catch {
        // The baseline executable may still support this system.
      }
    }
    if (!valid.length) throw new Error('Die native Formelmodell-Laufzeit ist nicht verfügbar.')
    return valid
  }

  const verifyModel = async () => {
    const info = await checkedRegularFile(modelPath, descriptor.size, descriptor.size)
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
    if (key !== verifiedModelKey) {
      if (await hashFile(modelPath) !== descriptor.sha256) {
        throw new Error('Das erweiterte Formelmodell ist beschädigt.')
      }
      verifiedModelKey = key
    }
    return modelPath
  }

  const state = async () => {
    let supported = false
    let installed = false
    try {
      await verifyRuntime()
      supported = true
    } catch {
      supported = false
    }
    if (supported) {
      try {
        await verifyModel()
        installed = true
      } catch {
        installed = false
      }
    }
    return {
      supported,
      installed,
      downloading: Boolean(downloadPromise),
      modelId: descriptor.id,
      size: descriptor.size,
      license: descriptor.license,
      homepage: descriptor.homepage,
    }
  }

  const install = async (request) => {
    if (request?.acceptLicense !== true) {
      throw new Error('Die Modelllizenz muss vor dem Download ausdrücklich bestätigt werden.')
    }
    await verifyRuntime()
    try {
      await verifyModel()
      return state()
    } catch {
      // Missing or corrupt files are replaced only by a verified download.
    }
    if (downloadPromise) return downloadPromise
    downloadPromise = (async () => {
      await fsp.mkdir(modelDirectory, { recursive: true, mode: 0o700 })
      try {
        const existing = await fsp.lstat(modelPath)
        if (existing.isDirectory()) throw new Error('Der Modellpfad wird von einem Verzeichnis blockiert.')
        await fsp.unlink(modelPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const temporary = path.join(modelDirectory, `.${descriptor.filename}.${crypto.randomUUID()}.tmp`)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
      timeout.unref?.()
      let handle
      try {
        const response = await fetchImpl(descriptor.url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': 'FaNotes enhanced-math-model/1' },
        })
        if (!response?.ok || !response.body) throw new Error(`Modell-Download fehlgeschlagen (${response?.status ?? 'Netzwerk'}).`)
        const finalUrl = new URL(response.url || descriptor.url)
        if (finalUrl.protocol !== 'https:') throw new Error('Unsicheres Modell-Downloadziel abgelehnt.')
        const declaredLength = Number(response.headers?.get?.('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength !== descriptor.size) {
          throw new Error('Der Modellserver meldet eine unerwartete Dateigrösse.')
        }
        handle = await fsp.open(temporary, 'wx', 0o600)
        const hash = crypto.createHash('sha256')
        let received = 0
        for await (const rawChunk of response.body) {
          const chunk = Buffer.from(rawChunk)
          received += chunk.length
          if (received > descriptor.size) throw new Error('Der Modell-Download überschreitet die erwartete Grösse.')
          hash.update(chunk)
          await handle.write(chunk)
        }
        if (received !== descriptor.size || hash.digest('hex') !== descriptor.sha256) {
          throw new Error('Das heruntergeladene Formelmodell hat die Integritätsprüfung nicht bestanden.')
        }
        await handle.sync()
        await handle.close()
        handle = null
        await fsp.rename(temporary, modelPath)
        verifiedModelKey = ''
        await verifyModel()
        return state()
      } finally {
        clearTimeout(timeout)
        await handle?.close().catch(() => {})
        await fsp.rm(temporary, { force: true }).catch(() => {})
      }
    })().finally(() => { downloadPromise = null })
    return downloadPromise
  }

  const recognize = async (request) => {
    if (recognitionActive) throw new Error('Eine erweiterte Formelerkennung läuft bereits.')
    if (
      !request
      || !(request.pixels instanceof Uint8Array)
      || !Number.isSafeInteger(request.width)
      || !Number.isSafeInteger(request.height)
      || request.width < 64
      || request.width > 1_024
      || request.height < 48
      || request.height > 512
      || request.pixels.length !== request.width * request.height
      || request.pixels.length > MAX_IMAGE_BYTES
    ) throw new Error('Das Formelbild ist ungültig.')
    recognitionActive = true
    const startedAt = Date.now()
    const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-enhanced-math-'))
    const imagePath = path.join(temporary, 'formula.pgm')
    let child
    try {
      const [executables, verifiedModel] = await Promise.all([verifyRuntime(), verifyModel()])
      const header = Buffer.from(`P5\n${request.width} ${request.height}\n255\n`, 'ascii')
      await fsp.writeFile(imagePath, Buffer.concat([header, Buffer.from(request.pixels)]), { mode: 0o600, flag: 'wx' })
      const configuredThreads = Number(request.threads)
      const threads = Number.isSafeInteger(configuredThreads) ? Math.max(1, Math.min(4, configuredThreads)) : 2
      const execute = async (executable) => {
        const runtimeDirectory = path.dirname(executable)
        const environment = { ...process.env }
        if (process.platform === 'win32') environment.PATH = `${runtimeDirectory};${environment.PATH ?? ''}`
        else environment.LD_LIBRARY_PATH = `${runtimeDirectory}:${environment.LD_LIBRARY_PATH ?? ''}`
        // CrispEmbed's unified math branch currently writes LaTeX backslashes
        // unescaped in `--json` mode, which is not valid JSON. Its plain mode
        // has the narrower and safer contract we need: LaTeX on stdout and
        // diagnostics on stderr. The result still passes the strict sanitizer
        // below before it can reach the renderer.
        child = spawnImpl(executable, ['-m', verifiedModel, '-t', String(threads), '--ocr', imagePath], {
          cwd: runtimeDirectory,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = Buffer.alloc(0)
        let stderr = Buffer.alloc(0)
        let outputOverflow = false
        const appendBounded = (current, chunk) => {
          const combined = Buffer.concat([current, Buffer.from(chunk)])
          if (combined.length > MAX_OUTPUT_BYTES) {
            outputOverflow = true
            child.kill('SIGKILL')
            return current
          }
          return combined
        }
        child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk) })
        child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk) })
        const outcome = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error('Die erweiterte Formelerkennung hat das Zeitlimit überschritten.'))
          }, RECOGNITION_TIMEOUT_MS)
          timer.unref?.()
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('close', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal })
          })
        })
        child = null
        return { ...outcome, stdout, stderr, outputOverflow }
      }
      let outcome = await execute(executables[0])
      const illegalInstruction = outcome.signal === 'SIGILL'
        || outcome.code === 132
        || outcome.code === 3
        || outcome.code === 3_221_225_501
        || outcome.code === -1_073_741_795
      if (illegalInstruction && executables.length > 1) outcome = await execute(executables[1])
      if (outcome.outputOverflow) throw new Error('Die native Formelmodell-Ausgabe ist unerwartet gross.')
      if (outcome.code !== 0) {
        throw new Error(`Die native Formelerkennung ist fehlgeschlagen: ${outcome.stderr.toString('utf8').trim().slice(-500)}`)
      }
      const latex = cleanEnhancedMathLatex(outcome.stdout.toString('utf8'))
      if (!latex) throw new Error('Das Formelmodell lieferte keine sichere LaTeX-Struktur.')
      const diagnostics = analyzeEnhancedMathDiagnostics(outcome.stderr.toString('utf8'))
      const structured = hasEnhancedMathStructure(latex)
      return {
        latex,
        engine: descriptor.id,
        durationMs: Date.now() - startedAt,
        structured,
        // On the independent MathWriting renderer audit, every structured
        // candidate below this raw top-1/top-2 margin was less reliable than
        // the classic fallback. This is a conservative acceptance gate, not a
        // fabricated probability score.
        recommended: structured && diagnostics.meanTokenMargin >= 2.25,
        ...diagnostics,
      }
    } finally {
      child?.kill('SIGKILL')
      recognitionActive = false
      await fsp.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
    }
  }

  return { state, install, recognize, model: descriptor }
}

module.exports = {
  MODEL,
  analyzeEnhancedMathDiagnostics,
  cleanEnhancedMathLatex,
  createEnhancedMathService,
}
