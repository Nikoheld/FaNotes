const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..')
const source = path.join(repoRoot, 'dist')
const destination = path.resolve(appRoot, 'public', 'glyphenwerk')

const glyphenwerkReady = () => fs.existsSync(path.join(source, 'index.html')) && fs.existsSync(path.join(source, 'assets'))

if (!glyphenwerkReady()) {
  const run = (args) => {
    // Windows needs a shell so Node can launch npm.cmd. spawnSync("npm.cmd")
    // without a shell fails with EINVAL.
    const result = spawnSync('npm', args, { cwd: repoRoot, stdio: 'inherit', shell: true, windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`GlyphenWerk: npm ${args.join(' ')} wurde mit Status ${result.status} beendet.`)
  }
  if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) run(['ci'])
  run(['run', 'build'])
}

if (!glyphenwerkReady()) {
  throw new Error('Der GlyphenWerk-Webbuild fehlt oder ist unvollständig.')
}

fs.rmSync(destination, { recursive: true, force: true })
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.cpSync(source, destination, { recursive: true })
console.log(`GlyphenWerk wurde lokal nach ${path.relative(appRoot, destination)} eingebettet.`)
