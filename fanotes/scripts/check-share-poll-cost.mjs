// A shared (editable) note is polled every second while it is open. A poll that finds nothing new must not
// cost time in proportion to the ink on the page (it used to parse, compare and serialise every stroke):
// this opens a share editor on a 100,000-point drawing against a fake port and times repeated polls.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
if (typeof globalThis.window === 'undefined') globalThis.window = { fanotes: {}, localStorage: { getItem: () => null, setItem: () => {} } }
const vite = await createServer({ root: appRoot, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } })
try {
  const shareEdit = await vite.ssrLoadModule('/src/lib/sync/shareEdit.ts')
  const strokes = Array.from({ length: 1000 }, (_, index) => ({ color: '#000', width: 2, opacity: 1, points: Array.from({ length: 100 }, (_, point) => ({ x: (index * 7 + point) % 900, y: (point * 13 + index) % 1200 })) }))
  const notes = [{ path: 'a.md', title: 'A', content: 'text', ink: { width: 900, height: 1273, strokes } }]
  const session = JSON.stringify({ revision: 3, notes, editors: [], present: [] })
  let polls = 0
  let sinceSeen = null
  const port = {
    exchange: async (request) => {
      if (request.method === 'GET') {
        polls += 1
        sinceSeen = new URL(request.url).searchParams.get('since')
        const unchanged = sinceSeen === '3'
        return { status: 200, body: unchanged ? JSON.stringify({ revision: 3, editors: [], present: [], unchanged: true }) : session }
      }
      return { status: 200, body: JSON.stringify({ editors: [] }) }
    },
  }
  const share = { schemaVersion: 1, id: 'a'.repeat(32), mode: 'edit', kind: 'note', rootPath: 'a.md', title: 'A', notes, updatedAt: new Date().toISOString(), revision: 3 }
  const client = await shareEdit.openShareEditor({ share, name: 'Ada', port, origin: 'http://127.0.0.1', clientId: 'ada' })
  const before = client.version()
  const started = performance.now()
  for (let index = 0; index < 20; index += 1) await client.pull()
  const perPoll = (performance.now() - started) / 20
  assert.equal(sinceSeen, '3', 'the poll asks for changes since the revision it holds')
  assert.equal(client.version(), before, 'a poll at the same revision leaves the notes alone')
  assert.ok(perPoll < 15, `an idle poll took ${perPoll.toFixed(1)} ms`)
  // The App's once-a-second ink pass: nothing to add, nothing changed.
  const drawing = JSON.stringify({ schemaVersion: 1, width: 900, height: 1273, strokes })
  const started2 = performance.now()
  const next = shareEdit.drawingJsonWithRemoteInk(drawing, client.noteInk('a.md'))
  assert.equal(next, drawing, 'the shared strokes are already on the page')
  console.log(`share poll cost: ${perPoll.toFixed(2)} ms per idle poll; one full ink pass ${Math.round(performance.now() - started2)} ms (the App now runs it only when the share or the drawing changed)`)
} finally {
  await vite.close()
}
console.log('share poll cost: ok')
