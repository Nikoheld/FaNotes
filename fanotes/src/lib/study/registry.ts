import { escapeHtml, type StudyKind } from './blocks'
import { defaultKeyData, normaliseKeyData, parseKeyData, type KeyData } from './keyTree'
import { defaultSortData, normaliseSortData, parseSortData, type SortData } from './sortBoard'
import { defaultMapData, normaliseMapData, parseMapData, type MapData } from './conceptMap'
import { defaultPlateData, defaultTermData, normalisePlateData, normaliseTermData, parsePlateData, parseTermData, type PlateData, type TermData } from './cardsModels'
import { defaultCryptoData, normaliseCryptoData, parseCryptoData, CRYPTO_KEYS, type CryptoData } from './crypto/model'
import { renderStudyHtml, type StudyAnyData } from './render'

export const parseStudyData = (kind: StudyKind, body: string): StudyAnyData => {
  switch (kind) {
    case 'key': return parseKeyData(body)
    case 'sort': return parseSortData(body)
    case 'map': return parseMapData(body)
    case 'plate': return parsePlateData(body)
    case 'term': return parseTermData(body)
    case 'crypto': return parseCryptoData(body)
  }
}

export const defaultStudyData = (kind: StudyKind): StudyAnyData => {
  switch (kind) {
    case 'key': return defaultKeyData()
    case 'sort': return defaultSortData()
    case 'map': return defaultMapData()
    case 'plate': return defaultPlateData()
    case 'term': return defaultTermData()
    case 'crypto': return defaultCryptoData()
  }
}

/**
 * What a block is allowed to hold, applied to the editor's working data: lists are cut at their caps, texts at
 * their lengths, dangling references and duplicates are removed. Writing anything else would leave a block that
 * `readStudyBlock` refuses on the next open, so every write goes through here first.
 */
export const normaliseStudyData = (kind: StudyKind, data: StudyAnyData): StudyAnyData => {
  switch (kind) {
    case 'key': return normaliseKeyData(data as KeyData)
    case 'sort': return normaliseSortData(data as SortData)
    case 'map': return normaliseMapData(data as MapData)
    case 'plate': return normalisePlateData(data as PlateData)
    case 'term': return normaliseTermData(data as TermData)
    case 'crypto': return normaliseCryptoData(data as CryptoData)
  }
}

const KNOWN_KEYS: Record<StudyKind, readonly string[]> = {
  key: ['v', 'title', 'table', 'tree', 'compareImage', 'compareLabel'],
  sort: ['v', 'title', 'mode', 'cards', 'groups'],
  map: ['v', 'title', 'dir', 'nodes', 'edges'],
  plate: ['v', 'title', 'cols', 'showLabels', 'items'],
  term: ['v', 'terms'],
  crypto: CRYPTO_KEYS,
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Describes the first place where `data` (the sanitised model) holds less than `raw` (what the note says):
 * a list that was cut, text that was shortened, a value that was replaced. Padding and generated ids are not loss.
 */
export const findLoss = (raw: unknown, data: unknown, path = ''): string | null => {
  if (Array.isArray(raw)) {
    if (!Array.isArray(data)) return path || 'Wert'
    if (raw.length > data.length) return `${path || 'Liste'} (${raw.length} Einträge, übernommen würden ${data.length})`
    const byId = data.length && data.every((entry) => isRecord(entry) && typeof entry.id === 'string')
    for (let index = 0; index < raw.length; index += 1) {
      const entry = raw[index]
      const other = byId && isRecord(entry) && typeof entry.id === 'string' ? data.find((candidate) => (candidate as { id: string }).id === entry.id) : data[index]
      if (other === undefined) return `${path}[${index}]`
      const loss = findLoss(entry, other, `${path}[${index}]`)
      if (loss) return loss
    }
    return null
  }
  if (isRecord(raw)) {
    if (!isRecord(data)) return path || 'Wert'
    for (const key of Object.keys(data)) {
      if (!(key in raw) || key === 'v') continue
      const loss = findLoss(raw[key], data[key], path ? `${path}.${key}` : key)
      if (loss) return loss
    }
    return null
  }
  if (typeof raw === 'string') return typeof data === 'string' && data === raw ? null : (path || 'Text')
  if (typeof raw === 'number') return data === raw || data === String(raw) ? null : (path || 'Zahl')
  if (typeof raw === 'boolean') return data === raw ? null : (path || 'Wert')
  return raw === null || raw === undefined ? null : (path || 'Wert')
}

export type StudyBlockRead =
  | { ok: true; data: StudyAnyData; extra: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Strict reading for anything that may write the block back. A block that does not parse, or that the
 * sanitiser would cut or rewrite, is reported instead of being replaced by a default or a shortened copy.
 */
export const readStudyBlock = (kind: StudyKind, body: string): StudyBlockRead => {
  if (!body.trim()) return { ok: true, data: defaultStudyData(kind), extra: {} }
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (error) {
    return { ok: false, error: `Der Block ist kein gültiges JSON (${error instanceof Error ? error.message : 'Syntaxfehler'}).` }
  }
  if (!isRecord(raw)) return { ok: false, error: 'Der Block muss ein JSON-Objekt sein.' }
  if (!Object.keys(raw).length) return { ok: true, data: defaultStudyData(kind), extra: {} }
  const data = parseStudyData(kind, body)
  const loss = findLoss(raw, data)
  if (loss) return { ok: false, error: `Der Block enthält Daten, die FaNotes nicht vollständig übernehmen würde: ${loss}. Bearbeite den Text direkt.` }
  const known = new Set(KNOWN_KEYS[kind])
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)))
  return { ok: true, data, extra }
}

/** Safe HTML for a block body, used by the editor widget and the preview. A block with a problem shows its source and the reason. */
export const renderStudyBlockHtml = (kind: StudyKind, body: string) => {
  const read = readStudyBlock(kind, body)
  if (!read.ok) return `<div class="lw-error" role="alert">${escapeHtml(read.error)}</div><pre class="lw-raw">${escapeHtml(body)}</pre>`
  return renderStudyHtml(kind, read.data)
}
