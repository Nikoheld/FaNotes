export const SEND_DATA_MIN_INTERVAL_MS = 5 * 60 * 1000
export const SEND_DATA_MAX_BYTES = 48 * 1024
export const SEND_DATA_HOST = 'fanotes.fasrv.ch'
export const SEND_DATA_ORIGIN = `https://${SEND_DATA_HOST}`
export const SEND_DATA_PATH = '/api/v1/send-data'

export type SendDataPolicy = {
  enabled: boolean
  ongoing: boolean
}

export type SendDataLinuxRuntime = {
  platform: string
  ozone: string
  sessionType: string
  desktop: string
  hyprland: boolean
  hyprlandInstance: boolean
  display: string
  waylandDisplay: string
  hyprlandZeroScaling: boolean
}

export type SendDataNutzerdaten = {
  version: string
  platform: string
  theme: string
  uiLanguage: string
  paperStyle: string
  penOnly: boolean
  experimentalHandwritingToText: boolean
  experimentalNoteBackup: boolean
  experimentalRemoteSupport: boolean
  hasOpenNote: boolean
}

export type SendDataPayload = {
  schemaVersion: 1
  kind: 'send-data'
  sentAt: number
  logs: unknown[]
  nutzerdaten: SendDataNutzerdaten
  linux: SendDataLinuxRuntime
}

export type SendDataTickDecision = {
  send: boolean
  reason: 'disabled' | 'idle' | 'too-soon' | 'empty' | 'duplicate' | 'oversized' | 'send'
  hash?: string
}

const envText = (env: Record<string, unknown> | undefined, key: string) => {
  const value = env?.[key]
  return typeof value === 'string' ? value : ''
}

export const sendDataPolicy = (experimentalOn: unknown): SendDataPolicy => {
  const enabled = experimentalOn === true
  return { enabled, ongoing: enabled }
}

export const linuxHyprlandRuntimeContext = (input: {
  platform?: unknown
  ozone?: unknown
  sessionType?: unknown
  desktop?: unknown
  hyprland?: unknown
  hyprlandInstance?: unknown
  display?: unknown
  waylandDisplay?: unknown
  hyprlandZeroScaling?: unknown
  env?: Record<string, unknown>
} = {}): SendDataLinuxRuntime => {
  const env = input.env && typeof input.env === 'object' ? input.env : {}
  const desktop = typeof input.desktop === 'string' && input.desktop ? input.desktop : envText(env, 'XDG_CURRENT_DESKTOP')
  const sessionType = typeof input.sessionType === 'string' ? input.sessionType : envText(env, 'XDG_SESSION_TYPE')
  const hyprlandInstance = input.hyprlandInstance === true || Boolean(envText(env, 'HYPRLAND_INSTANCE_SIGNATURE'))
  const hyprland = input.hyprland === true || hyprlandInstance || /hyprland/i.test(desktop)
  const ozoneHint = envText(env, 'ELECTRON_OZONE_PLATFORM_HINT')
  const ozone = typeof input.ozone === 'string' && input.ozone
    ? input.ozone
    : ozoneHint || (typeof input.platform === 'string' && input.platform === 'linux' ? 'x11' : '')
  return {
    platform: typeof input.platform === 'string' && input.platform ? input.platform : 'linux',
    ozone,
    sessionType,
    desktop,
    hyprland,
    hyprlandInstance,
    display: typeof input.display === 'string' ? input.display : envText(env, 'DISPLAY'),
    waylandDisplay: typeof input.waylandDisplay === 'string' ? input.waylandDisplay : envText(env, 'WAYLAND_DISPLAY'),
    hyprlandZeroScaling: input.hyprlandZeroScaling === true,
  }
}

export const collectSendDataNutzerdaten = (input: {
  version?: unknown
  platform?: unknown
  theme?: unknown
  uiLanguage?: unknown
  paperStyle?: unknown
  penOnly?: unknown
  experimentalHandwritingToText?: unknown
  experimentalNoteBackup?: unknown
  experimentalRemoteSupport?: unknown
  hasOpenNote?: unknown
} = {}): SendDataNutzerdaten => ({
  version: typeof input.version === 'string' ? input.version : '',
  platform: typeof input.platform === 'string' ? input.platform : '',
  theme: typeof input.theme === 'string' ? input.theme : '',
  uiLanguage: typeof input.uiLanguage === 'string' ? input.uiLanguage : '',
  paperStyle: typeof input.paperStyle === 'string' ? input.paperStyle : '',
  penOnly: input.penOnly === true,
  experimentalHandwritingToText: input.experimentalHandwritingToText === true,
  experimentalNoteBackup: input.experimentalNoteBackup === true,
  experimentalRemoteSupport: input.experimentalRemoteSupport === true,
  hasOpenNote: input.hasOpenNote === true,
})

