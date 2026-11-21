'use strict'

// QA-015: npm 12 does not run the postinstall script of dependencies, so `npm ci` can leave
// node_modules/electron without its binary and `electron .` aborts with "Electron failed to
// install correctly". This runs from the project's own postinstall and downloads the binary
// through electron's installer when it is missing. It never fails the install: without network
// the message tells how to retry.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const electronRoot = path.join(__dirname, '..', 'node_modules', 'electron')

/** True when electron is not a dependency here or its binary is already in place. */
const electronInstalled = (root = electronRoot) => {
  if (!fs.existsSync(path.join(root, 'install.js'))) return true
  try {
    const relative = fs.readFileSync(path.join(root, 'path.txt'), 'utf8').trim()
    return relative.length > 0 && fs.existsSync(path.join(root, 'dist', relative))
  } catch {
    return false
  }
}

const main = () => {
  if (process.env.FANOTES_SKIP_ELECTRON_INSTALL === '1' || process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') return 0
  if (electronInstalled()) return 0
  console.log('Electron binary is missing (npm 12 skips dependency install scripts); running electron/install.js ...')
  const result = spawnSync(process.execPath, [path.join(electronRoot, 'install.js')], { stdio: 'inherit' })
  if (result.status !== 0 || !electronInstalled()) {
    console.warn('Could not download Electron. Retry with: node node_modules/electron/install.js')
  }
  return 0
}

if (require.main === module) process.exitCode = main()

module.exports = { electronInstalled }
