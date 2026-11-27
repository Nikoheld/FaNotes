// The note library of the vault: which files are notes, folders, sorting, search and the trash list.
import type { VaultBackend } from './backend'
import type { VaultEntry } from './client'
import { CALENDAR_NOTE_PATH, HOMEWORK_NOTE_PATH, textOf } from './files'
import { isListedUserFile } from './upload'
import { plainText } from '../lib/markdown'
import { readFamd } from '../lib/famd'

export type NoteKind = 'markdown' | 'famd' | 'pdf' | 'image' | 'audio' | 'video' | 'story' | 'other'

export interface LibNote { path: string; name: string; folder: string; kind: NoteKind; mtimeMs: number; size: number }

const EXTENSIONS: [NoteKind, string[]][] = [
  ['markdown', ['md', 'markdown']], ['famd', ['famd']], ['pdf', ['pdf']],
  ['image', ['png', 'jpg', 'jpeg', 'webp', 'gif']], ['audio', ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'aac', 'flac']], ['video', ['mp4', 'webm', 'mov', 'm4v', 'ogv']],
]
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
}

export const extensionOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()
export const mimeOf = (path: string) => MIME[extensionOf(path)] || 'application/octet-stream'
export const kindOf = (path: string): NoteKind => {
  if (path.toLowerCase().endsWith('.story')) return 'story'
  const extension = extensionOf(path)
  return EXTENSIONS.find(([, list]) => list.includes(extension))?.[0] ?? 'other'
}
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const titleOf = (path: string) => baseName(path).replace(/\.(md|markdown|famd|pdf|story)$/iu, '')
export const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const FAMD_SIBLINGS = ['.md', '.markdown', '.pdf']

const STORY_SEGMENT = /^(.*?\.story)(?:\/|$)/iu

/** What the library shows: the user's notes and files, stories as one entry; nothing internal, no task or calendar file. */
export const libraryNotes = (entries: VaultEntry[]): LibNote[] => {
  const stories = new Map<string, LibNote>()
  const out: LibNote[] = []
  for (const entry of entries) {
    const path = entry.path
    if (path.split('/').some((part) => part.startsWith('.')) || !isListedUserFile(path) || path === HOMEWORK_NOTE_PATH || path === CALENDAR_NOTE_PATH) continue
    const story = STORY_SEGMENT.exec(path)
    if (story) {
      const root = story[1]
      const known = stories.get(root)
      stories.set(root, { path: root, name: titleOf(root), folder: folderOf(root), kind: 'story', mtimeMs: Math.max(known?.mtimeMs ?? 0, entry.mtimeMs), size: (known?.size ?? 0) + entry.size })
      continue
    }
    out.push({ path, name: titleOf(path), folder: folderOf(path), kind: kindOf(path), mtimeMs: entry.mtimeMs, size: entry.size })
  }
  // A `.famd` next to prose or a PDF is that note's handwriting, not a second note (desktop `famdSiblingPaths`).
  const paths = new Set(entries.map((entry) => entry.path))
  const companion = (note: LibNote) => note.kind === 'famd'
    && FAMD_SIBLINGS.some((extension) => paths.has(note.path.replace(/\.famd$/iu, extension)))
  return [...out.filter((note) => !companion(note)), ...stories.values()]
}

export type NoteSort = 'recent' | 'name'
export const sortNotes = (notes: LibNote[], sort: NoteSort): LibNote[] =>
  [...notes].sort((a, b) => (sort === 'recent' ? b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'de') : a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })))

