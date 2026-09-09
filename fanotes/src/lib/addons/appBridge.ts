import type { AppSettings, SearchHit, VaultEntry } from '../../types'
import { readPageStatsFromNote, stripFamdPayload } from '../famd'
import { AddonApiError } from './protocol'
import type { AddonHostBridge, AddonNetResponse, AddonNoteSummary } from './runtime'

// Glue between App.tsx and the add-on runtime. App hands over a small set of
// getters/actions (backed by refs so the bridge never goes stale) and this
// module shapes them into the AddonHostBridge the runtime validates against.
// Secrets never cross this boundary: settings.read() returns an explicit
// allow-list of display preferences only.

export type AppAddonDeps = {
  appVersion: string
  platform: string
  web: boolean
  language: () => string
  tree: () => VaultEntry[]
  activePath: () => string | null
  activeKind: () => string
  noteContent: (path: string) => string | null
  updateOpenNote: (path: string, content: string) => boolean
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<unknown>
  createNote: (folder: string | undefined, name: string | undefined) => Promise<string>
  openNote: (path: string) => Promise<unknown>
  search: (query: string) => Promise<SearchHit[]>
  createFolder: (parent: string | undefined, name: string | undefined) => Promise<string>
  renameEntry: (path: string, name: string) => Promise<string>
  moveEntry: (path: string, folder: string) => Promise<string>
  trashEntry: (path: string) => Promise<void>
  refreshTree: () => Promise<unknown>
  editor: AddonHostBridge['editor']
  readInk: (path: string) => Promise<unknown>
  pageStats: (path: string) => unknown | null
  settings: () => AppSettings
  writeClipboard: (text: string) => Promise<void>
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<AddonNetResponse>
  toast: (message: string, kind: 'info' | 'success' | 'error') => void
  confirm: (message: string, options: { title?: string; confirmLabel?: string }) => Promise<boolean>
  prompt: (message: string, options: { title?: string; placeholder?: string; value?: string; multiline?: boolean }) => Promise<string | null>
  openExternal: (url: string) => Promise<void>
  paletteActions: () => Array<{ id: string; label: string; group: string; run: () => void }>
}

const fileName = (path: string) => path.split('/').pop() ?? path
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')
const noteTitle = (path: string) => fileName(path).replace(/\.(md|markdown|pdf)$/iu, '')

const isNotePath = (path: string) => /\.(md|markdown|pdf)$/iu.test(path)

export const flattenNoteTree = (entries: VaultEntry[]): AddonNoteSummary[] => {
  const notes: AddonNoteSummary[] = []
  const walk = (nodes: VaultEntry[]) => {
    for (const node of nodes) {
      if (node.kind === 'file' && isNotePath(node.relativePath)) {
        notes.push({ path: node.relativePath, title: noteTitle(node.relativePath), folder: parentPath(node.relativePath), modifiedAt: node.modifiedAt ?? null, size: typeof node.size === 'number' ? node.size : null })
      }
      if (node.children) walk(node.children)
    }
  }
  walk(entries)
  return notes
}

const SAFE_SETTING_KEYS = [
  'uiLanguage', 'theme', 'workspaceBackground', 'accent', 'accentSecondary', 'uiFont', 'editorFont', 'editorFontSize', 'previewFontSize',
  'lineHeight', 'readableLineLength', 'contentWidth', 'showLineNumbers', 'spellcheck', 'autocorrect', 'vimMode', 'autosaveDelay',
  'compactMode', 'glassEffects', 'reduceMotion', 'showWordCount', 'showOutline', 'defaultFolder', 'dailyNotesFolder', 'paperStyle',
  'viewZoomMax', 'viewZoomSpeed', 'penOnly', 'inkSmoothing',
] as const

/** Only display preferences; API keys, passwords, remote-support and vault paths are never exposed. */
export const safeSettingsView = (settings: AppSettings): Record<string, unknown> => {
  const view: Record<string, unknown> = {}
  const record = settings as unknown as Record<string, unknown>
  for (const key of SAFE_SETTING_KEYS) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') view[key] = value
  }
  return view
}

export const stripTreeForAddons = (entries: VaultEntry[]): unknown => entries.map((entry) => ({
  name: entry.name,
  path: entry.relativePath,
  kind: entry.kind,
  extension: entry.extension,
  modifiedAt: entry.modifiedAt ?? null,
  size: entry.size ?? null,
  children: entry.children ? stripTreeForAddons(entry.children) : undefined,
}))

export const createAppAddonBridge = (deps: AppAddonDeps): AddonHostBridge => ({
  appVersion: deps.appVersion,
  platform: deps.platform,
  language: deps.language(),
  web: deps.web,
  notes: {
    list: async () => flattenNoteTree(deps.tree()),
    tree: async () => stripTreeForAddons(deps.tree()),
    read: async (path) => {
      const open = deps.noteContent(path)
      if (open !== null) return stripFamdPayload(open)
      return stripFamdPayload(await deps.readFile(path))
    },
    exists: async (path) => flattenNoteTree(deps.tree()).some((note) => note.path === path),
    write: async (path, content) => {
      if (!/\.(md|markdown)$/iu.test(path)) throw new Error('Add-ons können nur Markdown-Notizen (.md) schreiben.')
      if (deps.updateOpenNote(path, content)) return
      await deps.writeFile(path, content)
    },
    create: async (folder, name, content) => {
      const path = await deps.createNote(folder ?? undefined, name ?? undefined)
      if (content) {
        if (!deps.updateOpenNote(path, content)) await deps.writeFile(path, content)
      }
      await deps.refreshTree().catch(() => undefined)
      return path
    },
    open: async (path) => { await deps.openNote(path) },
    search: async (query) => (await deps.search(query)).slice(0, 200).map((hit) => ({ path: hit.relativePath, title: hit.title, excerpt: hit.excerpt, matches: hit.matches, kind: hit.kind ?? 'note' })),
    active: () => {
      const path = deps.activePath()
      return path ? { path, title: noteTitle(path), kind: deps.activeKind() } : null
    },
  },
  vault: {
    createFolder: async (parent, name) => deps.createFolder(parent ?? undefined, name ?? undefined),
    rename: async (path, name) => deps.renameEntry(path, name),
    move: async (path, folder) => deps.moveEntry(path, folder ?? ''),
    trash: async (path) => deps.trashEntry(path),
  },
  editor: deps.editor,
  ink: { read: (path) => deps.readInk(path) },
  stats: {
    read: async (path) => {
      const live = deps.pageStats(path)
      if (live) return live
      const open = deps.noteContent(path)
      return readPageStatsFromNote(open ?? await deps.readFile(path))
    },
  },
  settings: { read: () => safeSettingsView(deps.settings()) },
  clipboard: { writeText: (text) => deps.writeClipboard(text) },
  net: { fetch: (url, init) => deps.fetch(url, init) },
  ui: {
    toast: (message, kind) => deps.toast(message, kind),
    confirm: (message, options) => deps.confirm(message, options),
    prompt: (message, options) => deps.prompt(message, options),
    openExternal: (url) => deps.openExternal(url),
  },
  commands: {
    execute: async (id, _args) => {
      const action = deps.paletteActions().find((candidate) => candidate.id === id)
      if (!action) throw new AddonApiError('E_NO_COMMAND', `Unbekannter FaNotes-Befehl "${id}".`)
      action.run()
      return true
    },
    list: () => deps.paletteActions().map((action) => ({ id: action.id, label: action.label, group: action.group })),
  },
})
