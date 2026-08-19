export const REMOTE_SUPPORT_HOST = 'fanotes.fasrv.ch'
export const REMOTE_SUPPORT_ORIGIN = `https://${REMOTE_SUPPORT_HOST}`
export const REMOTE_SUPPORT_API_ROOT = '/api/v1/remote-support'
export const REMOTE_SUPPORT_TOKEN_BYTES = 12
export const REMOTE_SUPPORT_TOKEN_LENGTH = REMOTE_SUPPORT_TOKEN_BYTES * 2

export type RemoteSupportSession = {
  token: string
  code: string
  startedAt: number
}

export type RemoteSupportDriveCommand =
  | { kind: 'open-note'; path: string }
  | { kind: 'set-tool'; tool: string }
  | { kind: 'set-mode'; mode: string }
  | { kind: 'pointer'; type?: string; pointerType?: string; x: number; y: number; buttons?: number }
  | { kind: 'key'; key: string; code?: string; type?: string }

export type RemoteSupportCommand =
  | { kind: 'inspect' }
  | RemoteSupportDriveCommand

export type RemoteSupportLiveState = {
  version: string
  platform: string
  settings: Record<string, unknown>
  openNote: string
  openPath: string
  vaultTree: string[]
  tool: string
  mode: string
  snapshot: string
  injected: RemoteSupportDriveCommand[]
}

export type RemoteSupportDenied = { ok: false; error: 'unauthorized' }
export type RemoteSupportInspectOk = {
  ok: true
  inspect: {
    version: string
    platform: string
    settings: Record<string, unknown>
    openNote: string
    openPath: string
    vaultTree: string[]
    tool: string
    mode: string
    snapshot: string
  }
}
export type RemoteSupportDriveOk = {
  ok: true
  accepted: true
  state: RemoteSupportLiveState
}

const HEX = /^[0-9a-f]+$/u

export const denyRemoteSupport = (): RemoteSupportDenied => ({ ok: false, error: 'unauthorized' })

export const normalizeRemoteSupportToken = (value: string | null | undefined) => (
  String(value || '').replace(/[^0-9a-fA-F]/gu, '').toLowerCase()
)

export const formatRemoteSupportCode = (token: string) => {
  const normalized = normalizeRemoteSupportToken(token)
  return normalized.replace(/(.{4})/gu, '$1-').replace(/-$/u, '').toUpperCase()
}

export const createRemoteSupportToken = (bytes?: Uint8Array) => {
  const raw = bytes && bytes.byteLength >= REMOTE_SUPPORT_TOKEN_BYTES
    ? bytes.subarray(0, REMOTE_SUPPORT_TOKEN_BYTES)
    : crypto.getRandomValues(new Uint8Array(REMOTE_SUPPORT_TOKEN_BYTES))
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const startRemoteSupportSession = (input: { now?: number; bytes?: Uint8Array } = {}): RemoteSupportSession => {
  const token = createRemoteSupportToken(input.bytes)
  return {
    token,
    code: formatRemoteSupportCode(token),
    startedAt: Number.isFinite(input.now) ? Number(input.now) : Date.now(),
  }
}

export const remoteSupportSessionIsLive = (
  session: RemoteSupportSession | null | undefined,
  enabled: boolean,
) => Boolean(enabled && session && normalizeRemoteSupportToken(session.token).length === REMOTE_SUPPORT_TOKEN_LENGTH)

export const tokensMatch = (expected: string, provided: string) => {
  const left = normalizeRemoteSupportToken(expected)
  const right = normalizeRemoteSupportToken(provided)
  if (!left || left.length !== REMOTE_SUPPORT_TOKEN_LENGTH || left.length !== right.length || !HEX.test(left) || !HEX.test(right)) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

export const authorizeRemoteSupport = (
  session: RemoteSupportSession | null | undefined,
  enabled: boolean,
  token: string,
) => remoteSupportSessionIsLive(session, enabled) && tokensMatch(session!.token, token)

export const noteTitleFromPath = (path: string) => {
  const base = String(path || '').split(/[\\/]/u).pop() || ''
  return base.replace(/\.(md|pdf|famd)$/iu, '')
}

export const collectVaultTreeNames = (entries: Array<{ name?: string; children?: unknown[] }> | null | undefined): string[] => {
  const names: string[] = []
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const record = node as { name?: unknown; children?: unknown }
      if (typeof record.name === 'string' && record.name) names.push(record.name)
      if (Array.isArray(record.children)) walk(record.children)
    }
  }
  walk(entries)
  return names
}

export const createRemoteSupportLiveState = (
  partial: Partial<RemoteSupportLiveState> = {},
): RemoteSupportLiveState => ({
  version: partial.version || '',
  platform: partial.platform || '',
  settings: { ...(partial.settings || {}) },
  openNote: partial.openNote || '',
  openPath: partial.openPath || '',
  vaultTree: [...(partial.vaultTree || [])],
  tool: partial.tool || 'pen',
  mode: partial.mode || 'keyboard',
  snapshot: partial.snapshot || '',
  injected: [...(partial.injected || [])],
})

const copyInspect = (live: RemoteSupportLiveState): RemoteSupportInspectOk['inspect'] => ({
  version: String(live.version || ''),
  platform: String(live.platform || ''),
  settings: { ...live.settings },
  openNote: String(live.openNote || ''),
  openPath: String(live.openPath || ''),
  vaultTree: [...live.vaultTree],
  tool: String(live.tool || ''),
  mode: String(live.mode || ''),
  snapshot: String(live.snapshot || ''),
})

