import assert from 'node:assert/strict'
import { createServer } from 'vite'
import {
  enqueueRemoteSupportCommand,
  extractRemoteSupportToken,
  readRemoteSupportResult,
  resetRemoteSupportRelayForTests,
  storeRemoteSupportResult,
  takeRemoteSupportPending,
} from '../../fanotes-site/remote-support-api.mjs'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  REMOTE_SUPPORT_HOST,
  REMOTE_SUPPORT_TOKEN_LENGTH,
  applyAuthorizedRemoteSupportDrive,
  authorizeRemoteSupport,
  buildRemoteSupportCommandRequest,
  buildRemoteSupportPollRequest,
  collectVaultTreeNames,
  createRemoteSupportLiveState,
  denyRemoteSupport,
  dispatchRemoteSupportCommand,
  driveRemoteSupport,
  formatRemoteSupportCode,
  inspectRemoteSupport,
  noteTitleFromPath,
  startRemoteSupportSession,
  tokensMatch,
} = await server.ssrLoadModule('/src/lib/remoteSupport.ts')

const secretNote = 'Biologie-Arbeitsblatt.md'
const secretTitle = 'Oberstufenklausur'

const liveFor = () => createRemoteSupportLiveState({
  version: '2026.8.44',
  platform: 'linux',
  settings: { theme: 'dark', experimentalRemoteSupport: true, experimentalHomeworkApi: false },
  openNote: 'Willkommen',
  openPath: 'Willkommen.md',
  vaultTree: ['Eingang', secretNote, secretTitle],
  tool: 'pen',
  mode: 'keyboard',
  snapshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
})

const assertNoLeak = (value, label) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  assert.equal(text.includes(secretNote), false, `${label} must not leak ${secretNote}`)
  assert.equal(text.includes(secretTitle), false, `${label} must not leak ${secretTitle}`)
  assert.equal(text.includes('Willkommen.md'), false, `${label} must not leak open path`)
}

