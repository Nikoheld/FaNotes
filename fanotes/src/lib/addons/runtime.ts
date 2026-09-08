import { normaliseAddonBlocks, type AddonBlock } from './blocks'
import {
  ADDON_MAIN_FILE,
  ADDON_MAX_ICON_BYTES,
  ADDON_MAX_MAIN_BYTES,
  ADDON_MAX_README_BYTES,
  appSatisfiesMinVersion,
  compareAddonVersions,
  hostMatchesPattern,
  parseAddonManifest,
  type AddonManifest,
  type AddonPermission,
} from './manifest'
import {
  ADDON_LIMITS,
  ADDON_METHOD_PERMISSIONS,
  AddonApiError,
  isAddonEventName,
  serializeAddonError,
  type AddonEventName,
  type AddonSerializedError,
  type HostInvokeKind,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from './protocol'
import { sha256Hex, type AddonFetchText, type AddonIndex, type AddonIndexEntry } from './registry'
import { ADDON_WORKER_BOOTSTRAP } from './workerBootstrap'

// The host side of the add-on system. Every add-on runs in its own Web Worker;
// this runtime owns the workers, validates every request against the manifest
// permissions, applies rate limits and timeouts, and turns worker crashes into
// a visible "crashed" state instead of an app failure. Nothing in here may
// throw into React: all public methods catch and record.

export type InstalledAddonRecord = {
  id: string
  manifest: AddonManifest
  enabled: boolean
  installedAt: string
  updatedAt: string
  source: string
  path: string
  mainSha256: string | null
  origin: 'store' | 'local'
}

export type AddonStoragePort = {
  list: () => Promise<InstalledAddonRecord[]>
  save: (record: InstalledAddonRecord) => Promise<void>
  remove: (id: string) => Promise<void>
  readFile: (id: string, name: string) => Promise<string | null>
  writeFiles: (id: string, files: Record<string, string>) => Promise<void>
  readData: (id: string) => Promise<string | null>
  writeData: (id: string, value: string) => Promise<void>
}

export type AddonNoteSummary = { path: string; title: string; folder: string; modifiedAt: string | null; size: number | null }

export type AddonSelection = { from: number; to: number; text: string; line: number }

export type AddonNetResponse = { status: number; statusText: string; headers: Record<string, string>; body: string; url: string }

export type AddonHostBridge = {
  appVersion: string
  platform: string
  language: string
  web: boolean
  notes: {
    list: () => Promise<AddonNoteSummary[]>
    tree: () => Promise<unknown>
    read: (path: string) => Promise<string>
    exists: (path: string) => Promise<boolean>
    write: (path: string, content: string) => Promise<void>
    create: (folder: string | null, name: string | null, content: string | null) => Promise<string>
    open: (path: string) => Promise<void>
    search: (query: string) => Promise<unknown[]>
    active: () => { path: string; title: string; kind: string } | null
  }
  vault: {
    createFolder: (parent: string | null, name: string | null) => Promise<string>
    rename: (path: string, name: string) => Promise<string>
    move: (path: string, folder: string | null) => Promise<string>
    trash: (path: string) => Promise<void>
  }
  editor: {
    getText: () => string | null
    getSelection: () => AddonSelection | null
    insert: (text: string, where: 'cursor' | 'end' | 'start' | 'line-end') => boolean
    replaceSelection: (text: string) => boolean
    setText: (text: string) => boolean
    format: (action: string) => boolean
  }
  ink: { read: (path: string) => Promise<unknown> }
  stats: { read: (path: string) => Promise<unknown> }
  settings: { read: () => Record<string, unknown> }
  clipboard: { writeText: (text: string) => Promise<void> }
  net: { fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<AddonNetResponse> }
  ui: {
    toast: (message: string, kind: 'info' | 'success' | 'error') => void
    confirm: (message: string, options: { title?: string; confirmLabel?: string }) => Promise<boolean>
    prompt: (message: string, options: { title?: string; placeholder?: string; value?: string; multiline?: boolean }) => Promise<string | null>
    openExternal: (url: string) => Promise<void>
  }
  commands: {
    execute: (id: string, args: unknown[]) => Promise<boolean>
    list: () => Array<{ id: string; label: string; group: string }>
  }
}

export type AddonLifecycle = 'disabled' | 'starting' | 'running' | 'stopped' | 'crashed' | 'incompatible'

export type AddonLogEntry = { at: number; level: 'log' | 'info' | 'warn' | 'error'; text: string }

export type AddonStatus = {
  state: AddonLifecycle
  error: string | null
  restarts: number
  errorCount: number
  startedAt: number | null
  logs: AddonLogEntry[]
  calls: number
}

export type AddonCommandContribution = { addonId: string; id: string; title: string; detail?: string; keywords?: string; shortcut?: string }

export type AddonPanelState = { addonId: string; addonName: string; id: string; title: string; icon: string | null; blocks: AddonBlock[]; updatedAt: number }

export type AddonStatusItem = { addonId: string; id: string; text: string; title: string | null; clickable: boolean }

export type AddonRuntimeState = {
  ready: boolean
  installed: InstalledAddonRecord[]
  statuses: Record<string, AddonStatus>
  commands: AddonCommandContribution[]
  panels: AddonPanelState[]
  statusItems: AddonStatusItem[]
  activePanel: string | null
  dockOpen: boolean
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }

type Instance = {
  id: string
  record: InstalledAddonRecord
  worker: Worker
  bootstrapUrl: string
  codeUrl: string
  pending: Map<number, Pending>
  sequence: number
  subscriptions: Set<AddonEventName>
  rate: { windowStart: number; count: number; strikes: number }
  pingTimer: number
  pongTimer: number
  storageCache: Record<string, unknown> | null
  storageWrite: Promise<void>
  generation: number
}

const emptyStatus = (state: AddonLifecycle): AddonStatus => ({ state, error: null, restarts: 0, errorCount: 0, startedAt: null, logs: [], calls: 0 })

const panelKey = (addonId: string, panelId: string) => `${addonId}/${panelId}`

const asPath = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) throw new AddonApiError('E_ARGS', 'Ein Notizpfad (String) wird erwartet.')
  const path = value.trim().replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (path.length > 1024 || path.split('/').some((part) => part === '..' || part === '')) throw new AddonApiError('E_ARGS', `Ungültiger Pfad: ${value}`)
  return path
}

