const DB_NAME = 'lernwerk-notes-handwriting'
const DB_VERSION = 1
const SAMPLE_STORE = 'samples'
const LAYOUT_STORE = 'layoutExamples'
const LABEL_STORE = 'labels'

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (!('indexedDB' in globalThis)) {
    reject(new Error('IndexedDB ist in dieser Umgebung nicht verfügbar.'))
    return
  }

  const request = indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(SAMPLE_STORE)) {
      const samples = database.createObjectStore(SAMPLE_STORE, { keyPath: 'id' })
      samples.createIndex('labelId', 'labelId', { unique: false })
      samples.createIndex('createdAt', 'createdAt', { unique: false })
    }
    if (!database.objectStoreNames.contains(LAYOUT_STORE)) {
      const layouts = database.createObjectStore(LAYOUT_STORE, { keyPath: 'id' })
      layouts.createIndex('anchorLabelId', 'anchorLabelId', { unique: false })
      layouts.createIndex('createdAt', 'createdAt', { unique: false })
    }
    if (!database.objectStoreNames.contains(LABEL_STORE)) {
      database.createObjectStore(LABEL_STORE, { keyPath: 'id' })
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Der lokale Handschriftspeicher konnte nicht geöffnet werden.'))
})

export const getHandwritingTrainingSampleCount = async (): Promise<number> => {
  const database = await openDatabase()
  try {
    if (!database.objectStoreNames.contains(SAMPLE_STORE)) return 0
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(SAMPLE_STORE, 'readonly')
      const request = transaction.objectStore(SAMPLE_STORE).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Trainingsanzahl konnte nicht gelesen werden.'))
    })
  } finally {
    database.close()
  }
}
