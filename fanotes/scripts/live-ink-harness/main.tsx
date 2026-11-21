// Test-only page for scripts/check-live-collab-ink.mjs: two real DrawingBoard instances (inline ink on a paper sheet)
// bound to live notes through an in-page relay with the same semantics as fanotes-site/live-relay.mjs.
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/styles.css'
import { DEFAULT_SETTINGS } from '../../src/defaults'
import { DrawingBoard, type DrawingBoardHandle } from '../../src/components/DrawingBoard'
import { LiveChannel, type LivePort } from '../../src/lib/collab/liveChannel'
import { LiveNote } from '../../src/lib/collab/liveNotes'
import { liveUserFor } from '../../src/lib/collab/liveAwareness'
import { deriveShareKeys, newShareKey } from '../../src/lib/sync/crypto'

const CHANNEL = 'b'.repeat(32)
const w = window as unknown as Record<string, unknown>
const relay = { seq: 0, snap: null as { q: number; d: string } | null, updates: [] as Array<{ q: number; d: string }>, devices: new Map<string, LiveChannel>() }

const portFor = (deviceId: string): LivePort => ({
  async send(body) {
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    if (body.k !== 's') for (const [id, channel] of relay.devices) if (id !== deviceId) void channel.handlePush({ c: CHANNEL, k: body.k, q, f: deviceId, d: body.d })
    return { q, seq: relay.seq }
  },
  async fetch(since) {
    return { seq: relay.seq, snapshot: relay.snap && (since === 0 || since < relay.snap.q) ? relay.snap : null, updates: relay.updates.filter((item) => item.q > since) }
  },
})

const names = ['Anna_F', 'Ben_K']
const notes: Array<LiveNote | null> = [null, null]
const handles: Array<DrawingBoardHandle | null> = [null, null]
w.__notes = notes
w.__handles = handles
w.__strokes = (index: number) => notes[index]?.ink?.current().length ?? -1

function Board({ index, note }: { index: number; note: LiveNote | null }) {
  const ref = useRef<DrawingBoardHandle>(null)
  useEffect(() => { handles[index] = ref.current })
  return (
    <div className="app-shell theme-light" style={{ width: 560 }}>
      <div className="unified-paper" data-peer={names[index]} style={{ position: 'relative', width: 560, height: 700, background: '#fff' }}>
        <DrawingBoard
          ref={ref}
          settings={{ ...DEFAULT_SETTINGS, penOnly: false, pressureEnabled: false }}
          inline
          inputActive
          title={`Live ${names[index]}`}
          onSaveDrawing={async () => undefined}
          onInsertMarkdown={() => false}
          liveNote={note}
        />
      </div>
    </div>
  )
}

function App() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void (async () => {
      const keys = await deriveShareKeys(newShareKey())
      for (let index = 0; index < 2; index += 1) {
        const id = `dev-${index}`
        const channel = new LiveChannel({ port: portFor(id), keys, channel: CHANNEL, deviceId: id, canWrite: true })
        channel.awareness.setLocalState({ user: liveUserFor(names[index]), cursor: null, pen: null })
        relay.devices.set(id, channel)
        const result = await channel.open('', false)
        if (!result.ok) throw new Error('open failed')
        notes[index] = new LiveNote({ shareId: 's', rel: 'n.famd', canWrite: true, role: 'owner', peer: 'x', username: names[index], deviceId: id }, channel)
      }
      setReady(true)
      w.__ready = true
    })()
  }, [])
  if (!ready) return null
  return <div style={{ display: 'flex', gap: 24, padding: 16 }}>{[0, 1].map((index) => <Board key={index} index={index} note={notes[index]} />)}</div>
}
createRoot(document.getElementById('root')!).render(<App />)
