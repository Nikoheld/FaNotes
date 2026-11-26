/**
 * Whether any trained letters are stored, without loading the handwriting module (and its zip code) and without
 * creating the database: only an existing store is opened, read-only, and counted.
 */
export const hasTrainedSamples = async (): Promise<boolean> => {
  try {
    const known = await indexedDB.databases?.()
    if (!known?.some((entry) => entry.name === 'fanotes-handwriting')) return false
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fanotes-handwriting')
      request.onupgradeneeded = () => { request.transaction?.abort() }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!database.objectStoreNames.contains('samples')) return false
      const transaction = database.transaction('samples', 'readonly')
      return await new Promise<boolean>((resolve, reject) => {
        const request = transaction.objectStore('samples').count()
        request.onsuccess = () => resolve(request.result > 0)
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  } catch {
    return false
  }
}
