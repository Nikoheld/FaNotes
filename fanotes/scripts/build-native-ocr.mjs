// Rebuilds the committed native OCR sidecar (crates/fanotes-ort) into native-ocr/<platform>-<arch>.
//
//   node scripts/build-native-ocr.mjs [linux-x64] [win32-x64]
//
// Needs the toolchain from rust-toolchain.toml; win32-x64 cross-compiles with the
// x86_64-pc-windows-gnu target and mingw-w64. Packaging does not run this: electron-builder ships the
// committed sidecar next to ONNX Runtime from the pinned onnxruntime-node package.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(appRoot, '..')
const ONNXRUNTIME_VERSION = '1.21.0'

const targets = {
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', platform: 'linux', arch: 'x64', executable: 'fanotes-ocr', runtime: 'libonnxruntime.so.1', rustflags: [] },
  // The PE timestamp would make every build differ.
  'win32-x64': { triple: 'x86_64-pc-windows-gnu', platform: 'win32', arch: 'x64', executable: 'fanotes-ocr.exe', runtime: 'onnxruntime.dll', rustflags: ['-Clink-arg=-Wl,--no-insert-timestamp'] },
}

const requested = process.argv.slice(2)
for (const name of requested) {
  if (!targets[name]) throw new Error(`Unknown target ${name}; expected ${Object.keys(targets).join(' or ')}`)
}

const pinned = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).devDependencies['onnxruntime-node']
const installed = JSON.parse(readFileSync(join(appRoot, 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8')).version
if (pinned !== ONNXRUNTIME_VERSION || installed !== ONNXRUNTIME_VERSION) {
  throw new Error(`fanotes-ort is built for ONNX Runtime ${ONNXRUNTIME_VERSION}; package.json pins ${pinned}, node_modules has ${installed}`)
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const writeIfChanged = (file, contents) => {
  let previous = null
  try {
    previous = readFileSync(file)
  } catch {
    previous = null
  }
  const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  if (previous && previous.equals(next)) return false
  writeFileSync(file, next)
  return true
}

const targetDir = join(repoRoot, 'target', 'native-ocr')
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
const remap = [`--remap-path-prefix=${repoRoot}=.`, `--remap-path-prefix=${cargoHome}=cargo`]

for (const name of requested.length ? requested : Object.keys(targets)) {
  const target = targets[name]
  execFileSync('cargo', [
    'build', '--release', '--locked',
    '-p', 'fanotes-ort', '--bin', 'fanotes-ocr',
    '--target', target.triple,
    '--target-dir', targetDir,
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CARGO_PROFILE_RELEASE_STRIP: 'symbols',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
      CARGO_ENCODED_RUSTFLAGS: [...remap, ...target.rustflags].join('\x1f'),
    },
  })
  const directory = join(appRoot, 'native-ocr', name)
  mkdirSync(directory, { recursive: true })
  const executable = readFileSync(join(targetDir, target.triple, 'release', target.executable))
  const runtimeFrom = ['node_modules', 'onnxruntime-node', 'bin', 'napi-v3', target.platform, target.arch, target.runtime]
  const runtime = readFileSync(join(appRoot, ...runtimeFrom))
  const changed = []
  if (writeIfChanged(join(directory, target.executable), executable)) changed.push(target.executable)
  chmodSync(join(directory, target.executable), 0o755)
  const manifest = {
    format: 'fanotes-native-ocr-runtime-v1',
    platform: target.platform,
    arch: target.arch,
    engine: 'fanotes-ort-cpu',
    source: 'crates/fanotes-ort',
    rustTarget: target.triple,
    executable: { file: target.executable, size: executable.length, sha256: sha256(executable) },
    onnxruntime: {
      version: ONNXRUNTIME_VERSION,
      package: `onnxruntime-node@${ONNXRUNTIME_VERSION}`,
      from: runtimeFrom.join('/'),
      file: target.runtime,
      size: runtime.length,
      sha256: sha256(runtime),
    },
  }
  if (writeIfChanged(join(directory, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)) changed.push('runtime-manifest.json')
  console.log(`${name}: ${target.executable} ${executable.length} bytes${changed.length ? `, updated ${changed.join(', ')}` : ', unchanged'}`)
}
