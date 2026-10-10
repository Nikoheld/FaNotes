// Rebuilds the embedded wasm modules from the Rust workspace at the repo root.
//
//   node scripts/build-rust-wasm.mjs
//
// Needs the toolchain from rust-toolchain.toml with the wasm32-unknown-unknown
// target and wasm-bindgen-cli at the version Cargo.lock pins. The Electron and
// web builds do not run this: they use the committed glue and bytes.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(appRoot, '..')

const modules = [
  {
    crate: 'fanotes-wasm',
    artifact: 'fanotes_wasm',
    dir: join(appRoot, 'src', 'lib', 'paperWasm'),
    constant: 'PAPER_WASM_BASE64',
    bindgenFlags: [],
  },
  {
    crate: 'fanotes-raster-wasm',
    artifact: 'fanotes_raster_wasm',
    dir: join(appRoot, 'src', 'lib', 'rasterWasm'),
    constant: 'RASTER_WASM_BASE64',
    bindgenFlags: ['--remove-name-section', '--remove-producers-section'],
  },
]

const lockedBindgen = () => {
  const lock = readFileSync(join(repoRoot, 'Cargo.lock'), 'utf8')
  const match = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/u)
  if (!match) throw new Error('wasm-bindgen is not in Cargo.lock')
  return match[1]
}

const installed = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim().split(/\s+/u).at(-1)
const wanted = lockedBindgen()
if (installed !== wanted) {
  throw new Error(`wasm-bindgen ${installed} is installed, Cargo.lock pins ${wanted}: cargo install wasm-bindgen-cli --version ${wanted} --locked`)
}

execFileSync('cargo', [
  'build',
  '--release',
  '--target', 'wasm32-unknown-unknown',
  ...modules.flatMap((module) => ['-p', module.crate]),
], { cwd: repoRoot, stdio: 'inherit' })

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

for (const module of modules) {
  const out = mkdtempSync(join(tmpdir(), `${module.artifact}-`))
  try {
    execFileSync('wasm-bindgen', [
      '--target', 'web',
      ...module.bindgenFlags,
      '--out-dir', out,
      join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', `${module.artifact}.wasm`),
    ], { stdio: 'inherit' })
    mkdirSync(module.dir, { recursive: true })
    const changed = []
    for (const glue of [`${module.artifact}.js`, `${module.artifact}.d.ts`]) {
      const target = join(module.dir, glue)
      const before = (() => { try { return readFileSync(target) } catch { return null } })()
      copyFileSync(join(out, glue), target)
      if (!before || !before.equals(readFileSync(target))) changed.push(glue)
    }
    const bytes = readFileSync(join(out, `${module.artifact}_bg.wasm`))
    const source = `/* Generated from ${module.crate}. Do not edit. */\nexport const ${module.constant} = ${JSON.stringify(bytes.toString('base64'))}\n`
    if (writeIfChanged(join(module.dir, 'bytes.ts'), source)) changed.push('bytes.ts')
    console.log(`${module.crate}: ${bytes.length} bytes${changed.length ? `, updated ${changed.join(', ')}` : ', unchanged'}`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
