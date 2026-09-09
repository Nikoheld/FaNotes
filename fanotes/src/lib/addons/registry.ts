import {
  ADDON_ICON_FILE,
  ADDON_MAIN_FILE,
  ADDON_MANIFEST_FILE,
  ADDON_README_FILE,
  parseAddonManifest,
  type AddonManifest,
} from './manifest'

// The registry is a plain GitHub repository. FaNotes never needs a release to
// learn about new add-ons: it reads index.json (written by the repository's
// CI on every merge) and falls back to listing the addons/ folder through the
// GitHub contents API when the index is missing or stale.

export const DEFAULT_ADDON_SOURCE = 'Nikoheld/FaNotes-Addons#main'
export const ADDON_INDEX_FILE = 'index.json'
export const ADDON_INDEX_SCHEMA = 1
export const ADDONS_FOLDER = 'addons'

export const ADDON_ALLOWED_FETCH_HOSTS = ['raw.githubusercontent.com', 'api.github.com', 'github.com', 'objects.githubusercontent.com'] as const

export type AddonSource = {
  kind: 'github'
  owner: string
  repo: string
  branch: string
  label: string
  repoUrl: string
  rawBase: string
  indexUrl: string
} | {
  kind: 'url'
  label: string
  indexUrl: string
  rawBase: string
  repoUrl: string | null
}

const GITHUB_SLUG = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})(?:#([A-Za-z0-9_./-]{1,120}))?$/u

export const parseAddonSource = (input: string | undefined | null): AddonSource => {
  const text = (input ?? '').trim() || DEFAULT_ADDON_SOURCE
  if (/^https:\/\//iu.test(text)) {
    const indexUrl = text.replace(/\/+$/u, '').endsWith(ADDON_INDEX_FILE) ? text : `${text.replace(/\/+$/u, '')}/${ADDON_INDEX_FILE}`
    const rawBase = indexUrl.slice(0, indexUrl.length - ADDON_INDEX_FILE.length).replace(/\/+$/u, '')
    let repoUrl: string | null = null
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//u.exec(`${rawBase}/`)
    if (raw) repoUrl = `https://github.com/${raw[1]}/${raw[2]}/tree/${raw[3]}`
    return { kind: 'url', label: rawBase, indexUrl, rawBase, repoUrl }
  }
  const match = GITHUB_SLUG.exec(text) ?? GITHUB_SLUG.exec(DEFAULT_ADDON_SOURCE)!
  const owner = match[1]
  const repo = match[2].replace(/\.git$/u, '')
  const branch = match[3] || 'main'
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`
  return {
    kind: 'github',
    owner,
    repo,
    branch,
    label: `${owner}/${repo}${branch === 'main' ? '' : `#${branch}`}`,
    repoUrl: `https://github.com/${owner}/${repo}`,
    rawBase,
    indexUrl: `${rawBase}/${ADDON_INDEX_FILE}`,
  }
}

export const isAllowedAddonFetchUrl = (url: string) => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    return (ADDON_ALLOWED_FETCH_HOSTS as readonly string[]).includes(parsed.hostname)
  } catch {
    return false
  }
}

export type AddonFileInfo = { size: number; sha256?: string }

export type AddonIndexEntry = {
  manifest: AddonManifest
  path: string
  mainUrl: string
  readmeUrl: string
  manifestUrl: string
  iconUrl: string | null
  pageUrl: string | null
  files: Partial<Record<string, AddonFileInfo>>
  updatedAt: string | null
}

