import {
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  BookOpen,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  File,
  Files,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Share2,
  Trash2,
  X,
} from 'lucide-react'
import type { VaultEntry } from '../types'
import { bestContrastText } from '../lib/colorContrast'
import { folderPathsIn, nextExpandedFolders } from '../lib/noteQoL'

type MaybePromise<T = void> = T | Promise<T>

export type FileTreeProps = {
  entries: VaultEntry[]
  activePath?: string | null
  /** The note shown in the second split pane, marked in the tree. */
  splitPath?: string | null
  /** Entries (and their folders) that arrived from outside and were not opened yet. */
  newPaths?: ReadonlySet<string>
  onOpen: (relativePath: string) => MaybePromise<unknown>
  /** Shift+click, Shift+Enter or the context menu open a note in the second pane. */
  onOpenInSplit?: (relativePath: string) => MaybePromise<unknown>
  /** Remember expanded folders under this key (per vault). */
  expansionStorageKey?: string
  onCreateNote: (parentPath?: string) => MaybePromise
  onCreateFolder: (parentPath?: string) => MaybePromise
  onImportPdf?: (parentPath?: string) => MaybePromise
  /** Creates a writing-mode story in this folder. */
  onCreateStory?: (parentPath?: string) => MaybePromise
  /** Imports a DOCX, Markdown or text file as a new story in the folder. */
  onImportStory?: (parentPath?: string) => MaybePromise
  onAttachBook?: (parentPath: string) => MaybePromise
  onDetachBook?: (parentPath: string) => MaybePromise
  bookFolderPaths?: string[]
  localOnlyPaths?: string[]
  onToggleLocalOnly?: (relativePath: string) => void
  onSetFolderColor?: (relativePath: string, color: string | null) => MaybePromise
  /** Colours a note or PDF icon in the tree; `null` restores the default. */
  onSetFileColor?: (relativePath: string, color: string | null) => MaybePromise
  onEditFolderPath?: (relativePath: string) => MaybePromise
  onRename: (relativePath: string, nextName: string) => MaybePromise
  onMove: (relativePath: string, destFolder: string) => MaybePromise
  onTrash: (relativePath: string) => MaybePromise
  onDuplicate?: (relativePath: string) => MaybePromise
  onCopyWikiLink?: (relativePath: string) => MaybePromise
  onCopyPath?: (relativePath: string) => MaybePromise
  /** Upload this note, or every note in this folder, as a frozen copy, a live link, or an editable share. */
  onShare?: (relativePath: string, mode: 'copy' | 'live' | 'edit') => MaybePromise
  confirmTrash?: (message: string) => Promise<boolean>
  className?: string
  rootLabel?: string
  showHeader?: boolean
  showRootActions?: boolean
  emptyLabel?: string
  /** Expand this folder and its parents after creating a nested folder. */
  revealPath?: string | null
}

type ContextMenuState = {
  entry: VaultEntry
  x: number
  y: number
}

type RenameState = {
  entry: VaultEntry
  value: string
  error?: string
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
const FOLDER_COLORS = [
  '#6b7280', '#2a6f97', '#337ea9', '#0f7b6c', '#448361',
  '#ba9b4a', '#d9730d', '#c4554d', '#9065b0', '#787774',
]
const sortedEntryCache = new WeakMap<VaultEntry[], VaultEntry[]>()

function sortedEntries(entries: VaultEntry[]) {
  const cached = sortedEntryCache.get(entries)
  if (cached) return cached
  const sorted = [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
    return collator.compare(left.name, right.name)
  })
  sortedEntryCache.set(entries, sorted)
  return sorted
}

