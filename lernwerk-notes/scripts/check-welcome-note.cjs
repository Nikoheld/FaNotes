'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
const preview = fs.readFileSync(path.join(root, 'src/lib/browserPreview.ts'), 'utf8')
const browserApi = fs.readFileSync(path.join(root, 'src/lib/browserApi.ts'), 'utf8')

const requiredTopics = [
  'Handschrift: schreiben wie auf Papier',
  'Durchkritzel-Empfindlichkeit',
  'Bereich konvertieren',
  'unsichtbare Transkription',
  'GlyphenWerk',
  'Mathematik-Korrigierer',
  'Kleine Handschrift-Übung',
]

for (const topic of requiredTopics) {
  assert.ok(main.includes(topic), `Desktop-Willkommensnotiz behandelt „${topic}“ nicht.`)
  assert.ok(preview.includes(topic), `Browser-Willkommensnotiz behandelt „${topic}“ nicht.`)
}

assert.match(main, /content === LEGACY_WELCOME_NOTE/u)
assert.match(main, /name: 'Willkommen\.md'/u)
assert.match(main, /name: 'Welcome\.md'/u)
assert.match(main, /queueFileWrite\(resolved\.target/u)
assert.match(main, /Mit \*\*Strg\+Z\*\*/u, 'Der Renderer-Bug durch Inline-Code in Willkommen.md ist nicht repariert.')
assert.match(preview, /Mit \*\*Strg\+Z\*\*/u)
assert.match(browserApi, /repairBrowserWelcomeMarkdown/u, 'Bestehende Web-Vaults erhalten keine Welcome.md-Reparatur.')
assert.match(browserApi, /Mit `Strg\\\+Z`\? holst du/u, 'Die deutsche Web-Migration deckt den alten oder unvollständigen Inline-Code nicht ab.')
assert.match(browserApi, /Press `Ctrl\\\+Z`\? to restore/u, 'Die englische Web-Migration deckt den alten oder unvollständigen Inline-Code nicht ab.')
assert.match(browserApi, /repairStore\.put\(row satisfies FileRecord\)/u, 'Die Web-Reparatur wird nicht dauerhaft in IndexedDB gespeichert.')

console.log('Willkommensnotiz erfolgreich: umfassende Handschrift-Einführung sowie dauerhafte Desktop- und Web-Reparatur des Strg+Z-Renderingfehlers.')
