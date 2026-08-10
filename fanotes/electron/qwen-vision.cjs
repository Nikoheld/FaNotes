'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * Optional Qwen3-VL vision recognizer for Intel Core Ultra NPUs.
 *
 * Format: OpenVINO IR INT4 (low power / high throughput on NPU)
 * Target: Intel Core Ultra 9 with NPU (Series 1/2 H/V SKUs, e.g. Ultra 9 185H/285H/288V)
 * Policy: when enabled, inference is NPU-only — never CPU fallback for power reasons.
 */

const MODEL = Object.freeze({
  id: 'qwen3-vl-2b-int4-npu',
  label: 'Qwen3-VL 2B · OpenVINO INT4 · NPU',
  // Community OpenVINO export of Qwen/Qwen3-VL-2B-Instruct (Apache-2.0).
  repo: 'shawnxhong/Qwen3-VL-2B-Instruct-ov-int4',
  revision: 'main',
  homepage: 'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct',
  license: 'Apache-2.0',
  precision: 'int4',
  device: 'NPU',
  // Files required for OpenVINO GenAI VLMPipeline.
  files: Object.freeze([
    'config.json',
    'generation_config.json',
    'openvino_config.json',
    'openvino_detokenizer.bin',
    'openvino_detokenizer.xml',
    'openvino_language_model.bin',
    'openvino_language_model.xml',
    'openvino_text_embeddings_model.bin',
    'openvino_text_embeddings_model.xml',
    'openvino_tokenizer.bin',
    'openvino_tokenizer.xml',
    'openvino_vision_embeddings_merger_model.bin',
    'openvino_vision_embeddings_merger_model.xml',
    'openvino_vision_embeddings_model.bin',
    'openvino_vision_embeddings_model.xml',
    'openvino_vision_embeddings_pos_model.bin',
    'openvino_vision_embeddings_pos_model.xml',
    'preprocessor_config.json',
    'processor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'chat_template.jinja',
  ]),
})

const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_OUTPUT_CHARS = 4_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const WORKER_TIMEOUT_MS = 90_000
const RUNTIME_INSTALL_TIMEOUT_MS = 45 * 60_000
const HF_BASE = 'https://huggingface.co'
/**
 * Packages installed into an isolated FaNotes venv for Qwen3-VL.
 * Qwen3-VL (`model_type: qwen3_vl`) needs OpenVINO GenAI ≥2026.1 — older 2025.x
 * builds raise: Unsupported 'qwen3_vl' VLM model type.
 */
const RUNTIME_PIP_PACKAGES = Object.freeze([
  'openvino>=2026.1',
  'openvino-genai>=2026.1',
  'openvino-tokenizers>=2026.1',
  'pillow>=10.0.0,<12',
])
const RUNTIME_MARKER_VERSION = 2
const MIN_OPENVINO_MAJOR = 2026
const MIN_OPENVINO_MINOR = 1

const hashFile = (filename) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filename)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.once('error', reject)
  stream.once('end', () => resolve(hash.digest('hex')))
})

const isAsarPath = (candidate) => String(candidate).includes(`${path.sep}app.asar${path.sep}`) || String(candidate).includes('/app.asar/')

const resolvePackagedWorkerSource = () => path.join(__dirname, 'qwen-vision-worker.py')

const lookUpCommand = async (command, spawnImpl) => {
  if (path.isAbsolute(command) && fs.existsSync(command)) return command
  const locator = process.platform === 'win32' ? 'where' : 'command'
  const locatorArgs = process.platform === 'win32' ? [command] : ['-v', command]
  try {
    const found = await new Promise((resolve, reject) => {
      const child = spawnImpl(locator, locatorArgs, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`not found: ${command}`))
          return
        }
        const line = stdout.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean)
        if (!line) reject(new Error(`not found: ${command}`))
        else resolve(line)
      })
    })
    return found
  } catch {
    return null
  }
}

