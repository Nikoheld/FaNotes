import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import type { VaultEntry } from '../types'
import { bestContrastText } from '../lib/colorContrast'

type MaybePromise<T = void> = T | Promise<T>

export type FileTreeProps = {
  entries: VaultEntry[]
  activePath?: string | null
  onOpen: (relativePath: string) => MaybePromise
  onCreateNote: (parentPath?: string) => MaybePromise
  onCreateFolder: (parentPath?: string) => MaybePromise
  onSetFolderColor?: (relativePath: string, color: string | null) => MaybePromise
  onRename: (relativePath: string, nextName: string) => MaybePromise
  onTrash: (relativePath: string) => MaybePromise
  className?: string
  rootLabel?: string
  showRootActions?: boolean
  emptyLabel?: string
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
  '#8b7cff', '#6f8cff', '#4f9df8', '#45c9b7', '#55cfa8',
  '#d4b54c', '#f09a5d', '#ef7aa8', '#b878eb', '#8b8994',
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

function displayName(entry: VaultEntry) {
  return entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md')
    ? entry.name.slice(0, -3)
    : entry.name
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Umbenennen fehlgeschlagen.'
}

export const FileTree = memo(function FileTree({
  entries,
  activePath = null,
  onOpen,
  onCreateNote,
  onCreateFolder,
  onSetFolderColor,
  onRename,
  onTrash,
  className = '',
  rootLabel = 'Dateien',
  showRootActions = true,
  emptyLabel = 'Noch keine Notizen vorhanden',
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const orderedEntries = useMemo(() => sortedEntries(entries), [entries])

  useEffect(() => {
    if (!activePath) return
    setExpanded((current) => {
      const next = new Set(current)
      parentFolders(activePath).forEach((path) => next.add(path))
      return next
    })
  }, [activePath])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
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

  const toggleFolder = (path: string, forceOpen?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current)
      const open = forceOpen ?? !next.has(path)
      if (open) next.add(path)
      else next.delete(path)
      return next
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
    if (!window.confirm(`${type} „${displayName(entry)}“ in den Papierkorb verschieben?`)) {
      return
    }
    await onTrash(entry.relativePath)
  }

  const createInFolder = (
    entry: VaultEntry,
    kind: 'note' | 'folder',
    event?: MouseEvent,
  ) => {
    event?.stopPropagation()
    setContextMenu(null)
    toggleFolder(entry.relativePath, true)
    const action = kind === 'note' ? onCreateNote : onCreateFolder
    void Promise.resolve(action(entry.relativePath))
  }

  const handleRowKey = (event: KeyboardEvent, entry: VaultEntry) => {
    if (event.key === 'F2') {
      event.preventDefault()
      beginRename(entry)
      return
    }
    if (entry.kind !== 'folder') return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      toggleFolder(entry.relativePath, true)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      toggleFolder(entry.relativePath, false)
    }
  }

  const renderEntry = (entry: VaultEntry, depth: number) => {
    const isFolder = entry.kind === 'folder'
    const isExpanded = isFolder && expanded.has(entry.relativePath)
    const isActive = !isFolder && activePath === entry.relativePath
    const isRenaming = renaming?.entry.relativePath === entry.relativePath
    const children = isFolder ? sortedEntries(entry.children ?? []) : []
    const depthStyle = {
      '--tree-depth': depth,
      ...(isFolder ? { '--folder-color': entry.color ?? 'var(--accent)' } : {}),
    } as CSSProperties

    return (
      <li
        aria-expanded={isFolder ? isExpanded : undefined}
        className={`file-tree__item ${isActive ? 'is-active' : ''} ${
          isExpanded ? 'is-expanded' : ''
        }`.trim()}
        key={entry.relativePath}
        role="treeitem"
      >
        <div
          className="file-tree__row"
          data-kind={entry.kind}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({ entry, x: event.clientX, y: event.clientY })
          }}
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
                onClick={() => {
                  if (isFolder) toggleFolder(entry.relativePath)
                  else void Promise.resolve(onOpen(entry.relativePath))
                }}
                onKeyDown={(event) => handleRowKey(event, entry)}
                title={entry.relativePath}
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
                  ) : (
                    <FileText size={16} />
                  )}
                </span>
                <span className="file-tree__name">{displayName(entry)}</span>
              </button>

              <span className="file-tree__inline-actions">
                {isFolder && (
                  <button
                    aria-label={`Neue Notiz in ${displayName(entry)}`}
                    className="file-tree__mini-action"
                    onClick={(event) => createInFolder(entry, 'note', event)}
                    title="Neue Notiz"
                    type="button"
                  >
                    <Plus aria-hidden="true" size={14} />
                  </button>
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
              <li className="file-tree__folder-empty" style={depthStyle}>
                Leer
              </li>
            )}
          </ul>
        )}
      </li>
    )
  }

  return (
    <section className={`file-tree ${className}`.trim()} aria-label={rootLabel}>
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
          </span>
        )}
      </div>

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
          role="menu"
          style={{
            left: Math.min(Math.max(8, contextMenu.x), window.innerWidth - 232),
            top: Math.min(
              Math.max(8, contextMenu.y),
              window.innerHeight - (contextMenu.entry.kind === 'folder' ? 390 : 172),
            ),
          }}
        >
          <div className="file-tree__menu-head">
            <span>{contextMenu.entry.kind === 'folder' ? <FolderOpen size={16} /> : <FileText size={16} />}</span>
            <div><small>{contextMenu.entry.kind === 'folder' ? 'Ordner' : 'Notiz'}</small><strong>{displayName(contextMenu.entry)}</strong></div>
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
              <button
                onClick={() => createInFolder(contextMenu.entry, 'folder')}
                role="menuitem"
                type="button"
              >
                <FolderPlus aria-hidden="true" size={15} />
                Neuer Unterordner
              </button>
              <span className="file-tree__menu-separator" role="separator" />
              {onSetFolderColor && (
                <div className="folder-color-menu">
                  <span><Palette aria-hidden="true" size={14} /> Darstellung</span>
                  <div className="folder-color-swatches" role="group" aria-label="Ordnerfarbe wählen">
                    {FOLDER_COLORS.map((color) => (
                      <button
                        aria-label={`Ordnerfarbe ${color}`}
                        aria-pressed={contextMenu.entry.color === color}
                        className={contextMenu.entry.color === color ? 'active' : ''}
                        key={color}
                        onClick={() => {
                          const path = contextMenu.entry.relativePath
                          setContextMenu(null)
                          void Promise.resolve(onSetFolderColor(path, color))
                        }}
                        role="menuitemradio"
                        style={{ '--folder-swatch': color, '--folder-swatch-contrast': bestContrastText(color) } as CSSProperties}
                        title={color}
                        type="button"
                      >
                        {contextMenu.entry.color === color && <Check size={12} />}
                      </button>
                    ))}
                    <button
                      aria-label="Ordnerfarbe entfernen"
                      className="folder-color-clear"
                      onClick={() => {
                        const path = contextMenu.entry.relativePath
                        setContextMenu(null)
                        void Promise.resolve(onSetFolderColor(path, null))
                      }}
                      role="menuitemradio"
                      title="Standardfarbe"
                      type="button"
                    ><X size={12} /></button>
                  </div>
                </div>
              )}
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
