import type { Sample } from '../types'

const DB_NAME = 'glyphenwerk-db'
const DB_VERSION = 1
const STORE_NAME = 'samples'

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('labelId', 'labelId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Lokaler Speicher konnte nicht geöffnet werden.'))
  })

const runTransaction = async <T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = action(transaction.objectStore(STORE_NAME))

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
    transaction.onerror = () => {
      database.close()
      reject(transaction.error)
    }
  })
}

export const getAllSamples = async (): Promise<Sample[]> => {
  const samples = await runTransaction<Sample[]>('readonly', (store) => store.getAll())
  return samples.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export const putSample = (sample: Sample) =>
  runTransaction<IDBValidKey>('readwrite', (store) => store.put(sample))

export const removeSample = (id: string) =>
  runTransaction<undefined>('readwrite', (store) => store.delete(id))

export const removeAllSamples = () =>
  runTransaction<undefined>('readwrite', (store) => store.clear())
