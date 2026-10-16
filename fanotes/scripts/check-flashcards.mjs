import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { applyReview, cardsFromMarkdown } = await server.ssrLoadModule('/src/lib/flashcards.ts')
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
  console.log('flashcards ok')
} finally {
  await server.close()
}
