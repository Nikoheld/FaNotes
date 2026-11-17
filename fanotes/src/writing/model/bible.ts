// The story bible: characters, places and timeline events, one JSON file per
// entry (`bible/characters/<id>.json`, `bible/places/<id>.json`,
// `bible/events/<id>.json`) so two devices editing different entries never
// touch the same file. Free-form fields keep the sheets flexible.
import { isId, newId } from './ids'

export const BIBLE_FORMAT = 'fanotes-story-bible-v1' as const
export type BibleKind = 'character' | 'place' | 'event'
export const BIBLE_FOLDERS: Record<BibleKind, string> = { character: 'characters', place: 'places', event: 'events' }

export type BibleField = { label: string; value: string }

export type BibleEntry = {
  format: typeof BIBLE_FORMAT
  kind: BibleKind
  id: string
  name: string
  /** Character: role in the story; place: what kind of place; event: unused. */
  role?: string
  /** Other names the entry is mentioned by (nicknames, short forms). */
  aliases?: string[]
  fields: BibleField[]
  notes?: string
  /** Hex colour for cards and chips. */
  color?: string
  /** Event: when it happens in story time, as the writer says it ("Tag 3, Morgen"). */
  when?: string
  /** Event: position on the timeline (sortable number). */
  order?: number
  /** Event: scenes, characters and places it involves. */
  scenes?: string[]
  characters?: string[]
  places?: string[]
  /** Removed by the writer: hidden, but kept on disk (stories never delete files). */
  archived?: true
  updatedAt: string
  updatedBy?: string
}

export const biblePath = (storyPath: string, kind: BibleKind, id: string) => `${storyPath}/bible/${BIBLE_FOLDERS[kind]}/${id}.json`

/** The kind and id of a story-relative file name, if it is a bible entry. */
export const bibleFileOf = (relative: string): { kind: BibleKind; id: string } | null => {
  const match = /^bible\/(characters|places|events)\/([0-9a-z]{6,40})\.json$/u.exec(relative)
  if (!match) return null
  const kind = (Object.entries(BIBLE_FOLDERS).find(([, folder]) => folder === match[1])?.[0] ?? null) as BibleKind | null
  return kind ? { kind, id: match[2] } : null
}

const DEFAULT_FIELDS: Record<BibleKind, Array<[string, string]>> = {
  character: [['Alter', 'Age'], ['Aussehen', 'Appearance'], ['Ziel', 'Goal'], ['Konflikt', 'Conflict'], ['Hintergrund', 'Backstory']],
  place: [['Lage', 'Location'], ['Atmosphäre', 'Atmosphere'], ['Bedeutung für die Geschichte', 'Role in the story']],
  event: [],
}

export const newBibleEntry = (kind: BibleKind, name: string, english: boolean, writer?: string, order?: number): BibleEntry => ({
  format: BIBLE_FORMAT,
  kind,
  id: newId(),
  name,
  fields: DEFAULT_FIELDS[kind].map(([de, en]) => ({ label: english ? en : de, value: '' })),
  ...(kind === 'event' ? { order: order ?? 0 } : {}),
  updatedAt: new Date().toISOString(),
  ...(writer ? { updatedBy: writer } : {}),
})

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\u0000/gu, '').slice(0, max) : '')
const ids = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter(isId))].slice(0, 500) : [])

export const sanitizeBibleEntry = (value: unknown): BibleEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (source.format !== BIBLE_FORMAT || !isId(source.id) || !['character', 'place', 'event'].includes(source.kind as string)) return null
  const entry: BibleEntry = {
    format: BIBLE_FORMAT,
    kind: source.kind as BibleKind,
    id: source.id,
    name: text(source.name, 300),
    fields: Array.isArray(source.fields)
      ? source.fields.slice(0, 100).flatMap((field) => (field && typeof field === 'object' ? [{ label: text((field as BibleField).label, 200), value: text((field as BibleField).value, 20_000) }] : []))
      : [],
    updatedAt: text(source.updatedAt, 40) || new Date(0).toISOString(),
  }
  const role = text(source.role, 300)
  if (role) entry.role = role
  const aliases = Array.isArray(source.aliases) ? [...new Set(source.aliases.map((alias) => text(alias, 200).trim()).filter(Boolean))].slice(0, 50) : []
  if (aliases.length) entry.aliases = aliases
  const notes = text(source.notes, 200_000)
  if (notes) entry.notes = notes
  if (typeof source.color === 'string' && /^#[0-9a-f]{6}$/iu.test(source.color)) entry.color = source.color
  const when = text(source.when, 300)
  if (when) entry.when = when
  if (typeof source.order === 'number' && Number.isFinite(source.order)) entry.order = source.order
  for (const key of ['scenes', 'characters', 'places'] as const) {
    const list = ids(source[key])
    if (list.length) entry[key] = list
  }
  if (source.archived === true) entry.archived = true
  const by = text(source.updatedBy, 80)
  if (by) entry.updatedBy = by
  return entry
}

export const serializeBibleEntry = (entry: BibleEntry) => `${JSON.stringify(entry, null, 2)}\n`

/** Names an entry is mentioned by, longest first (so "Anna Maria" wins over "Anna"). */
export const entryNames = (entry: BibleEntry) => [entry.name, ...(entry.aliases ?? [])].map((name) => name.trim()).filter((name) => name.length >= 2).sort((a, b) => b.length - a.length)

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** A matcher that finds whole-word mentions of an entry (case-sensitive for names, like a reader would). */
export const mentionPattern = (entry: BibleEntry) => {
  const names = entryNames(entry)
  return names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'u') : null
}
