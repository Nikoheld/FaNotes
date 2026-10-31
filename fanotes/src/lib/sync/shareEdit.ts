// Desktop half of an editable share: folder, account or typed name, and the
// live document two people edit at once. Copy and live shares do not use this.
// The website paints the browser questions from public/share/share-link.js.
// This module is what FaNotes runs after fanotes://share/<id>.

import type { NoteTextField } from '../noteTextField'
import {
  shareApiUrl,
  type ShareInk,
  type SharePayload,
  type SharePort,
  type ShareTextField,
} from './share'
import { mergeShareNotes } from './shareMerge.mjs'

export const SHARE_DESKTOP_PROMPTS = {
  folder: 'In welchem Ordner soll die geteilte Datei liegen?',
  identity: 'Konto anlegen oder nur einen Namen eintragen?',
  account: 'Konto anlegen',
  nameOnly: 'Nur einen Namen eintragen',
  canEdit: 'Personen, die bearbeiten können',
  editingNow: 'Gerade am Bearbeiten',
} as const

export const parseShareProtocol = (value: string) => {
  const match = /fanotes:\/\/share\/([a-f0-9]{32})/iu.exec(String(value || ''))
  return match ? match[1].toLowerCase() : ''
}

export type ShareEditorRecord = { name: string; account?: string }

export type PlacedShareFile = {
  relativePath: string
  sharePath: string
  title: string
  content: string
  ink?: ShareInk
  textFields?: ShareTextField[]
}

export type ShareOpenFolder = {
  step: 'folder'
  prompt: string
  share: SharePayload
  folders: string[]
}

export type ShareOpenIdentity = {
  step: 'identity'
  prompt: string
  share: SharePayload
  folder: string
  files: PlacedShareFile[]
}

export type ShareOpenState = ShareOpenFolder | ShareOpenIdentity

const normalizeFolder = (folder: string) => folder.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')

const safeFileName = (value: string) => {
  const cleaned = value.replace(/[\\/:*?"<>|]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80)
  return cleaned || 'Freigabe'
}

const joinVault = (folder: string, path: string) => {
  const root = normalizeFolder(folder)
  const note = path.replace(/\\/gu, '/').replace(/^\/+/u, '')
  return root ? `${root}/${note}` : note
}

/** The first screen after FaNotes opens an editable share. */
export const beginDesktopShareOpen = (share: SharePayload, folders: readonly string[]): ShareOpenFolder => {
  if (share.mode !== 'edit' || share.stopped) throw new Error('Diese Freigabe kann nicht bearbeitet werden.')
  const unique = [...new Set(folders.map((folder) => normalizeFolder(folder)))]
  return {
    step: 'folder',
    prompt: SHARE_DESKTOP_PROMPTS.folder,
    share,
    folders: unique,
  }
}

/** Place every shared note under the folder the person picked. */
export const chooseShareFolder = (state: ShareOpenFolder, folder: string): ShareOpenIdentity => {
  const picked = normalizeFolder(folder)
  if (!state.folders.includes(picked)) throw new Error('Dieser Ordner gehört nicht zum Vault.')
  const files = state.share.notes.map((note) => {
    const leaf = state.share.kind === 'folder'
      ? note.path
      : `${safeFileName(note.title || state.share.title)}.md`
    return {
      relativePath: joinVault(picked, leaf),
      sharePath: note.path,
      title: note.title,
      content: note.content,
      ...(note.ink ? { ink: note.ink } : {}),
      ...(note.textFields?.length ? { textFields: note.textFields } : {}),
    }
  })
  return {
    step: 'identity',
    prompt: SHARE_DESKTOP_PROMPTS.identity,
    share: state.share,
    folder: picked,
    files,
  }
}

export const editorNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    const name = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
        ? (entry as { name: string }).name
        : ''
    const trimmed = name.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
    if (!trimmed || names.includes(trimmed)) continue
    names.push(trimmed)
    if (names.length >= 80) break
  }
  return names
}

const postShare = (id: string, action: string, body: unknown, origin: string): ShareHttpRequestLike => ({
  method: 'POST',
  url: `${shareApiUrl(id, origin)}/${action}`,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FaNotes-Share': '1' },
  body: JSON.stringify(body),
})

type ShareHttpRequestLike = {
  method: 'PUT' | 'GET' | 'DELETE' | 'POST'
  url: string
  headers: Record<string, string>
  body: string
}

