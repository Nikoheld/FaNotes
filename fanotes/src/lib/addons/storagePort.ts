import type { AddonsHostApi } from '../../types'
import { parseAddonManifest } from './manifest'
import { isAllowedAddonFetchUrl, type AddonFetchText } from './registry'
import type { AddonStoragePort, InstalledAddonRecord } from './runtime'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Re-validates a stored record; a corrupted addons.json entry is dropped instead of crashing the runtime. */
export const parseInstalledAddonRecord = (raw: unknown): InstalledAddonRecord | null => {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  const parsed = parseAddonManifest(raw.manifest)
  if (parsed.errors.length || parsed.manifest.id !== raw.id) return null
  const iso = (value: unknown) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : new Date(0).toISOString())
  return {
    id: raw.id,
    manifest: parsed.manifest,
    enabled: raw.enabled !== false,
    installedAt: iso(raw.installedAt),
    updatedAt: iso(raw.updatedAt),
    source: typeof raw.source === 'string' ? raw.source.slice(0, 500) : '',
    path: typeof raw.path === 'string' ? raw.path.slice(0, 300) : '',
    mainSha256: typeof raw.mainSha256 === 'string' && /^[a-f0-9]{64}$/u.test(raw.mainSha256) ? raw.mainSha256 : null,
    origin: raw.origin === 'local' ? 'local' : 'store',
  }
}

export const createAddonStoragePort = (api: AddonsHostApi): AddonStoragePort => ({
  list: async () => (await api.list()).map(parseInstalledAddonRecord).filter((record): record is InstalledAddonRecord => record !== null),
  save: (record) => api.save(record),
  remove: (id) => api.remove(id),
  readFile: (id, name) => api.readFile(id, name),
  writeFiles: (id, files) => api.writeFiles(id, files),
  readData: (id) => api.readData(id),
  writeData: (id, value) => api.writeData(id, value),
})

export const createAddonFetchText = (api: AddonsHostApi): AddonFetchText => async (url) => {
  if (!isAllowedAddonFetchUrl(url)) throw new Error(`Diese Adresse ist für Add-ons nicht erlaubt: ${url}`)
  return api.fetchText(url)
}
