'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { nightlyVersion } = require('../electron/releaseVersion.cjs')

const root = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let described = ''
try {
  described = execFileSync('git', ['describe', '--exact-match', '--tags', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  described = ''
}

if (/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(described)) process.exit(0)

const committedAt = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
process.stdout.write(`${nightlyVersion(packageJson.version, committedAt, sha)}\n`)
