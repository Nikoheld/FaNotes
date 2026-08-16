import {
  type CSSProperties,
  type DragEvent,
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
  File,
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
  onImportPdf?: (parentPath?: string) => MaybePromise
  onSetFolderColor?: (relativePath: string, color: string | null) => MaybePromise
  onRename: (relativePath: string, nextName: string) => MaybePromise
  onMove: (relativePath: string, destFolder: string) => MaybePromise
  onTrash: (relativePath: string) => MaybePromise
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
  return entry.kind === 'file' && /\.(md|markdown|famd|pdf)$/i.test(entry.name)
    ? entry.name.replace(/\.(md|markdown|famd|pdf)$/i, '')
    : entry.name
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
  onOpen,
  onCreateNote,
  onCreateFolder,
  onImportPdf,
  onSetFolderColor,
  onRename,
  onMove,
  onTrash,
  className = '',
  rootLabel = 'Dateien',
  showHeader = true,
  showRootActions = true,
  emptyLabel = 'Noch keine Notizen vorhanden',
  revealPath = null,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const [moveBusy, setMoveBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const dragSourceRef = useRef<{ path: string; kind: VaultEntry['kind'] } | null>(null)
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
    if (!revealPath) return
    setExpanded((current) => {
      const next = new Set(current)
      parentFolders(revealPath).forEach((path) => next.add(path))
      next.add(revealPath)
      return next
    })
  }, [revealPath])

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
    kind: 'note' | 'folder' | 'pdf',
    event?: MouseEvent,
  ) => {
    event?.stopPropagation()
    setContextMenu(null)
    toggleFolder(entry.relativePath, true)
    const action = kind === 'note' ? onCreateNote : kind === 'pdf' ? onImportPdf : onCreateFolder
    if (!action) return
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
        } ${dragPath === entry.relativePath ? 'is-dragging' : ''}`.trim()}
        key={entry.relativePath}
        role="treeitem"
      >
        <div
          className={`file-tree__row ${
            isFolder && dropFolder === entry.relativePath ? 'is-drop-target' : ''
          }`.trim()}
          data-kind={entry.kind}
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
                draggable={!isRenaming && !moveBusy}
                onClick={() => {
                  if (isFolder) toggleFolder(entry.relativePath)
                  else void Promise.resolve(onOpen(entry.relativePath))
                }}
                onDragStart={(event) => beginDrag(entry, event)}
                onDragEnd={endDrag}
                onKeyDown={(event) => handleRowKey(event, entry)}
                title={`${entry.relativePath} · Ziehen, um in einen Ordner oder auf die oberste Ebene zu legen`}
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
                  ) : (
                    <FileText size={16} />
                  )}
                </span>
                <span className="file-tree__name">{displayName(entry)}</span>
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
              window.innerHeight - (contextMenu.entry.kind === 'folder' ? 430 : 172),
            ),
          }}
        >
          <div className="file-tree__menu-head">
            <span>{contextMenu.entry.kind === 'folder' ? <FolderOpen size={16} /> : isPdfEntry(contextMenu.entry) ? <File size={16} /> : <FileText size={16} />}</span>
            <div><small>{contextMenu.entry.kind === 'folder' ? 'Ordner' : isPdfEntry(contextMenu.entry) ? 'PDF-Notiz' : 'Notiz'}</small><strong>{displayName(contextMenu.entry)}</strong></div>
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
