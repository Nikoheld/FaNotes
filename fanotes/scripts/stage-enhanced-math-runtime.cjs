'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SOURCE_URL = 'https://github.com/CrispStrobe/CrispEmbed.git'
const SOURCE_COMMIT = 'b9b7fb44bfa2fed866f0577e390b2a1b8ad75bac'
const GGML_COMMIT = '0714117daca2471b00e09554c7eaa74a06b0b2c5'
const appRoot = path.resolve(__dirname, '..')
const platform = process.platform
const arch = process.arch

if (!['linux', 'win32'].includes(platform) || arch !== 'x64') {
  throw new Error(`Die native Formelmodell-Laufzeit wird nur für linux-x64 und win32-x64 gebaut, nicht ${platform}-${arch}.`)
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} wurde mit Status ${result.status} beendet.`)
}

const readCommand = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `${command} wurde mit Status ${result.status} beendet.`)
  return result.stdout.trim()
}

const requestedSource = process.env.FANOTES_CRISPEMBED_SOURCE?.trim()
const temporary = requestedSource ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-crispembed-source-'))
const source = requestedSource ? path.resolve(requestedSource) : path.join(temporary, 'CrispEmbed')
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-crispembed-build-'))
const destination = path.join(appRoot, 'native-math', `${platform}-${arch}`)

try {
  if (!requestedSource) {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', SOURCE_URL, source], temporary)
    run('git', ['checkout', '--detach', SOURCE_COMMIT], source)
    run('git', ['submodule', 'update', '--init', '--depth', '1', 'ggml'], source)
  }
  if (readCommand('git', ['rev-parse', 'HEAD'], source) !== SOURCE_COMMIT) {
    throw new Error('Der CrispEmbed-Quellstand entspricht nicht dem festgelegten Commit.')
  }
  if (readCommand('git', ['rev-parse', 'HEAD'], path.join(source, 'ggml')) !== GGML_COMMIT) {
    throw new Error('Der ggml-Quellstand entspricht nicht dem festgelegten Commit.')
  }
  const commonCmakeArguments = [
    '-S', source,
    '-B', build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_BACKEND_DL=OFF',
    '-DGGML_CPU_ALL_VARIANTS=OFF',
    '-DCRISPEMBED_BUILD_SHARED=OFF',
    '-DCRISPEMBED_NATIVE=OFF',
    '-DGGML_NATIVE=OFF',
    '-DGGML_BLAS=OFF',
    '-DGGML_CUDA=OFF',
    '-DGGML_VULKAN=OFF',
    '-DGGML_OPENMP=OFF',
    ...(platform === 'win32' ? ['-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'] : []),
  ]
  run('cmake', [
    ...commonCmakeArguments,
    '-DGGML_SSE42=ON',
    '-DGGML_AVX=ON',
    '-DGGML_AVX2=ON',
    '-DGGML_BMI2=ON',
    '-DGGML_FMA=ON',
    '-DGGML_F16C=ON',
  ])
  const parallel = Math.max(1, Math.min(4, Number(process.env.FANOTES_NATIVE_BUILD_JOBS) || 1))
  run('cmake', ['--build', build, '--config', 'Release', '--target', 'crispembed-cli', '--parallel', String(parallel)])
  const executableName = platform === 'win32' ? 'crispembed.exe' : 'crispembed'
  const optimizedName = platform === 'win32' ? 'crispembed-avx2.exe' : 'crispembed-avx2'
  const candidates = [
    path.join(build, executableName),
    path.join(build, 'Release', executableName),
  ]
  const executable = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
  if (!executable) throw new Error('Die gebaute CrispEmbed-Laufzeit wurde nicht gefunden.')
  const optimizedBytes = fs.readFileSync(executable)
  run('cmake', [
    ...commonCmakeArguments,
    '-DGGML_SSE42=OFF',
    '-DGGML_AVX=OFF',
    '-DGGML_AVX2=OFF',
    '-DGGML_BMI2=OFF',
    '-DGGML_FMA=OFF',
    '-DGGML_F16C=OFF',
    '-DGGML_LLAMAFILE=OFF',
  ])
  run('cmake', ['--build', build, '--config', 'Release', '--target', 'crispembed-cli', '--parallel', String(parallel)])
  const baselineBytes = fs.readFileSync(executable)
  for (const [flavor, bytes] of [['avx2', optimizedBytes], ['baseline', baselineBytes]]) {
    if (bytes.length < 512 * 1024 || bytes.length > 32 * 1024 * 1024) {
      throw new Error(`Unerwartete CrispEmbed-${flavor}-Laufzeitgrösse: ${bytes.length} Bytes.`)
    }
  }
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 })
  const stagedExecutable = path.join(destination, executableName)
  const stagedOptimized = path.join(destination, optimizedName)
  fs.writeFileSync(stagedExecutable, baselineBytes, { mode: platform === 'win32' ? 0o644 : 0o755 })
  fs.writeFileSync(stagedOptimized, optimizedBytes, { mode: platform === 'win32' ? 0o644 : 0o755 })
  // CI and release hosts may use a restrictive 0077 umask. Force portable
  // resource permissions after writing so a system-wide Linux installation
  // remains executable for its non-root user.
  if (platform !== 'win32') {
    fs.chmodSync(destination, 0o755)
    fs.chmodSync(stagedExecutable, 0o755)
    fs.chmodSync(stagedOptimized, 0o755)
  }
  const manifestPath = path.join(destination, 'runtime-manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    format: 'fanotes-enhanced-math-runtime-v1',
    platform,
    arch,
    source: SOURCE_URL,
    sourceCommit: SOURCE_COMMIT,
    ggmlCommit: GGML_COMMIT,
    runtimes: [
      {
        flavor: 'avx2',
        executable: optimizedName,
        size: optimizedBytes.length,
        sha256: crypto.createHash('sha256').update(optimizedBytes).digest('hex'),
      },
      {
        flavor: 'baseline-x64',
        executable: executableName,
        size: baselineBytes.length,
        sha256: crypto.createHash('sha256').update(baselineBytes).digest('hex'),
      },
    ],
    modelBundled: false,
  }, null, 2)}\n`, { mode: 0o644 })
  if (platform !== 'win32') fs.chmodSync(manifestPath, 0o644)
  console.log(`Native Formelmodell-Laufzeiten bereit: ${path.relative(appRoot, destination)} (AVX2 ${optimizedBytes.length}, Baseline ${baselineBytes.length} Bytes)`)
} finally {
  fs.rmSync(build, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}
