/** Remembers per document whether it was last used in pen or keyboard mode. */
const STORAGE_KEY = 'fanotes.docInputMode.v1'
const MAX_ENTRIES = 2000

const readAll = (): Record<string, boolean> => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** true = pen, false = keyboard, undefined = never recorded. */
export const readDocInputMode = (path: string): boolean | undefined => {
  const value = readAll()[path]
  return typeof value === 'boolean' ? value : undefined
}

export const writeDocInputMode = (path: string, pen: boolean) => {
  try {
    const all = readAll()
    if (all[path] === pen) return
    delete all[path]
    all[path] = pen
    const keys = Object.keys(all)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[key]
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage unavailable: the mode simply is not remembered.
  }
}
