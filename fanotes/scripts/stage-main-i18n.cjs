'use strict'

const fs = require('node:fs')
const path = require('node:path')

const source = path.resolve(__dirname, '../resources/i18n/en.json')
const destination = path.resolve(__dirname, '../electron/i18n-en.json')

if (!fs.existsSync(source)) {
  throw new Error('Der englische Übersetzungskatalog fehlt.')
}

fs.copyFileSync(source, destination)
console.log('Englischer Main-Process-Katalog liegt neben electron/i18n.cjs.')