export const buildSendDataPayload = (input: {
  enabled: unknown
  logs?: unknown
  nutzerdaten?: unknown
  linux?: unknown
  now?: number
}): { send: false } | { send: true; payload: SendDataPayload } => {
  if (input.enabled !== true) return { send: false }
  const logs = Array.isArray(input.logs) ? input.logs : []
  const nutzerdaten = collectSendDataNutzerdaten(
    input.nutzerdaten && typeof input.nutzerdaten === 'object' ? input.nutzerdaten as object : {},
  )
  const linux = input.linux && typeof input.linux === 'object'
    ? linuxHyprlandRuntimeContext(input.linux as { platform?: unknown; ozone?: unknown; hyprlandZeroScaling?: unknown; env?: Record<string, unknown> })
    : linuxHyprlandRuntimeContext()
  return {
    send: true,
    payload: {
      schemaVersion: 1,
      kind: 'send-data',
      sentAt: Number.isFinite(input.now) ? Number(input.now) : Date.now(),
      logs,
      nutzerdaten,
      linux,
    },
  }
}

export const sendDataBodyHash = (body: string) => {
  let hash = 5381
  for (let index = 0; index < body.length; index += 1) {
    hash = ((hash << 5) + hash + body.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

export const sendDataSubmitTarget = (origin = SEND_DATA_ORIGIN) => {
  try {
    const parsed = new URL(String(origin || SEND_DATA_ORIGIN))
    if (parsed.hostname === SEND_DATA_HOST && parsed.protocol === 'https:') {
      return { url: `${parsed.origin}${SEND_DATA_PATH}`, host: SEND_DATA_HOST }
    }
  } catch { /* fall back to the shipped fasrv host */ }
  return { url: `${SEND_DATA_ORIGIN}${SEND_DATA_PATH}`, host: SEND_DATA_HOST }
}

export const decideSendDataTick = (input: {
  enabled: unknown
  now: number
  lastSentAt?: number | null
  body?: unknown
  lastBodyHash?: string | null
  idle?: unknown
  minIntervalMs?: number
  maxBytes?: number
}): SendDataTickDecision => {
  if (input.enabled !== true) return { send: false, reason: 'disabled' }
  if (input.idle === true) return { send: false, reason: 'idle' }
  const minInterval = typeof input.minIntervalMs === 'number' && Number.isFinite(input.minIntervalMs)
    ? Math.max(0, input.minIntervalMs)
    : SEND_DATA_MIN_INTERVAL_MS
  const lastSentAt = typeof input.lastSentAt === 'number' && Number.isFinite(input.lastSentAt)
    ? input.lastSentAt
    : null
  if (lastSentAt != null && input.now - lastSentAt < minInterval) {
    return { send: false, reason: 'too-soon' }
  }
  const body = typeof input.body === 'string' ? input.body : ''
  if (!body.trim() || body === '{}' || body === '[]' || body === 'null') {
    return { send: false, reason: 'empty' }
  }
  const maxBytes = typeof input.maxBytes === 'number' && Number.isFinite(input.maxBytes)
    ? Math.max(1, input.maxBytes)
    : SEND_DATA_MAX_BYTES
  if (body.length > maxBytes) return { send: false, reason: 'oversized' }
  const hash = sendDataBodyHash(body)
  if (input.lastBodyHash && input.lastBodyHash === hash) {
    return { send: false, reason: 'duplicate' }
  }
  return { send: true, reason: 'send', hash }
}

export const planSendDataTick = (input: {
  enabled: unknown
  logs?: unknown
  nutzerdaten?: unknown
  linux?: unknown
  now: number
  lastSentAt?: number | null
  lastBodyHash?: string | null
  idle?: unknown
  minIntervalMs?: number
  maxBytes?: number
}) => {
  const built = buildSendDataPayload(input)
  if (!built.send) return { send: false as const, reason: 'disabled' as const, payload: null, body: '', hash: undefined }
  const body = JSON.stringify(built.payload)
  const decision = decideSendDataTick({
    enabled: true,
    now: input.now,
    lastSentAt: input.lastSentAt,
    body,
    lastBodyHash: input.lastBodyHash,
    idle: input.idle,
    minIntervalMs: input.minIntervalMs,
    maxBytes: input.maxBytes,
  })
  return { ...decision, payload: decision.send ? built.payload : null, body }
}
