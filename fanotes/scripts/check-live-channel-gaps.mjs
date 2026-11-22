// LiveChannel must not skip server messages it has never seen. The server sequence is global (shared by
// every note of the user), so a number jumping ahead proves nothing: only a fetch may advance the cursor.
// Here a peer's update reaches the server (and its push is lost) between two of our own sends.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import * as Y from 'yjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
try {
  const crypto = await vite.ssrLoadModule('/src/lib/sync/crypto.ts')
  const { LiveChannel } = await vite.ssrLoadModule('/src/lib/collab/liveChannel.ts')
  const keys = await crypto.deriveShareKeys(crypto.newShareKey())
  const channel = 'share-1'
  const seal = async (bytes) => crypto.toBase64(await crypto.encryptBytes(keys, `live:${channel}:u`, bytes))

  const server = { seq: 0, snap: null, updates: [] }
  const port = {
    async send(body) {
      if (body.k === 'i') { server.seq += 1; server.snap = { q: server.seq, d: body.d }; return { q: server.seq, seq: server.seq } }
      if (body.k === 'u') { server.seq += 1; server.updates.push({ q: server.seq, d: body.d }); return { q: server.seq, seq: server.seq } }
      return { q: server.seq, seq: server.seq }
    },
    async fetch(since) {
      return { seq: server.seq, snapshot: server.snap && server.snap.q > since ? server.snap : null, updates: server.updates.filter((item) => item.q > since) }
    },
  }

  const live = new LiveChannel({ port, keys, channel, deviceId: 'a', canWrite: true })
  const opened = await live.open('hello', false)
  assert.equal(opened.ok, true)

  // A peer (own lineage) writes through the server; the push to us is lost.
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(live.doc))
  const captured = []
  peer.on('update', (update) => captured.push(update))
  peer.getText('text').insert(5, ' from peer')
  server.seq += 1
  server.updates.push({ q: server.seq, d: await seal(captured[0]) })

  // We type and our update is sent: its sequence number lies after the peer's.
  live.text.insert(0, 'X')
  await live.flush()
  await live.catchUp()
  assert.ok(live.text.toString().includes('from peer'), `the peer's update was skipped: ${JSON.stringify(live.text.toString())}`)
  await live.close()

  // Closing the channel itself (the room key rotated, the share ended, access withdrawn) must reach the
  // note's close listeners: they release the sync guard of the file and let the editor join again.
  const { openLiveNote } = await vite.ssrLoadModule('/src/lib/collab/liveNotes.ts')
  const info = { shareId: 's', rel: 'a.md', canWrite: true, role: 'owner', peer: 'p', username: 'anna', deviceId: 'b' }
  const outcome = await openLiveNote({ info, port, keys, channelId: channel, store: undefined }, 'hello', false)
  assert.ok(outcome.note, 'the note opens')
  let closed = 0
  outcome.note.onClosed(() => { closed += 1 })
  await outcome.note.channel.close()
  assert.equal(closed, 1, 'closing the channel directly did not notify the note listeners')
  await outcome.note.close()
  assert.equal(closed, 1, 'the listeners run once')
  console.log('live channel checks passed')
} finally {
  await vite.close()
}
