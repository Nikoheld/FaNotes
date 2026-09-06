import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  applyInteractOp,
  chromePressable,
  emptyInteractState,
  interactOpsFromBugEvents,
  overlayGlobalPointerLockOn,
  overlayHitEnabled,
  overlayInert,
  overlaySessionAfterNoteSwitch,
} = await server.ssrLoadModule('/src/lib/overlayInteract.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(readFileSync(join(root, 'scripts/fixtures/bug-1788698537115.json'), 'utf8'))
const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const boardSource = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

const notesFromEvents = (events) => {
  const notes = []
  for (const event of events) {
    if (event?.kind !== 'note' || typeof event.noteId !== 'string' || !event.noteId) continue
    if (!notes.includes(event.noteId)) notes.push(event.noteId)
  }
  return notes
}

try {
  assert.equal(fixture.id, '1788698537115')
  assert.equal(fixture.version, '2026.9.11')
  assert.equal(fixture.platform, 'linux')
  assert.equal(fixture.description, 'Everything laggs, i can\'t press most of the things. Fix it!')
  const notes = notesFromEvents(fixture.events)
  assert.deepEqual(notes, [
    'Englisch/Untitled note.md',
    'Eingang/Untitled note 3.md',
    'Eingang/Untitled note.md',
    'Eingang/Untitled note 5.famd',
    'Eingang/arbeitsblätter_progII.md',
  ])
  assert.equal(notes.includes('Eingang/Untitled note 4.md'), false)

  assert.equal(overlayHitEnabled(false), false)
  assert.equal(overlayHitEnabled(true), true)
  assert.equal(overlayInert(true, false), true)
  assert.equal(overlayInert(true, true), false)
  assert.equal(overlayGlobalPointerLockOn(true, false), false)
  assert.equal(overlayGlobalPointerLockOn(true, true), true)
  assert.deepEqual(
    overlaySessionAfterNoteSwitch({ drawingOpen: false, session: { key: 4, document: null } }),
    { key: 0, document: null },
  )
  assert.equal(
    overlaySessionAfterNoteSwitch({ drawingOpen: true, session: { key: 4, document: null } }).key,
    4,
  )

  const ops = interactOpsFromBugEvents(fixture.events)
  assert.equal(ops[0].type, 'note-switch')
  assert.equal(ops[1].type, 'session-start')
  const noteOps = ops.filter((op) => op.type === 'note-switch')
  assert.equal(noteOps.length, 8)
  assert.equal(noteOps[1].noteId, 'Englisch/Untitled note.md')
  assert.equal(noteOps.at(-1).noteId, 'Eingang/Untitled note 5.famd')

  let state = emptyInteractState()
  assert.equal(chromePressable(state), true)

  const frames = []
  for (const op of ops) {
    state = applyInteractOp(state, op)
    if (op.type === 'note-switch') {
      assert.equal(state.leftoverCapture, false)
      assert.equal(state.sessionKey, 0, 'keyboard-mode switch must drop the overlay')
      assert.equal(state.globalLock, false)
      assert.equal(state.overlayHits, false)
      assert.equal(state.inert, true)
      assert.equal(chromePressable(state), true)
      frames.push({
        noteId: state.noteId,
        sessionKey: state.sessionKey,
        pressable: chromePressable(state),
      })
    }
  }

  const stale = applyInteractOp(state, { type: 'ink-ready', requestId: 1 })
  assert.equal(stale.sessionKey, 0, 'stale FAMD/ink load from an earlier note must not remount')
  assert.equal(chromePressable(stale), true)

  state = applyInteractOp(state, { type: 'ink-ready', requestId: state.loadGeneration })
  assert.equal(state.sessionKey, state.loadGeneration)
  assert.equal(state.noteId, 'Eingang/Untitled note 5.famd')
  assert.equal(state.inert, true)
  assert.equal(state.globalLock, false)
  assert.equal(state.overlayHits, false)
  assert.equal(chromePressable(state), true)

  const captured = applyInteractOp(state, { type: 'capture', leftover: true })
  assert.equal(chromePressable(captured), false)
  state = applyInteractOp(captured, {
    type: 'note-switch',
    requestId: state.loadGeneration + 1,
    noteId: 'Eingang/Untitled note 5.famd',
  })
  assert.equal(state.leftoverCapture, false)
  assert.equal(chromePressable(state), true)

  const stiftOn = applyInteractOp(state, { type: 'stift', open: true })
  assert.equal(stiftOn.overlayHits, true)
  assert.equal(stiftOn.globalLock, true)
  assert.equal(stiftOn.inert, false)
  const switchedOn = applyInteractOp(stiftOn, {
    type: 'note-switch',
    requestId: stiftOn.loadGeneration + 1,
    noteId: 'Englisch/Untitled note.md',
  })
  assert.ok(switchedOn.sessionKey > 0)
  assert.equal(switchedOn.drawingOpen, true)

  assert.match(appSource, /overlaySessionAfterNoteSwitch\(switched\)/)
  assert.match(boardSource, /overlayInert\(inline, inputActive\)/)
  assert.match(boardSource, /overlayGlobalPointerLockOn\(inline, inputActive\)/)
  assert.match(boardSource, /pointer-events:none!important/)
  assert.match(boardSource, /inline && overlayHitEnabled\(inputActive\) \? handlePointerDown/)

  console.log(JSON.stringify({
    report: fixture.id,
    version: fixture.version,
    platform: fixture.platform,
    description: fixture.description,
    notes,
    frames,
    lastNote: state.noteId,
    lastPressable: chromePressable(state),
    lastSessionKey: state.sessionKey,
    lastInert: state.inert,
    lastGlobalLock: state.globalLock,
  }))
  console.log('latest-bug ok')
} finally {
  await server.close()
}