export const inspectRemoteSupport = (
  session: RemoteSupportSession | null | undefined,
  enabled: boolean,
  token: string,
  live: RemoteSupportLiveState,
): RemoteSupportDenied | RemoteSupportInspectOk => {
  if (!authorizeRemoteSupport(session, enabled, token)) return denyRemoteSupport()
  return { ok: true, inspect: copyInspect(live) }
}

export const applyAuthorizedRemoteSupportDrive = (
  live: RemoteSupportLiveState,
  command: RemoteSupportDriveCommand,
): RemoteSupportLiveState => {
  if (command.kind === 'open-note') {
    const path = String(command.path || '')
    live.openPath = path
    live.openNote = noteTitleFromPath(path)
    return live
  }
  if (command.kind === 'set-tool') {
    live.tool = String(command.tool || '')
    return live
  }
  if (command.kind === 'set-mode') {
    live.mode = String(command.mode || '')
    return live
  }
  if (command.kind === 'pointer' || command.kind === 'key') {
    live.injected = [...live.injected, command]
    return live
  }
  return live
}

const isDriveCommand = (command: RemoteSupportCommand | null | undefined): command is RemoteSupportDriveCommand => (
  Boolean(command && command.kind && command.kind !== 'inspect')
)

export const driveRemoteSupport = (
  session: RemoteSupportSession | null | undefined,
  enabled: boolean,
  token: string,
  command: RemoteSupportCommand | null | undefined,
  live: RemoteSupportLiveState,
): RemoteSupportDenied | RemoteSupportDriveOk => {
  if (!authorizeRemoteSupport(session, enabled, token) || !isDriveCommand(command)) return denyRemoteSupport()
  applyAuthorizedRemoteSupportDrive(live, command)
  return { ok: true, accepted: true, state: live }
}

export const dispatchRemoteSupportCommand = (
  session: RemoteSupportSession | null | undefined,
  enabled: boolean,
  token: string,
  command: RemoteSupportCommand | null | undefined,
  live: RemoteSupportLiveState,
) => {
  if (!command || command.kind === 'inspect') return inspectRemoteSupport(session, enabled, token, live)
  return driveRemoteSupport(session, enabled, token, command, live)
}

export const remoteSupportApiUrl = (path: string, origin = REMOTE_SUPPORT_ORIGIN) => (
  `${origin.replace(/\/$/u, '')}${REMOTE_SUPPORT_API_ROOT}${path}`
)

export const remoteSupportAuthHeaders = (token: string) => ({
  Accept: 'application/json',
  Authorization: `Bearer ${normalizeRemoteSupportToken(token)}`,
  'X-FaNotes-Remote-Support': '1',
})

export const buildRemoteSupportRegisterRequest = (token: string, origin = REMOTE_SUPPORT_ORIGIN) => ({
  url: remoteSupportApiUrl('/session', origin),
  method: 'PUT',
  headers: {
    ...remoteSupportAuthHeaders(token),
    'Content-Type': 'application/json',
  },
  body: { token: normalizeRemoteSupportToken(token) },
})

export const buildRemoteSupportStopRequest = (token: string, origin = REMOTE_SUPPORT_ORIGIN) => ({
  url: remoteSupportApiUrl('/session', origin),
  method: 'DELETE',
  headers: remoteSupportAuthHeaders(token),
})

export const buildRemoteSupportPollRequest = (token: string, origin = REMOTE_SUPPORT_ORIGIN) => ({
  url: remoteSupportApiUrl('/poll', origin),
  method: 'GET',
  headers: remoteSupportAuthHeaders(token),
})

export const buildRemoteSupportCommandRequest = (
  token: string,
  command: RemoteSupportCommand,
  origin = REMOTE_SUPPORT_ORIGIN,
) => ({
  url: remoteSupportApiUrl('/command', origin),
  method: 'POST',
  headers: {
    ...remoteSupportAuthHeaders(token),
    'Content-Type': 'application/json',
  },
  body: { command },
})

export const buildRemoteSupportResultRequest = (
  token: string,
  id: string,
  result: unknown,
  origin = REMOTE_SUPPORT_ORIGIN,
) => ({
  url: remoteSupportApiUrl('/result', origin),
  method: 'POST',
  headers: {
    ...remoteSupportAuthHeaders(token),
    'Content-Type': 'application/json',
  },
  body: { id, result },
})

export const injectRemoteSupportPointer = (command: Extract<RemoteSupportDriveCommand, { kind: 'pointer' }>) => {
  if (typeof document === 'undefined') return false
  const target = document.querySelector('.lw-canvas-surface, .unified-paper, .workspace') || document.body
  const rect = 'getBoundingClientRect' in target ? target.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 }
  const clientX = rect.left + Math.max(0, Math.min(1, command.x)) * Math.max(1, rect.width)
  const clientY = rect.top + Math.max(0, Math.min(1, command.y)) * Math.max(1, rect.height)
  const type = command.type === 'pointerup' || command.type === 'pointermove' ? command.type : 'pointerdown'
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: command.pointerType || 'pen',
    clientX,
    clientY,
    buttons: command.buttons ?? (type === 'pointerup' ? 0 : 1),
    pressure: type === 'pointerup' ? 0 : 0.6,
  })
  target.dispatchEvent(event)
  return true
}

export const injectRemoteSupportKey = (command: Extract<RemoteSupportDriveCommand, { kind: 'key' }>) => {
  if (typeof document === 'undefined') return false
  const type = command.type === 'keyup' ? 'keyup' : 'keydown'
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: command.key,
    code: command.code || command.key,
  })
  const target = document.activeElement || document.body
  target.dispatchEvent(event)
  return true
}
