/** Folders the user keeps on this device. The rest of the vault still syncs. */

export const RECOGNITION_MODEL_SYNC_PATH = '.fanotes/recognition-model.json'

const cleanPrefix = (value: string) => value
  .replace(/\\/gu, '/')
  .replace(/^\/+/u, '')
  .replace(/\/+$/u, '')
  .trim()

/** Newline- or comma-separated vault folders, such as `Physik/Buch`. */
export const syncPrefixesFromSetting = (value: unknown): string[] => {
  if (typeof value !== 'string') return []
  const seen = new Set<string>()
  for (const part of value.split(/[\n,]/u)) {
    const prefix = cleanPrefix(part)
    if (!prefix || prefix.length > 480 || prefix.split('/').some((segment) => !segment || segment === '.' || segment === '..')) continue
    seen.add(prefix)
  }
  return [...seen].slice(0, 80)
}

export const pathIsSyncExcluded = (path: string, prefixes: readonly string[]) => {
  const normalized = path.replace(/\\/gu, '/')
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

export const toggleSyncPrefix = (value: string, folder: string) => {
  const prefixes = syncPrefixesFromSetting(value)
  const next = cleanPrefix(folder)
  if (!next) return prefixes.join('\n')
  const without = prefixes.filter((prefix) => prefix !== next)
  const list = without.length === prefixes.length ? [...without, next] : without
  return list.join('\n')
}