const pythonSearchPaths = () => {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    const home = os.homedir()
    return [
      process.env.FANOTES_PYTHON,
      local ? path.join(local, 'Programs', 'Python', 'Python312', 'python.exe') : null,
      local ? path.join(local, 'Programs', 'Python', 'Python311', 'python.exe') : null,
      home ? path.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'python3.exe') : null,
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      'py',
      'python',
      'python3',
    ].filter(Boolean)
  }
  return [
    process.env.FANOTES_PYTHON,
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    '/bin/python3',
    path.join(os.homedir(), '.local', 'bin', 'python3'),
    '/usr/bin/python',
    '/usr/local/bin/python',
    'python3',
    'python',
  ].filter(Boolean)
}

function createQwenVisionService({
  userDataPath,
  workerSourcePath = resolvePackagedWorkerSource(),
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  model = MODEL,
}) {
  if (!path.isAbsolute(userDataPath)) throw new Error('Ungültiger Qwen-Vision-Datenpfad.')
  const descriptor = Object.freeze({ ...model, files: [...model.files] })
  const modelDirectory = path.join(userDataPath, 'models', 'qwen-vision', descriptor.id)
  const runtimeDirectory = path.join(userDataPath, 'models', 'qwen-vision', 'runtime')
  const venvDirectory = path.join(runtimeDirectory, 'python-env')
  const venvPythonPath = process.platform === 'win32'
    ? path.join(venvDirectory, 'Scripts', 'python.exe')
    : path.join(venvDirectory, 'bin', 'python')
  const materializedWorkerPath = path.join(runtimeDirectory, 'qwen-vision-worker.py')
  const integrityPath = path.join(modelDirectory, '.fanotes-integrity.json')
  const runtimeMarkerPath = path.join(venvDirectory, '.fanotes-openvino-runtime.json')
  let downloadPromise = null
  let recognitionActive = false
  let cachedProbe = null
  let cachedProbeAt = 0
  let resolvedPython = null
  let runtimeInstallPromise = null
  let runtimePhase = 'idle' // idle | preparing | installing | ready | error
  let runtimeMessage = null

  const fileUrl = (relativePath) => (
    `${HF_BASE}/${descriptor.repo}/resolve/${encodeURIComponent(descriptor.revision)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`
  )

  const runProcess = (command, args, { timeoutMs = RUNTIME_INSTALL_TIMEOUT_MS, cwd = runtimeDirectory } = {}) => (
    new Promise((resolve, reject) => {
      const child = spawnImpl(command, args, {
        cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH || (process.platform === 'win32'
            ? 'C:\\Windows\\System32;C:\\Windows'
            : '/usr/local/bin:/usr/bin:/bin'),
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
          PIP_DISABLE_PIP_VERSION_CHECK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Zeitlimit überschritten: ${path.basename(command)} ${args.slice(0, 3).join(' ')}`))
      }, timeoutMs)
      timer.unref?.()
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (stdout.length > 500_000) stdout = stdout.slice(-250_000)
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        if (stderr.length > 500_000) stderr = stderr.slice(-250_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }
        const detail = (stderr || stdout).trim().split(/\r?\n/u).filter(Boolean).slice(-8).join(' · ')
        reject(new Error(detail || `${path.basename(command)} beendete mit Code ${code ?? '?'}.`))
      })
    })
  )

  /**
   * Electron packs worker sources into app.asar. Python cannot execute scripts
   * from asar, and using an asar directory as cwd yields spawn ENOTDIR. Copy the
   * worker to a real userData path before every probe/inference run.
   */
  const ensureMaterializedWorker = async () => {
    await fsp.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
    const source = path.resolve(workerSourcePath)
    let sourceBytes
    try {
      // Electron's fs reads asar paths transparently.
      sourceBytes = await fsp.readFile(source)
    } catch (error) {
      throw new Error(`Qwen-Vision-Worker nicht lesbar: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!sourceBytes.length || sourceBytes.length > 256 * 1024) {
      throw new Error('Der Qwen-Vision-Worker ist ungültig.')
    }
    let needsWrite = true
    try {
      const existing = await fsp.readFile(materializedWorkerPath)
      needsWrite = existing.length !== sourceBytes.length || !existing.equals(sourceBytes)
    } catch {
      needsWrite = true
    }
    if (needsWrite) {
      const temporary = `${materializedWorkerPath}.${process.pid}.tmp`
      await fsp.writeFile(temporary, sourceBytes, { mode: 0o600 })
      await fsp.rename(temporary, materializedWorkerPath)
    }
    if (isAsarPath(materializedWorkerPath)) {
      throw new Error('Qwen-Vision-Worker konnte nicht aus dem App-Paket materialisiert werden.')
    }
    return materializedWorkerPath
  }

  const resolveBootstrapPython = async () => {
    const errors = []
    for (const candidate of pythonSearchPaths()) {
      try {
        if (path.isAbsolute(candidate)) {
          const info = await fsp.stat(candidate)
          if (!info.isFile()) {
            errors.push(`${candidate}: keine ausführbare Datei`)
            continue
          }
          if (process.platform !== 'win32' && (info.mode & 0o111) === 0) {
            errors.push(`${candidate}: nicht ausführbar`)
            continue
          }
          return candidate
        }
        const lookedUp = await lookUpCommand(candidate, spawnImpl)
        if (lookedUp && fs.existsSync(lookedUp)) return lookedUp
        errors.push(`${candidate}: nicht gefunden`)
      } catch (error) {
        errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(
      `Kein Python gefunden (${errors.slice(0, 4).join(' · ')}). `
      + 'Installiere Python 3.10–3.12 (empfohlen) und setze optional FANOTES_PYTHON.',
    )
  }

  const openvinoVersionOk = (version) => {
    const match = /^(\d+)\.(\d+)/u.exec(String(version || ''))
    if (!match) return false
    const major = Number(match[1])
    const minor = Number(match[2])
    return major > MIN_OPENVINO_MAJOR
      || (major === MIN_OPENVINO_MAJOR && minor >= MIN_OPENVINO_MINOR)
  }

  const venvHasRuntimePackages = async () => {
    if (!fs.existsSync(venvPythonPath)) return false
    try {
      const marker = JSON.parse(await fsp.readFile(runtimeMarkerPath, 'utf8'))
      // Bump RUNTIME_MARKER_VERSION whenever required wheels change (e.g. Qwen3-VL).
      if (marker?.version !== RUNTIME_MARKER_VERSION || !Array.isArray(marker.packages)) return false
      const check = await runProcess(venvPythonPath, [
        '-c',
        'import openvino, openvino_genai, openvino_tokenizers, PIL; print(openvino.__version__); print(getattr(openvino_genai, "__version__", "0"))',
      ], { timeoutMs: 60_000 })
      const lines = (check.stdout || '').trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
      const ovVersion = lines[0] || ''
      const genaiVersion = lines[1] || ovVersion
      if (!openvinoVersionOk(ovVersion) || !openvinoVersionOk(genaiVersion)) return false
      return true
    } catch {
      return false
    }
  }

  const ensureOpenVinoRuntime = async () => {
    if (runtimeInstallPromise) return runtimeInstallPromise
    runtimeInstallPromise = (async () => {
      runtimePhase = 'preparing'
      runtimeMessage = 'Python-Umgebung für OpenVINO wird vorbereitet …'
      await fsp.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
      if (await venvHasRuntimePackages()) {
        resolvedPython = venvPythonPath
        runtimePhase = 'ready'
        runtimeMessage = null
        cachedProbe = null
        return
      }

      const bootstrap = await resolveBootstrapPython()
      runtimePhase = 'preparing'
      runtimeMessage = 'Isolierte Python-Umgebung wird angelegt …'
      // Recreate venv if python binary missing or broken.
      if (!fs.existsSync(venvPythonPath)) {
        await fsp.rm(venvDirectory, { recursive: true, force: true }).catch(() => {})
        await runProcess(bootstrap, ['-m', 'venv', venvDirectory], { timeoutMs: 120_000 })
      }
      if (!fs.existsSync(venvPythonPath)) {
        throw new Error('Die FaNotes-Python-Umgebung für OpenVINO konnte nicht erzeugt werden.')
      }

      runtimePhase = 'installing'
      runtimeMessage = 'OpenVINO, OpenVINO GenAI und Pillow werden heruntergeladen (einmalig, mehrere 100 MB) …'
      // Ensure pip exists inside the venv.
      await runProcess(venvPythonPath, ['-m', 'ensurepip', '--upgrade'], { timeoutMs: 120_000 }).catch(() => {})
      await runProcess(venvPythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
        timeoutMs: 300_000,
      })
      await runProcess(venvPythonPath, [
        '-m', 'pip', 'install',
        '--upgrade',
        '--prefer-binary',
        ...RUNTIME_PIP_PACKAGES,
      ], { timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS })

      // Verify imports after install.
      const check = await runProcess(venvPythonPath, [
        '-c',
        'import openvino, openvino_genai, openvino_tokenizers, PIL; print(openvino.__version__); print(getattr(openvino_genai, "__version__", openvino.__version__))',
      ], { timeoutMs: 90_000 })
      const lines = (check.stdout || '').trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
      const openvinoVersion = lines[0] || 'unknown'
      const genaiVersion = lines[1] || openvinoVersion
      if (!openvinoVersionOk(openvinoVersion) || !openvinoVersionOk(genaiVersion)) {
        throw new Error(
          `OpenVINO ${openvinoVersion} / GenAI ${genaiVersion} ist zu alt für Qwen3-VL. `
          + 'Es wird OpenVINO GenAI ≥2026.1 benötigt.',
        )
      }
      const marker = {
        version: RUNTIME_MARKER_VERSION,
        installedAt: new Date().toISOString(),
        openvinoVersion,
        genaiVersion,
        packages: [...RUNTIME_PIP_PACKAGES],
      }
      const temporary = `${runtimeMarkerPath}.${process.pid}.tmp`
      await fsp.writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
      await fsp.rename(temporary, runtimeMarkerPath)

      resolvedPython = venvPythonPath
      runtimePhase = 'ready'
      runtimeMessage = null
      cachedProbe = null
      cachedProbeAt = 0
    })().catch((error) => {
      runtimePhase = 'error'
      runtimeMessage = error instanceof Error ? error.message : String(error)
      throw new Error(
        `OpenVINO-Laufzeit konnte nicht installiert werden: ${runtimeMessage}. `
        + 'Benötigt Python 3.10–3.12 und Internetzugang für den einmaligen Paket-Download.',
      )
    }).finally(() => {
      runtimeInstallPromise = null
    })
    return runtimeInstallPromise
  }

  const resolvePythonExecutable = async () => {
    // Prefer the isolated FaNotes venv once OpenVINO packages are present.
    if (fs.existsSync(venvPythonPath) && await venvHasRuntimePackages()) {
      resolvedPython = venvPythonPath
      return venvPythonPath
    }
    if (resolvedPython && fs.existsSync(resolvedPython)) return resolvedPython
    const bootstrap = await resolveBootstrapPython()
    resolvedPython = bootstrap
    return bootstrap
  }

  const runWorker = async (payload, timeoutMs = WORKER_TIMEOUT_MS) => {
    const worker = await ensureMaterializedWorker()
    const python = await resolvePythonExecutable()
    // Always use a real filesystem directory as cwd (never app.asar).
    const cwd = runtimeDirectory
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawnImpl(python, [worker], {
          cwd,
          env: {
            ...process.env,
            PATH: process.env.PATH || (process.platform === 'win32'
              ? 'C:\\Windows\\System32;C:\\Windows'
              : '/usr/local/bin:/usr/bin:/bin'),
            // Allow user-site OpenVINO installs (`pip install --user openvino …`).
            // Do not force PYTHONNOUSERSITE=1 — that hid intentionally installed packages.
            PYTHONUTF8: '1',
            PYTHONUNBUFFERED: '1',
            // Do not force OPENVINO_DEVICE / OV_NPU_PLATFORM here: probe must see
            // all devices, and newer NPUs break when pinned to MTL platform 3720.
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('Qwen-Vision-Worker Zeitlimit überschritten.'))
        }, timeoutMs)
        timer.unref?.()
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || ''
          if (!line) {
            reject(new Error(stderr.trim() || `Qwen-Vision-Worker beendete mit Code ${code ?? '?'}.`))
            return
          }
          try {
            resolve(JSON.parse(line))
          } catch {
            reject(new Error(`Ungültige Worker-Antwort: ${line.slice(0, 200)}`))
          }
        })
        child.stdin.end(`${JSON.stringify(payload)}\n`)
      })
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // Reset cached interpreter if it disappeared or is invalid.
      if (/ENOENT|ENOTDIR|EACCES/u.test(detail)) resolvedPython = null
      throw new Error(
        `Python/OpenVINO-Worker nicht startbar (${python}: ${detail}). `
        + 'Prüfe Python 3, OpenVINO GenAI und dass FANOTES_PYTHON auf eine echte python-Binary zeigt.',
      )
    }
  }

  const probe = async (force = false) => {
    if (!force && cachedProbe && Date.now() - cachedProbeAt < 30_000) return cachedProbe
    try {
      const result = await runWorker({ command: 'probe' }, 20_000)
      cachedProbe = {
        ok: Boolean(result?.ok),
        npu: Boolean(result?.npu),
        genai: Boolean(result?.genai),
        devices: Array.isArray(result?.devices) ? result.devices.map(String) : [],
        npuDevice: typeof result?.npuDevice === 'string' ? result.npuDevice : null,
        host: result?.host && typeof result.host === 'object' ? result.host : null,
        openvinoVersion: typeof result?.openvinoVersion === 'string' ? result.openvinoVersion : null,
        error: typeof result?.error === 'string' ? result.error : null,
      }
    } catch (error) {
      cachedProbe = {
        ok: false,
        npu: false,
        genai: false,
        devices: [],
        npuDevice: null,
        host: null,
        openvinoVersion: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    cachedProbeAt = Date.now()
    return cachedProbe
  }

  const readIntegrity = async () => {
    try {
      const raw = JSON.parse(await fsp.readFile(integrityPath, 'utf8'))
      if (raw?.version !== 1 || raw?.modelId !== descriptor.id || typeof raw?.files !== 'object') return null
      return raw
    } catch {
      return null
    }
  }

  const writeIntegrity = async (files) => {
    const payload = {
      version: 1,
      modelId: descriptor.id,
      repo: descriptor.repo,
      revision: descriptor.revision,
      precision: descriptor.precision,
      device: descriptor.device,
      createdAt: new Date().toISOString(),
      files,
    }
    const temporary = `${integrityPath}.${process.pid}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(temporary, integrityPath)
  }

  const verifyInstalled = async () => {
    const integrity = await readIntegrity()
    if (!integrity) return false
    for (const relativePath of descriptor.files) {
      const expected = integrity.files?.[relativePath]
      if (!expected?.sha256 || !Number.isSafeInteger(expected.size) || expected.size <= 0) return false
      const absolute = path.join(modelDirectory, relativePath)
      try {
        const info = await fsp.lstat(absolute)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size) return false
        if (await hashFile(absolute) !== expected.sha256) return false
      } catch {
        return false
      }
    }
    return true
  }

  const explainRuntimeError = (runtime) => {
    const raw = typeof runtime?.error === 'string' ? runtime.error : ''
    const missingOpenvino = /No module named ['"]openvino['"]|OpenVINO ist nicht verfügbar/iu.test(raw)
    const missingGenai = /No module named ['"]openvino_genai['"]|openvino-genai fehlt|GenAI/iu.test(raw)
    const installHint = process.platform === 'win32'
      ? 'Im Terminal: py -3 -m pip install --user "openvino>=2024.4" "openvino-genai>=2024.4" pillow'
      : 'Im Terminal: python3 -m pip install --user "openvino>=2024.4" "openvino-genai>=2024.4" pillow'
    if (missingOpenvino || (raw && !runtime.ok && !runtime.genai && !runtime.npu && /openvino/iu.test(raw))) {
      return (
        'OpenVINO fehlt in deinem Python. Qwen3-VL braucht die Pakete openvino und openvino-genai '
        + `(plus Pillow) für denselben Interpreter, den FaNotes nutzt. ${installHint}. `
        + 'Optional: FANOTES_PYTHON auf diesen Interpreter setzen. Danach Einstellungen neu öffnen.'
      )
    }
    if (missingGenai || (runtime.ok && runtime.npu && !runtime.genai)) {
      return (
        'OpenVINO GenAI fehlt. Installiere openvino-genai für Python 3 '
        + `(${installHint}). Danach Einstellungen neu öffnen.`
      )
    }
    if (raw) return raw
    if (!runtime.npu) {
      const devices = Array.isArray(runtime.devices) && runtime.devices.length
        ? runtime.devices.join(', ')
        : 'keine'
      const hostHints = Array.isArray(runtime.host?.hints) ? runtime.host.hints.join(' ') : ''
      return (
        'Keine Intel-NPU von OpenVINO erkannt '
        + `(sichtbare Geräte: ${devices}). `
        + 'Dein Core Ultra (z. B. Ultra X9 388H) hat eine NPU – sie muss vom Intel-NPU-Treiber und OpenVINO ≥2025 sichtbar sein. '
        + (hostHints ? `${hostHints} ` : '')
        + 'Qwen3-VL bleibt bewusst NPU-only (kein CPU-Fallback).'
      )
    }
    return 'Qwen3-VL-Laufzeit nicht bereit.'
  }

  const state = async () => {
    const runtime = await probe()
    const installed = await verifyInstalled()
    const runtimeReady = await venvHasRuntimePackages()
    const supported = Boolean(runtime.ok && runtime.npu && runtime.genai)
    const installingRuntime = runtimePhase === 'preparing' || runtimePhase === 'installing' || Boolean(runtimeInstallPromise)
    let error = null
    if (installingRuntime) {
      error = runtimeMessage || 'OpenVINO-Laufzeit wird installiert …'
    } else if (!supported) {
      error = explainRuntimeError(runtime)
      if (!runtimeReady && runtimePhase !== 'error') {
        error = (
          'OpenVINO-Laufzeit noch nicht installiert. '
          + 'FaNotes lädt openvino, openvino-genai und Pillow automatisch, sobald du die Lizenz bestätigst und herunterlädst.'
        )
      }
      if (runtimePhase === 'error' && runtimeMessage) {
        error = `OpenVINO-Laufzeitfehler: ${runtimeMessage}`
      }
    }
    return {
      supported,
      installed,
      downloading: Boolean(downloadPromise) && !installingRuntime,
      runtimeInstalling: installingRuntime,
      runtimeReady,
      runtimePhase,
      runtimeMessage,
      npu: Boolean(runtime.npu),
      genai: Boolean(runtime.genai),
      devices: runtime.devices,
      npuDevice: runtime.npuDevice ?? null,
      host: runtime.host ?? null,
      openvinoVersion: runtime.openvinoVersion,
      modelId: descriptor.id,
      label: descriptor.label,
      precision: descriptor.precision,
      device: descriptor.device,
      license: descriptor.license,
      homepage: descriptor.homepage,
      repo: descriptor.repo,
      error,
      installHint: null,
    }
  }

  const downloadFile = async (relativePath, destination) => {
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    timeout.unref?.()
    let handle
    try {
      const response = await fetchImpl(fileUrl(relativePath), {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'FaNotes qwen-vision/1',
          Accept: 'application/octet-stream,*/*',
        },
      })
      if (!response?.ok || !response.body) {
        throw new Error(`Download fehlgeschlagen für ${relativePath} (HTTP ${response?.status ?? 'Netzwerk'}).`)
      }
      const finalUrl = new URL(response.url || fileUrl(relativePath))
      if (finalUrl.protocol !== 'https:') throw new Error('Unsicheres Downloadziel abgelehnt.')
      handle = await fsp.open(temporary, 'wx', 0o600)
      const hash = crypto.createHash('sha256')
      let received = 0
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk)
        received += chunk.length
        if (received > 2_500_000_000) throw new Error(`Datei ${relativePath} ist unerwartet gross.`)
        hash.update(chunk)
        await handle.write(chunk)
      }
      if (received <= 0) throw new Error(`Leere Datei: ${relativePath}`)
      await handle.sync()
      await handle.close()
      handle = null
      await fsp.rename(temporary, destination)
      return { size: received, sha256: hash.digest('hex') }
    } finally {
      clearTimeout(timeout)
      await handle?.close().catch(() => {})
      await fsp.rm(temporary, { force: true }).catch(() => {})
    }
  }

  const install = async (request) => {
    if (request?.acceptLicense !== true) {
      throw new Error('Die Modelllizenz muss vor dem Download ausdrücklich bestätigt werden.')
    }
    if (downloadPromise) return downloadPromise

    downloadPromise = (async () => {
      // 1) Auto-download OpenVINO Python runtime into an isolated FaNotes venv.
      await ensureOpenVinoRuntime()
      // 2) Probe NPU with the freshly prepared environment.
      const runtime = await probe(true)
      if (!runtime.ok || !runtime.npu) {
        const devices = Array.isArray(runtime.devices) && runtime.devices.length
          ? ` OpenVINO sieht: ${runtime.devices.join(', ')}.`
          : ''
        throw new Error(
          (runtime.error
            || 'Intel-NPU erforderlich. Qwen3-VL ist NPU-only für geringen Stromverbrauch (Core Ultra + NPU-Treiber).')
          + devices,
        )
      }
      if (!runtime.genai) {
        throw new Error(
          runtime.error
          || 'OpenVINO GenAI ist nach der Laufzeit-Installation nicht nutzbar. Bitte erneut versuchen.',
        )
      }
      // 3) Download model weights if needed.
      if (await verifyInstalled()) return state()
      runtimePhase = 'ready'
      runtimeMessage = 'Qwen3-VL-Modell wird heruntergeladen …'
      await fsp.mkdir(modelDirectory, { recursive: true, mode: 0o700 })
      const files = {}
      for (const relativePath of descriptor.files) {
        const destination = path.join(modelDirectory, relativePath)
        try {
          const existing = await fsp.lstat(destination)
          if (existing.isFile() && !existing.isSymbolicLink() && existing.size > 0) {
            files[relativePath] = {
              size: existing.size,
              sha256: await hashFile(destination),
            }
            continue
          }
        } catch {
          // Download missing files.
        }
        files[relativePath] = await downloadFile(relativePath, destination)
      }
      await writeIntegrity(files)
      if (!(await verifyInstalled())) {
        throw new Error('Qwen3-VL-Installation unvollständig nach Download.')
      }
      runtimeMessage = null
      return state()
    })().finally(() => { downloadPromise = null })

    return downloadPromise
  }

  const sanitizeText = (value) => {
    if (typeof value !== 'string') return ''
    let text = value
      .normalize('NFC')
      .replace(/\r\n/gu, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
      .trim()
    // Drop common chatty prefixes from VLMs.
    text = text
      .replace(/^(?:the (?:handwritten )?text (?:is|reads|says)\s*[:\-]?\s*)/iu, '')
      .replace(/^(?:transcri(?:ption|bed text)\s*[:\-]?\s*)/iu, '')
      .trim()
    if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS).trim()
    return text
  }

  const recognize = async (request) => {
    if (recognitionActive) throw new Error('Eine Qwen3-VL-Erkennung läuft bereits.')
    if (
      !request
      || !(request.pixels instanceof Uint8Array)
      || !Number.isSafeInteger(request.width)
      || !Number.isSafeInteger(request.height)
      || request.width < 32
      || request.width > 2_048
      || request.height < 32
      || request.height > 2_048
      || request.pixels.length !== request.width * request.height * 3
      || request.pixels.length > MAX_IMAGE_BYTES
    ) throw new Error('Das Vision-Bild ist ungültig.')

    if (!(await verifyInstalled())) {
      throw new Error('Qwen3-VL ist nicht installiert. Lade das NPU-Modell in den Einstellungen.')
    }

    // Ensure GenAI is new enough for model_type qwen3_vl before the first call.
    if (!(await venvHasRuntimePackages())) {
      await ensureOpenVinoRuntime()
    }

    recognitionActive = true
    const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-qwen-vision-'))
    const imagePath = path.join(temporary, 'input.ppm')
    try {
      // RGB binary PPM — no extra dependency in main process.
      const header = Buffer.from(`P6\n${request.width} ${request.height}\n255\n`, 'ascii')
      await fsp.writeFile(imagePath, Buffer.concat([header, Buffer.from(request.pixels)]), {
        mode: 0o600,
        flag: 'wx',
      })
      const language = request.language === 'en' ? 'en' : 'de'
      const prompt = language === 'en'
        ? 'Transcribe the handwritten text in this image exactly. Return only the plain text, no markdown or commentary.'
        : 'Transkribiere den handgeschriebenen Text in diesem Bild exakt. Gib nur den reinen Text zurück, ohne Markdown oder Erklärungen.'
      const workerRequest = {
        command: 'recognize',
        modelDir: modelDirectory,
        imagePath,
        prompt,
        maxNewTokens: Number.isSafeInteger(request.maxNewTokens)
          ? Math.max(16, Math.min(256, request.maxNewTokens))
          : 96,
      }
      let result = await runWorker(workerRequest)
      // One automatic runtime upgrade if GenAI rejects qwen3_vl.
      if (
        !result?.ok
        && (
          result?.needsRuntimeUpgrade
          || /unsupported ['"]qwen3_vl['"]/iu.test(String(result?.error || ''))
        )
      ) {
        await fsp.rm(runtimeMarkerPath, { force: true }).catch(() => {})
        resolvedPython = null
        cachedProbe = null
        await ensureOpenVinoRuntime()
        result = await runWorker(workerRequest)
      }
      if (!result?.ok) {
        throw new Error(result?.error || 'Qwen3-VL-Inferenz fehlgeschlagen.')
      }
      if (!String(result.device || '').toUpperCase().includes('NPU')) {
        throw new Error('Qwen3-VL lief nicht auf der NPU und wurde abgelehnt.')
      }
      const text = sanitizeText(result.text)
      if (!text) throw new Error('Qwen3-VL lieferte keinen lesbaren Text.')
      return {
        text,
        device: 'NPU',
        precision: descriptor.precision,
        modelId: descriptor.id,
        confidence: 72,
      }
    } finally {
      recognitionActive = false
      await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    state,
    install,
    recognize,
    probe,
    model: descriptor,
  }
}

module.exports = {
  MODEL,
  createQwenVisionService,
}
