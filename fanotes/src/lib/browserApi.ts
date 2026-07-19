import { DEFAULT_SETTINGS } from '../defaults'
import { getUiLanguage } from '../i18n'
import type { AppSettings, BootstrapData, DrawingLibraryDocument, FaNotesApi, ServerBackupState, UpdateState, VaultEntry, WorksheetDocument } from '../types'
import { browserInitialFiles, browserStarterFolders, browserStarterSubjects } from './browserPreview'
import { listBrowserLmStudioModels, transformWithBrowserLmStudio } from './lmStudioBrowser'
import { listBrowserAiModels, transformWithBrowserAi } from './aiProviderBrowser'
import { loadBrowserSpellingResources, loadBrowserSpellingWordCandidates } from './spellingResources'
import { loadBrowserHandwritingRecognitionResources } from './handwritingRecognitionResources'

const DATABASE_NAME = 'fanotes-web-vault'
const DATABASE_VERSION = 1
const WEB_VERSION = '2026.7.4-beta.7'
const MAX_NOTE_BYTES = 16 * 1024 * 1024
const MAX_DRAWING_BYTES = 24 * 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_PDF_BYTES = 96 * 1024 * 1024
const STORES = ['meta', 'files', 'folders', 'assets', 'drawings', 'worksheets'] as const
type StoreName = typeof STORES[number]

type FileRecord = { path: string; content: string; modifiedAt: string }
type FolderRecord = { path: string; color?: string }
type AssetRecord = { path: string; value: Blob }
type MetaRecord = { key: string; value: unknown }
type StoredServerBackup = {
  schemaVersion: 1
  id: string
  secret: string
  recoveryCode: string
  automatic: boolean
  lastBackupAt: string | null
  sizeBytes: number
  error: string | null
}

type ServerAssetReference = { path: string; digest: string; mimeType: string; size: number }

const RECOVERY_CODE_PATTERN = /^fanotes1_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/u
const SERVER_ASSET_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])

export const repairBrowserWelcomeMarkdown = (path: string, content: string) => {
  if (path === 'Willkommen.md') {
    return content.replace(
      /Mit `Strg\+Z`? holst du eine versehentliche Löschung sofort zurück\./gu,
      'Mit **Strg+Z** holst du eine versehentliche Löschung sofort zurück.',
    )
  }
  if (path === 'Welcome.md') {
    return content.replace(
      /Press `Ctrl\+Z`? to restore something you erased by accident\./gu,
      'Press **Ctrl+Z** to restore something you erased by accident.',
    )
  }
  return content
}

const textBytes = (value: string) => new TextEncoder().encode(value).byteLength
const clone = <T>(value: T): T => structuredClone(value)

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Der lokale Web-Vault antwortet nicht.'))
})

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error ?? new Error('Der lokale Speichervorgang wurde abgebrochen.'))
  transaction.onerror = () => reject(transaction.error ?? new Error('Der lokale Speichervorgang ist fehlgeschlagen.'))
})

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (!('indexedDB' in globalThis)) {
    reject(new Error('Dieser Browser stellt keinen dauerhaften lokalen Speicher bereit. Aktiviere IndexedDB oder verwende einen aktuellen Chromium-/Firefox-Browser.'))
    return
  }
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' })
    if (!database.objectStoreNames.contains('files')) database.createObjectStore('files', { keyPath: 'path' })
    if (!database.objectStoreNames.contains('folders')) database.createObjectStore('folders', { keyPath: 'path' })
    if (!database.objectStoreNames.contains('assets')) database.createObjectStore('assets', { keyPath: 'path' })
    if (!database.objectStoreNames.contains('drawings')) database.createObjectStore('drawings', { keyPath: 'id' })
    if (!database.objectStoreNames.contains('worksheets')) database.createObjectStore('worksheets', { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Der lokale Web-Vault konnte nicht geöffnet werden.'))
  request.onblocked = () => reject(new Error('Eine ältere FaNotes-Webseite blockiert den lokalen Speicher. Schließe andere FaNotes-Tabs und lade neu.'))
})

const safeSegment = (raw: string, fallback: string) => {
  const value = raw.trim().replace(/[\0-\x1f\x7f]/gu, '').slice(0, 180)
  if (!value || value === '.' || value === '..' || /[\\/]/u.test(value)) return fallback
  return value
}

const normalizePath = (raw: string) => {
  if (typeof raw !== 'string' || raw.length > 4096 || raw.includes('\0')) throw new Error('Der Vault-Pfad ist ungültig.')
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '').replace(/\/{2,}/gu, '/')
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Der Vault-Pfad ist ungültig.')
  return normalized
}

const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')
const fileName = (path: string) => path.split('/').pop() ?? path
const stem = (name: string) => name.replace(/\.[^.]+$/u, '')

const worksheetFormats = new Map([
  ['pdf', { kind: 'pdf' as const, mimeType: 'application/pdf', maxBytes: MAX_PDF_BYTES }],
  ['png', { kind: 'image' as const, mimeType: 'image/png', maxBytes: MAX_IMAGE_BYTES }],
  ['jpg', { kind: 'image' as const, mimeType: 'image/jpeg', maxBytes: MAX_IMAGE_BYTES }],
  ['jpeg', { kind: 'image' as const, mimeType: 'image/jpeg', maxBytes: MAX_IMAGE_BYTES }],
  ['webp', { kind: 'image' as const, mimeType: 'image/webp', maxBytes: MAX_IMAGE_BYTES }],
  ['gif', { kind: 'image' as const, mimeType: 'image/gif', maxBytes: MAX_IMAGE_BYTES }],
])