const asText = (value: unknown, max: number, what: string) => {
  if (typeof value !== 'string') throw new AddonApiError('E_ARGS', `${what} muss ein String sein.`)
  if (value.length > max) throw new AddonApiError('E_TOO_LARGE', `${what} ist länger als ${max} Zeichen.`)
  return value
}

const asOptionalText = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : null)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const clonePlain = <T>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

export class AddonRuntime {
  private state: AddonRuntimeState = {
    ready: false,
    installed: [],
    statuses: {},
    commands: [],
    panels: [],
    statusItems: [],
    activePanel: null,
    dockOpen: false,
  }

  private listeners = new Set<() => void>()
  private instances = new Map<string, Instance>()
  private bridge: AddonHostBridge | null = null
  private port: AddonStoragePort | null = null
  private started = false
  private startPromise: Promise<void> | null = null

  getState = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private setState(patch: Partial<AddonRuntimeState> | ((current: AddonRuntimeState) => Partial<AddonRuntimeState>)) {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...next }
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { console.error('[addons] listener failed', error) }
    }
  }

  private patchStatus(id: string, patch: Partial<AddonStatus> | ((current: AddonStatus) => Partial<AddonStatus>)) {
    this.setState((current) => {
      const previous = current.statuses[id] ?? emptyStatus('disabled')
      const next = typeof patch === 'function' ? patch(previous) : patch
      return { statuses: { ...current.statuses, [id]: { ...previous, ...next } } }
    })
  }

  private log(id: string, level: AddonLogEntry['level'], text: string) {
    this.patchStatus(id, (status) => ({ logs: [...status.logs.slice(-(ADDON_LIMITS.maxLogEntries - 1)), { at: Date.now(), level, text: text.slice(0, 4000) }] }))
  }

  attach(bridge: AddonHostBridge, port: AddonStoragePort) {
    this.bridge = bridge
    this.port = port
  }

  /** Loads the installed list and activates enabled add-ons. Safe to call repeatedly. */
  start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      if (!this.port) return
      let installed: InstalledAddonRecord[] = []
      try {
        installed = (await this.port.list()).filter((record) => record && typeof record.id === 'string')
      } catch (error) {
        console.error('[addons] konnte installierte Add-ons nicht laden', error)
      }
      const statuses: Record<string, AddonStatus> = {}
      for (const record of installed) statuses[record.id] = emptyStatus(record.enabled ? 'stopped' : 'disabled')
      this.setState({ installed, statuses, ready: true })
      this.started = true
      for (const record of installed) {
        if (!record.enabled) continue
        await this.activate(record.id).catch(() => undefined)
        await new Promise((resolve) => { window.setTimeout(resolve, 40) })
      }
    })()
    return this.startPromise
  }

  private record(id: string) {
    return this.state.installed.find((record) => record.id === id) ?? null
  }

  async activate(id: string) {
    const record = this.record(id)
    if (!record || !this.bridge || !this.port) return false
    if (this.instances.has(id)) return true
    if (!appSatisfiesMinVersion(this.bridge.appVersion, record.manifest.minAppVersion)) {
      this.patchStatus(id, { state: 'incompatible', error: `Braucht FaNotes ${record.manifest.minAppVersion} oder neuer.` })
      return false
    }
    this.patchStatus(id, (status) => ({ ...emptyStatus('starting'), restarts: status.restarts, logs: status.logs }))
    let code: string | null = null
    try {
      code = await this.port.readFile(id, ADDON_MAIN_FILE)
    } catch (error) {
      this.patchStatus(id, { state: 'crashed', error: `main.js konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}` })
      return false
    }
    if (typeof code !== 'string') {
      this.patchStatus(id, { state: 'crashed', error: 'main.js fehlt. Bitte das Add-on neu installieren.' })
      return false
    }
    if (record.mainSha256) {
      const digest = await sha256Hex(code)
      if (digest && digest !== record.mainSha256) {
        this.patchStatus(id, { state: 'crashed', error: 'main.js wurde nach der Installation verändert und wird nicht gestartet.' })
        return false
      }
    }
    let worker: Worker
    let bootstrapUrl = ''
    let codeUrl = ''
    try {
      bootstrapUrl = URL.createObjectURL(new Blob([ADDON_WORKER_BOOTSTRAP], { type: 'text/javascript' }))
      codeUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      worker = new Worker(bootstrapUrl, { type: 'module', name: `fanotes-addon:${id}` })
    } catch (error) {
      if (bootstrapUrl) URL.revokeObjectURL(bootstrapUrl)
      if (codeUrl) URL.revokeObjectURL(codeUrl)
      this.patchStatus(id, { state: 'crashed', error: `Worker konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}` })
      return false
    }
    const instance: Instance = {
      id,
      record,
      worker,
      bootstrapUrl,
      codeUrl,
      pending: new Map(),
      sequence: 0,
      subscriptions: new Set(),
      rate: { windowStart: performance.now(), count: 0, strikes: 0 },
      pingTimer: 0,
      pongTimer: 0,
      storageCache: null,
      storageWrite: Promise.resolve(),
      generation: (this.state.statuses[id]?.restarts ?? 0) + 1,
    }
    this.instances.set(id, instance)
    const ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Das Add-on hat sich nicht innerhalb von 15 s gemeldet.')), ADDON_LIMITS.activateTimeoutMs)
      const onMessage = (event: MessageEvent<WorkerToHostMessage>) => {
        const message = event.data
        if (!message || typeof message !== 'object') return
        if (message.t === 'ready') {
          window.clearTimeout(timer)
          worker.removeEventListener('message', onMessage)
          resolve()
        } else if (message.t === 'fatal') {
          window.clearTimeout(timer)
          worker.removeEventListener('message', onMessage)
          reject(new Error(`${message.error.name}: ${message.error.message}`))
        }
      }
      worker.addEventListener('message', onMessage)
    })
    worker.addEventListener('message', (event: MessageEvent<WorkerToHostMessage>) => this.onWorkerMessage(instance, event.data))
    worker.addEventListener('error', (event) => {
      event.preventDefault()
      this.recordError(instance, { name: 'WorkerError', message: event.message || 'Unbekannter Worker-Fehler' })
    })
    worker.addEventListener('messageerror', () => {
      this.recordError(instance, { name: 'MessageError', message: 'Nachricht konnte nicht deserialisiert werden.' })
    })
    const init: HostToWorkerMessage = {
      t: 'init',
      codeUrl,
      addon: { id, name: record.manifest.name, version: record.manifest.version, permissions: [...record.manifest.permissions] },
      context: { appVersion: this.bridge.appVersion, platform: this.bridge.platform, language: this.bridge.language, apiVersion: record.manifest.api, web: this.bridge.web },
    }
    worker.postMessage(init)
    try {
      await ready
      await this.invoke(instance, 'activate', {}, ADDON_LIMITS.activateTimeoutMs)
    } catch (error) {
      this.log(id, 'error', `Aktivierung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`)
      this.terminate(id, 'crashed', error instanceof Error ? error.message : String(error))
      return false
    }
    if (this.instances.get(id) !== instance) return false
    this.patchStatus(id, { state: 'running', startedAt: Date.now(), error: null })
    this.log(id, 'info', `Gestartet (v${record.manifest.version}).`)
    this.schedulePing(instance)
    return true
  }

  private schedulePing(instance: Instance) {
    window.clearTimeout(instance.pingTimer)
    instance.pingTimer = window.setTimeout(() => {
      if (this.instances.get(instance.id) !== instance) return
      const id = ++instance.sequence
      const ping: HostToWorkerMessage = { t: 'ping', id }
      instance.worker.postMessage(ping)
      instance.pongTimer = window.setTimeout(() => {
        if (this.instances.get(instance.id) !== instance) return
        this.log(instance.id, 'error', 'Der Worker antwortet nicht mehr (Endlosschleife?) und wurde beendet.')
        this.terminate(instance.id, 'crashed', 'Das Add-on reagiert nicht mehr und wurde gestoppt.')
        this.maybeRestart(instance.id)
      }, ADDON_LIMITS.pingTimeoutMs)
    }, ADDON_LIMITS.pingIntervalMs)
  }

  private maybeRestart(id: string) {
    const status = this.state.statuses[id]
    const record = this.record(id)
    if (!record?.enabled || !status) return
    if (status.restarts >= ADDON_LIMITS.maxRestarts) {
      this.patchStatus(id, { state: 'crashed', error: `${status.error ?? 'Abgestürzt'} – nach ${ADDON_LIMITS.maxRestarts} Neustarts deaktiviert.` })
      void this.setEnabled(id, false, { keepStatus: true })
      return
    }
    this.patchStatus(id, (current) => ({ restarts: current.restarts + 1 }))
    window.setTimeout(() => { void this.activate(id) }, 1200)
  }

  private terminate(id: string, state: AddonLifecycle, error: string | null) {
    const instance = this.instances.get(id)
    if (instance) {
      window.clearTimeout(instance.pingTimer)
      window.clearTimeout(instance.pongTimer)
      for (const pending of instance.pending.values()) {
        window.clearTimeout(pending.timer)
        pending.reject(new Error('Add-on wurde beendet.'))
      }
      instance.pending.clear()
      try { instance.worker.terminate() } catch { /* already gone */ }
      URL.revokeObjectURL(instance.bootstrapUrl)
      URL.revokeObjectURL(instance.codeUrl)
      this.instances.delete(id)
    }
    this.setState((current) => ({
      commands: current.commands.filter((command) => command.addonId !== id),
      panels: current.panels.filter((panel) => panel.addonId !== id),
      statusItems: current.statusItems.filter((item) => item.addonId !== id),
      activePanel: current.activePanel?.startsWith(`${id}/`) ? null : current.activePanel,
    }))
    this.patchStatus(id, { state, error, startedAt: null })
  }

  /** Stops every running add-on without touching its enabled flag (window unload, tests). */
  async stopAll() {
    await Promise.all([...this.instances.keys()].map((id) => this.deactivate(id)))
  }

  async deactivate(id: string, state: AddonLifecycle = 'stopped') {
    const instance = this.instances.get(id)
    if (instance) {
      try {
        await this.invoke(instance, 'deactivate', {}, 3000)
      } catch (error) {
        this.log(id, 'warn', `deactivate() schlug fehl: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.terminate(id, state, null)
  }

  async restart(id: string) {
    await this.deactivate(id)
    this.patchStatus(id, { restarts: 0, errorCount: 0, error: null })
    return this.activate(id)
  }

  private recordError(instance: Instance, error: AddonSerializedError) {
    const id = instance.id
    this.log(id, 'error', `${error.name}: ${error.message}`)
    const status = this.state.statuses[id]
    const now = Date.now()
    const recent = (status?.logs ?? []).filter((entry) => entry.level === 'error' && now - entry.at < ADDON_LIMITS.errorWindowMs).length
    this.patchStatus(id, (current) => ({ errorCount: current.errorCount + 1 }))
    if (recent >= ADDON_LIMITS.maxErrorsBeforeDisable) {
      this.terminate(id, 'crashed', `${recent} Fehler innerhalb einer Minute – das Add-on wurde gestoppt.`)
      void this.setEnabled(id, false, { keepStatus: true })
    }
  }

  private invoke(instance: Instance, kind: HostInvokeKind, payload: unknown, timeoutMs: number = ADDON_LIMITS.invokeTimeoutMs) {
    return new Promise<unknown>((resolve, reject) => {
      const id = ++instance.sequence
      const timer = window.setTimeout(() => {
        instance.pending.delete(id)
        reject(new Error(`Zeitüberschreitung (${Math.round(timeoutMs / 1000)} s) bei "${kind}".`))
      }, timeoutMs)
      instance.pending.set(id, { resolve, reject, timer })
      const message: HostToWorkerMessage = { t: 'invoke', id, kind, payload }
      try {
        instance.worker.postMessage(message)
      } catch (error) {
        window.clearTimeout(timer)
        instance.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private onWorkerMessage(instance: Instance, message: WorkerToHostMessage) {
    if (this.instances.get(instance.id) !== instance) return
    if (!message || typeof message !== 'object') return
    switch (message.t) {
      case 'pong':
        window.clearTimeout(instance.pongTimer)
        this.schedulePing(instance)
        return
      case 'result': {
        const pending = instance.pending.get(message.id)
        if (!pending) return
        instance.pending.delete(message.id)
        window.clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(`${message.error.name}: ${message.error.message}`))
        return
      }
      case 'log':
        this.log(instance.id, message.level === 'log' || message.level === 'info' || message.level === 'warn' || message.level === 'error' ? message.level : 'log', String(message.text ?? ''))
        return
      case 'error':
        this.recordError(instance, message.error ?? { name: 'Error', message: 'Unbekannter Fehler' })
        return
      case 'call':
        void this.handleCall(instance, message)
        return
      default:
        return
    }
  }

  private reply(instance: Instance, id: number, result: { ok: true; value: unknown } | { ok: false; error: AddonSerializedError }) {
    if (this.instances.get(instance.id) !== instance) return
    const message: HostToWorkerMessage = result.ok ? { t: 'reply', id, ok: true, value: result.value } : { t: 'reply', id, ok: false, error: result.error }
    try {
      instance.worker.postMessage(message)
    } catch (error) {
      try {
        instance.worker.postMessage({ t: 'reply', id, ok: false, error: serializeAddonError(error) } satisfies HostToWorkerMessage)
      } catch { /* worker gone */ }
    }
  }

  private checkRate(instance: Instance) {
    const now = performance.now()
    if (now - instance.rate.windowStart > 1000) {
      instance.rate.windowStart = now
      if (instance.rate.count > ADDON_LIMITS.maxCallsPerSecond) instance.rate.strikes += 1
      else instance.rate.strikes = 0
      instance.rate.count = 0
    }
    instance.rate.count += 1
    if (instance.rate.strikes >= 5) {
      this.terminate(instance.id, 'crashed', 'Das Add-on hat dauerhaft zu viele Anfragen gesendet und wurde gestoppt.')
      void this.setEnabled(instance.id, false, { keepStatus: true })
      return false
    }
    if (instance.rate.count > ADDON_LIMITS.maxCallsPerSecond) throw new AddonApiError('E_RATE', `Höchstens ${ADDON_LIMITS.maxCallsPerSecond} Aufrufe pro Sekunde.`)
    if (instance.pending.size > ADDON_LIMITS.maxPendingCalls) throw new AddonApiError('E_RATE', 'Zu viele gleichzeitig offene Aufrufe.')
    return true
  }

  private async handleCall(instance: Instance, message: { id: number; method: string; args: unknown[] }) {
    const method = typeof message.method === 'string' ? message.method : ''
    const args = Array.isArray(message.args) ? message.args : []
    try {
      if (!this.checkRate(instance)) return
      if (!(method in ADDON_METHOD_PERMISSIONS)) throw new AddonApiError('E_UNKNOWN_METHOD', `Unbekannte Methode "${method}".`)
      const needed = ADDON_METHOD_PERMISSIONS[method]
      if (needed && !instance.record.manifest.permissions.includes(needed)) {
        throw new AddonApiError('E_PERMISSION', `"${method}" braucht die Berechtigung "${needed}", die im Manifest nicht angegeben ist.`)
      }
      this.patchStatus(instance.id, (status) => ({ calls: status.calls + 1 }))
      let timer: number | undefined
      try {
        const value = await Promise.race([
          this.dispatch(instance, method, args),
          new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new AddonApiError('E_TIMEOUT', `"${method}" hat nicht innerhalb von 30 s geantwortet.`)), ADDON_LIMITS.callTimeoutMs) }),
        ])
        this.reply(instance, message.id, { ok: true, value: value === undefined ? null : clonePlain(value) })
      } finally {
        if (timer !== undefined) window.clearTimeout(timer)
      }
    } catch (error) {
      this.reply(instance, message.id, { ok: false, error: serializeAddonError(error) })
    }
  }

  private bridgeOrThrow() {
    if (!this.bridge) throw new AddonApiError('E_HOST', 'FaNotes ist noch nicht bereit.')
    return this.bridge
  }

  private async dispatch(instance: Instance, method: string, args: unknown[]): Promise<unknown> {
    const bridge = this.bridgeOrThrow()
    const id = instance.id
    switch (method) {
      case 'app.info':
        return { appVersion: bridge.appVersion, platform: bridge.platform, language: bridge.language, web: bridge.web, addon: { id, name: instance.record.manifest.name, version: instance.record.manifest.version, permissions: instance.record.manifest.permissions } }
      case 'app.log':
        this.log(id, 'log', args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '))
        return null
      case 'notes.list':
        return bridge.notes.list()
      case 'notes.tree':
        return bridge.notes.tree()
      case 'notes.read':
        return bridge.notes.read(asPath(args[0]))
      case 'notes.exists':
        return bridge.notes.exists(asPath(args[0]))
      case 'notes.search':
        return bridge.notes.search(asText(args[0], 500, 'Suchbegriff'))
      case 'notes.active':
        return bridge.notes.active()
      case 'notes.write':
        await bridge.notes.write(asPath(args[0]), asText(args[1], ADDON_LIMITS.maxNoteBytes, 'Inhalt'))
        return true
      case 'notes.append': {
        const path = asPath(args[0])
        const addition = asText(args[1], ADDON_LIMITS.maxNoteBytes, 'Inhalt')
        const current = await bridge.notes.read(path)
        if (current.length + addition.length > ADDON_LIMITS.maxNoteBytes) throw new AddonApiError('E_TOO_LARGE', 'Die Notiz würde zu groß werden.')
        const separator = current && !current.endsWith('\n') ? '\n' : ''
        await bridge.notes.write(path, `${current}${separator}${addition}`)
        return true
      }
      case 'notes.create': {
        const options = isRecord(args[0]) ? args[0] : {}
        const content = asOptionalText(options.content, ADDON_LIMITS.maxNoteBytes)
        return bridge.notes.create(asOptionalText(options.folder, 1024), asOptionalText(options.name, 200), content)
      }
      case 'notes.open':
        await bridge.notes.open(asPath(args[0]))
        return true
      case 'vault.createFolder':
        return bridge.vault.createFolder(asOptionalText(args[0], 1024), asOptionalText(args[1], 200))
      case 'vault.rename':
        return bridge.vault.rename(asPath(args[0]), asText(args[1], 200, 'Name'))
      case 'vault.move':
        return bridge.vault.move(asPath(args[0]), asOptionalText(args[1], 1024))
      case 'vault.trash':
        await bridge.vault.trash(asPath(args[0]))
        return true
      case 'editor.getText':
        return bridge.editor.getText()
      case 'editor.getSelection':
        return bridge.editor.getSelection()
      case 'editor.insert': {
        const where = args[1] === 'end' || args[1] === 'start' || args[1] === 'line-end' ? args[1] : 'cursor'
        return bridge.editor.insert(asText(args[0], ADDON_LIMITS.maxNoteBytes, 'Text'), where)
      }
      case 'editor.replaceSelection':
        return bridge.editor.replaceSelection(asText(args[0], ADDON_LIMITS.maxNoteBytes, 'Text'))
      case 'editor.setText':
        return bridge.editor.setText(asText(args[0], ADDON_LIMITS.maxNoteBytes, 'Text'))
      case 'editor.format':
        return bridge.editor.format(asText(args[0], 40, 'Formatierung'))
      case 'ink.read':
        return bridge.ink.read(asPath(args[0]))
      case 'stats.read':
        return bridge.stats.read(asPath(args[0]))
      case 'settings.read':
        return bridge.settings.read()
      case 'clipboard.writeText':
        await bridge.clipboard.writeText(asText(args[0], 2_000_000, 'Text'))
        return true
      case 'net.fetch': {
        const url = asText(args[0], 4000, 'URL')
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new AddonApiError('E_ARGS', `Ungültige URL: ${url}`)
        }
        if (parsed.protocol !== 'https:') throw new AddonApiError('E_NETWORK', 'Nur https:// wird unterstützt.')
        if (!instance.record.manifest.networkHosts.some((pattern) => hostMatchesPattern(parsed.hostname, pattern))) {
          throw new AddonApiError('E_NETWORK', `${parsed.hostname} steht nicht in "networkHosts" des Manifests.`)
        }
        const init = isRecord(args[1]) ? args[1] : {}
        const headers: Record<string, string> = {}
        if (isRecord(init.headers)) {
          for (const [key, value] of Object.entries(init.headers).slice(0, 20)) {
            if (typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/u.test(key) && !/^(cookie|authorization|host|origin|referer)$/iu.test(key)) headers[key] = value.slice(0, 2000)
          }
        }
        const methodName = typeof init.method === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/iu.test(init.method) ? init.method.toUpperCase() : 'GET'
        const body = typeof init.body === 'string' ? init.body.slice(0, 2_000_000) : undefined
        const response = await bridge.net.fetch(parsed.toString(), { method: methodName, headers, body })
        if (response.body.length > ADDON_LIMITS.maxNetworkResponseBytes) throw new AddonApiError('E_TOO_LARGE', 'Die Antwort ist größer als 5 MB.')
        return response
      }
      case 'ui.toast': {
        const kind = args[1] === 'success' || args[1] === 'error' ? args[1] : 'info'
        bridge.ui.toast(`${instance.record.manifest.name}: ${asText(args[0], 400, 'Nachricht')}`, kind)
        return true
      }
      case 'ui.confirm': {
        const options = isRecord(args[1]) ? args[1] : {}
        return bridge.ui.confirm(asText(args[0], 2000, 'Nachricht'), { title: asOptionalText(options.title, 120) ?? instance.record.manifest.name, confirmLabel: asOptionalText(options.confirmLabel, 60) ?? undefined })
      }
      case 'ui.prompt': {
        const options = isRecord(args[1]) ? args[1] : {}
        return bridge.ui.prompt(asText(args[0], 2000, 'Nachricht'), {
          title: asOptionalText(options.title, 120) ?? instance.record.manifest.name,
          placeholder: asOptionalText(options.placeholder, 200) ?? undefined,
          value: asOptionalText(options.value, 20_000) ?? undefined,
          multiline: options.multiline === true,
        })
      }
      case 'ui.openExternal': {
        const url = asText(args[0], 4000, 'URL')
        if (!/^https:\/\//iu.test(url)) throw new AddonApiError('E_ARGS', 'Nur https:// Links können geöffnet werden.')
        const allowed = await bridge.ui.confirm(`${instance.record.manifest.name} möchte diesen Link öffnen:\n${url}`, { title: 'Link öffnen', confirmLabel: 'Öffnen' })
        if (allowed) await bridge.ui.openExternal(url)
        return allowed
      }
      case 'ui.panel.show': {
        const spec = isRecord(args[0]) ? args[0] : {}
        const panelId = typeof spec.id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(spec.id) ? spec.id : 'main'
        const key = panelKey(id, panelId)
        const existing = this.state.panels.find((panel) => panel.addonId === id && panel.id === panelId)
        if (!existing && this.state.panels.filter((panel) => panel.addonId === id).length >= ADDON_LIMITS.maxPanelsPerAddon) {
          throw new AddonApiError('E_LIMIT', `Höchstens ${ADDON_LIMITS.maxPanelsPerAddon} Panels pro Add-on.`)
        }
        const blocks = spec.blocks === undefined && existing ? existing.blocks : normaliseAddonBlocks(spec.blocks)
        const next: AddonPanelState = {
          addonId: id,
          addonName: instance.record.manifest.name,
          id: panelId,
          title: asOptionalText(spec.title, 80) || existing?.title || instance.record.manifest.name,
          icon: asOptionalText(spec.icon, 8) ?? existing?.icon ?? null,
          blocks,
          updatedAt: Date.now(),
        }
        this.setState((current) => ({
          panels: existing ? current.panels.map((panel) => (panel.addonId === id && panel.id === panelId ? next : panel)) : [...current.panels, next],
          activePanel: spec.focus === false && current.activePanel ? current.activePanel : key,
          dockOpen: spec.focus === false ? current.dockOpen : true,
        }))
        return true
      }
      case 'ui.panel.update': {
        const panelId = asText(args[0], 80, 'Panel-ID')
        const blocks = normaliseAddonBlocks(args[1])
        let found = false
        this.setState((current) => ({
          panels: current.panels.map((panel) => {
            if (panel.addonId !== id || panel.id !== panelId) return panel
            found = true
            return { ...panel, blocks, updatedAt: Date.now() }
          }),
        }))
        if (!found) throw new AddonApiError('E_NO_PANEL', `Panel "${panelId}" ist nicht geöffnet.`)
        return true
      }
      case 'ui.panel.close': {
        const panelId = asText(args[0], 80, 'Panel-ID')
        this.closePanel(id, panelId)
        return true
      }
      case 'ui.status.set': {
        const spec = isRecord(args[0]) ? args[0] : {}
        const itemId = typeof spec.id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(spec.id) ? spec.id : 'status'
        if (typeof spec.text === 'string' && !spec.text.trim()) {
          this.setState((current) => ({ statusItems: current.statusItems.filter((item) => !(item.addonId === id && item.id === itemId)) }))
          return true
        }
        const existing = this.state.statusItems.find((item) => item.addonId === id && item.id === itemId)
        if (!existing && this.state.statusItems.filter((item) => item.addonId === id).length >= ADDON_LIMITS.maxStatusItemsPerAddon) {
          throw new AddonApiError('E_LIMIT', `Höchstens ${ADDON_LIMITS.maxStatusItemsPerAddon} Statusleisten-Einträge pro Add-on.`)
        }
        const next: AddonStatusItem = { addonId: id, id: itemId, text: asText(spec.text, 60, 'Text'), title: asOptionalText(spec.title, 200), clickable: spec.clickable === true }
        this.setState((current) => ({
          statusItems: existing ? current.statusItems.map((item) => (item.addonId === id && item.id === itemId ? next : item)) : [...current.statusItems, next],
        }))
        return true
      }
      case 'ui.status.remove': {
        const itemId = asText(args[0], 80, 'ID')
        this.setState((current) => ({ statusItems: current.statusItems.filter((item) => !(item.addonId === id && item.id === itemId)) }))
        return true
      }
      case 'commands.register': {
        const spec = isRecord(args[0]) ? args[0] : {}
        const commandId = asText(spec.id, 80, 'Befehls-ID')
        if (!/^[A-Za-z0-9_.:-]+$/u.test(commandId)) throw new AddonApiError('E_ARGS', 'Befehls-IDs dürfen nur Buchstaben, Ziffern, Punkte, Doppelpunkte und Bindestriche enthalten.')
        const existing = this.state.commands.find((command) => command.addonId === id && command.id === commandId)
        if (!existing && this.state.commands.filter((command) => command.addonId === id).length >= ADDON_LIMITS.maxCommandsPerAddon) {
          throw new AddonApiError('E_LIMIT', `Höchstens ${ADDON_LIMITS.maxCommandsPerAddon} Befehle pro Add-on.`)
        }
        const next: AddonCommandContribution = {
          addonId: id,
          id: commandId,
          title: asText(spec.title, 80, 'Titel'),
          detail: asOptionalText(spec.detail, 160) ?? undefined,
          keywords: asOptionalText(spec.keywords, 200) ?? undefined,
          shortcut: asOptionalText(spec.shortcut, 40) ?? undefined,
        }
        this.setState((current) => ({
          commands: existing ? current.commands.map((command) => (command.addonId === id && command.id === commandId ? next : command)) : [...current.commands, next],
        }))
        return true
      }
      case 'commands.unregister': {
        const commandId = asText(args[0], 80, 'Befehls-ID')
        this.setState((current) => ({ commands: current.commands.filter((command) => !(command.addonId === id && command.id === commandId)) }))
        return true
      }
      case 'commands.execute': {
        const commandId = asText(args[0], 120, 'Befehls-ID')
        const commandArgs = Array.isArray(args[1]) ? args[1].slice(0, 10) : []
        const own = this.state.commands.find((command) => command.id === commandId && command.addonId === id)
        if (own) return this.runCommand(id, commandId, commandArgs)
        return bridge.commands.execute(commandId, commandArgs)
      }
      case 'commands.list':
        return [...bridge.commands.list(), ...this.state.commands.map((command) => ({ id: command.id, label: command.title, group: `Add-on: ${this.record(command.addonId)?.manifest.name ?? command.addonId}` }))]
      case 'events.subscribe': {
        const name = asText(args[0], 40, 'Ereignisname')
        if (!isAddonEventName(name)) throw new AddonApiError('E_ARGS', `Unbekanntes Ereignis "${name}".`)
        const needed: Partial<Record<AddonEventName, AddonPermission>> = { 'note:changed': 'notes:read', 'note:saved': 'notes:read', 'ink:stroke': 'ink:read', 'settings:changed': 'settings:read' }
        const permission = needed[name]
        if (permission && !instance.record.manifest.permissions.includes(permission)) throw new AddonApiError('E_PERMISSION', `"${name}" braucht die Berechtigung "${permission}".`)
        instance.subscriptions.add(name)
        return true
      }
      case 'events.unsubscribe': {
        const name = asText(args[0], 40, 'Ereignisname')
        if (isAddonEventName(name)) instance.subscriptions.delete(name)
        return true
      }
      case 'storage.get': {
        const store = await this.loadStorage(instance)
        return store[asText(args[0], 200, 'Schlüssel')] ?? null
      }
      case 'storage.set': {
        const store = await this.loadStorage(instance)
        const key = asText(args[0], 200, 'Schlüssel')
        const value = clonePlain(args[1])
        const next = { ...store, [key]: value }
        if (Object.keys(next).length > ADDON_LIMITS.maxStorageKeys) throw new AddonApiError('E_LIMIT', `Höchstens ${ADDON_LIMITS.maxStorageKeys} Schlüssel.`)
        await this.saveStorage(instance, next)
        return true
      }
      case 'storage.remove': {
        const store = await this.loadStorage(instance)
        const next = { ...store }
        delete next[asText(args[0], 200, 'Schlüssel')]
        await this.saveStorage(instance, next)
        return true
      }
      case 'storage.keys':
        return Object.keys(await this.loadStorage(instance))
      case 'storage.clear':
        await this.saveStorage(instance, {})
        return true
      default:
        throw new AddonApiError('E_UNKNOWN_METHOD', `Unbekannte Methode "${method}".`)
    }
  }

  private async loadStorage(instance: Instance) {
    if (instance.storageCache) return instance.storageCache
    if (!this.port) throw new AddonApiError('E_HOST', 'Kein Speicher verfügbar.')
    let parsed: Record<string, unknown> = {}
    try {
      const raw = await this.port.readData(instance.id)
      const value = raw ? JSON.parse(raw) : {}
      if (isRecord(value)) parsed = value
    } catch {
      parsed = {}
    }
    instance.storageCache = parsed
    return parsed
  }

  private async saveStorage(instance: Instance, next: Record<string, unknown>) {
    if (!this.port) throw new AddonApiError('E_HOST', 'Kein Speicher verfügbar.')
    const serialized = JSON.stringify(next)
    if (serialized.length > ADDON_LIMITS.maxStorageBytes) throw new AddonApiError('E_TOO_LARGE', 'Der Add-on-Speicher ist auf 1 MB begrenzt.')
    instance.storageCache = next
    const port = this.port
    instance.storageWrite = instance.storageWrite.then(() => port.writeData(instance.id, serialized)).catch((error) => {
      this.log(instance.id, 'error', `Speicher konnte nicht geschrieben werden: ${error instanceof Error ? error.message : String(error)}`)
    })
    await instance.storageWrite
  }

  /** Runs a command an add-on registered. Never throws; failures land in the log and a toast. */
  async runCommand(addonId: string, commandId: string, args: unknown[] = []) {
    const instance = this.instances.get(addonId)
    if (!instance) {
      this.bridge?.ui.toast(`${this.record(addonId)?.manifest.name ?? addonId} läuft gerade nicht.`, 'error')
      return false
    }
    try {
      await this.invoke(instance, 'command', { id: commandId, args: clonePlain(args) })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(addonId, 'error', `Befehl "${commandId}" fehlgeschlagen: ${message}`)
      this.bridge?.ui.toast(`${instance.record.manifest.name}: ${message}`, 'error')
      this.recordError(instance, { name: 'CommandError', message })
      return false
    }
  }

  clickStatusItem(addonId: string, itemId: string) {
    void this.runCommand(addonId, `status:${itemId}`)
  }

  /** Delivers a UI action (button, list row) from a rendered panel back to its add-on. */
  panelAction(addonId: string, panelId: string, actionId: string, itemId: string | undefined, values: Record<string, unknown>) {
    const instance = this.instances.get(addonId)
    if (!instance) return
    this.invoke(instance, 'action', { panelId, actionId, itemId, values: clonePlain(values) }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.recordError(instance, { name: 'PanelActionError', message })
      this.bridge?.ui.toast(`${instance.record.manifest.name}: ${message}`, 'error')
    })
  }

  panelInput(addonId: string, panelId: string, inputId: string, value: unknown) {
    const instance = this.instances.get(addonId)
    if (!instance) return
    this.invoke(instance, 'input', { panelId, inputId, value: clonePlain(value) }).catch((error) => {
      this.recordError(instance, { name: 'PanelInputError', message: error instanceof Error ? error.message : String(error) })
    })
  }

  closePanel(addonId: string, panelId: string) {
    const key = panelKey(addonId, panelId)
    this.setState((current) => {
      const panels = current.panels.filter((panel) => !(panel.addonId === addonId && panel.id === panelId))
      const activePanel = current.activePanel === key ? (panels[0] ? panelKey(panels[0].addonId, panels[0].id) : null) : current.activePanel
      return { panels, activePanel, dockOpen: panels.length ? current.dockOpen : false }
    })
  }

  setActivePanel(key: string | null) {
    this.setState({ activePanel: key, dockOpen: key !== null })
  }

  setDockOpen(open: boolean) {
    this.setState((current) => ({ dockOpen: open && current.panels.length > 0, activePanel: current.activePanel ?? (current.panels[0] ? panelKey(current.panels[0].addonId, current.panels[0].id) : null) }))
  }

  /** Fans an app event out to every running add-on that subscribed. Fire-and-forget. */
  emit(name: AddonEventName, data: unknown) {
    if (!this.instances.size) return
    let payload: unknown = null
    let cloned = false
    for (const instance of this.instances.values()) {
      if (!instance.subscriptions.has(name)) continue
      if (!cloned) {
        payload = clonePlain(data ?? null)
        cloned = true
      }
      this.invoke(instance, 'event', { name, data: payload }, 10_000).catch((error) => {
        this.recordError(instance, { name: 'EventError', message: `${name}: ${error instanceof Error ? error.message : String(error)}` })
      })
    }
  }

  hasSubscribers(name: AddonEventName) {
    for (const instance of this.instances.values()) if (instance.subscriptions.has(name)) return true
    return false
  }

  async setEnabled(id: string, enabled: boolean, options: { keepStatus?: boolean } = {}) {
    const record = this.record(id)
    if (!record || !this.port) return
    const next = { ...record, enabled }
    this.setState((current) => ({ installed: current.installed.map((item) => (item.id === id ? next : item)) }))
    try {
      await this.port.save(next)
    } catch (error) {
      console.error('[addons] Zustand konnte nicht gespeichert werden', error)
    }
    if (enabled) {
      this.patchStatus(id, { restarts: 0, error: null })
      await this.activate(id)
    } else if (options.keepStatus) {
      if (this.instances.has(id)) this.terminate(id, 'crashed', this.state.statuses[id]?.error ?? null)
    } else {
      await this.deactivate(id, 'disabled')
    }
  }

  /** Installs (or updates) an add-on from the registry. Verifies size, id and sha256 before anything is stored. */
  async install(entry: AddonIndexEntry, fetchText: AddonFetchText): Promise<InstalledAddonRecord> {
    if (!this.port) throw new Error('Kein Speicher verfügbar.')
    const main = await fetchText(entry.mainUrl)
    if (main.length > ADDON_MAX_MAIN_BYTES) throw new Error('main.js ist größer als 1,5 MB.')
    const expected = entry.files[ADDON_MAIN_FILE]?.sha256
    const digest = await sha256Hex(main)
    if (expected && digest && digest !== expected) throw new Error('main.js stimmt nicht mit der Prüfsumme aus dem Index überein.')
    let manifest = entry.manifest
    try {
      const parsed = parseAddonManifest(JSON.parse(await fetchText(entry.manifestUrl)), { expectedId: entry.manifest.id })
      if (parsed.errors.length) throw new Error(parsed.errors[0])
      manifest = parsed.manifest
    } catch (error) {
      if (entry.files[ADDON_MAIN_FILE]?.sha256 === undefined) throw new Error(`manifest.json konnte nicht geprüft werden: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!appSatisfiesMinVersion(this.bridge?.appVersion, manifest.minAppVersion)) throw new Error(`Dieses Add-on braucht FaNotes ${manifest.minAppVersion} oder neuer.`)
    const files: Record<string, string> = { [ADDON_MAIN_FILE]: main, 'manifest.json': JSON.stringify(manifest, null, 2) }
    try {
      const readme = await fetchText(entry.readmeUrl)
      if (readme.length <= ADDON_MAX_README_BYTES) files['README.md'] = readme
    } catch { /* README is optional */ }
    if (entry.iconUrl) {
      try {
        const icon = await fetchText(entry.iconUrl)
        if (icon.length <= ADDON_MAX_ICON_BYTES && /<svg[\s>]/iu.test(icon) && !/<script|on[a-z]+\s*=|javascript:/iu.test(icon)) files['icon.svg'] = icon
      } catch { /* icon is optional */ }
    }
    const previous = this.record(manifest.id)
    if (previous && this.instances.has(manifest.id)) await this.deactivate(manifest.id)
    const now = new Date().toISOString()
    const record: InstalledAddonRecord = {
      id: manifest.id,
      manifest,
      enabled: previous?.enabled ?? true,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      source: entry.pageUrl ?? entry.mainUrl,
      path: entry.path,
      mainSha256: digest,
      origin: 'store',
    }
    await this.port.writeFiles(manifest.id, files)
    await this.port.save(record)
    this.setState((current) => ({
      installed: previous ? current.installed.map((item) => (item.id === record.id ? record : item)) : [...current.installed, record],
      statuses: { ...current.statuses, [record.id]: { ...emptyStatus(record.enabled ? 'stopped' : 'disabled'), logs: current.statuses[record.id]?.logs ?? [] } },
    }))
    if (record.enabled && this.started) await this.activate(record.id)
    return record
  }

  /** Installs an add-on from local files (developer mode). No checksum: it is the author's own machine. */
  async installLocal(files: { manifest: string; main: string; readme?: string }): Promise<InstalledAddonRecord> {
    if (!this.port) throw new Error('Kein Speicher verfügbar.')
    let raw: unknown
    try {
      raw = JSON.parse(files.manifest)
    } catch (error) {
      throw new Error(`manifest.json ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = parseAddonManifest(raw)
    if (parsed.errors.length) throw new Error(parsed.errors.join(' '))
    if (files.main.length > ADDON_MAX_MAIN_BYTES) throw new Error('main.js ist größer als 1,5 MB.')
    const manifest = parsed.manifest
    const previous = this.record(manifest.id)
    if (previous && this.instances.has(manifest.id)) await this.deactivate(manifest.id)
    const now = new Date().toISOString()
    const record: InstalledAddonRecord = {
      id: manifest.id,
      manifest,
      enabled: true,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      source: 'local',
      path: '',
      mainSha256: null,
      origin: 'local',
    }
    const stored: Record<string, string> = { [ADDON_MAIN_FILE]: files.main, 'manifest.json': JSON.stringify(manifest, null, 2) }
    if (files.readme) stored['README.md'] = files.readme.slice(0, ADDON_MAX_README_BYTES)
    await this.port.writeFiles(manifest.id, stored)
    await this.port.save(record)
    this.setState((current) => ({
      installed: previous ? current.installed.map((item) => (item.id === record.id ? record : item)) : [...current.installed, record],
      statuses: { ...current.statuses, [record.id]: { ...emptyStatus('stopped'), logs: current.statuses[record.id]?.logs ?? [] } },
    }))
    if (this.started) await this.activate(record.id)
    return record
  }

  async uninstall(id: string) {
    if (!this.port) return
    await this.deactivate(id, 'disabled')
    try {
      await this.port.remove(id)
    } catch (error) {
      console.error('[addons] Deinstallation fehlgeschlagen', error)
    }
    this.setState((current) => {
      const statuses = { ...current.statuses }
      delete statuses[id]
      return { installed: current.installed.filter((record) => record.id !== id), statuses }
    })
  }

  /** Returns installed add-ons for which the index carries a newer version. */
  updatesFor(index: AddonIndex | null) {
    if (!index) return [] as Array<{ record: InstalledAddonRecord; entry: AddonIndexEntry }>
    const updates: Array<{ record: InstalledAddonRecord; entry: AddonIndexEntry }> = []
    for (const record of this.state.installed) {
      if (record.origin !== 'store') continue
      const entry = index.entries.find((candidate) => candidate.manifest.id === record.id)
      if (entry && compareAddonVersions(entry.manifest.version, record.manifest.version) > 0) updates.push({ record, entry })
    }
    return updates
  }

  async readInstalledFile(id: string, name: string) {
    if (!this.port) return null
    try {
      return await this.port.readFile(id, name)
    } catch {
      return null
    }
  }

  clearLogs(id: string) {
    this.patchStatus(id, { logs: [] })
  }

  runningCount() {
    return this.instances.size
  }
}

export const addonRuntime = new AddonRuntime()
