// Desktop half of an editable share: folder, account or typed name, and the
// live document two people edit at once. Copy and live shares do not use this.
// The website paints the browser questions from public/share/share-link.js.
// This module is what FaNotes runs after fanotes://share/<id>.

import {
  shareApiUrl,
  type ShareInk,
  type SharePayload,
  type SharePort,
  type ShareTextField,
} from './share'

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

export type ShareEditClient = {
  id: string
  name: string
  documentText: () => string
  noteContent: (sharePath: string) => string
  peopleEditing: () => string[]
  peopleWhoCanEdit: () => string[]
  editNote: (sharePath: string, patch: { content?: string; ink?: ShareInk | null; textFields?: ShareTextField[] | null }) => Promise<void>
  pull: () => Promise<void>
  leave: () => Promise<void>
  owns: (path: string) => boolean
  sharePathFor: (path: string) => string
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
  let notes = cloneNotes(input.share.notes)
  let revision = Number.isInteger(input.share.revision) ? input.share.revision as number : 1
  let editors = editorNames(readJson(joined.body)?.editors)
  let present: string[] = []
  let left = false
  const vaultPaths = input.vaultPaths ?? {}

  const adopt = (body: Record<string, unknown> | null) => {
    if (!body) return
    if (Array.isArray(body.notes)) notes = cloneNotes(body.notes as ShareNoteSnapshot[])
    if (Number.isInteger(body.revision)) revision = body.revision as number
    if (body.editors) editors = editorNames(body.editors)
    if (Array.isArray(body.present)) present = editorNames(body.present.map((item) => (
      item && typeof item === 'object' ? (item as { name?: string }).name ?? '' : item
    )))
  }

  const push = async () => {
    const response = await input.port.exchange(postShare(input.share.id, 'edit', {
      clientId,
      name,
      baseRevision: revision,
      notes,
    }, input.origin))
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Die Änderung wurde nicht übernommen (${response.status}).`)
    }
    adopt(readJson(response.body))
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
    const remoteRevision = Number(body?.revision)
    if (!body || !Number.isInteger(remoteRevision)) return
    if (remoteRevision === revision) {
      adopt(body)
      return
    }
    const local = JSON.stringify(notes)
    const remote = JSON.stringify(body.notes ?? [])
    if (local === remote) {
      adopt(body)
      return
    }
    // Local notes differ. Send them against the revision we last had.
    // The server merges that base with the copy it has now.
    await push()
  }

  await input.port.exchange(postShare(input.share.id, 'presence', { clientId, name, present: true }, input.origin))
  await pull()

  return {
    id: clientId,
    name,
    documentText: () => notes.map((note) => note.content).join('\n'),
    noteContent: (sharePath: string) => notes.find((note) => note.path === sharePath)?.content ?? '',
    peopleEditing: () => present.filter((person) => !left || person !== name),
    peopleWhoCanEdit: () => editors.slice(),
    editNote: async (sharePath, patch) => {
      if (left) return
      const current = notes.find((note) => note.path === sharePath)
      if (!current) throw new Error('Diese Notiz ist nicht in der Freigabe.')
      notes = notes.map((note) => {
        if (note.path !== sharePath) return note
        const next = {
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
      await push()
    },
    pull,
    leave: async () => {
      left = true
      present = present.filter((person) => person !== name)
      await input.port.exchange(postShare(input.share.id, 'presence', { clientId, name, present: false }, input.origin))
    },
    sharePathFor: (path: string) => {
      if (notes.some((note) => note.path === path)) return path
      return vaultPaths[path] || ''
    },
    owns: (path: string) => notes.some((note) => note.path === path) || Boolean(vaultPaths[path]),
  }
}
