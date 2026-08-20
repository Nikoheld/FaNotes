import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  emptyNoteNavStack,
  followNoteNav,
  goBackNoteNav,
} = await server.ssrLoadModule('/src/lib/noteLink.ts')

const runOnce = () => {
  const source = 'Faecher/Skript.pdf'
  const firstTarget = 'Faecher/Skript · Notiz.md'
  const secondTarget = 'Faecher/Skript · Notiz-2.md'

  let nav = { stack: emptyNoteNavStack(), current: source }
  assert.deepEqual(nav.stack, [])

  const emptyBack = goBackNoteNav(nav.stack, nav.current)
  assert.equal(emptyBack.current, source)
  assert.deepEqual(emptyBack.stack, [])

  nav = followNoteNav(nav.stack, nav.current, firstTarget)
  assert.equal(nav.current, firstTarget)
  assert.deepEqual(nav.stack, [source])

  nav = goBackNoteNav(nav.stack, nav.current)
  assert.equal(nav.current, source)
  assert.deepEqual(nav.stack, [])

  nav = followNoteNav(nav.stack, nav.current, firstTarget)
  nav = followNoteNav(nav.stack, nav.current, secondTarget)
  assert.equal(nav.current, secondTarget)
  assert.deepEqual(nav.stack, [source, firstTarget])

  nav = goBackNoteNav(nav.stack, nav.current)
  assert.equal(nav.current, firstTarget)
  nav = goBackNoteNav(nav.stack, nav.current)
  assert.equal(nav.current, source)
  assert.deepEqual(nav.stack, [])

  const stillHere = goBackNoteNav(nav.stack, nav.current)
  assert.equal(stillHere.current, source)

  return {
    afterFollow: firstTarget,
    afterTwoHops: secondTarget,
    afterBack: source,
    emptyStays: stillHere.current,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-link-back ok')
} finally {
  await server.close()
}
