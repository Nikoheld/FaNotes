import { ArrowDown, ArrowUp, Columns2, CornerDownLeft, File, FileText, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SwitcherNote } from '../lib/workspaceNav'

export type PaletteAction = {
  id: string
  label: string
  detail?: string
  shortcut?: string
  group: string
  keywords?: string
  icon?: React.ReactNode
  run: () => void
}

export type PaletteMode = 'commands' | 'notes'

type PaletteRow =
  | { kind: 'action'; id: string; group: string; action: PaletteAction }
  | { kind: 'note'; id: string; group: string; note: SwitcherNote; active: boolean }

/** Matching notes shown below the commands while typing in command mode. */
const NOTES_IN_COMMAND_MODE = 6
const NOTES_IN_NOTE_MODE = 40

const isPdfPath = (path: string) => /\.pdf$/i.test(path)

export function CommandPalette({ actions, mode = 'commands', rankNotes, activePath = null, onOpenNote, onOpenNoteInSplit, onClose }: {
  actions: PaletteAction[]
  mode?: PaletteMode
  rankNotes?: (query: string, limit: number) => SwitcherNote[]
  activePath?: string | null
  onOpenNote?: (path: string) => void
  onOpenNoteInSplit?: (path: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const rows = useMemo<PaletteRow[]>(() => {
    const trimmed = query.trim()
    const terms = trimmed.toLocaleLowerCase('de').split(/\s+/).filter(Boolean)
    const noteRows = (limit: number): PaletteRow[] => (rankNotes?.(trimmed, limit) ?? []).map((note) => ({
      kind: 'note',
      id: `note:${note.path}`,
      group: trimmed ? 'Notizen' : 'Zuletzt geöffnet',
      note,
      active: note.path === activePath,
    }))
    if (mode === 'notes') return noteRows(NOTES_IN_NOTE_MODE)
    const actionRows: PaletteRow[] = (terms.length
      ? actions.filter((action) => {
        const haystack = `${action.label} ${action.detail ?? ''} ${action.group} ${action.keywords ?? ''}`.toLocaleLowerCase('de')
        return terms.every((term) => haystack.includes(term))
      })
      : actions
    ).map((action) => ({ kind: 'action', id: action.id, group: action.group, action }))
    return terms.length ? [...actionRows, ...noteRows(NOTES_IN_COMMAND_MODE)] : actionRows
  }, [actions, activePath, mode, query, rankNotes])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSelected(0) }, [query, mode])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('button.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const execute = (row: PaletteRow | undefined, split = false) => {
    if (!row) return
    onClose()
    if (row.kind === 'action') {
      row.action.run()
      return
    }
    if (split) onOpenNoteInSplit?.(row.note.path)
    else onOpenNote?.(row.note.path)
  }

  const noteMode = mode === 'notes'

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <section className={`command-palette ${noteMode ? 'is-note-switcher' : ''}`} role="dialog" aria-modal="true" aria-label={noteMode ? 'Notiz öffnen' : 'Befehlspalette'} onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Search size={19} />
          <input
            ref={inputRef}
            value={query}
            placeholder={noteMode ? 'Notiz öffnen …' : 'Befehl suchen …'}
            aria-label={noteMode ? 'Notiz suchen' : 'Befehl suchen'}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(rows.length - 1, value + 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)) }
              if (event.key === 'PageDown') { event.preventDefault(); setSelected((value) => Math.min(rows.length - 1, value + 8)) }
              if (event.key === 'PageUp') { event.preventDefault(); setSelected((value) => Math.max(0, value - 8)) }
              if (event.key === 'Enter') { event.preventDefault(); execute(rows[selected], event.shiftKey) }
            }}
          />
          <button type="button" onClick={onClose} aria-label="Schließen"><X size={16} /></button>
        </div>
        <div className="palette-results" ref={listRef}>
          {!rows.length && <div className="palette-empty">{noteMode ? 'Keine passende Notiz' : 'Kein passender Befehl'}</div>}
          {rows.map((row, index) => {
            const previousGroup = rows[index - 1]?.group
            return (
              <div key={row.id}>
                {row.group !== previousGroup && <div className="palette-group">{row.group}</div>}
                {row.kind === 'action' ? (
                  <button
                    type="button"
                    className={index === selected ? 'selected' : ''}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => execute(row)}
                  >
                    <span className="palette-action-icon">{row.action.icon}</span>
                    <span className="palette-action-copy"><strong>{row.action.label}</strong>{row.action.detail && <small>{row.action.detail}</small>}</span>
                    {row.action.shortcut && <kbd>{row.action.shortcut}</kbd>}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`palette-note ${index === selected ? 'selected' : ''} ${row.active ? 'is-active-note' : ''}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={(event) => execute(row, event.shiftKey)}
                    title={row.note.path}
                  >
                    <span className="palette-action-icon">{isPdfPath(row.note.path) ? <File size={15} /> : <FileText size={15} />}</span>
                    <span className="palette-action-copy"><strong>{row.note.title}</strong>{row.note.folder && <small>{row.note.folder}</small>}</span>
                    {row.active ? <kbd>geöffnet</kbd> : index === selected ? <kbd title="Umschalt+Enter öffnet rechts"><Columns2 size={11} /> ⇧↵</kbd> : null}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <footer><span><ArrowUp size={13} /><ArrowDown size={13} /> auswählen</span><span><CornerDownLeft size={13} /> öffnen</span>{(noteMode || rows.some((row) => row.kind === 'note')) && <span>⇧ <CornerDownLeft size={13} /> rechts öffnen</span>}<span>Esc schließen</span></footer>
      </section>
    </div>
  )
}