export type AddonIndex = {
  schema: number
  generatedAt: string | null
  source: AddonSource
  entries: AddonIndexEntry[]
  problems: string[]
  origin: 'index' | 'listing'
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const addonFileUrl = (source: AddonSource, addonPath: string, file: string) => `${source.rawBase}/${addonPath.replace(/^\/+|\/+$/gu, '')}/${file}`

export const addonPageUrl = (source: AddonSource, addonPath: string) => {
  if (source.kind !== 'github') return source.repoUrl ? `${source.repoUrl}/${addonPath}` : null
  return `${source.repoUrl}/tree/${source.branch}/${addonPath}`
}

const buildEntry = (source: AddonSource, manifest: AddonManifest, path: string, files: Partial<Record<string, AddonFileInfo>>, updatedAt: string | null): AddonIndexEntry => ({
  manifest,
  path,
  mainUrl: addonFileUrl(source, path, ADDON_MAIN_FILE),
  readmeUrl: addonFileUrl(source, path, ADDON_README_FILE),
  manifestUrl: addonFileUrl(source, path, ADDON_MANIFEST_FILE),
  iconUrl: manifest.icon ? addonFileUrl(source, path, ADDON_ICON_FILE) : null,
  pageUrl: addonPageUrl(source, path),
  files,
  updatedAt,
})

const parseFiles = (raw: unknown): Partial<Record<string, AddonFileInfo>> => {
  if (!isRecord(raw)) return {}
  const files: Partial<Record<string, AddonFileInfo>> = {}
  for (const [name, info] of Object.entries(raw)) {
    if (!isRecord(info)) continue
    const size = typeof info.size === 'number' && Number.isFinite(info.size) ? Math.max(0, Math.floor(info.size)) : 0
    const sha256 = typeof info.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(info.sha256) ? info.sha256.toLowerCase() : undefined
    files[name] = { size, sha256 }
  }
  return files
}

/** Parses index.json written by the registry CI. Invalid entries are reported, never thrown. */
export const parseAddonIndex = (raw: unknown, source: AddonSource): AddonIndex => {
  const problems: string[] = []
  const entries: AddonIndexEntry[] = []
  const root = isRecord(raw) ? raw : {}
  if (!isRecord(raw)) problems.push('index.json ist kein JSON-Objekt.')
  const schema = typeof root.schema === 'number' ? root.schema : ADDON_INDEX_SCHEMA
  if (schema !== ADDON_INDEX_SCHEMA) problems.push(`index.json nutzt Schema ${schema}; diese FaNotes-Version versteht Schema ${ADDON_INDEX_SCHEMA}.`)
  const list = Array.isArray(root.addons) ? root.addons : []
  const seen = new Set<string>()
  for (const item of list.slice(0, 500)) {
    if (!isRecord(item)) continue
    const parsed = parseAddonManifest(item)
    if (parsed.errors.length) {
      problems.push(`${parsed.manifest.id || '?'}: ${parsed.errors[0]}`)
      continue
    }
    if (seen.has(parsed.manifest.id)) {
      problems.push(`${parsed.manifest.id}: doppelter Eintrag.`)
      continue
    }
    seen.add(parsed.manifest.id)
    const path = typeof item.path === 'string' && /^[A-Za-z0-9_./-]{1,200}$/u.test(item.path) && !item.path.includes('..')
      ? item.path.replace(/^\/+|\/+$/gu, '')
      : `${ADDONS_FOLDER}/${parsed.manifest.id}`
    const updatedAt = typeof item.updatedAt === 'string' && !Number.isNaN(Date.parse(item.updatedAt)) ? item.updatedAt : null
    entries.push(buildEntry(source, parsed.manifest, path, parseFiles(item.files), updatedAt))
  }
  entries.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, 'de'))
  return {
    schema,
    generatedAt: typeof root.generatedAt === 'string' ? root.generatedAt : null,
    source,
    entries,
    problems,
    origin: 'index',
  }
}

export type AddonFetchText = (url: string) => Promise<string>

/**
 * Lists addons/ through the GitHub contents API and reads every manifest.
 * Used when index.json does not exist yet (fresh repository) or is broken, so
 * a merged pull request shows up even before the indexing workflow ran.
 */
export const listAddonsFromGitHub = async (source: AddonSource, fetchText: AddonFetchText): Promise<AddonIndex> => {
  if (source.kind !== 'github') return { schema: ADDON_INDEX_SCHEMA, generatedAt: null, source, entries: [], problems: ['Für diese Quelle gibt es keine Ordner-Auflistung.'], origin: 'listing' }
  const listingUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${ADDONS_FOLDER}?ref=${encodeURIComponent(source.branch)}`
  const problems: string[] = []
  let listing: unknown
  try {
    listing = JSON.parse(await fetchText(listingUrl))
  } catch (error) {
    return { schema: ADDON_INDEX_SCHEMA, generatedAt: null, source, entries: [], problems: [`Ordner-Auflistung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`], origin: 'listing' }
  }
  const folders = Array.isArray(listing)
    ? listing.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'dir' && typeof item.name === 'string').slice(0, 200)
    : []
  const results = await Promise.all(folders.map(async (folder) => {
    const name = String(folder.name)
    const path = `${ADDONS_FOLDER}/${name}`
    try {
      const raw = JSON.parse(await fetchText(addonFileUrl(source, path, ADDON_MANIFEST_FILE)))
      const parsed = parseAddonManifest(raw, { expectedId: name })
      if (parsed.errors.length) {
        problems.push(`${name}: ${parsed.errors[0]}`)
        return null
      }
      return buildEntry(source, parsed.manifest, path, {}, null)
    } catch (error) {
      problems.push(`${name}: manifest.json konnte nicht gelesen werden (${error instanceof Error ? error.message : String(error)}).`)
      return null
    }
  }))
  const entries = results.filter((entry): entry is AddonIndexEntry => entry !== null)
  entries.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, 'de'))
  return { schema: ADDON_INDEX_SCHEMA, generatedAt: null, source, entries, problems, origin: 'listing' }
}

export const fetchAddonIndex = async (source: AddonSource, fetchText: AddonFetchText): Promise<AddonIndex> => {
  let indexProblem: string | null = null
  try {
    const parsed = parseAddonIndex(JSON.parse(await fetchText(source.indexUrl)), source)
    if (parsed.entries.length || source.kind !== 'github') return parsed
    indexProblem = parsed.problems[0] ?? null
  } catch (error) {
    indexProblem = error instanceof Error ? error.message : String(error)
  }
  const listing = await listAddonsFromGitHub(source, fetchText)
  if (indexProblem && !listing.entries.length) listing.problems.unshift(`index.json: ${indexProblem}`)
  return listing
}

export const searchAddonEntries = (entries: AddonIndexEntry[], query: string, category: string | null) => {
  const needle = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (category && !entry.manifest.categories.includes(category as AddonManifest['categories'][number])) return false
    if (!needle) return true
    const haystack = [entry.manifest.id, entry.manifest.name, entry.manifest.description, entry.manifest.author.name, ...entry.manifest.keywords, ...entry.manifest.categories]
      .join(' ')
      .toLowerCase()
    return needle.split(/\s+/u).every((word) => haystack.includes(word))
  })
}

export const sha256Hex = async (text: string) => {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
