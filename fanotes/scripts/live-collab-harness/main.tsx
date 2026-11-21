// Test-only page for scripts/check-live-collab-editor.mjs: three real MarkdownEditors (two writers, one reader)
// bound to live notes that talk through an in-page relay with the same semantics as fanotes-site/live-relay.mjs.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import '../../src/styles.css'
import { DEFAULT_SETTINGS } from '../../src/defaults'
import { MarkdownEditor } from '../../src/components/MarkdownEditor'
import { LiveChannel, type LivePort } from '../../src/lib/collab/liveChannel'
import { LiveNote } from '../../src/lib/collab/liveNotes'
import { liveUserFor } from '../../src/lib/collab/liveAwareness'
import { deriveShareKeys, newShareKey } from '../../src/lib/sync/crypto'

const CHANNEL = 'a'.repeat(32)
const w = window as unknown as Record<string, unknown>
const relay = { seq: 0, snap: null as { q: number; d: string } | null, updates: [] as Array<{ q: number; d: string }>, devices: new Map<string, LiveChannel>(), posts: 0 }
const LATENCY_MS = 20

const portFor = (deviceId: string, canWrite: boolean): LivePort => ({
  async send(body) {
    if (!canWrite) throw Object.assign(new Error('read only'), { status: 403 })
    relay.posts += 1
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
    let q: number | undefined
    if (body.k === 'i') {
      if (relay.snap || relay.updates.length) throw Object.assign(new Error('exists'), { status: 409 })
      relay.seq += 1
      relay.snap = { q: relay.seq, d: body.d }
      q = relay.seq
    } else if (body.k === 's') {
      relay.snap = { q: body.upTo ?? 0, d: body.d }
      relay.updates = relay.updates.filter((item) => item.q > (body.upTo ?? 0))
      relay.seq += 1
    } else if (body.k === 'u') {
      relay.seq += 1
      relay.updates.push({ q: relay.seq, d: body.d })
      q = relay.seq
    }
    if (body.k !== 's') {
      for (const [id, channel] of relay.devices) {
        if (id === deviceId) continue
        void channel.handlePush({ c: CHANNEL, k: body.k, q, f: deviceId, d: body.d })
      }
    }
    return { q, seq: relay.seq }
  },
  async fetch(since) {
    return { seq: relay.seq, snapshot: relay.snap && (since === 0 || since < relay.snap.q) ? relay.snap : null, updates: relay.updates.filter((item) => item.q > since) }
  },
})

type Peer = { id: string; name: string; canWrite: boolean; note: LiveNote | null; content: string; changes: string[] }
const peers: Peer[] = [
  { id: 'dev-a', name: 'Anna_F', canWrite: true, note: null, content: '', changes: [] },
  { id: 'dev-b', name: 'Ben_K', canWrite: true, note: null, content: '', changes: [] },
  { id: 'dev-c', name: 'Cleo_R', canWrite: false, note: null, content: '', changes: [] },
]
w.__peers = peers
const views = () => [...document.querySelectorAll<HTMLElement>('.cm-editor')].map((element) => EditorView.findFromDOM(element)!)
w.__views = views
w.__text = (index: number) => views()[index].state.doc.toString()
w.__posts = () => relay.posts
w.__live = (index: number) => peers[index].note
w.__changes = (index: number) => peers[index].changes

function App() {
  const [, setTick] = useState(0)
  w.__rerender = () => setTick((value) => value + 1)
  w.__setContent = (index: number, content: string) => { peers[index].content = content; setTick((value) => value + 1) }
  useEffect(() => {
    void (async () => {
      const keys = await deriveShareKeys(newShareKey())
      const initial = 'Titel\n\nErster Absatz.\n'
      for (const peer of peers) {
        const channel = new LiveChannel({ port: portFor(peer.id, peer.canWrite), keys, channel: CHANNEL, deviceId: peer.id, canWrite: peer.canWrite })
        channel.awareness.setLocalState({ user: liveUserFor(peer.name), cursor: null, pen: null })
        relay.devices.set(peer.id, channel)
        const result = await channel.open(initial, false)
        if (!result.ok) throw new Error(`open failed for ${peer.name}: ${result.reason}`)
        peer.content = result.text
        peer.note = new LiveNote({ shareId: 's', rel: 'n.md', canWrite: peer.canWrite, role: 'owner', peer: 'x', username: peer.name, deviceId: peer.id }, channel)
        setTick((value) => value + 1)
      }
      w.__ready = true
    })()
  }, [])
  return (
    <div className="app-shell theme-light" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, padding: 12 }}>
      {peers.map((peer, index) => (
        <div key={peer.id} data-peer={peer.name}>
          {peer.note && (
            <MarkdownEditor
              content={peer.content}
              onChange={(content) => { peer.content = content; peer.changes.push(content) }}
              onSave={() => undefined}
              settings={DEFAULT_SETTINGS}
              paperMode
              readOnly={!peer.canWrite}
              liveNote={peer.note}
              ariaLabel={`Editor ${index}`}
            />
          )}
        </div>
      ))}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
