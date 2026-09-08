import type { AddonPermission } from './manifest'

// Wire format between the FaNotes host and an add-on worker. Both ends treat
// every message as untrusted: the host validates arguments before acting, the
// worker SDK (workerBootstrap.ts) validates replies before resolving.

export type AddonSerializedError = { name: string; message: string; stack?: string; code?: string }

export type WorkerToHostMessage =
  | { t: 'ready'; exports: string[] }
  | { t: 'fatal'; error: AddonSerializedError }
  | { t: 'call'; id: number; method: string; args: unknown[] }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: AddonSerializedError }
  | { t: 'log'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | { t: 'error'; error: AddonSerializedError }
  | { t: 'pong'; id: number }

export type HostInvokeKind = 'activate' | 'deactivate' | 'command' | 'event' | 'action' | 'input'

export type HostToWorkerMessage =
  | {
    t: 'init'
    codeUrl: string
    addon: { id: string; name: string; version: string; permissions: AddonPermission[] }
    context: { appVersion: string; platform: string; language: string; apiVersion: number; web: boolean }
  }
  | { t: 'invoke'; id: number; kind: HostInvokeKind; payload: unknown }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: AddonSerializedError }
  | { t: 'ping'; id: number }

/** Events an add-on can subscribe to with `fanotes.events.on(name, handler)`. */
export const ADDON_EVENTS = [
  'note:opened',
  'note:changed',
  'note:saved',
  'note:created',
  'note:deleted',
  'ink:stroke',
  'mode:changed',
  'vault:changed',
  'settings:changed',
] as const

export type AddonEventName = (typeof ADDON_EVENTS)[number]

export const isAddonEventName = (value: string): value is AddonEventName => (ADDON_EVENTS as readonly string[]).includes(value)

/** Host methods and the permission they need. Anything not listed here is rejected. */
export const ADDON_METHOD_PERMISSIONS: Record<string, AddonPermission | null> = {
  'app.info': null,
  'app.log': null,
  'notes.list': 'notes:read',
  'notes.tree': 'notes:read',
  'notes.read': 'notes:read',
  'notes.search': 'notes:read',
  'notes.active': 'notes:read',
  'notes.exists': 'notes:read',
  'notes.write': 'notes:write',
  'notes.append': 'notes:write',
  'notes.create': 'notes:write',
  'notes.open': 'ui',
  'vault.createFolder': 'vault:write',
  'vault.rename': 'vault:write',
  'vault.move': 'vault:write',
  'vault.trash': 'vault:write',
  'editor.getText': 'editor',
  'editor.getSelection': 'editor',
  'editor.insert': 'editor',
  'editor.replaceSelection': 'editor',
  'editor.setText': 'editor',
  'editor.format': 'editor',
  'ink.read': 'ink:read',
  'stats.read': 'stats:read',
  'settings.read': 'settings:read',
  'clipboard.writeText': 'clipboard',
  'net.fetch': 'network',
  'ui.toast': 'ui',
  'ui.confirm': 'ui',
  'ui.prompt': 'ui',
  'ui.panel.show': 'ui',
  'ui.panel.update': 'ui',
  'ui.panel.close': 'ui',
  'ui.status.set': 'ui',
  'ui.status.remove': 'ui',
  'ui.openExternal': 'ui',
  'commands.register': 'commands',
  'commands.unregister': 'commands',
  'commands.execute': 'commands',
  'commands.list': 'commands',
  'events.subscribe': null,
  'events.unsubscribe': null,
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.remove': 'storage',
  'storage.keys': 'storage',
  'storage.clear': 'storage',
}

export const ADDON_LIMITS = Object.freeze({
  callTimeoutMs: 30_000,
  activateTimeoutMs: 15_000,
  invokeTimeoutMs: 30_000,
  pingIntervalMs: 5_000,
  pingTimeoutMs: 8_000,
  maxCallsPerSecond: 240,
  maxPendingCalls: 200,
  maxCommandsPerAddon: 40,
  maxPanelsPerAddon: 6,
  maxStatusItemsPerAddon: 3,
  maxStorageBytes: 1_000_000,
  maxStorageKeys: 500,
  maxNoteBytes: 4_000_000,
  maxNetworkResponseBytes: 5_000_000,
  maxLogEntries: 200,
  maxErrorsBeforeDisable: 8,
  errorWindowMs: 60_000,
  maxRestarts: 3,
})

export const serializeAddonError = (error: unknown): AddonSerializedError => {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: typeof error.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
      code: typeof code === 'string' ? code : undefined,
    }
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    return {
      name: typeof record.name === 'string' ? record.name : 'Error',
      message: typeof record.message === 'string' ? record.message : JSON.stringify(record).slice(0, 500),
      code: typeof record.code === 'string' ? record.code : undefined,
    }
  }
  return { name: 'Error', message: String(error ?? 'Unbekannter Fehler') }
}

export class AddonApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AddonApiError'
    this.code = code
  }
}
