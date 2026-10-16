import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

if (process.env.TZ !== 'America/New_York') {
  const rerun = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TZ: 'America/New_York' },
    stdio: 'inherit',
  })
  process.exit(rerun.status ?? 1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { applyReview, cardsFromMarkdown, reviewCard, reviewQueue } = await server.ssrLoadModule('/src/lib/flashcards.ts')
  const now = new Date(2026, 9, 16, 12, 0, 0)
  const markdown = `## Lernfragen

<details><summary>Was ist 2?</summary>Zwei</details>
`
  const first = cardsFromMarkdown(markdown, now)
  assert.equal(first.length, 1)
  assert.notEqual(first[0].id, 'card-1')
  const reviewed = applyReview(markdown, first[0].id, 'good', now)
  const withNew = reviewed.replace(
    '## Lernfragen\n',
    '## Lernfragen\n\n<details><summary>Was ist 1?</summary>Eins</details>\n',
  )
  const both = cardsFromMarkdown(withNew, now)
  assert.equal(new Set(both.map((card) => card.id)).size, 2)
  const kept = both.find((card) => card.front === 'Was ist 2?')
  const fresh = both.find((card) => card.front === 'Was ist 1?')
  assert.equal(kept.reps, 1)
  assert.equal(fresh.reps, 0)
  const after = cardsFromMarkdown(applyReview(withNew, fresh.id, 'easy', now), now)
  assert.equal(after.find((card) => card.front === 'Was ist 2?').reps, 1)
  assert.equal(after.find((card) => card.front === 'Was ist 1?').reps, 1)

  const card = (id) => ({ id, front: id, back: '', ease: 2.5, intervalDays: 1, due: '2026-10-16', reps: 1, lapses: 0 })
  const due = [card('a'), card('b'), card('c')]
  assert.deepEqual(reviewQueue(due, []).map((item) => item.id), ['a', 'b', 'c'])
  assert.deepEqual(reviewQueue(due, ['a']).map((item) => item.id), ['b', 'c'])
  assert.deepEqual(reviewQueue(due, ['a', 'b']).map((item) => item.id), ['c'])
  assert.deepEqual(reviewQueue(due, ['a', 'b', 'c']).map((item) => item.id), ['a', 'b', 'c'])
  assert.deepEqual(reviewQueue([card('b'), card('c')], ['a', 'b']).map((item) => item.id), ['c'])
  assert.deepEqual(reviewQueue([card('a')], ['a']).map((item) => item.id), ['a'])

  const repeating = { id: 'dst', front: 'dst', back: '', ease: 2.5, intervalDays: 1, due: '2026-11-01', reps: 1, lapses: 0 }
  const fallBack = reviewCard(repeating, 'hard', new Date(2026, 10, 1, 0, 30, 0))
  assert.equal(fallBack.intervalDays, 1)
  assert.equal(fallBack.due, '2026-11-02', 'a one-day review on the fall-back morning is the next calendar day')
  const spring = reviewCard(repeating, 'hard', new Date(2026, 2, 7, 23, 30, 0))
  assert.equal(spring.due, '2026-03-08', 'a one-day review before the spring jump does not skip a day')

  const view = readFileSync(join(root, 'src/components/FlashcardReview.tsx'), 'utf8')
  assert.match(view, /reviewQueue\(due, later\)/)
  assert.match(view, /value === 'again'/)
  assert.match(view, /GRADE_KEYS/)
  assert.match(view, /addEventListener\('keydown', onKey, true\)/)
  assert.match(view, /bindHandGestures/)
  assert.match(view, /copy\.show/)
  console.log('flashcards ok')
} finally {
  await server.close()
}