/** The folders directly below `folder` (all of them, also those that only hold subfolders) and the notes directly in it. */
export const folderContents = (notes: LibNote[], folder: string) => {
  const prefix = folder ? `${folder}/` : ''
  const folders = new Set<string>()
  const here: LibNote[] = []
  for (const note of notes) {
    if (note.folder === folder) here.push(note)
    else if (note.folder.startsWith(prefix)) folders.add(note.folder.slice(prefix.length).split('/')[0])
  }
  return { folders: [...folders].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' })), notes: here }
}

export const countIn = (notes: LibNote[], folder: string) => notes.filter((note) => note.folder === folder || note.folder.startsWith(`${folder}/`)).length

export interface SearchHit { note: LibNote; excerpt: string }

/** Title matches first, then text matches (when the text index has the note); excerpt around the first text match. */
export const searchNotes = (notes: LibNote[], query: string, texts: Map<string, string>): SearchHit[] => {
  const needle = query.trim().toLocaleLowerCase('de')
  if (needle.length < 2) return []
  const titleHits: SearchHit[] = []
  const textHits: SearchHit[] = []
  for (const note of notes) {
    const inTitle = `${note.folder}/${note.name}`.toLocaleLowerCase('de').includes(needle)
    const text = texts.get(note.path) || ''
    const at = text.toLocaleLowerCase('de').indexOf(needle)
    if (inTitle) titleHits.push({ note, excerpt: at >= 0 ? text.slice(Math.max(0, at - 40), at + needle.length + 80) : '' })
    else if (at >= 0) textHits.push({ note, excerpt: `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + needle.length + 80)}` })
  }
  return [...titleHits, ...textHits].slice(0, 100)
}

const MAX_INDEXED_BYTES = 400_000
const MAX_INDEXED_NOTES = 400

/** The searchable text of the notes (markdown and handwriting notes), read and decrypted one by one; cached by revision-free path. */
export const buildTextIndex = async (backend: VaultBackend, notes: LibNote[], into: Map<string, string>, isCancelled: () => boolean): Promise<void> => {
  const candidates = notes.filter((note) => (note.kind === 'markdown' || note.kind === 'famd') && note.size <= MAX_INDEXED_BYTES && !into.has(note.path)).slice(0, MAX_INDEXED_NOTES)
  for (let at = 0; at < candidates.length; at += 8) {
    if (isCancelled()) return
    await Promise.all(candidates.slice(at, at + 8).map(async (note) => {
      try {
        const text = textOf((await backend.read(note.path)).bytes) || ''
        into.set(note.path, plainText(note.kind === 'famd' ? readFamd(text).markdown : text))
      } catch { into.set(note.path, '') }
    }))
  }
}

export interface TrashItem { id: string; path: string; folder: boolean; deletedAt: string; name: string }

/** The app's trash index (`.fanotes/trash/index.json`), if it is in the vault. The app keeps its trash on the device, so this is usually empty. */
export const readTrash = async (backend: VaultBackend): Promise<TrashItem[]> => {
  try {
    const text = textOf((await backend.read('.fanotes/trash/index.json')).bytes)
    const root = text ? JSON.parse(text) as { items?: unknown } : null
    if (!root || !Array.isArray(root.items)) return []
    return root.items.flatMap((item): TrashItem[] => {
      const row = item as Record<string, unknown>
      return typeof row?.id === 'string' && typeof row.path === 'string'
        ? [{ id: row.id, path: row.path, folder: row.folder === true, deletedAt: typeof row.deletedAt === 'string' ? row.deletedAt : '', name: typeof row.name === 'string' && row.name ? row.name : titleOf(row.path) }]
        : []
    }).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  } catch { return [] }
}

/** Resolves a path written in a note (relative to the note, or from the vault root) to a file of the vault. */
export const resolveVaultPath = (written: string, from: string, known: Set<string>): string | null => {
  const clean = written.replace(/^\.\//u, '').replace(/^\/+/u, '')
  const base = folderOf(from)
  const candidates = [base ? `${base}/${clean}` : clean, clean]
  for (const candidate of candidates) {
    const parts: string[] = []
    for (const part of candidate.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part) }
    const normalized = parts.join('/')
    if (known.has(normalized)) return normalized
  }
  const name = baseName(clean).toLocaleLowerCase('de')
  for (const path of known) if (baseName(path).toLocaleLowerCase('de') === name) return path
  return null
}

/** A wiki link target ("Mechanik", "Physik/Mechanik") to a note path. */
export const resolveWikiLink = (target: string, notes: LibNote[]): LibNote | null => {
  const wanted = target.trim().replace(/\.md$/iu, '').toLocaleLowerCase('de')
  if (!wanted) return null
  return notes.find((note) => note.kind === 'markdown' && (note.path.replace(/\.md$/iu, '').toLocaleLowerCase('de') === wanted))
    || notes.find((note) => (note.kind === 'markdown' || note.kind === 'famd') && note.name.toLocaleLowerCase('de') === wanted) || null
}

export const bytesToDataUrl = (bytes: Uint8Array, mime: string): string => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return `data:${mime};base64,${btoa(binary)}`
}
