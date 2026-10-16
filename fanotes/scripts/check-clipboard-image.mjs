import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { clipboardImageFile } = await server.ssrLoadModule('/src/lib/clipboardImage.ts')
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')

const png = new File([Uint8Array.from([1, 2, 3])], 'shot.png', { type: 'image/png' })
const unnamed = new File([Uint8Array.from([1])], 'bild.png', { type: '' })
const text = new File(['hi'], 'note.txt', { type: 'text/plain' })
const source = (files, plain, items = []) => ({
  files,
  items,
  getData: (type) => (type === 'text/plain' ? plain : ''),
})

assert.equal(clipboardImageFile(source([png], '')), png)
assert.equal(clipboardImageFile(source([png], ' \n ')), png, 'a blank clipboard is still a screenshot')
assert.equal(clipboardImageFile(source([png], 'hello')), null, 'text paste stays with the editor')
assert.equal(clipboardImageFile(source([text], '')), null)
assert.equal(clipboardImageFile(source([unnamed], '')), unnamed)
assert.equal(clipboardImageFile(source([], '', [{ kind: 'file', type: 'image/png', getAsFile: () => png }])), png)
assert.equal(clipboardImageFile(null), null)
assert.equal(clipboardImageFile({
  files: [],
  items: [],
  getData: () => { throw new Error('unavailable') },
}), null)

assert.match(app, /placeImage\(event\.clipboardData, event, 'Bild konnte nicht eingefügt werden\.'\)/)
assert.match(app, /addEventListener\('paste', onPaste, true\)/)
assert.match(app, /addEventListener\('drop', onDrop, true\)/)
assert.doesNotMatch(app, /closest\('textarea, input, \[contenteditable="true"\]'\)\) return/)

await server.close()
console.log('clipboard image ok')