function parentFolders(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** Scroll the sidebar list only. Element.scrollIntoView also moves outer scrollers. */
function revealTreeRow(row: HTMLElement | null | undefined) {
  const scroller = row?.closest<HTMLElement>('.file-tree-wrap')
  if (!row || !scroller) return
  const rowBox = row.getBoundingClientRect()
  const frame = scroller.getBoundingClientRect()
  if (rowBox.top < frame.top) scroller.scrollTop += rowBox.top - frame.top
  else if (rowBox.bottom > frame.bottom) scroller.scrollTop += rowBox.bottom - frame.bottom
}

function displayName(entry: VaultEntry) {
  return entry.kind === 'file' && /\.(md|markdown|famd|pdf|story)$/i.test(entry.name)
    ? entry.name.replace(/\.(md|markdown|famd|pdf|story)$/i, '')
    : entry.name
}

/** A writing-mode project (`Name.story`), shown as one document. */
function isStoryEntry(entry: VaultEntry) {
  return entry.kind === 'file' && /\.story$/i.test(entry.name)
}

function isPdfEntry(entry: VaultEntry) {
  return entry.kind === 'file' && /\.pdf$/i.test(entry.name)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Umbenennen fehlgeschlagen.'
}

const FANOTES_DRAG_TYPE = 'application/x-fanotes-entry'

function parentPath(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

function isSelfOrDescendant(candidate: string, ancestor: string) {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`)
}

function dropFolderFor(targetKind: 'file' | 'folder' | 'root', targetPath = '') {
  if (targetKind === 'root') return ''
  if (targetKind === 'folder') return targetPath
  return parentPath(targetPath)
}

function canMoveTo(sourcePath: string, sourceKind: VaultEntry['kind'], destFolder: string) {
  if (sourceKind === 'folder' && isSelfOrDescendant(destFolder, sourcePath)) return false
  return parentPath(sourcePath) !== destFolder
}

const readExpandedFolders = (storageKey: string | undefined): Set<string> => {
  if (!storageKey) return new Set()
  try {
    const raw = localStorage.getItem(storageKey)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

const writeExpandedFolders = (storageKey: string | undefined, expanded: Set<string>) => {
  if (!storageKey) return
  try {
    localStorage.setItem(storageKey, JSON.stringify([...expanded]))
  } catch {
    // Not remembering the folders is harmless.
  }
}

function parseDragSource(event: DragEvent): { path: string; kind: VaultEntry['kind'] } | null {
  const typed = event.dataTransfer.getData(FANOTES_DRAG_TYPE)
  if (typed) {
    try {
      const parsed = JSON.parse(typed) as { path?: unknown; kind?: unknown }
      if (typeof parsed.path === 'string' && (parsed.kind === 'file' || parsed.kind === 'folder')) {
        return { path: parsed.path, kind: parsed.kind }
      }
    } catch {
      return null
    }
  }
  const plain = event.dataTransfer.getData('text/plain').trim()
  return plain ? { path: plain, kind: 'file' } : null
}

export const FileTree = memo(function FileTree({
  entries,
  activePath = null,
  splitPath = null,
  onOpen,
  onOpenInSplit,
  expansionStorageKey,
  onCreateNote,
  onCreateFolder,
  onImportPdf,
  onCreateStory,
  onImportStory,
  onAttachBook,
  onDetachBook,
  bookFolderPaths = [],
  localOnlyPaths = [],
  onToggleLocalOnly,
  onSetFolderColor,
  onSetFileColor,
  onEditFolderPath,
  onRename,
  onMove,
  onTrash,
  onDuplicate,
  onCopyWikiLink,
  onCopyPath,
  onShare,
  confirmTrash,
  newPaths,
  className = '',
  rootLabel = 'Dateien',
  showHeader = true,
  showRootActions = true,
  emptyLabel = 'Noch keine Notizen vorhanden',
  revealPath = null,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpandedFolders(expansionStorageKey))
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [menuPlacement, setMenuPlacement] = useState<{ menu: ContextMenuState; left: number; top: number; maxHeight: number } | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const [moveBusy, setMoveBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLElement>(null)
  const treeScrollTop = useRef<number | null>(null)
  const dragSourceRef = useRef<{ path: string; kind: VaultEntry['kind'] } | null>(null)
  const orderedEntries = useMemo(() => sortedEntries(entries), [entries])
  const folderList = useMemo(() => folderPathsIn(entries), [entries])
  const foldersOpen = folderList.some((path) => expanded.has(path))
  const foldLabel = foldersOpen ? 'Alle Ordner einklappen' : 'Alle Ordner aufklappen'

  // A vault switch hands over a new key: forget the old vault's folders.
  const storageKeyRef = useRef(expansionStorageKey)
  useEffect(() => {
    if (storageKeyRef.current === expansionStorageKey) return
    storageKeyRef.current = expansionStorageKey
    setExpanded(readExpandedFolders(expansionStorageKey))
  }, [expansionStorageKey])
  useEffect(() => { writeExpandedFolders(expansionStorageKey, expanded) }, [expanded, expansionStorageKey])

  // Reveal the active note when it was opened elsewhere. Folder toggles must not move the list.
  useEffect(() => {
    if (!activePath) return
    setExpanded((current) => {
      const parents = parentFolders(activePath)
      if (parents.every((path) => current.has(path))) return current
      const next = new Set(current)
      parents.forEach((path) => next.add(path))
      return next
    })
    const frame = window.requestAnimationFrame(() => {
      const row = treeRef.current?.querySelector<HTMLElement>(`.file-tree__item.is-active > .file-tree__row`)
      revealTreeRow(row)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activePath])

  useEffect(() => {
    if (!revealPath) return
    setExpanded((current) => {
      const next = new Set(current)
      parentFolders(revealPath).forEach((path) => next.add(path))
      next.add(revealPath)
      return next
    })
  }, [revealPath])

  // The row only exists once the refreshed tree arrives, which is after revealPath is set.
  // Scroll it into view once (the sidebar of a long tree may have it off-screen).
  const scrolledRevealRef = useRef<string | null>(null)
  useEffect(() => {
    if (!revealPath) { scrolledRevealRef.current = null; return undefined }
    if (scrolledRevealRef.current === revealPath) return undefined
    const frame = window.requestAnimationFrame(() => {
      const button = treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(revealPath)}"]`)
      if (!button) return
      scrolledRevealRef.current = revealPath
      revealTreeRow(button.closest<HTMLElement>('.file-tree__row'))
    })
    return () => window.cancelAnimationFrame(frame)
  }, [revealPath, entries])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    // A long menu scrolls itself; only scrolling the tree or page closes it.
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('scroll', closeOnScroll, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('scroll', closeOnScroll, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  // Measure the open menu and keep all of it inside the window: shift it left
  // or up as needed, and let it scroll when it is taller than the window.
  useLayoutEffect(() => {
    if (!contextMenu) return
    const place = () => {
      const menu = contextMenuRef.current
      if (!menu) return
      const margin = 8
      const maxHeight = Math.max(120, window.innerHeight - margin * 2)
      const frame = menu.offsetHeight - menu.clientHeight
      const height = Math.min(menu.scrollHeight + frame, maxHeight)
      const width = menu.offsetWidth
      const left = Math.max(margin, Math.min(contextMenu.x, window.innerWidth - width - margin))
      const top = Math.max(margin, Math.min(contextMenu.y, window.innerHeight - height - margin))
      setMenuPlacement({ menu: contextMenu, left, top, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [contextMenu])

  useEffect(() => {
    if (!renaming) return
    const input = renameInputRef.current
    if (!input) return
    input.focus()
    const extensionIndex =
      renaming.entry.kind === 'file' ? renaming.value.lastIndexOf('.') : -1
    input.setSelectionRange(0, extensionIndex > 0 ? extensionIndex : renaming.value.length)
  }, [renaming?.entry.relativePath])

  const rememberTreeScroll = (event: { button: number; currentTarget: EventTarget | null }) => {
    if (event.button !== 0 || !(event.currentTarget instanceof Element)) return
    const scroller = event.currentTarget.closest<HTMLElement>('.file-tree-wrap')
    if (!scroller) return
    // Record this before the browser focuses the row and pulls the list upward.
    treeScrollTop.current = scroller.scrollTop
    window.setTimeout(() => { treeScrollTop.current = null }, 0)
  }

  const holdTreeScroll = (apply: () => void) => {
    const scroller = treeRef.current?.closest<HTMLElement>('.file-tree-wrap')
    const top = treeScrollTop.current ?? scroller?.scrollTop ?? 0
    treeScrollTop.current = null
    apply()
    if (!scroller) return
    window.requestAnimationFrame(() => {
      scroller.scrollTop = top
    })
  }

  const toggleFolder = (path: string, forceOpen?: boolean) => {
    holdTreeScroll(() => {
      setExpanded((current) => {
        const next = new Set(current)
        const open = forceOpen ?? !next.has(path)
        if (open) next.add(path)
        else next.delete(path)
        return next
      })
    })
  }

  const beginRename = (entry: VaultEntry) => {
    setContextMenu(null)
    setRenaming({ entry, value: entry.name })
  }

  const commitRename = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!renaming || renameBusy) return
    const nextName = renaming.value.trim()
    if (!nextName) {
      setRenaming({ ...renaming, error: 'Der Name darf nicht leer sein.' })
      return
    }
    if (nextName === renaming.entry.name) {
      setRenaming(null)
      return
    }

    setRenameBusy(true)
    try {
      await onRename(renaming.entry.relativePath, nextName)
      setRenaming(null)
    } catch (error) {
      setRenaming((current) =>
        current ? { ...current, error: errorMessage(error) } : current,
      )
    } finally {
      setRenameBusy(false)
    }
  }

  const requestTrash = async (entry: VaultEntry) => {
    setContextMenu(null)
    const type = entry.kind === 'folder' ? 'Ordner' : 'Notiz'
    const message = `${type} „${displayName(entry)}“ in den Papierkorb verschieben?`
    const confirmed = confirmTrash
      ? await confirmTrash(message)
      : false
    if (!confirmed) return
    await onTrash(entry.relativePath)
  }

  useEffect(() => {
    if (dropFolder === null || dropFolder === '') return
    const timer = window.setTimeout(() => toggleFolder(dropFolder, true), 420)
    return () => window.clearTimeout(timer)
  }, [dropFolder])

  const beginDrag = (entry: VaultEntry, event: DragEvent) => {
    if (renaming || moveBusy) {
      event.preventDefault()
      return
    }
    const payload = { path: entry.relativePath, kind: entry.kind }
    dragSourceRef.current = payload
    event.dataTransfer.setData(FANOTES_DRAG_TYPE, JSON.stringify(payload))
    event.dataTransfer.setData('text/plain', entry.relativePath)
    event.dataTransfer.effectAllowed = 'move'
    setDragPath(entry.relativePath)
    setDropFolder(null)
  }

  const endDrag = () => {
    dragSourceRef.current = null
    setDragPath(null)
    setDropFolder(null)
  }

  const destForTarget = (targetKind: 'file' | 'folder' | 'root', targetPath = '') => {
    const source = dragSourceRef.current
    if (!source) return null
    const dest = dropFolderFor(targetKind, targetPath)
    return canMoveTo(source.path, source.kind, dest) ? dest : null
  }

  const handleDragOver = (
    event: DragEvent,
    targetKind: 'file' | 'folder' | 'root',
    targetPath = '',
  ) => {
    if (targetKind !== 'root') event.stopPropagation()
    const dest = destForTarget(targetKind, targetPath)
    if (dest === null) {
      setDropFolder(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropFolder(dest)
  }

  const handleDrop = async (
    event: DragEvent,
    targetKind: 'file' | 'folder' | 'root',
    targetPath = '',
  ) => {
    if (targetKind !== 'root') event.stopPropagation()
    event.preventDefault()
    const source = dragSourceRef.current ?? parseDragSource(event)
    const dest = source
      ? (canMoveTo(source.path, source.kind, dropFolderFor(targetKind, targetPath))
        ? dropFolderFor(targetKind, targetPath)
        : null)
      : null
    endDrag()
    if (!source || dest === null || moveBusy) return
    setMoveBusy(true)
    try {
      if (dest) toggleFolder(dest, true)
      await onMove(source.path, dest)
    } finally {
      setMoveBusy(false)
    }
  }

  const createInFolder = (
    entry: VaultEntry,
    kind: 'note' | 'folder' | 'pdf' | 'book' | 'story',
    event?: MouseEvent,
  ) => {
    event?.stopPropagation()
    setContextMenu(null)
    toggleFolder(entry.relativePath, true)
    const action = kind === 'note' ? onCreateNote
      : kind === 'pdf' ? onImportPdf
        : kind === 'story' ? onCreateStory
        : kind === 'book' ? onAttachBook
          : onCreateFolder
    if (!action) return
    void Promise.resolve(action(entry.relativePath))
  }

  /** Visible rows in document order: what ArrowUp/ArrowDown walk. */
  const visibleRowButtons = () => (
    [...(treeRef.current?.querySelectorAll<HTMLButtonElement>('.file-tree__entry-button') ?? [])]
  )

  const focusRowAt = (offset: number, from: HTMLElement) => {
    const rows = visibleRowButtons()
    const index = rows.indexOf(from as HTMLButtonElement)
    if (index === -1) return
    const target = offset === Number.NEGATIVE_INFINITY ? rows[0]
      : offset === Number.POSITIVE_INFINITY ? rows[rows.length - 1]
        : rows[Math.min(rows.length - 1, Math.max(0, index + offset))]
    target?.focus({ preventScroll: true })
    revealTreeRow(target)
  }

  const handleRowKey = (event: KeyboardEvent, entry: VaultEntry) => {
    const row = event.currentTarget as HTMLElement
    if (event.key === 'F2') {
      event.preventDefault()
      beginRename(entry)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusRowAt(event.key === 'ArrowDown' ? 1 : -1, row)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusRowAt(event.key === 'Home' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY, row)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      void requestTrash(entry)
      return
    }
    if (event.key === 'Enter' && event.shiftKey && entry.kind === 'file' && onOpenInSplit) {
      event.preventDefault()
      void Promise.resolve(onOpenInSplit(entry.relativePath))
      return
    }
    if (entry.kind !== 'folder') {
      if (event.key === 'ArrowLeft') {
        // Jump to the containing folder, like a file manager.
        event.preventDefault()
        const parent = parentPath(entry.relativePath)
        if (!parent) return
        const rows = visibleRowButtons()
        rows.find((button) => button.dataset.path === parent)?.focus()
      }
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (expanded.has(entry.relativePath)) focusRowAt(1, row)
      else toggleFolder(entry.relativePath, true)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (expanded.has(entry.relativePath)) {
        toggleFolder(entry.relativePath, false)
        return
      }
      const parent = parentPath(entry.relativePath)
      if (parent) visibleRowButtons().find((button) => button.dataset.path === parent)?.focus()
    }
  }

  const renderColorPicker = (
    entry: VaultEntry,
    onSetColor: (relativePath: string, color: string | null) => MaybePromise,
    labels: { group: string; clear: string },
  ) => (
    <div className="folder-color-menu">
      <span><Palette aria-hidden="true" size={14} /> Darstellung</span>
      <div className="folder-color-swatches" role="group" aria-label={labels.group}>
        {FOLDER_COLORS.map((color) => (
          <button
            aria-label={color}
            aria-checked={entry.color === color}
            className={entry.color === color ? 'active' : ''}
            key={color}
            onClick={() => {
              const path = entry.relativePath
              setContextMenu(null)
              void Promise.resolve(onSetColor(path, color))
            }}
            role="menuitemradio"
            style={{ '--folder-swatch': color, '--folder-swatch-contrast': bestContrastText(color) } as CSSProperties}
            title={color}
            type="button"
          >
            {entry.color === color && <Check size={12} />}
          </button>
        ))}
        <button
          aria-checked={!entry.color}
          aria-label={labels.clear}
          className="folder-color-clear"
          onClick={() => {
            const path = entry.relativePath
            setContextMenu(null)
            void Promise.resolve(onSetColor(path, null))
          }}
          role="menuitemradio"
          title="Standardfarbe"
          type="button"
        ><X size={12} /></button>
      </div>
    </div>
  )

  const renderEntry = (entry: VaultEntry, depth: number) => {
    const isFolder = entry.kind === 'folder'
    const isExpanded = isFolder && expanded.has(entry.relativePath)
    const isActive = !isFolder && activePath === entry.relativePath
    const isInSplit = !isFolder && splitPath === entry.relativePath
    const isRenaming = renaming?.entry.relativePath === entry.relativePath
    const children = isFolder ? sortedEntries(entry.children ?? []) : []
    const depthStyle = {
      '--tree-depth': depth,
      ...(isFolder ? { '--folder-color': entry.color ?? 'var(--accent)' } : {}),
      ...(!isFolder && entry.color ? { '--file-color': entry.color } : {}),
    } as CSSProperties

    return (
      <li
        aria-expanded={isFolder ? isExpanded : undefined}
        className={`file-tree__item ${isActive ? 'is-active' : ''} ${isInSplit ? 'is-in-split' : ''} ${
          isExpanded ? 'is-expanded' : ''
        } ${dragPath === entry.relativePath ? 'is-dragging' : ''}`.trim()}
        key={entry.relativePath}
        role="treeitem"
      >
        <div
          className={`file-tree__row ${
            isFolder && dropFolder === entry.relativePath ? 'is-drop-target' : ''
          }`.trim()}
          data-kind={entry.kind}
          data-new={newPaths?.has(entry.relativePath) ? '' : undefined}
          data-colored={!isFolder && entry.color ? '' : undefined}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({ entry, x: event.clientX, y: event.clientY })
          }}
          onDragOver={(event) => handleDragOver(event, entry.kind, entry.relativePath)}
          onDrop={(event) => void handleDrop(event, entry.kind, entry.relativePath)}
          style={depthStyle}
        >
          {isRenaming ? (
            <form className="file-tree__rename" onSubmit={commitRename}>
              <span className="file-tree__indent" aria-hidden="true" />
              <input
                aria-label={`${displayName(entry)} umbenennen`}
                className="file-tree__rename-input"
                disabled={renameBusy}
                onBlur={(event) => {
                  const nextTarget = event.relatedTarget
                  const staysInsideForm =
                    nextTarget instanceof Node && event.currentTarget.form?.contains(nextTarget)
                  if (!renameBusy && !staysInsideForm) void commitRename()
                }}
                onChange={(event) =>
                  setRenaming((current) =>
                    current ? { ...current, value: event.target.value, error: undefined } : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setRenaming(null)
                  }
                }}
                ref={renameInputRef}
                title={renaming.error}
                value={renaming.value}
              />
              <button
                aria-label="Namen übernehmen"
                className="file-tree__mini-action"
                disabled={renameBusy}
                type="submit"
              >
                <Check aria-hidden="true" size={14} />
              </button>
              <button
                aria-label="Umbenennen abbrechen"
                className="file-tree__mini-action"
                disabled={renameBusy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setRenaming(null)}
                type="button"
              >
                <X aria-hidden="true" size={14} />
              </button>
              {renaming.error && (
                <span className="file-tree__rename-error" role="alert">
                  {renaming.error}
                </span>
              )}
            </form>
          ) : (
            <>
              <button
                aria-current={isActive ? 'page' : undefined}
                className="file-tree__entry-button"
                data-path={entry.relativePath}
                draggable={!isRenaming && !moveBusy}
                onMouseDown={(event) => { if (isFolder) rememberTreeScroll(event) }}
                onClick={(event) => {
                  if (isFolder) {
                    toggleFolder(entry.relativePath)
                    event.currentTarget.focus({ preventScroll: true })
                  } else if (event.shiftKey && onOpenInSplit) void Promise.resolve(onOpenInSplit(entry.relativePath))
                  else void Promise.resolve(onOpen(entry.relativePath))
                }}
                onDragStart={(event) => beginDrag(entry, event)}
                onDragEnd={endDrag}
                onKeyDown={(event) => handleRowKey(event, entry)}
                title={isFolder
                  ? `${entry.relativePath}${entry.locations?.length ? ` · Verknüpfter Ordner (${entry.locations.length})` : ''} · Ziehen, um in einen Ordner oder auf die oberste Ebene zu legen`
                  : `${entry.relativePath} · Umschalt+Klick öffnet rechts · Ziehen zum Verschieben`}
                type="button"
              >
                <span className="file-tree__chevron" aria-hidden="true">
                  {isFolder && <ChevronRight size={14} strokeWidth={2.2} />}
                </span>
                <span className="file-tree__icon" aria-hidden="true">
                  {isFolder ? (
                    isExpanded ? (
                      <FolderOpen size={16} />
                    ) : (
                      <Folder size={16} />
                    )
                  ) : isPdfEntry(entry) ? (
                    <File size={16} />
                  ) : isStoryEntry(entry) ? (
                    <BookOpen size={16} />
                  ) : (
                    <FileText size={16} />
                  )}
                </span>
                <span className="file-tree__name">{displayName(entry)}</span>
                {newPaths?.has(entry.relativePath) && <span className="sr-only">{isFolder ? ', enthält neue Dateien' : ', neu'}</span>}
                {isFolder && entry.locations && entry.locations.length > 0 && (
                  <FolderInput className="file-tree__location-mark" aria-hidden="true" size={12} />
                )}
              </button>

              <span className="file-tree__inline-actions">
                {isFolder && (
                  <>
                    <button
                      aria-label={`Neue Notiz in ${displayName(entry)}`}
                      className="file-tree__mini-action"
                      onClick={(event) => createInFolder(entry, 'note', event)}
                      title="Neue Notiz in diesem Ordner"
                      type="button"
                    >
                      <Plus aria-hidden="true" size={14} />
                    </button>
                    <button
                      aria-label={`Neuer Unterordner in ${displayName(entry)}`}
                      className="file-tree__mini-action"
                      onClick={(event) => createInFolder(entry, 'folder', event)}
                      title="Unterordner anlegen"
                      type="button"
                    >
                      <FolderPlus aria-hidden="true" size={14} />
                    </button>
                  </>
                )}
                <button
                  aria-label={`Aktionen für ${displayName(entry)}`}
                  aria-haspopup="menu"
                  className="file-tree__mini-action"
                  onClick={(event) => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    setContextMenu({ entry, x: rect.right, y: rect.bottom + 4 })
                  }}
                  title="Weitere Aktionen"
                  type="button"
                >
                  <MoreHorizontal aria-hidden="true" size={15} />
                </button>
              </span>
            </>
          )}
        </div>

        {isFolder && isExpanded && (
          <ul className="file-tree__group" role="group">
            {children.length > 0 ? (
              children.map((child) => renderEntry(child, depth + 1))
            ) : (
              <li
                className={`file-tree__folder-empty ${
                  dropFolder === entry.relativePath ? 'is-drop-target' : ''
                }`.trim()}
                onDragOver={(event) => handleDragOver(event, 'folder', entry.relativePath)}
                onDrop={(event) => void handleDrop(event, 'folder', entry.relativePath)}
                style={depthStyle}
              >
                <span>Leer</span>
                <button
                  type="button"
                  className="file-tree__empty-subfolder"
                  onClick={(event) => createInFolder(entry, 'folder', event)}
                >
                  Unterordner anlegen
                </button>
              </li>
            )}
          </ul>
        )}
      </li>
    )
  }

  return (
    <section
      ref={treeRef}
      className={`file-tree ${className} ${dropFolder === '' ? 'is-drop-root' : ''}`.trim()}
      aria-label={rootLabel}
      onDragOver={(event) => handleDragOver(event, 'root')}
      onDrop={(event) => void handleDrop(event, 'root')}
    >
      {showHeader && (
        <div className="file-tree__header">
          <span className="file-tree__title">{rootLabel}</span>
          {showRootActions && (
            <span className="file-tree__root-actions">
              <button
                aria-label="Neue Notiz"
                className="file-tree__action"
                onClick={() => void Promise.resolve(onCreateNote())}
                title="Neue Notiz"
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
              </button>
              <button
                aria-label="Neuer Ordner"
                className="file-tree__action"
                onClick={() => void Promise.resolve(onCreateFolder())}
                title="Neuer Ordner"
                type="button"
              >
                <FolderPlus aria-hidden="true" size={16} />
              </button>
              {onImportPdf && (
                <button
                  aria-label="PDF importieren"
                  className="file-tree__action"
                  onClick={() => void Promise.resolve(onImportPdf())}
                  title="PDF importieren"
                  type="button"
                >
                  <File aria-hidden="true" size={16} />
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {folderList.length > 0 && (
        <div className="file-tree__fold">
          <button
            type="button"
            className="file-tree__fold-button"
            aria-label={foldLabel}
            title={foldLabel}
            onMouseDown={rememberTreeScroll}
            onClick={(event) => {
              holdTreeScroll(() => setExpanded(nextExpandedFolders(expanded, folderList)))
              event.currentTarget.focus({ preventScroll: true })
            }}
          >
            {foldersOpen ? <ChevronsDownUp aria-hidden="true" size={14} /> : <ChevronsUpDown aria-hidden="true" size={14} />}
            <span>{foldLabel}</span>
          </button>
        </div>
      )}

      {orderedEntries.length > 0 ? (
        <ul className="file-tree__root" role="tree">
          {orderedEntries.map((entry) => renderEntry(entry, 0))}
        </ul>
      ) : (
        <div className="file-tree__empty">
          <FileText aria-hidden="true" size={22} />
          <span>{emptyLabel}</span>
          {showRootActions && (
            <button type="button" onClick={() => void Promise.resolve(onCreateNote())}>
              Erste Notiz erstellen
            </button>
          )}
        </div>
      )}

      {contextMenu && (
        <div
          aria-label={`Aktionen für ${displayName(contextMenu.entry)}`}
          className="file-tree__context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          ref={contextMenuRef}
          role="menu"
          style={menuPlacement?.menu === contextMenu
            ? { left: menuPlacement.left, top: menuPlacement.top, maxHeight: menuPlacement.maxHeight }
            : { left: contextMenu.x, top: contextMenu.y, visibility: 'hidden' }}
        >
          <div className="file-tree__menu-head">
            <span style={contextMenu.entry.color ? { '--folder-color': contextMenu.entry.color } as CSSProperties : undefined}>{contextMenu.entry.kind === 'folder' ? <FolderOpen size={16} /> : isPdfEntry(contextMenu.entry) ? <File size={16} /> : isStoryEntry(contextMenu.entry) ? <BookOpen size={16} /> : <FileText size={16} />}</span>
            <div><small>{contextMenu.entry.kind === 'folder' ? 'Ordner' : isPdfEntry(contextMenu.entry) ? 'PDF-Notiz' : isStoryEntry(contextMenu.entry) ? 'Geschichte' : 'Notiz'}</small><strong>{displayName(contextMenu.entry)}</strong></div>
          </div>
          {contextMenu.entry.kind === 'folder' && (
            <>
              <span className="file-tree__menu-label">Erstellen</span>
              <button
                onClick={() => createInFolder(contextMenu.entry, 'note')}
                role="menuitem"
                type="button"
              >
                <Plus aria-hidden="true" size={15} />
                Neue Notiz
              </button>
              {onImportPdf && (
              <button
                onClick={() => createInFolder(contextMenu.entry, 'pdf')}
                role="menuitem"
                type="button"
              >
                <File aria-hidden="true" size={15} />
                PDF importieren
              </button>
              )}
              {onCreateStory && (
              <button
                onClick={() => createInFolder(contextMenu.entry, 'story')}
                role="menuitem"
                type="button"
              >
                <BookOpen aria-hidden="true" size={15} />
                Neue Geschichte
              </button>
              )}
              {onImportStory && (
              <button
                onClick={() => { setContextMenu(null); void Promise.resolve(onImportStory(contextMenu.entry.relativePath)) }}
                role="menuitem"
                type="button"
              >
                <BookOpen aria-hidden="true" size={15} />
                Geschichte importieren …
              </button>
              )}
              {onAttachBook && (
              <button
                onClick={() => createInFolder(contextMenu.entry, 'book')}
                role="menuitem"
                type="button"
              >
                <FileText aria-hidden="true" size={15} />
                Buch hinzufügen
              </button>
              )}
              {onToggleLocalOnly && contextMenu.entry.kind === 'folder' && (
              <button
                onClick={() => {
                  const path = contextMenu.entry.relativePath
                  setContextMenu(null)
                  onToggleLocalOnly(path)
                }}
                role="menuitem"
                type="button"
              >
                <Folder aria-hidden="true" size={15} />
                {localOnlyPaths.includes(contextMenu.entry.relativePath) ? 'Wieder synchronisieren' : 'Nur auf diesem Gerät'}
              </button>
              )}
              {onDetachBook && bookFolderPaths.includes(contextMenu.entry.relativePath) && (
              <button
                onClick={() => {
                  const path = contextMenu.entry.relativePath
                  setContextMenu(null)
                  void Promise.resolve(onDetachBook(path))
                }}
                role="menuitem"
                type="button"
              >
                <X aria-hidden="true" size={15} />
                Buch entfernen
              </button>
              )}
              <button
                onClick={() => createInFolder(contextMenu.entry, 'folder')}
                role="menuitem"
                type="button"
              >
                <FolderPlus aria-hidden="true" size={15} />
                Neuer Unterordner
              </button>
              <span className="file-tree__menu-separator" role="separator" />
              {onEditFolderPath && (
                <button
                  onClick={() => {
                    const path = contextMenu.entry.relativePath
                    setContextMenu(null)
                    void Promise.resolve(onEditFolderPath(path))
                  }}
                  role="menuitem"
                  type="button"
                >
                  <FolderInput aria-hidden="true" size={15} />
                  Ordnerpfad …
                </button>
              )}
              {onSetFolderColor && renderColorPicker(contextMenu.entry, onSetFolderColor, {
                group: 'Ordnerfarbe wählen',
                clear: 'Ordnerfarbe entfernen',
              })}
              <span className="file-tree__menu-separator" role="separator" />
            </>
          )}
          {contextMenu.entry.kind === 'file' && onOpenInSplit && (
            <>
              <span className="file-tree__menu-label">Öffnen</span>
              <button
                onClick={() => {
                  const path = contextMenu.entry.relativePath
                  setContextMenu(null)
                  void Promise.resolve(onOpenInSplit(path))
                }}
                role="menuitem"
                type="button"
              >
                <Columns2 aria-hidden="true" size={15} />
                Rechts öffnen
              </button>
              <span className="file-tree__menu-separator" role="separator" />
            </>
          )}
          {contextMenu.entry.kind === 'file' && onSetFileColor && (
            <>
              {renderColorPicker(contextMenu.entry, onSetFileColor, {
                group: 'Dokumentfarbe wählen',
                clear: 'Dokumentfarbe entfernen',
              })}
              <span className="file-tree__menu-separator" role="separator" />
            </>
          )}
          {(onDuplicate || onCopyWikiLink || onCopyPath) && (
            <>
              <span className="file-tree__menu-label">Kopieren</span>
              {contextMenu.entry.kind === 'file' && onDuplicate && !isPdfEntry(contextMenu.entry) && !isStoryEntry(contextMenu.entry) && (
                <button
                  onClick={() => {
                    const path = contextMenu.entry.relativePath
                    setContextMenu(null)
                    void Promise.resolve(onDuplicate(path))
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Files aria-hidden="true" size={15} />
                  Notiz duplizieren
                </button>
              )}
              {contextMenu.entry.kind === 'file' && onCopyWikiLink && (
                <button
                  onClick={() => {
                    const path = contextMenu.entry.relativePath
                    setContextMenu(null)
                    void Promise.resolve(onCopyWikiLink(path))
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Link2 aria-hidden="true" size={15} />
                  Wiki-Link kopieren
                </button>
              )}
              {onCopyPath && (
                <button
                  onClick={() => {
                    const path = contextMenu.entry.relativePath
                    setContextMenu(null)
                    void Promise.resolve(onCopyPath(path))
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Copy aria-hidden="true" size={15} />
                  Pfad kopieren
                </button>
              )}
              <span className="file-tree__menu-separator" role="separator" />
            </>
          )}
          {onShare && (contextMenu.entry.kind === 'folder' || (!isPdfEntry(contextMenu.entry) && !isStoryEntry(contextMenu.entry))) && (
            <>
              <span className="file-tree__menu-label">Teilen</span>
              <button
                className="file-tree__share-choice"
                onClick={() => {
                  const path = contextMenu.entry.relativePath
                  setContextMenu(null)
                  void Promise.resolve(onShare(path, 'copy'))
                }}
                role="menuitem"
                type="button"
              >
                <Share2 aria-hidden="true" size={15} />
                <span>
                  <strong>Kopie</strong>
                  <small>Eine Kopie bleibt so, wie sie hochgeladen wurde.</small>
                </span>
              </button>
              <button
                className="file-tree__share-choice"
                onClick={() => {
                  const path = contextMenu.entry.relativePath
                  setContextMenu(null)
                  void Promise.resolve(onShare(path, 'live'))
                }}
                role="menuitem"
                type="button"
              >
                <Share2 aria-hidden="true" size={15} />
                <span>
                  <strong>Live</strong>
                  <small>Eine Live-Freigabe zeigt spätere Änderungen.</small>
                </span>
              </button>
              <button
                className="file-tree__share-choice"
                onClick={() => {
                  const path = contextMenu.entry.relativePath
                  setContextMenu(null)
                  void Promise.resolve(onShare(path, 'edit'))
                }}
                role="menuitem"
                type="button"
              >
                <Share2 aria-hidden="true" size={15} />
                <span>
                  <strong>Gemeinsam</strong>
                  <small>Andere können diese Freigabe gleichzeitig bearbeiten.</small>
                </span>
              </button>
              <span className="file-tree__menu-separator" role="separator" />
            </>
          )}
          <span className="file-tree__menu-label">Verwalten</span>
          <button
            onClick={() => beginRename(contextMenu.entry)}
            role="menuitem"
            type="button"
          >
            <Pencil aria-hidden="true" size={15} />
            Umbenennen
          </button>
          <button
            className="is-danger"
            onClick={() => void requestTrash(contextMenu.entry)}
            role="menuitem"
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} />
            In Papierkorb
          </button>
        </div>
      )}
    </section>
  )
})

export default FileTree
