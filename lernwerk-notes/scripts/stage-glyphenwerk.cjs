const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const source = path.resolve(appRoot, '..', 'dist')
const destination = path.resolve(appRoot, 'public', 'glyphenwerk')

if (!fs.existsSync(path.join(source, 'index.html')) || !fs.existsSync(path.join(source, 'assets'))) {
  throw new Error('Der GlyphenWerk-Webbuild fehlt oder ist unvollständig.')
}

fs.rmSync(destination, { recursive: true, force: true })
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.cpSync(source, destination, { recursive: true })
console.log(`GlyphenWerk wurde lokal nach ${path.relative(appRoot, destination)} eingebettet.`)
