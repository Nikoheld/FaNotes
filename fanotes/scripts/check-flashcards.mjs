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

const { reviewQueue } = await server.ssrLoadModule('/src/lib/flashcards.ts')
const view = readFileSync(join(root, 'src/components/FlashcardReview.tsx'), 'utf8')

const card = (id) => ({ id, front: id, back: '', ease: 2.5, intervalDays: 1, due: '2026-10-16', reps: 1, lapses: 0 })
const due = [card('a'), card('b'), card('c')]
assert.deepEqual(reviewQueue(due, []).map((item) => item.id), ['a', 'b', 'c'])
assert.deepEqual(reviewQueue(due, ['a']).map((item) => item.id), ['b', 'c'])
assert.deepEqual(reviewQueue(due, ['a', 'b']).map((item) => item.id), ['c'])
assert.deepEqual(reviewQueue(due, ['a', 'b', 'c']).map((item) => item.id), ['a', 'b', 'c'])
assert.deepEqual(reviewQueue([card('b'), card('c')], ['a', 'b']).map((item) => item.id), ['c'])
assert.deepEqual(reviewQueue([card('a')], ['a']).map((item) => item.id), ['a'])

assert.match(view, /reviewQueue\(due, later\)/)
assert.match(view, /value === 'again'/)
assert.match(view, /GRADE_KEYS/)
assert.match(view, /addEventListener\('keydown', onKey, true\)/)
assert.match(view, /bindHandGestures/)
assert.match(view, /copy\.show/)

await server.close()
console.log('flashcards ok')
