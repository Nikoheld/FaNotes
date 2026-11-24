import { useEffect, useId, useRef, useState } from 'react'
import { FileDown, X } from 'lucide-react'
import { useModalFocus } from '../lib/useModalFocus'
import {
  normalizeNoteExportOptions,
  type NoteExportFormat,
  type NoteExportMargins,
  type NoteExportOptions,
  type NoteExportPageSize,
} from '../lib/noteExport/types'

/** What kind of note is exported: text notes support every format, handwriting and PDF notes fewer. */
export type NoteExportKind = 'text' | 'ink' | 'pdf'

export type NoteExportDialogProps = {
  title: string
  kind: NoteExportKind
  /** Runs the export. Rejects with an Error to show its message; an AbortError means the user cancelled. */
  onExport: (options: NoteExportOptions, signal: AbortSignal) => Promise<void>
  onClose: () => void
}

const STORAGE_KEY = 'fanotes.noteExport.options.v1'

export const loadNoteExportOptions = (): NoteExportOptions => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return normalizeNoteExportOptions(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeNoteExportOptions(null)
  }
}

const saveNoteExportOptions = (options: NoteExportOptions) => {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(options)) } catch { /* the choice is just not remembered */ }
}

const FORMAT_CHOICES: Array<{ id: NoteExportFormat; label: string; hint: string }> = [
  { id: 'pdf', label: 'PDF', hint: 'Text, Tabellen, Formeln und Bilder mit auswählbarem Text.' },
  { id: 'docx', label: 'Word (.docx)', hint: 'Bearbeitbares Dokument mit Überschriften, Tabellen und Formeln.' },
  { id: 'latex', label: 'LaTeX (.tex)', hint: 'LaTeX-Code der Notiz.' },
  { id: 'markdown', label: 'Markdown (.md)', hint: 'Der Text der Notiz. Hat sie Bilder, kommen sie in einem ZIP-Ordner daneben.' },
]

const PAGE_SIZES: Array<{ id: NoteExportPageSize; label: string }> = [{ id: 'a4', label: 'A4' }, { id: 'letter', label: 'Letter' }]
const MARGINS: Array<{ id: NoteExportMargins; label: string }> = [
  { id: 'narrow', label: 'Schmal' },
  { id: 'normal', label: 'Normal' },
  { id: 'wide', label: 'Breit' },
]

export function NoteExportDialog({ title, kind, onExport, onClose }: NoteExportDialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  useModalFocus(dialogRef)
  const [options, setOptions] = useState<NoteExportOptions>(() => {
    const stored = loadNoteExportOptions()
    // Handwriting and PDF notes only offer PDF and Word.
    return kind !== 'text' && stored.format !== 'pdf' && stored.format !== 'docx' ? { ...stored, format: 'pdf' } : stored
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const formats = kind === 'text' ? FORMAT_CHOICES : FORMAT_CHOICES.filter((choice) => choice.id === 'pdf' || choice.id === 'docx')
  const effective: NoteExportOptions = options
  const paged = effective.format === 'pdf' || effective.format === 'docx'
  const current = formats.find((choice) => choice.id === effective.format)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (abortRef.current) abortRef.current.abort()
      else onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const patch = (change: Partial<NoteExportOptions>) => setOptions((previous) => ({ ...previous, ...change }))

  const run = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    saveNoteExportOptions(effective)
    try {
      await onExport(effective, controller.signal)
      onCloseRef.current()
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError') && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Der Export ist fehlgeschlagen.')
      }
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <section
        ref={dialogRef}
        className="confirm-dialog note-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="confirm-dialog-header">
          <span className="confirm-dialog-icon" aria-hidden="true"><FileDown size={18} /></span>
          <div>
            <p className="eyebrow">Exportieren</p>
            <h3 id={titleId} data-i18n-ignore>{title}</h3>
          </div>
          <button type="button" className="icon-button note-export-dialog__close" aria-label="Schließen" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="note-export-dialog__body">
          <fieldset className="note-export-dialog__group" disabled={busy}>
            <legend>Format</legend>
            <div className="note-export-dialog__choices" role="radiogroup" aria-label="Format">
              {formats.map((choice) => {
                return (
                  <button
                    key={choice.id}
                    type="button"
                    role="radio"
                    aria-checked={effective.format === choice.id}
                    className={effective.format === choice.id ? 'is-active' : ''}
                    data-format={choice.id}
                    onClick={() => patch({ format: choice.id })}
                  >
                    {choice.label}
                  </button>
                )
              })}
            </div>
            {current && <small className="note-export-dialog__hint">{current.hint}</small>}
          </fieldset>
          <fieldset className="note-export-dialog__group" disabled={busy || !paged}>
            <legend>Seite</legend>
            <div className="note-export-dialog__row">
              <label>
                <span>Seitengröße</span>
                <select aria-label="Seitengröße" value={effective.pageSize} onChange={(event) => patch({ pageSize: event.target.value as NoteExportPageSize })}>
                  {PAGE_SIZES.map((size) => <option key={size.id} value={size.id}>{size.label}</option>)}
                </select>
              </label>
              <label>
                <span>Seitenränder</span>
                <select aria-label="Seitenränder" value={effective.margins} onChange={(event) => patch({ margins: event.target.value as NoteExportMargins })}>
                  {MARGINS.map((margin) => <option key={margin.id} value={margin.id}>{margin.label}</option>)}
                </select>
              </label>
            </div>
          </fieldset>
          <fieldset className="note-export-dialog__group" disabled={busy}>
            <legend>Inhalt</legend>
            <label className="note-export-dialog__check">
              <input type="checkbox" checked={effective.includeTitle} disabled={!paged || kind === 'pdf'} onChange={(event) => patch({ includeTitle: event.target.checked })} />
              Titel der Notiz als Überschrift
            </label>
            <label className="note-export-dialog__check">
              <input type="checkbox" checked={effective.pageNumbers} disabled={effective.format !== 'pdf'} onChange={(event) => patch({ pageNumbers: event.target.checked })} />
              Seitenzahlen unten (nur PDF)
            </label>
            {kind === 'ink' && (
              <label className="note-export-dialog__check">
                <input type="checkbox" checked={effective.paperBackground === true} onChange={(event) => patch({ paperBackground: event.target.checked })} />
                Kariertes oder liniertes Papier im Hintergrund
              </label>
            )}
            {kind === 'pdf' && (
              <label className="note-export-dialog__check">
                <input type="checkbox" checked={effective.annotations !== false} onChange={(event) => patch({ annotations: event.target.checked })} />
                Handschrift, Markierungen und Textfelder einfügen (aus: Original ohne Anmerkungen)
              </label>
            )}
            {paged && <small>Der Export ist immer hell, auch im dunklen Design.</small>}
          </fieldset>
          {busy && <p className="note-export-dialog__progress" role="status"><span className="note-export-dialog__spinner" aria-hidden="true" />Exportiere …</p>}
          {error && <p className="note-export-dialog__error" role="alert">{error}</p>}
        </div>
        <footer className="confirm-dialog-actions">
          <button type="button" className="secondary-button" onClick={() => { if (abortRef.current) abortRef.current.abort(); else onClose() }}>Abbrechen</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>Exportieren</button>
        </footer>
      </section>
    </div>
  )
}