const runOnce = () => {
  const bytes = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc])
  const live = liveFor()

  assert.equal(REMOTE_SUPPORT_HOST, 'fanotes.fasrv.ch')
  assert.equal(inspectRemoteSupport(null, false, '', live).ok, false, 'off without start rejects inspect')
  assert.equal(driveRemoteSupport(null, false, '', { kind: 'open-note', path: secretNote }, live).ok, false, 'off without start rejects drive')
  assertNoLeak(inspectRemoteSupport(null, false, '', live), 'default inspect')
  assertNoLeak(driveRemoteSupport(null, false, '', { kind: 'open-note', path: secretNote }, live), 'default drive')
  assert.equal(live.openPath, 'Willkommen.md', 'rejected drive must not mutate state')

  const session = startRemoteSupportSession({ now: 1_700_000_000_000, bytes })
  assert.equal(session.token.length, REMOTE_SUPPORT_TOKEN_LENGTH)
  assert.equal(session.code, formatRemoteSupportCode(session.token))
  assert.equal(tokensMatch(session.token, session.code), true)
  assert.equal(authorizeRemoteSupport(session, true, session.token), true)

  const inspect = inspectRemoteSupport(session, true, session.token, live)
  assert.equal(inspect.ok, true)
  assert.equal(inspect.inspect.version, '2026.8.44')
  assert.equal(inspect.inspect.platform, 'linux')
  assert.ok(inspect.inspect.settings.experimentalRemoteSupport)
  assert.equal(inspect.inspect.openNote, 'Willkommen')
  assert.equal(inspect.inspect.openPath, 'Willkommen.md')
  assert.deepEqual(inspect.inspect.vaultTree, live.vaultTree)
  assert.equal(inspect.inspect.tool, 'pen')
  assert.equal(inspect.inspect.mode, 'keyboard')
  assert.ok(inspect.inspect.snapshot.length > 0)

  const opened = driveRemoteSupport(session, true, session.token, { kind: 'open-note', path: `Faecher/${secretNote}` }, live)
  assert.equal(opened.ok, true)
  assert.equal(opened.accepted, true)
  const afterOpen = inspectRemoteSupport(session, true, session.token, live)
  assert.equal(afterOpen.inspect.openPath, `Faecher/${secretNote}`)
  assert.equal(afterOpen.inspect.openNote, noteTitleFromPath(secretNote))

  const tooled = driveRemoteSupport(session, true, session.token, { kind: 'set-tool', tool: 'eraser' }, live)
  assert.equal(tooled.ok, true)
  assert.equal(inspectRemoteSupport(session, true, session.token, live).inspect.tool, 'eraser')

  const mode = driveRemoteSupport(session, true, session.token, { kind: 'set-mode', mode: 'ink' }, live)
  assert.equal(mode.ok, true)
  assert.equal(inspectRemoteSupport(session, true, session.token, live).inspect.mode, 'ink')

  const pointer = driveRemoteSupport(session, true, session.token, { kind: 'pointer', x: 0.4, y: 0.55, type: 'pointerdown' }, live)
  assert.equal(pointer.ok, true)
  assert.equal(pointer.accepted, true)
  const key = driveRemoteSupport(session, true, session.token, { kind: 'key', key: 'a' }, live)
  assert.equal(key.ok, true)
  assert.equal(live.injected.length, 2)

  const wrong = inspectRemoteSupport(session, true, 'ffffffffffffffffffffffff', live)
  assert.equal(wrong.ok, false)
  assertNoLeak(wrong, 'wrong token inspect')
  const wrongDrive = driveRemoteSupport(session, true, '', { kind: 'open-note', path: secretNote }, live)
  assert.equal(wrongDrive.ok, false)
  assertNoLeak(wrongDrive, 'empty token drive')

  const stopped = inspectRemoteSupport(null, true, session.token, live)
  assert.equal(stopped.ok, false)
  assertNoLeak(stopped, 'stopped inspect')
  const switchOff = driveRemoteSupport(session, false, session.token, { kind: 'set-tool', tool: 'pen' }, live)
  assert.equal(switchOff.ok, false)
  assertNoLeak(switchOff, 'switch-off drive')

  const poll = buildRemoteSupportPollRequest(session.token)
  assert.match(poll.url, /^https:\/\/fanotes\.fasrv\.ch\/api\/v1\/remote-support\/poll$/u)
  const commandReq = buildRemoteSupportCommandRequest(session.token, { kind: 'inspect' })
  assert.match(commandReq.url, /^https:\/\/fanotes\.fasrv\.ch\/api\/v1\/remote-support\/command$/u)

  resetRemoteSupportRelayForTests()
  const fakeSession = { token: session.token, pending: [], results: new Map(), nextId: 1 }
  const id = enqueueRemoteSupportCommand(fakeSession, { kind: 'inspect' })
  const pending = takeRemoteSupportPending(fakeSession)
  assert.equal(pending[0].id, id)
  const dispatched = dispatchRemoteSupportCommand(session, true, session.token, pending[0].command, live)
  assert.equal(dispatched.ok, true)
  storeRemoteSupportResult(fakeSession, id, dispatched)
  assert.equal(readRemoteSupportResult(fakeSession, id).ready, true)
  assert.equal(extractRemoteSupportToken({ headers: { authorization: `Bearer ${session.token}` } }, {}), session.token)

  const names = collectVaultTreeNames([{ name: 'Eingang', children: [{ name: secretNote }] }])
  assert.deepEqual(names, ['Eingang', secretNote])
  applyAuthorizedRemoteSupportDrive(live, { kind: 'set-tool', tool: 'pen' })
  assert.equal(denyRemoteSupport().error, 'unauthorized')
}

try {
  runOnce()
  runOnce()
  console.log(JSON.stringify({
    host: REMOTE_SUPPORT_HOST,
    tokenLength: REMOTE_SUPPORT_TOKEN_LENGTH,
    inspectFields: ['version', 'platform', 'settings', 'openNote', 'openPath', 'vaultTree', 'tool', 'mode', 'snapshot'],
  }))
  console.log('remote-support-session ok')
} finally {
  await server.close()
}