const validWorksheetSignature = async (file: Blob, extension: string) => {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const ascii = new TextDecoder('ascii').decode(bytes)
  const begins = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  return extension === 'pdf' ? ascii.startsWith('%PDF-')
    : extension === 'png' ? begins(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
      : extension === 'jpg' || extension === 'jpeg' ? begins(0xff, 0xd8, 0xff)
        : extension === 'webp' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
          : extension === 'gif' ? ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')
            : false
}

const extensionForMime = (mimeType: string) => mimeType === 'application/pdf' ? 'pdf'
  : mimeType === 'image/png' ? 'png'
    : mimeType === 'image/jpeg' ? 'jpg'
      : mimeType === 'image/webp' ? 'webp'
        : mimeType === 'image/gif' ? 'gif'
          : ''

const sha256Blob = async (blob: Blob) => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

const storedServerBackup = (value: unknown): StoredServerBackup | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<StoredServerBackup>
  if (raw.schemaVersion !== 1 || typeof raw.recoveryCode !== 'string') return null
  const match = RECOVERY_CODE_PATTERN.exec(raw.recoveryCode)
  if (!match || raw.id !== match[1] || raw.secret !== match[2]) return null
  return {
    schemaVersion: 1,
    id: match[1],
    secret: match[2],
    recoveryCode: raw.recoveryCode,
    automatic: raw.automatic === true,
    lastBackupAt: typeof raw.lastBackupAt === 'string' ? raw.lastBackupAt : null,
    sizeBytes: Number.isFinite(raw.sizeBytes) && Number(raw.sizeBytes) >= 0 ? Number(raw.sizeBytes) : 0,
    error: typeof raw.error === 'string' ? raw.error : null,
  }
}

const pickWorksheet = () => new Promise<File | null>((resolve) => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.pdf,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/png,image/jpeg,image/webp,image/gif'
  input.style.display = 'none'
  document.body.append(input)
  let settled = false
  const finish = (file: File | null) => {
    if (settled) return
    settled = true
    window.removeEventListener('focus', afterFocus)
    input.remove()
    resolve(file)
  }
  const afterFocus = () => window.setTimeout(() => finish(input.files?.[0] ?? null), 350)
  input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true })
  window.addEventListener('focus', afterFocus, { once: true })
  input.click()
})

const blobFromDataUrl = async (dataUrl: string) => {
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error('Die Bilddaten konnten nicht gelesen werden.')
  return response.blob()
}

