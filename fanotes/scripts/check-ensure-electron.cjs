'use strict'

// Regression check for QA-015: the postinstall guard detects a missing electron binary
// (npm 12 skips dependency install scripts) and is wired into package.json.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronInstalled } = require('./ensure-electron.cjs')

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
assert.equal(pkg.scripts.postinstall, 'node scripts/ensure-electron.cjs', 'postinstall runs the guard')

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-electron-'))
try {
  assert.equal(electronInstalled(root), true, 'no electron package: nothing to install')
  fs.writeFileSync(path.join(root, 'install.js'), '')
  assert.equal(electronInstalled(root), false, 'package without binary')
  fs.writeFileSync(path.join(root, 'path.txt'), 'electron')
  assert.equal(electronInstalled(root), false, 'path.txt without dist')
  fs.mkdirSync(path.join(root, 'dist'))
  fs.writeFileSync(path.join(root, 'dist', 'electron'), '')
  assert.equal(electronInstalled(root), true, 'binary present')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
console.log('Electron install guard: ok')