const readJson = (body: string) => {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

export type ShareIdentityChoice = { kind: 'account' | 'name'; name: string }

/**
 * Record the account or the typed name on the share.
 * `claim` runs only for an account, and the name it returns is the one the sharer sees.
 */
export async function confirmShareIdentity(input: {
  state: ShareOpenIdentity
  choice: ShareIdentityChoice
  port: SharePort
  origin: string
  claim?: (name: string) => Promise<string>
}): Promise<{ name: string; account?: string; editors: string[] }> {
  const typed = input.choice.name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80)
  if (!typed) throw new Error('Der Name fehlt.')
  const claimed = input.choice.kind === 'account' && input.claim ? (await input.claim(typed)).trim() : typed
  if (!claimed) throw new Error('Der Name fehlt.')
  const identity = input.choice.kind === 'account'
    ? { name: claimed, account: claimed }
    : { name: claimed }
  const response = await input.port.exchange(postShare(input.state.share.id, 'join', identity, input.origin))
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Die Freigabe konnte nicht bearbeitet werden (${response.status}).`)
  }
  const listed = editorNames(readJson(response.body)?.editors)
  if (!listed.includes(identity.name)) throw new Error('Der Name wurde nicht gespeichert.')
  return { ...identity, editors: listed }
}

type ShareNoteSnapshot = SharePayload['notes'][number]

export type ShareEditPatch = {
  content?: string
  ink?: ShareInk | null
  textFields?: ShareTextField[] | null
}

export type ShareEditLayers = {
  content?: boolean
  ink?: boolean
  textFields?: boolean
}

export type ShareEditClient = {
  id: string
  name: string
  documentText: () => string
  noteContent: (sharePath: string) => string
  noteInk: (sharePath: string) => ShareInk | undefined
  noteFields: (sharePath: string) => ShareTextField[]
  hasNote: (sharePath: string) => boolean
  peopleEditing: () => string[]
  peopleWhoCanEdit: () => string[]
  prepareLocalEdit: (sharePath: string, patch: ShareEditPatch) => ShareNoteSnapshot
  editNote: (sharePath: string, patch: ShareEditPatch) => Promise<void>
  absorb: (sharePath: string, layers: ShareEditLayers) => void
  pull: () => Promise<void>
  leave: () => Promise<void>
  owns: (path: string) => boolean
  sharePathFor: (path: string) => string
}

const shareFieldKey = (field: { page?: number; x?: number; y?: number }) => [
  field.page ?? 1,
  Math.round((Number(field.x) || 0) * 1000),
  Math.round((Number(field.y) || 0) * 1000),
].join('-')

/** Remote markdown for a clean editor. A dirty buffer stays local so the save can merge it. */
export const remoteTextForEditor = (editorText: string, remoteText: string, dirty: boolean): string | null => {
  if (dirty) return null
  if (editorText === remoteText) return null
  return remoteText
}

/** Fold remote text fields into the open note. Matching positions keep their local id. */
export const applyRemoteTextFields = (
  local: readonly NoteTextField[],
  remote: readonly ShareTextField[],
): NoteTextField[] => {
  const localByKey = new Map<string, NoteTextField>()
  for (const field of local) localByKey.set(shareFieldKey(field), field)
  return remote.slice(0, 200).map((field) => {
    const key = shareFieldKey(field)
    const existing = localByKey.get(key)
    return {
      id: existing?.id ?? `tf-remote-${key}`,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      fontSize: field.fontSize,
      text: field.text,
    }
  })
}

const cloneNotes = (notes: readonly ShareNoteSnapshot[]): ShareNoteSnapshot[] => notes.map((note) => ({
  path: note.path,
  title: note.title,
  content: note.content,
  ...(note.ink ? { ink: note.ink } : {}),
  ...(note.textFields?.length ? { textFields: note.textFields } : {}),
  ...(note.textColumn ? { textColumn: note.textColumn } : {}),
}))

/** Open the saved share as one person. Later edits land in `documentText` without reloading the share. */
export async function openShareEditor(input: {
  share: SharePayload
  name: string
  port: SharePort
  origin: string
  clientId?: string
  vaultPaths?: Readonly<Record<string, string>>
}): Promise<ShareEditClient> {
  if (input.share.mode !== 'edit' || input.share.stopped) throw new Error('Diese Freigabe kann nicht bearbeitet werden.')
  const name = input.name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80)
  if (!name) throw new Error('Der Name fehlt.')
  const clientId = input.clientId || `c${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const joined = await input.port.exchange(postShare(input.share.id, 'join', { name }, input.origin))
  if (joined.status < 200 || joined.status >= 300) throw new Error(`Die Freigabe konnte nicht bearbeitet werden (${joined.status}).`)
  let basis = cloneNotes(input.share.notes)
  let remote = cloneNotes(input.share.notes)
  let basisRevision = Number.isInteger(input.share.revision) ? input.share.revision as number : 1
  let remoteRevision = basisRevision
  let editors = editorNames(readJson(joined.body)?.editors)
  let present: string[] = []
  let left = false
  let editChain: Promise<unknown> = Promise.resolve()
  const vaultPaths = input.vaultPaths ?? {}

  const adoptRemote = (body: Record<string, unknown> | null) => {
    if (!body) return
    if (Array.isArray(body.notes)) remote = cloneNotes(body.notes as ShareNoteSnapshot[])
    if (Number.isInteger(body.revision)) remoteRevision = body.revision as number
    if (body.editors) editors = editorNames(body.editors)
    if (Array.isArray(body.present)) present = editorNames(body.present.map((item) => (
      item && typeof item === 'object' ? (item as { name?: string }).name ?? '' : item
    )))
  }

  const syncBasisRevision = () => {
    if (JSON.stringify(basis) === JSON.stringify(remote)) basisRevision = remoteRevision
  }

  const shown = (sharePath: string) => (
    remote.find((note) => note.path === sharePath) ?? basis.find((note) => note.path === sharePath)
  )

  const applyPatch = (notes: readonly ShareNoteSnapshot[], sharePath: string, patch: ShareEditPatch) => {
    if (!notes.some((note) => note.path === sharePath)) throw new Error('Diese Notiz ist nicht in der Freigabe.')
    return notes.map((note) => {
      if (note.path !== sharePath) return note
      const next: ShareNoteSnapshot = {
        ...note,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
      }
      if (patch.ink !== undefined) {
        if (patch.ink) next.ink = patch.ink
        else delete next.ink
      }
      if (patch.textFields !== undefined) {
        if (patch.textFields?.length) next.textFields = patch.textFields
        else delete next.textFields
      }
      return next
    })
  }

  const mergedNote = (sharePath: string, patch: ShareEditPatch) => {
    const baseSnapshot = cloneNotes(basis)
    const local = applyPatch(baseSnapshot, sharePath, patch)
    const merged = mergeShareNotes(baseSnapshot, remote, local)
    const note = merged.find((item) => item.path === sharePath)
    if (!note) throw new Error('Diese Notiz ist nicht in der Freigabe.')
    return { baseSnapshot, local, merged, note }
  }

  const commitEdit = async (sharePath: string, patch: ShareEditPatch) => {
    if (left) return
    const { baseSnapshot, local, merged } = mergedNote(sharePath, patch)
    const response = await input.port.exchange(postShare(input.share.id, 'edit', {
      clientId,
      name,
      baseRevision: basisRevision,
      baseNotes: baseSnapshot,
      notes: merged,
    }, input.origin))
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Die Änderung wurde nicht übernommen (${response.status}).`)
    }
    adoptRemote(readJson(response.body))
    basis = local
    syncBasisRevision()
  }

  const prepareLocalEdit = (sharePath: string, patch: ShareEditPatch) => mergedNote(sharePath, patch).note

  const editNote = (sharePath: string, patch: ShareEditPatch) => {
    const run = editChain.then(() => commitEdit(sharePath, patch))
    editChain = run.then(() => undefined, () => undefined)
    return run
  }

  const absorb = (sharePath: string, layers: ShareEditLayers) => {
    const remoteNote = remote.find((note) => note.path === sharePath)
    if (!remoteNote) return
    const existing = basis.find((note) => note.path === sharePath)
    const next: ShareNoteSnapshot = existing ? { ...existing } : {
      path: remoteNote.path,
      title: remoteNote.title,
      content: remoteNote.content,
    }
    if (layers.content) {
      next.title = remoteNote.title
      next.content = remoteNote.content
    }
    if (layers.ink) {
      if (remoteNote.ink) next.ink = remoteNote.ink
      else delete next.ink
    }
    if (layers.textFields) {
      if (remoteNote.textFields?.length) next.textFields = remoteNote.textFields
      else delete next.textFields
    }
    basis = basis.some((note) => note.path === sharePath)
      ? basis.map((note) => note.path === sharePath ? next : note)
      : [...basis, next]
    syncBasisRevision()
  }

  const pull = async () => {
    if (left) return
    const response = await input.port.exchange({
      method: 'GET',
      url: `${shareApiUrl(input.share.id, input.origin)}/session`,
      headers: { Accept: 'application/json', 'X-FaNotes-Share': '1' },
      body: '',
    })
    if (response.status < 200 || response.status >= 300) return
    const body = readJson(response.body)
    const seen = Number(body?.revision)
    if (!body || !Number.isInteger(seen) || seen < remoteRevision) return
    adoptRemote(body)
  }

  await input.port.exchange(postShare(input.share.id, 'presence', { clientId, name, present: true }, input.origin))
  await pull()

  return {
    id: clientId,
    name,
    documentText: () => remote.map((note) => note.content).join('\n'),
    noteContent: (sharePath: string) => shown(sharePath)?.content ?? '',
    noteInk: (sharePath: string) => shown(sharePath)?.ink,
    noteFields: (sharePath: string) => (shown(sharePath)?.textFields ?? []).map((field) => ({ ...field })),
    hasNote: (sharePath: string) => basis.some((note) => note.path === sharePath) || remote.some((note) => note.path === sharePath),
    peopleEditing: () => present.filter((person) => !left || person !== name),
    peopleWhoCanEdit: () => editors.slice(),
    prepareLocalEdit,
    editNote,
    absorb,
    pull,
    leave: async () => {
      left = true
      present = present.filter((person) => person !== name)
      await input.port.exchange(postShare(input.share.id, 'presence', { clientId, name, present: false }, input.origin))
    },
    sharePathFor: (path: string) => {
      if (basis.some((note) => note.path === path) || remote.some((note) => note.path === path)) return path
      return vaultPaths[path] || ''
    },
    owns: (path: string) => basis.some((note) => note.path === path) || remote.some((note) => note.path === path) || Boolean(vaultPaths[path]),
  }
}
