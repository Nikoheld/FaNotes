/**
 * Persistent index storage in the app's own IndexedDB (desktop: the Electron
 * profile; web: the browser profile). One database per vault, never written
 * into the vault and never synced. Units are stored one record each so a batch
 * commit writes only what changed.
 */
import type { DocRecord, IndexUnit } from './docIndex'
import type { DocIndexStore } from './indexer'

const DB_VERSION = 1

const request = <T,>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error ?? new Error('IndexedDB-Fehler'))
})

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB-Transaktion abgebrochen'))
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB-Fehler'))
})

export const docSearchDatabaseName = (vaultKey: string) => `fanotes-doc-search-${vaultKey}`

/** SHA-256 of the platform and vault location, so two vaults never share an index. */
export const vaultKeyFor = async (platform: string, vaultPath: string) => {
  const bytes = new TextEncoder().encode(`${platform}\n${vaultPath}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const openDocSearchStore = async (vaultKey: string, factory: IDBFactory = indexedDB): Promise<DocIndexStore & { close: () => void; destroy: () => Promise<void> }> => {
  const name = docSearchDatabaseName(vaultKey)
  const open = factory.open(name, DB_VERSION)
  open.onupgradeneeded = () => {
    const db = open.result
    for (const store of [...db.objectStoreNames]) db.deleteObjectStore(store)
    db.createObjectStore('docs', { keyPath: 'path' })
    const units = db.createObjectStore('units', { keyPath: 'id' })
    units.createIndex('path', 'path', { unique: false })
  }
  const db = await request(open)
  const removeUnitsIn = (tx: IDBTransaction, path: string) => new Promise<void>((resolve, reject) => {
    const cursor = tx.objectStore('units').index('path').openKeyCursor(IDBKeyRange.only(path))
    cursor.onsuccess = () => {
      const current = cursor.result
      if (!current) { resolve(); return }
      tx.objectStore('units').delete(current.primaryKey)
      current.continue()
    }
    cursor.onerror = () => reject(cursor.error)
  })
  return {
    load: async () => {
      const tx = db.transaction(['docs', 'units'], 'readonly')
      const [docs, units] = await Promise.all([
        request(tx.objectStore('docs').getAll() as IDBRequest<DocRecord[]>),
        request(tx.objectStore('units').getAll() as IDBRequest<IndexUnit[]>),
      ])
      return { docs, units }
    },
    saveDoc: async (doc) => {
      const tx = db.transaction('docs', 'readwrite')
      tx.objectStore('docs').put(doc)
      await done(tx)
    },
    addUnits: async (units) => {
      if (!units.length) return
      const tx = db.transaction('units', 'readwrite')
      const store = tx.objectStore('units')
      for (const unit of units) store.put(unit)
      await done(tx)
    },
    removeUnits: async (path) => {
      const tx = db.transaction('units', 'readwrite')
      await removeUnitsIn(tx, path)
      await done(tx)
    },
    removeDoc: async (path) => {
      const tx = db.transaction(['docs', 'units'], 'readwrite')
      tx.objectStore('docs').delete(path)
      await removeUnitsIn(tx, path)
      await done(tx)
    },
    clear: async () => {
      const tx = db.transaction(['docs', 'units'], 'readwrite')
      tx.objectStore('docs').clear()
      tx.objectStore('units').clear()
      await done(tx)
    },
    close: () => db.close(),
    destroy: async () => {
      db.close()
      await request(factory.deleteDatabase(name) as IDBRequest<unknown>).catch(() => undefined)
    },
  }
}

/** Deletes every document index on this device (used by "reset app data" flows). */
export const deleteAllDocSearchStores = async (factory: IDBFactory = indexedDB) => {
  const databases = typeof factory.databases === 'function' ? await factory.databases() : []
  await Promise.all(databases
    .map((database) => database.name)
    .filter((name): name is string => Boolean(name?.startsWith('fanotes-doc-search-')))
    .map((name) => request(factory.deleteDatabase(name) as IDBRequest<unknown>).catch(() => undefined)))
}
