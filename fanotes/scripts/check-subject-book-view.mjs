import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  SUBJECT_BOOK_PLACEMENTS,
  applySubjectBookPlacement,
  parseSubjectBookPlacement,
  subjectBookViewPolicy,
  toggleSubjectBookView,
} = await server.ssrLoadModule('/src/lib/subjectBook.ts')

const runOnce = () => {
  const hidden = subjectBookViewPolicy({ hasBook: false, open: true, placement: 'rechts' })
  assert.equal(hidden.controlVisible, false)
  assert.equal(hidden.paneVisible, false)

  const closed = subjectBookViewPolicy({ hasBook: true, open: false, placement: 'rechts' })
  assert.equal(closed.controlVisible, true)
  assert.equal(closed.paneVisible, false)

  const placements = {}
  for (const placement of SUBJECT_BOOK_PLACEMENTS) {
    const applied = applySubjectBookPlacement(placement)
    assert.equal(applied.open, true)
    assert.equal(applied.placement, placement)
    const policy = subjectBookViewPolicy({ hasBook: true, open: applied.open, placement: applied.placement })
    assert.equal(policy.paneVisible, true)
    assert.equal(policy.placement, placement)
    placements[placement] = policy.placement
  }

  const unknown = parseSubjectBookPlacement('diagonal')
  assert.equal(unknown, null)
  const bad = applySubjectBookPlacement('diagonal')
  assert.equal(bad.open, false)
  assert.equal(bad.placement, null)
  const unknownPolicy = subjectBookViewPolicy({ hasBook: true, open: true, placement: 'diagonal' })
  assert.equal(unknownPolicy.paneVisible, false)
  assert.equal(unknownPolicy.placement, null)
  assert.ok(!SUBJECT_BOOK_PLACEMENTS.includes(unknownPolicy.placement))

  const toggled = toggleSubjectBookView(false, 'links')
  assert.equal(toggled.open, true)
  assert.equal(toggled.placement, 'links')
  const hiddenAgain = toggleSubjectBookView(true, 'links')
  assert.equal(hiddenAgain.open, false)

  return {
    hidden: hidden.controlVisible,
    closedVisible: closed.controlVisible,
    closedPane: closed.paneVisible,
    placements,
    unknown: unknownPolicy.placement,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('subject-book-view ok')
} finally {
  await server.close()
}