const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function createBrowserApi(): FaNotesApi {
  let database: IDBDatabase
  const english = getUiLanguage() === 'en'
  const initialFiles = browserInitialFiles()
  const starterSubjects = browserStarterSubjects()
  const starterFolders = browserStarterFolders()
  const localizedDefaults: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(english ? { recognitionLanguage: 'en' as const, defaultFolder: 'Inbox', dailyNotesFolder: 'Daily Notes' } : {}),
  }
  let settings: AppSettings = { ...localizedDefaults }
  let onboardingComplete = false
  const files = new Map<string, FileRecord>()
  const folders = new Map<string, FolderRecord>()
  const assets = new Map<string, Blob>()
  const assetUrls = new Map<string, string>()
  const drawings = new Map<string, DrawingLibraryDocument>()
  const worksheets = new Map<string, WorksheetDocument>()
  let cachedTree: VaultEntry[] | null = null
  let updateState: UpdateState = {
    status: 'up-to-date', supported: false, currentVersion: WEB_VERSION, latestVersion: WEB_VERSION,
    publishedAt: null, releaseNotes: [], downloadedBytes: 0, totalBytes: 0, progress: 0, error: null,
    checkedAt: null, installationKind: 'managed-appimage', autoCheckUpdates: false, autoDownloadUpdates: false, installUpdatesOnQuit: false, updateChannel: 'stable',
  }
  let serverBackup: StoredServerBackup | null = null
  let serverBackupRuntimeStatus: ServerBackupState['status'] = 'disabled'
  let serverBackupTimer: number | null = null
  let serverBackupSuppressed = false
  let serverBackupRun: Promise<ServerBackupState> | null = null
  let syncServerBackupInternal: () => Promise<ServerBackupState> = async () => serverBackupState()

  const serverBackupState = (): ServerBackupState => ({
    supported: true,
    enabled: Boolean(serverBackup),
    status: serverBackup ? serverBackupRuntimeStatus : 'disabled',
    lastBackupAt: serverBackup?.lastBackupAt ?? null,
    sizeBytes: serverBackup?.sizeBytes ?? 0,
    recoveryCode: serverBackup?.recoveryCode ?? null,
    automatic: serverBackup?.automatic === true,
    error: serverBackup?.error ?? null,
  })

  const scheduleServerBackup = () => {
    if (serverBackupSuppressed || !serverBackup?.automatic) return
    if (serverBackupTimer !== null) window.clearTimeout(serverBackupTimer)
    serverBackupTimer = window.setTimeout(() => {
      serverBackupTimer = null
      void syncServerBackupInternal().catch(() => undefined)
    }, 20_000)
  }

  const write = async (storeName: StoreName, operation: (store: IDBObjectStore) => void, queueBackup = true) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const done = transactionDone(transaction)
    operation(transaction.objectStore(storeName))
    await done
    if (queueBackup) scheduleServerBackup()
  }

  const writeMany = async (storeNames: StoreName[], operation: (stores: Map<StoreName, IDBObjectStore>) => void, queueBackup = true) => {
    const transaction = database.transaction(storeNames, 'readwrite')
    const done = transactionDone(transaction)
    operation(new Map(storeNames.map((name) => [name, transaction.objectStore(name)])))
    await done
    if (queueBackup) scheduleServerBackup()
  }

  const setMeta = (key: string, value: unknown, queueBackup = true) => write('meta', (store) => { store.put({ key, value } satisfies MetaRecord) }, queueBackup)

  const initialize = async () => {
    database = await openDatabase()
    const metaTransaction = database.transaction('meta', 'readonly')
    const initialized = await requestResult(metaTransaction.objectStore('meta').get('initialized') as IDBRequest<MetaRecord | undefined>)
    if (!initialized) {
      const now = new Date().toISOString()
      await writeMany(['meta', 'files', 'folders'], (stores) => {
        stores.get('meta')!.put({ key: 'initialized', value: true } satisfies MetaRecord)
        stores.get('meta')!.put({ key: 'settings', value: { ...localizedDefaults } } satisfies MetaRecord)
        stores.get('meta')!.put({ key: 'onboardingComplete', value: false } satisfies MetaRecord)
        const inbox = english ? 'Inbox' : 'Eingang'
        const welcome = english ? 'Welcome.md' : 'Willkommen.md'
        stores.get('folders')!.put({ path: inbox, color: '#8b7cff' } satisfies FolderRecord)
        stores.get('files')!.put({ path: welcome, content: initialFiles[welcome], modifiedAt: now } satisfies FileRecord)
      })
    }

    const transaction = database.transaction(STORES, 'readonly')
    const [metaRows, storedFileRows, folderRows, assetRows, drawingRows, worksheetRows] = await Promise.all([
      requestResult(transaction.objectStore('meta').getAll() as IDBRequest<MetaRecord[]>),
      requestResult(transaction.objectStore('files').getAll() as IDBRequest<FileRecord[]>),
      requestResult(transaction.objectStore('folders').getAll() as IDBRequest<FolderRecord[]>),
      requestResult(transaction.objectStore('assets').getAll() as IDBRequest<AssetRecord[]>),
      requestResult(transaction.objectStore('drawings').getAll() as IDBRequest<DrawingLibraryDocument[]>),
      requestResult(transaction.objectStore('worksheets').getAll() as IDBRequest<WorksheetDocument[]>),
    ])
    const repairTimestamp = new Date().toISOString()
    const fileRows = storedFileRows.map((row) => {
      const content = repairBrowserWelcomeMarkdown(row.path, row.content)
      return content === row.content ? row : { ...row, content, modifiedAt: repairTimestamp }
    })
    const repairedWelcomeRows = fileRows.filter((row, index) => row.content !== storedFileRows[index].content)
    if (repairedWelcomeRows.length) {
      const repairTransaction = database.transaction('files', 'readwrite')
      const repairStore = repairTransaction.objectStore('files')
      repairedWelcomeRows.forEach((row) => repairStore.put(row satisfies FileRecord))
      await transactionDone(repairTransaction)
    }
    const meta = new Map(metaRows.map((row) => [row.key, row.value]))
    const savedSettings = meta.get('settings')
    settings = { ...localizedDefaults, ...(isRecord(savedSettings) ? savedSettings : {}) }
    serverBackup = storedServerBackup(meta.get('serverBackup'))
    serverBackupRuntimeStatus = serverBackup ? serverBackup.error ? 'error' : 'ready' : 'disabled'
    onboardingComplete = meta.get('onboardingComplete') === true
    fileRows.forEach((row) => files.set(row.path, row))
    folderRows.forEach((row) => folders.set(row.path, row))
    assetRows.forEach((row) => assets.set(row.path, row.value))
    drawingRows.forEach((row) => drawings.set(row.id, row))
    worksheetRows.forEach((row) => worksheets.set(row.id, row))
    if (serverBackup?.automatic) window.setTimeout(scheduleServerBackup, 5_000)
  }

  const ready = initialize()

  const bootstrapData = (): BootstrapData => ({
    vaultPath: english ? 'Browser · this device' : 'Browser · dieses Gerät',
    vaultName: english ? 'My Web Vault' : 'Mein Web-Vault',
    settings: clone(settings),
    onboardingRequired: !onboardingComplete,
    starterSubjects: clone(starterSubjects),
  })

  const buildTree = () => {
    if (cachedTree) return clone(cachedTree)
    const root: VaultEntry[] = []
    const directories = new Map<string, VaultEntry[]>([['', root]])
    ;[...folders.values()].sort((a, b) => a.path.localeCompare(b.path, getUiLanguage())).forEach((folder) => {
      const children: VaultEntry[] = []
      directories.set(folder.path, children)
      const entry: VaultEntry = { name: fileName(folder.path), relativePath: folder.path, kind: 'folder', color: folder.color, children }
      ;(directories.get(parentPath(folder.path)) ?? root).push(entry)
    })
    files.forEach((record) => {
      const entry: VaultEntry = { name: fileName(record.path), relativePath: record.path, kind: 'file', extension: 'md', modifiedAt: record.modifiedAt, size: textBytes(record.content) }
      ;(directories.get(parentPath(record.path)) ?? root).push(entry)
    })
    const sort = (entries: VaultEntry[]) => entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, getUiLanguage()) : a.kind === 'folder' ? -1 : 1).forEach((entry) => { if (entry.children) sort(entry.children) })
    sort(root)
    cachedTree = root
    return clone(root)
  }

  const uniquePath = (preferred: string, kind: 'file' | 'folder') => {
    const exists = (candidate: string) => files.has(candidate) || folders.has(candidate)
    if (!exists(preferred)) return preferred
    const extension = kind === 'file' ? '.md' : ''
    const base = extension ? preferred.replace(/\.md$/iu, '') : preferred
    let index = 2
    while (exists(`${base} ${index}${extension}`)) index += 1
    return `${base} ${index}${extension}`
  }

  const refreshUpdate = async () => {
    updateState = { ...updateState, status: 'checking', checkedAt: new Date().toISOString(), error: null }
    try {
      const response = await fetch('/api/release', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const release = await response.json() as { version?: unknown; releasedAt?: unknown; changes?: unknown }
      const latest = typeof release.version === 'string' ? release.version : WEB_VERSION
      updateState = {
        ...updateState,
        status: latest === WEB_VERSION ? 'up-to-date' : 'available',
        latestVersion: latest,
        publishedAt: typeof release.releasedAt === 'string' ? release.releasedAt : null,
        releaseNotes: Array.isArray(release.changes) ? release.changes.filter((item): item is string => typeof item === 'string').slice(0, 10) : [],
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      updateState = { ...updateState, status: 'error', error: `Die Web-Version konnte nicht geprüft werden: ${error instanceof Error ? error.message : 'Netzwerkfehler'}` }
    }
    return clone(updateState)
  }

  const backupAuthorization = (credential = serverBackup) => {
    if (!credential) throw new Error('Das Server-Backup ist auf diesem Gerät nicht eingerichtet.')
    return `FaNotes ${credential.id}.${credential.secret}`
  }

  const backupFetch = async (path: string, init: RequestInit = {}, credential = serverBackup) => {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (credential) headers.set('Authorization', backupAuthorization(credential))
    const response = await fetch(path, { ...init, headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'same-origin' })
    if (!response.ok) {
      let message = `Server-Backup fehlgeschlagen (HTTP ${response.status}).`
      try {
        const body = await response.json() as { error?: unknown }
        if (typeof body.error === 'string' && body.error.length <= 500) message = body.error
      } catch { /* The generic status message is intentionally used. */ }
      throw new Error(message)
    }
    return response
  }

  const persistServerBackup = async () => {
    if (serverBackup) await setMeta('serverBackup', serverBackup, false)
    else await write('meta', (store) => { store.delete('serverBackup') }, false)
  }

  const performServerBackup = async (): Promise<ServerBackupState> => {
    await ready
    if (!serverBackup) throw new Error('Das Server-Backup ist nicht eingerichtet.')
    serverBackupRuntimeStatus = 'syncing'
    serverBackup.error = null
    await persistServerBackup()
    try {
      const assetReferences: ServerAssetReference[] = []
      for (const [path, blob] of assets) {
        if (!SERVER_ASSET_MIME.has(blob.type)) throw new Error(`Die lokale Datei „${path}“ besitzt einen nicht unterstützten Typ.`)
        const sourceDigest = await sha256Blob(blob)
        const response = await backupFetch(`/api/v1/backups/assets/${sourceDigest}`, {
          method: 'PUT',
          headers: { 'Content-Type': blob.type },
          body: blob,
        })
        const uploaded = await response.json() as { digest?: unknown; size?: unknown; mimeType?: unknown }
        if (
          typeof uploaded.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(uploaded.digest) ||
          !Number.isSafeInteger(uploaded.size) || Number(uploaded.size) <= 0 || uploaded.mimeType !== blob.type
        ) throw new Error('Der Backup-Server hat eine ungültige Datei-Bestätigung gesendet.')
        assetReferences.push({ path, digest: uploaded.digest, size: Number(uploaded.size), mimeType: blob.type })
      }

      const handwriting = await import('./handwritingDb')
      const [samples, labels, layouts] = await Promise.all([
        handwriting.getHandwritingSamples(),
        handwriting.getImportedLabels(),
        handwriting.getMathLayoutExamples(),
      ])
      const safeSettings = { ...settings } as Partial<AppSettings>
      delete safeSettings.lmStudioApiToken
      delete safeSettings.ollamaApiToken
      delete safeSettings.openAiApiKey
      delete safeSettings.geminiApiKey
      delete safeSettings.anthropicApiKey
      delete safeSettings.openCodePassword
      const response = await backupFetch('/api/v1/backups/snapshot', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          files: [...files.values()],
          folders: [...folders.values()],
          assets: assetReferences,
          drawings: [...drawings.values()],
          worksheets: [...worksheets.values()],
          settings: safeSettings,
          onboardingComplete,
          training: { samples, labels, layouts },
        }),
      })
      const saved = await response.json() as { savedAt?: unknown; sizeBytes?: unknown }
      if (typeof saved.savedAt !== 'string' || !Number.isFinite(Date.parse(saved.savedAt)) || !Number.isSafeInteger(saved.sizeBytes)) {
        throw new Error('Der Backup-Server hat den Abschluss nicht eindeutig bestätigt.')
      }
      serverBackup.lastBackupAt = new Date(saved.savedAt).toISOString()
      serverBackup.sizeBytes = Math.max(0, Number(saved.sizeBytes))
      serverBackup.error = null
      serverBackupRuntimeStatus = 'ready'
      await persistServerBackup()
      return serverBackupState()
    } catch (error) {
      serverBackupRuntimeStatus = 'error'
      if (serverBackup) {
        serverBackup.error = error instanceof Error ? error.message : 'Das Server-Backup ist fehlgeschlagen.'
        await persistServerBackup().catch(() => undefined)
      }
      throw error
    }
  }

  syncServerBackupInternal = () => {
    if (!serverBackupRun) serverBackupRun = performServerBackup().finally(() => { serverBackupRun = null })
    return serverBackupRun
  }

  const connectServerBackup = async (recoveryCode: string) => {
    await ready
    const normalized = recoveryCode.trim()
    const match = RECOVERY_CODE_PATTERN.exec(normalized)
    if (!match) throw new Error('Der Wiederherstellungscode besitzt kein gültiges FaNotes-Format.')
    const candidate: StoredServerBackup = {
      schemaVersion: 1,
      id: match[1],
      secret: match[2],
      recoveryCode: normalized,
      automatic: false,
      lastBackupAt: null,
      sizeBytes: 0,
      error: null,
    }
    const response = await backupFetch('/api/v1/backups/status', { method: 'GET' }, candidate)
    const remote = await response.json() as { lastBackupAt?: unknown; sizeBytes?: unknown }
    candidate.lastBackupAt = typeof remote.lastBackupAt === 'string' && Number.isFinite(Date.parse(remote.lastBackupAt)) ? new Date(remote.lastBackupAt).toISOString() : null
    candidate.sizeBytes = Number.isSafeInteger(remote.sizeBytes) ? Math.max(0, Number(remote.sizeBytes)) : 0
    serverBackup = candidate
    serverBackupRuntimeStatus = 'ready'
    await persistServerBackup()
    return serverBackupState()
  }

  const restoreServerBackup = async (): Promise<ServerBackupState> => {
    await ready
    if (!serverBackup) throw new Error('Gib zuerst den Wiederherstellungscode ein.')
    serverBackupRuntimeStatus = 'syncing'
    try {
      const response = await backupFetch('/api/v1/backups/snapshot', { method: 'GET', headers: { Accept: 'application/vnd.fanotes.backup+json' } })
      const contentLength = Number(response.headers.get('content-length') || 0)
      if (contentLength > 128 * 1024 * 1024) throw new Error('Das Server-Backup überschreitet das sichere Wiederherstellungslimit.')
      const raw: unknown = await response.json()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Das Server-Backup enthält keine gültigen FaNotes-Daten.')
      const snapshot = raw as {
        schemaVersion?: unknown
        files?: unknown
        folders?: unknown
        assets?: unknown
        drawings?: unknown
        worksheets?: unknown
        settings?: unknown
        onboardingComplete?: unknown
        training?: unknown
      }
      if (
        snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.files) || snapshot.files.length > 10_000 ||
        !Array.isArray(snapshot.folders) || snapshot.folders.length > 10_000 || !Array.isArray(snapshot.assets) || snapshot.assets.length > 1_000 ||
        !Array.isArray(snapshot.drawings) || snapshot.drawings.length > 10_000 || !Array.isArray(snapshot.worksheets) || snapshot.worksheets.length > 10_000
      ) throw new Error('Das Server-Backup überschreitet die lokalen Sicherheitslimits.')

      const restoredFiles = snapshot.files.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Eine Notiz im Backup ist ungültig.')
        const row = entry as Partial<FileRecord>
        const path = normalizePath(row.path ?? '')
        if (!path.toLocaleLowerCase('en-US').endsWith('.md') || typeof row.content !== 'string' || textBytes(row.content) > MAX_NOTE_BYTES || typeof row.modifiedAt !== 'string' || !Number.isFinite(Date.parse(row.modifiedAt))) throw new Error('Eine Notiz im Backup ist ungültig.')
        return { path, content: row.content, modifiedAt: new Date(row.modifiedAt).toISOString() } satisfies FileRecord
      })
      const restoredFolders = snapshot.folders.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Ein Ordner im Backup ist ungültig.')
        const row = entry as Partial<FolderRecord>
        const path = normalizePath(row.path ?? '')
        if (row.color !== undefined && !/^#[a-f0-9]{6}$/iu.test(row.color)) throw new Error('Eine Ordnerfarbe im Backup ist ungültig.')
        return { path, ...(row.color ? { color: row.color } : {}) } satisfies FolderRecord
      })
      const restoredDrawings = snapshot.drawings as DrawingLibraryDocument[]
      const restoredWorksheets = snapshot.worksheets as WorksheetDocument[]
      const assetRows: AssetRecord[] = []
      for (const entry of snapshot.assets) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Eine Datei im Backup ist ungültig.')
        const reference = entry as Partial<ServerAssetReference>
        if (typeof reference.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.digest) || typeof reference.mimeType !== 'string' || !SERVER_ASSET_MIME.has(reference.mimeType) || !Number.isSafeInteger(reference.size) || Number(reference.size) <= 0) throw new Error('Eine Datei-Referenz im Backup ist ungültig.')
        const path = normalizePath(reference.path ?? '')
        const assetResponse = await backupFetch(`/api/v1/backups/snapshot/assets/${reference.digest}`, { method: 'GET', headers: { Accept: reference.mimeType } })
        const blob = await assetResponse.blob()
        if (blob.size !== reference.size || blob.type !== reference.mimeType || await sha256Blob(blob) !== reference.digest) throw new Error('Eine wiederhergestellte Datei hat die Integritätsprüfung nicht bestanden.')
        const extension = extensionForMime(blob.type)
        if (!extension || !await validWorksheetSignature(blob, extension)) throw new Error('Eine wiederhergestellte Datei stimmt nicht mit ihrem Format überein.')
        assetRows.push({ path, value: blob })
      }

      if (!snapshot.training || typeof snapshot.training !== 'object' || Array.isArray(snapshot.training)) throw new Error('Die Trainingsdaten im Backup sind ungültig.')
      const training = snapshot.training as { samples?: unknown; labels?: unknown; layouts?: unknown }
      if (!Array.isArray(training.samples) || !Array.isArray(training.labels) || !Array.isArray(training.layouts)) throw new Error('Die Trainingsdaten im Backup sind unvollständig.')
      const handwriting = await import('./handwritingDb')
      await handwriting.putHandwritingLabels(training.labels as Parameters<typeof handwriting.putHandwritingLabels>[0])
      await handwriting.putHandwritingSamples(training.samples as Parameters<typeof handwriting.putHandwritingSamples>[0])
      await handwriting.putMathLayoutExamples(training.layouts as Parameters<typeof handwriting.putMathLayoutExamples>[0])

      if (!snapshot.settings || typeof snapshot.settings !== 'object' || Array.isArray(snapshot.settings)) throw new Error('Die Einstellungen im Backup sind ungültig.')
      const restoredSettings = {
        ...localizedDefaults,
        ...(snapshot.settings as Partial<AppSettings>),
        lmStudioApiToken: settings.lmStudioApiToken,
        ollamaApiToken: settings.ollamaApiToken,
        openAiApiKey: settings.openAiApiKey,
        geminiApiKey: settings.geminiApiKey,
        anthropicApiKey: settings.anthropicApiKey,
        openCodePassword: settings.openCodePassword,
      }
      serverBackup.automatic = true
      serverBackup.error = null
      serverBackupSuppressed = true
      await writeMany([...STORES], (stores) => {
        stores.get('files')!.clear(); restoredFiles.forEach((row) => stores.get('files')!.put(row))
        stores.get('folders')!.clear(); restoredFolders.forEach((row) => stores.get('folders')!.put(row))
        stores.get('assets')!.clear(); assetRows.forEach((row) => stores.get('assets')!.put(row))
        stores.get('drawings')!.clear(); restoredDrawings.forEach((row) => stores.get('drawings')!.put(row))
        stores.get('worksheets')!.clear(); restoredWorksheets.forEach((row) => stores.get('worksheets')!.put(row))
        stores.get('meta')!.put({ key: 'initialized', value: true } satisfies MetaRecord)
        stores.get('meta')!.put({ key: 'settings', value: restoredSettings } satisfies MetaRecord)
        stores.get('meta')!.put({ key: 'onboardingComplete', value: snapshot.onboardingComplete === true } satisfies MetaRecord)
        stores.get('meta')!.put({ key: 'serverBackup', value: serverBackup } satisfies MetaRecord)
      }, false)
      serverBackupRuntimeStatus = 'ready'
      window.setTimeout(() => location.reload(), 100)
      return serverBackupState()
    } catch (error) {
      serverBackupRuntimeStatus = 'error'
      serverBackup.error = error instanceof Error ? error.message : 'Das Server-Backup konnte nicht wiederhergestellt werden.'
      await persistServerBackup().catch(() => undefined)
      throw error
    } finally {
      serverBackupSuppressed = false
    }
  }

  return {
    platform: 'web',
    bootstrap: async () => { await ready; return bootstrapData() },
    reportRendererReady: () => undefined,
    completeOnboarding: async (subjects) => {
      await ready
      const selected = new Set(subjects)
      await writeMany(['meta', 'folders'], (stores) => {
        for (const subject of starterFolders) {
          if (selected.has(subject.name)) stores.get('folders')!.put({ path: subject.name, color: subject.color } satisfies FolderRecord)
        }
        stores.get('meta')!.put({ key: 'onboardingComplete', value: true } satisfies MetaRecord)
      })
      starterFolders.forEach((subject) => { if (selected.has(subject.name)) folders.set(subject.name, { path: subject.name, color: subject.color }) })
      onboardingComplete = true
      cachedTree = null
      void navigator.storage?.persist?.().catch(() => false)
      return bootstrapData()
    },
    selectVault: async () => { await ready; return bootstrapData() },
    getCachedTree: async () => { await ready; return buildTree() },
    getFastTree: async () => { await ready; return buildTree() },
    getTree: async () => { await ready; return buildTree() },
    readFile: async (rawPath) => {
      await ready
      const record = files.get(normalizePath(rawPath))
      if (!record) throw new Error('Die Notiz wurde im Browser-Vault nicht gefunden.')
      return record.content
    },
    readAssetDataUrl: async (rawPath) => {
      await ready
      const path = normalizePath(rawPath)
      const blob = assets.get(path)
      if (!blob) throw new Error('Die lokale Bild- oder PDF-Datei wurde nicht gefunden.')
      const previous = assetUrls.get(path)
      if (previous) return previous
      const url = URL.createObjectURL(blob)
      assetUrls.set(path, url)
      return url
    },
    writeFile: async (rawPath, content) => {
      await ready
      const path = normalizePath(rawPath)
      if (!files.has(path)) throw new Error('Die Notiz wurde im Browser-Vault nicht gefunden.')
      if (typeof content !== 'string' || textBytes(content) > MAX_NOTE_BYTES) throw new Error('Die Notiz ist zu groß.')
      const record = { path, content, modifiedAt: new Date().toISOString() }
      await write('files', (store) => { store.put(record) })
      files.set(path, record)
      cachedTree = null
      return { modifiedAt: record.modifiedAt }
    },
    createNote: async (rawParent, rawPreferredName) => {
      await ready
      const parent = typeof rawParent === 'string' && rawParent.trim() ? normalizePath(rawParent) : ''
      if (parent && !folders.has(parent)) throw new Error('Der Zielordner wurde nicht gefunden.')
      const preferredName = typeof rawPreferredName === 'string' && rawPreferredName.trim()
        ? rawPreferredName
        : english ? 'Untitled Note' : 'Unbenannte Notiz'
      const name = safeSegment(preferredName.replace(/\.md$/iu, ''), english ? 'Untitled Note' : 'Unbenannte Notiz')
      const path = uniquePath([parent, `${name}.md`].filter(Boolean).join('/'), 'file')
      const record = { path, content: `# ${name}\n\n`, modifiedAt: new Date().toISOString() }
      await write('files', (store) => { store.put(record) })
      files.set(path, record)
      cachedTree = null
      return { relativePath: path, entry: { name: fileName(path), relativePath: path, kind: 'file', extension: 'md', modifiedAt: record.modifiedAt, size: textBytes(record.content) } }
    },
    createFolder: async (rawParent = '', preferredName = english ? 'New Folder' : 'Neuer Ordner') => {
      await ready
      const parent = rawParent ? normalizePath(rawParent) : ''
      if (parent && !folders.has(parent)) throw new Error('Der Zielordner wurde nicht gefunden.')
      const path = uniquePath([parent, safeSegment(preferredName, english ? 'New Folder' : 'Neuer Ordner')].filter(Boolean).join('/'), 'folder')
      const record = { path }
      await write('folders', (store) => { store.put(record) })
      folders.set(path, record)
      cachedTree = null
      return { relativePath: path, entry: { name: fileName(path), relativePath: path, kind: 'folder', children: [] } }
    },
    setFolderColor: async (rawPath, color) => {
      await ready
      const path = normalizePath(rawPath)
      const current = folders.get(path)
      if (!current) throw new Error('Der Ordner wurde nicht gefunden.')
      if (color !== null && !/^#[a-f0-9]{6}$/iu.test(color)) throw new Error('Die Ordnerfarbe ist ungültig.')
      const record = { path, ...(color ? { color } : {}) }
      await write('folders', (store) => { store.put(record) })
      folders.set(path, record)
      cachedTree = null
      return { color }
    },
    renameEntry: async (rawPath, nextName) => {
      await ready
      const path = normalizePath(rawPath)
      const parent = parentPath(path)
      if (files.has(path)) {
        const name = `${safeSegment(nextName.replace(/\.md$/iu, ''), stem(fileName(path)))}.md`
        const next = [parent, name].filter(Boolean).join('/')
        if (next !== path && (files.has(next) || folders.has(next))) throw new Error('An diesem Ort existiert bereits ein Eintrag mit diesem Namen.')
        const record = { ...files.get(path)!, path: next, modifiedAt: new Date().toISOString() }
        await write('files', (store) => { store.delete(path); store.put(record) })
        files.delete(path); files.set(next, record); cachedTree = null
        return next
      }
      if (!folders.has(path)) throw new Error('Der Eintrag wurde nicht gefunden.')
      const next = [parent, safeSegment(nextName, fileName(path))].filter(Boolean).join('/')
      if (next !== path && (files.has(next) || folders.has(next))) throw new Error('An diesem Ort existiert bereits ein Eintrag mit diesem Namen.')
      const movedFolders = [...folders.values()].filter((row) => row.path === path || row.path.startsWith(`${path}/`)).map((row) => ({ ...row, path: `${next}${row.path.slice(path.length)}` }))
      const movedFiles = [...files.values()].filter((row) => row.path.startsWith(`${path}/`)).map((row) => ({ ...row, path: `${next}${row.path.slice(path.length)}` }))
      await writeMany(['folders', 'files'], (stores) => {
        ;[...folders.keys()].filter((candidate) => candidate === path || candidate.startsWith(`${path}/`)).forEach((candidate) => stores.get('folders')!.delete(candidate))
        ;[...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)).forEach((candidate) => stores.get('files')!.delete(candidate))
        movedFolders.forEach((row) => stores.get('folders')!.put(row))
        movedFiles.forEach((row) => stores.get('files')!.put(row))
      })
      ;[...folders.keys()].filter((candidate) => candidate === path || candidate.startsWith(`${path}/`)).forEach((candidate) => folders.delete(candidate))
      ;[...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)).forEach((candidate) => files.delete(candidate))
      movedFolders.forEach((row) => folders.set(row.path, row)); movedFiles.forEach((row) => files.set(row.path, row)); cachedTree = null
      return next
    },
    trashEntry: async (rawPath) => {
      await ready
      const path = normalizePath(rawPath)
      const deletedFiles = [...files.keys()].filter((candidate) => candidate === path || candidate.startsWith(`${path}/`))
      const deletedFolders = [...folders.keys()].filter((candidate) => candidate === path || candidate.startsWith(`${path}/`))
      await writeMany(['files', 'folders'], (stores) => {
        deletedFiles.forEach((candidate) => stores.get('files')!.delete(candidate))
        deletedFolders.forEach((candidate) => stores.get('folders')!.delete(candidate))
      })
      deletedFiles.forEach((candidate) => files.delete(candidate)); deletedFolders.forEach((candidate) => folders.delete(candidate)); cachedTree = null
    },
    search: async (query) => {
      await ready
      const needle = query.trim().toLocaleLowerCase('de')
      if (!needle) return []
      const noteHits = [...files.values()].flatMap((record) => {
        const contentLower = record.content.toLocaleLowerCase('de')
        const index = contentLower.indexOf(needle)
        const lower = `${record.path}\n${record.content}`.toLocaleLowerCase('de')
        const pathMatch = record.path.toLocaleLowerCase('de').includes(needle)
        if (index < 0 && !pathMatch) return []
        const excerpt = index >= 0
          ? record.content.slice(Math.max(0, index - 60), Math.min(record.content.length, index + needle.length + 120)).replace(/[#*_`]/gu, '')
          : `Dateiname · ${record.path}`
        return [{ relativePath: record.path, title: stem(fileName(record.path)), excerpt, matches: lower.split(needle).length - 1, kind: 'note' as const }]
      })
      const drawingHits = [...drawings.values()].flatMap((drawing) => {
        try {
          const parsed = JSON.parse(drawing.drawingJson) as { searchTranscript?: unknown }
          const transcript = typeof parsed.searchTranscript === 'string' ? parsed.searchTranscript : ''
          const haystack = `${drawing.title}\n${transcript}`
          if (!haystack.toLocaleLowerCase('de').includes(needle)) return []
          return [{ relativePath: drawing.dataRelativePath, title: drawing.title, excerpt: haystack.slice(0, 180), matches: 1, kind: 'drawing' as const, drawingId: drawing.id }]
        } catch { return [] }
      })
      return [...noteHits, ...drawingHits].slice(0, 250)
    },
    saveDrawing: async ({ id = crypto.randomUUID(), title, imageData, drawingJson }) => {
      await ready
      if (textBytes(drawingJson) > MAX_DRAWING_BYTES) throw new Error('Die Handschriftseite ist zu groß.')
      let parsed: { updatedAt?: unknown }
      try { parsed = JSON.parse(drawingJson) as { updatedAt?: unknown } } catch { throw new Error('Die Handschriftseite enthält ungültige Daten.') }
      const now = typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt)) ? new Date(parsed.updatedAt).toISOString() : new Date().toISOString()
      const imageRelativePath = `.fanotes/assets/${id}.png`
      const dataRelativePath = `.fanotes/assets/${id}.json`
      const document: DrawingLibraryDocument = { id, title: safeSegment(title, 'Handschrift'), updatedAt: now, imageRelativePath, dataRelativePath, drawingJson }
      let image: Blob | null = null
      if (imageData) {
        image = await blobFromDataUrl(imageData)
        if (image.type !== 'image/png' || image.size > MAX_IMAGE_BYTES) throw new Error('Die Handschriftvorschau ist ungültig oder zu groß.')
      }
      await writeMany(image ? ['drawings', 'assets'] : ['drawings'], (stores) => {
        stores.get('drawings')!.put(document)
        if (image) stores.get('assets')!.put({ path: imageRelativePath, value: image } satisfies AssetRecord)
      })
      drawings.set(id, document)
      if (image) {
        const previous = assetUrls.get(imageRelativePath); if (previous) URL.revokeObjectURL(previous)
        assetUrls.delete(imageRelativePath); assets.set(imageRelativePath, image)
      }
      return { id, title: document.title, updatedAt: now, imageRelativePath, dataRelativePath }
    },
    listDrawings: async () => {
      await ready
      return [...drawings.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ drawingJson: _json, ...row }) => clone(row))
    },
    readDrawing: async (id) => {
      await ready
      const document = drawings.get(id)
      if (!document) throw new Error('Die gespeicherte Handschriftseite wurde nicht gefunden.')
      return clone(document)
    },
    importWorksheet: async () => {
      const file = await pickWorksheet()
      if (!file) return null
      await ready
      const extension = file.name.split('.').pop()?.toLocaleLowerCase('en-US') ?? ''
      const format = worksheetFormats.get(extension)
      if (!format) throw new Error('Es werden PDF-, PNG-, JPEG-, WebP- und GIF-Arbeitsblätter unterstützt.')
      if (!file.size || file.size > format.maxBytes) throw new Error(`Das Arbeitsblatt ist leer oder größer als ${Math.round(format.maxBytes / 1024 / 1024)} MB.`)
      if (!await validWorksheetSignature(file, extension)) throw new Error('Die ausgewählte Datei stimmt nicht mit ihrem Dateiformat überein.')
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const sourceRelativePath = `.fanotes/worksheets/${id}.${extension}`
      const document: WorksheetDocument = { schemaVersion: 1, id, title: safeSegment(stem(file.name), 'Arbeitsblatt'), kind: format.kind, mimeType: format.mimeType, sourceRelativePath, dataRelativePath: `.fanotes/worksheets/${id}.json`, createdAt: now, updatedAt: now, textBoxes: [] }
      const source = file.slice(0, file.size, format.mimeType)
      await writeMany(['worksheets', 'assets'], (stores) => {
        stores.get('worksheets')!.put(document)
        stores.get('assets')!.put({ path: sourceRelativePath, value: source } satisfies AssetRecord)
      })
      worksheets.set(id, document); assets.set(sourceRelativePath, source)
      return clone(document)
    },
    importOneNote: async () => {
      throw new Error('Binäre OneNote-Notizbücher werden sicher in der Linux- oder Windows-App importiert.')
    },
    readWorksheet: async (id) => {
      await ready
      const document = worksheets.get(id)
      if (!document) throw new Error('Das Arbeitsblatt wurde nicht gefunden.')
      return clone(document)
    },
    loadSpellingResources: loadBrowserSpellingResources,
    loadSpellingWordCandidates: loadBrowserSpellingWordCandidates,
    loadHandwritingRecognitionResources: loadBrowserHandwritingRecognitionResources,
    saveWorksheet: async (document) => {
      await ready
      if (!worksheets.has(document.id) || document.textBoxes.length > 2000) throw new Error('Die Arbeitsblattdaten sind ungültig.')
      const saved = { ...clone(document), updatedAt: new Date().toISOString() }
      await write('worksheets', (store) => { store.put(saved) })
      worksheets.set(saved.id, saved)
      return clone(saved)
    },
    lmStudioListModels: listBrowserLmStudioModels,
    lmStudioTransform: transformWithBrowserLmStudio,
    aiListModels: listBrowserAiModels,
    aiTransform: transformWithBrowserAi,
    saveSettings: async (next) => {
      await ready
      settings = { ...localizedDefaults, ...clone(next) }
      await setMeta('settings', settings)
      return clone(settings)
    },
    getServerBackupState: async () => {
      await ready
      return clone(serverBackupState())
    },
    enableServerBackup: async (enrollmentCode) => {
      await ready
      if (serverBackup) return clone(serverBackupState())
      const normalizedEnrollment = enrollmentCode.trim()
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(normalizedEnrollment)) throw new Error('Der private Einrichtungs-Code besitzt kein gültiges Format.')
      const response = await backupFetch('/api/v1/backups/register', { method: 'POST', headers: { 'X-FaNotes-Enrollment': normalizedEnrollment } }, null)
      const registered = await response.json() as { recoveryCode?: unknown; createdAt?: unknown }
      if (typeof registered.recoveryCode !== 'string') throw new Error('Der Backup-Server hat keinen gültigen Wiederherstellungscode gesendet.')
      const match = RECOVERY_CODE_PATTERN.exec(registered.recoveryCode)
      if (!match) throw new Error('Der Backup-Server hat einen ungültigen Wiederherstellungscode gesendet.')
      serverBackup = {
        schemaVersion: 1,
        id: match[1],
        secret: match[2],
        recoveryCode: registered.recoveryCode,
        automatic: true,
        lastBackupAt: null,
        sizeBytes: 0,
        error: null,
      }
      serverBackupRuntimeStatus = 'ready'
      await persistServerBackup()
      return clone(await syncServerBackupInternal())
    },
    connectServerBackup: async (recoveryCode) => clone(await connectServerBackup(recoveryCode)),
    syncServerBackup: async () => clone(await syncServerBackupInternal()),
    restoreServerBackup: async () => clone(await restoreServerBackup()),
    deleteServerBackup: async () => {
      await ready
      if (serverBackup) await backupFetch('/api/v1/backups', { method: 'DELETE' })
      if (serverBackupTimer !== null) window.clearTimeout(serverBackupTimer)
      serverBackupTimer = null
      serverBackup = null
      serverBackupRuntimeStatus = 'disabled'
      await persistServerBackup()
      return clone(serverBackupState())
    },
    resetAppData: async () => {
      await ready
      settings = { ...localizedDefaults }
      await setMeta('settings', settings)
      if (serverBackupTimer !== null) window.clearTimeout(serverBackupTimer)
      serverBackupTimer = null
      serverBackup = null
      serverBackupRuntimeStatus = 'disabled'
      await persistServerBackup()
      for (const key of Object.keys(localStorage)) if (key.startsWith('fanotes-') || key.startsWith('lernwerk-')) localStorage.removeItem(key)
      await Promise.all(['fanotes-handwriting', 'lernwerk-notes-handwriting'].map((databaseName) => new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(databaseName)
        request.onsuccess = () => resolve(); request.onerror = () => resolve(); request.onblocked = () => resolve()
      })))
      if ('caches' in window) await Promise.all((await caches.keys()).filter((key) => key.startsWith('fanotes-web-')).map((key) => caches.delete(key)))
      window.setTimeout(() => location.reload(), 80)
      return { restarting: true }
    },
    getUpdateState: async () => { await ready; return clone(updateState) },
    checkForUpdates: refreshUpdate,
    downloadUpdate: async () => {
      await navigator.serviceWorker?.getRegistration()?.then((registration) => registration?.update())
      updateState = { ...updateState, status: 'downloaded', downloadedBytes: 1, totalBytes: 1, progress: 1 }
      return clone(updateState)
    },
    installUpdate: async () => {
      if ('caches' in window) await Promise.all((await caches.keys()).filter((key) => key.startsWith('fanotes-web-')).map((key) => caches.delete(key)))
      window.setTimeout(() => location.reload(), 50)
      return { ...clone(updateState), status: 'installing' }
    },
    onUpdateState: () => () => undefined,
    revealInFolder: async (rawPath) => {
      await ready
      const path = normalizePath(rawPath)
      const record = files.get(path)
      if (!record) throw new Error('Nur Markdown-Notizen können direkt heruntergeladen werden.')
      downloadBlob(new Blob([record.content], { type: 'text/markdown;charset=utf-8' }), fileName(path))
    },
    openExternal: async (rawUrl) => {
      const url = new URL(rawUrl, location.href)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Dieser externe Link ist nicht erlaubt.')
      window.open(url.href, '_blank', 'noopener,noreferrer')
    },
    onBeforeClose: () => () => undefined,
    confirmClose: () => undefined,
    cancelClose: () => undefined,
    requestClose: () => { location.href = '../' },
  }
}

const isRecord = (value: unknown): value is Partial<AppSettings> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
