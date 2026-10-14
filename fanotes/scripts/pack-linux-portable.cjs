'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { version } = require('../package.json')

const appRoot = path.resolve(__dirname, '..')
const archiveName = `FaNotes-${version}-x86_64`
const result = spawnSync('tar', [
  '-C', 'release',
  '--sort=name',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  "--mtime=@0",
  '--mode=u+rwX,go+rX,go-w',
  `--transform=s#^linux-unpacked#${archiveName}#`,
  '-czf', `release/${archiveName}.tar.gz`,
  'linux-unpacked',
], { cwd: appRoot, stdio: 'inherit' })

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Portables Linux-Archiv geschrieben: release/${archiveName}.tar.gz`)
