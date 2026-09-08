import type { AddonsHostApi } from '../../types'
import { isAllowedAddonFetchUrl } from './registry'

// Web-mode backend for the add-on store. The site's CSP only allows same-origin
// connections, so GitHub requests go through two reverse-proxy paths
// (addons-registry/ -> raw.githubusercontent.com, addons-api/ -> api.github.com,
// see fanotes-site/deploy and vite.config.ts). Installed add-ons live in
// localStorage next to the other web-mode preferences.

const RECORDS_KEY = 'fanotes.addons.records.v1'
const FILE_PREFIX = 'fanotes.addons.file.v1:'
const DATA_PREFIX = 'fanotes.addons.data.v1:'
const MAX_TEXT_BYTES = 2_000_000

export const rewriteAddonUrlForProxy = (url: string, baseHref: string) => {
  const parsed = new URL(url)
  if (parsed.hostname === 'raw.githubusercontent.com') return new URL(`addons-registry${parsed.pathname}${parsed.search}`, baseHref).toString()
  if (parsed.hostname === 'api.github.com') return new URL(`addons-api${parsed.pathname}${parsed.search}`, baseHref).toString()
  return null
}

const readRecords = (): unknown[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeRecords = (records: unknown[]) => {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records))
}

const recordId = (record: unknown) => (typeof record === 'object' && record !== null && typeof (record as { id?: unknown }).id === 'string' ? (record as { id: string }).id : null)

const safeFileName = (name: string) => {
  if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(name) || name.includes('..')) throw new Error(`Ungültiger Dateiname: ${name}`)
  return name
}

const safeId = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) throw new Error(`Ungültige Add-on-ID: ${id}`)
  return id
}

export const createBrowserAddonsApi = (): AddonsHostApi => ({
  fetchText: async (url) => {
    if (!isAllowedAddonFetchUrl(url)) throw new Error('Nur GitHub-Adressen dürfen für Add-ons geladen werden.')
    const target = rewriteAddonUrlForProxy(url, document.baseURI) ?? url
    const response = await fetch(target, { headers: { Accept: 'application/vnd.github.raw+json, text/plain, application/json;q=0.9, */*;q=0.1' }, cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status} beim Laden von ${url}`)
    const text = await response.text()
    if (text.length > MAX_TEXT_BYTES) throw new Error('Die Datei ist größer als 2 MB.')
    return text
  },
  list: async () => readRecords(),
  save: async (record) => {
    const id = recordId(record)
    if (!id) throw new Error('Ungültiger Add-on-Eintrag.')
    const records = readRecords().filter((item) => recordId(item) !== id)
    records.push(record)
    writeRecords(records)
  },
  remove: async (id) => {
    safeId(id)
    writeRecords(readRecords().filter((item) => recordId(item) !== id))
    const doomed: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && (key.startsWith(`${FILE_PREFIX}${id}/`) || key === `${DATA_PREFIX}${id}`)) doomed.push(key)
    }
    doomed.forEach((key) => localStorage.removeItem(key))
  },
  readFile: async (id, name) => localStorage.getItem(`${FILE_PREFIX}${safeId(id)}/${safeFileName(name)}`),
  writeFiles: async (id, files) => {
    safeId(id)
    for (const [name, content] of Object.entries(files)) {
      if (typeof content !== 'string') continue
      if (content.length > MAX_TEXT_BYTES) throw new Error(`${name} ist zu groß für den Browser-Speicher.`)
      localStorage.setItem(`${FILE_PREFIX}${id}/${safeFileName(name)}`, content)
    }
  },
  readData: async (id) => localStorage.getItem(`${DATA_PREFIX}${safeId(id)}`),
  writeData: async (id, value) => {
    localStorage.setItem(`${DATA_PREFIX}${safeId(id)}`, value)
  },
})
