// Export dialog: format, scope (whole book / current chapter), options, progress.
// The caller decides where the file goes (`onSave`); by default it is downloaded.
import { Download } from 'lucide-react'
import { useRef, useState } from 'react'
import { DialogFrame } from '../../components/DialogFrame'
import type { Hyphenator, TextMeasurer } from '../layout/measure'
import type { ManuscriptLayout } from '../layout/paginate'
import { L } from '../ui/i18n'
import { ExportCancelled, exportStory, type ExportFormat, type ExportResult, type NotesPlacement, type StorySource } from './index'
import './export.css'

export type ExportDialogProps = {
  project: StorySource
  /** The chapter (or part) at the caret, for "current chapter". */
  currentChapter?: { id: string; title: string } | null
  /** The editor's measurer, hyphenators and layout, so the PDF matches the screen exactly. */
  measurer?: TextMeasurer
  hyphenators?: Partial<Record<string, Hyphenator | null>>
  layout?: ManuscriptLayout
  /** Saves the file (Electron save dialog, Android share…). Default: browser download. */
  onSave?: (result: ExportResult) => Promise<void> | void
  onClose: () => void
}

export const downloadExport = (result: ExportResult) => {
  const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: result.mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = result.fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const FORMATS: Array<{ id: ExportFormat; label: string; hint: () => string }> = [
  { id: 'pdf', label: 'PDF', hint: () => L('Druckfertig, genau wie die Seiten im Editor', 'Print-ready, exactly the pages in the editor') },
  { id: 'docx', label: 'Word', hint: () => L('Für Lektorat und Verlag (DOCX)', 'For editors and publishers (DOCX)') },
  { id: 'epub', label: 'EPUB', hint: () => L('E-Book für Reader und Apps', 'E-book for readers and apps') },
  { id: 'md', label: 'Markdown', hint: () => L('Text mit Auszeichnungen', 'Text with markup') },
  { id: 'txt', label: L('Text', 'Text'), hint: () => L('Reiner Text ohne Formatierung', 'Plain text without formatting') },
]

export function ExportDialog(props: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('pdf')
  const [scope, setScope] = useState<'book' | 'chapter'>('book')
  const [notes, setNotes] = useState<NotesPlacement>('footnotes')
  const [sceneTitles, setSceneTitles] = useState(false)
  const [comments, setComments] = useState(true)
  const [embedFonts, setEmbedFonts] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const busy = progress !== null
  const run = async () => {
    setError('')
    setProgress(0)
    const controller = new AbortController()
    abort.current = controller
    try {
      const result = await exportStory(props.project, format, {
        scope,
        ...(scope === 'chapter' && props.currentChapter ? { chapterId: props.currentChapter.id } : {}),
        notes,
        sceneTitles,
        comments,
        embedFonts,
        measurer: props.measurer,
        hyphenators: props.hyphenators,
        layout: props.layout,
        signal: controller.signal,
        onProgress: setProgress,
      })
      await (props.onSave ?? downloadExport)(result)
      props.onClose()
    } catch (failure) {
      if (!(failure instanceof ExportCancelled)) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      abort.current = null
      setProgress(null)
    }
  }
  const close = () => {
    abort.current?.abort()
    props.onClose()
  }
  const current = FORMATS.find((entry) => entry.id === format)!
  return (
    <DialogFrame
      icon={<Download size={18} />}
      eyebrow={L('Exportieren', 'Export')}
      title={L('Geschichte exportieren', 'Export story')}
      titleId="wm-export-title"
      closeLabel={L('Schliessen', 'Close')}
      size="md"
      className="wm-export"
      onClose={close}
      footer={(
        <>
          <button type="button" className="secondary-button" onClick={close}>{busy ? L('Abbrechen', 'Cancel') : L('Schliessen', 'Close')}</button>
          <button type="submit" form="wm-export-form" className="primary-button" disabled={busy}>{busy ? L('Exportiere …', 'Exporting…') : L('Exportieren', 'Export')}</button>
        </>
      )}
    >
      <form id="wm-export-form" className="wm-export-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void run() }}>
        <div className="wm-export-formats" role="radiogroup" aria-label={L('Format', 'Format')}>
          {FORMATS.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={format === entry.id} className={format === entry.id ? 'is-on' : ''} disabled={busy} onClick={() => setFormat(entry.id)}>
              <strong>{entry.label}</strong><span>.{entry.id}</span>
            </button>
          ))}
        </div>
        <p className="wm-export-hint">{current.hint()}</p>
        <div className="wm-export-options">
          <label className="wm-export-field">{L('Umfang', 'Scope')}
            <select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as 'book' | 'chapter')}>
              <option value="book">{L('Ganzes Buch', 'Whole book')}</option>
              <option value="chapter" disabled={!props.currentChapter}>{props.currentChapter ? `${L('Aktuelles Kapitel', 'Current chapter')}: ${props.currentChapter.title}` : L('Aktuelles Kapitel', 'Current chapter')}</option>
            </select>
          </label>
          {format !== 'txt' && (
            <label className="wm-export-field">{L('Anmerkungen', 'Notes')}
              <select value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value as NotesPlacement)}>
                <option value="footnotes">{L('Fussnoten unten auf der Seite', 'Footnotes at the bottom of the page')}</option>
                <option value="endnotes-chapter">{L('Endnoten nach jedem Kapitel', 'Endnotes after each chapter')}</option>
                <option value="endnotes-book">{L('Endnoten am Ende des Buchs', 'Endnotes at the end of the book')}</option>
              </select>
            </label>
          )}
          <div className="wm-toggles">
            {format !== 'pdf' && <label className="wm-toggle"><input type="checkbox" checked={sceneTitles} disabled={busy} onChange={(event) => setSceneTitles(event.target.checked)} />{L('Szenentitel als Überschriften (statt Trennzeichen)', 'Scene titles as headings (instead of break markers)')}</label>}
            {format === 'docx' && <label className="wm-toggle"><input type="checkbox" checked={comments} disabled={busy} onChange={(event) => setComments(event.target.checked)} />{L('Kommentare mitnehmen', 'Include comments')}</label>}
            {format === 'epub' && <label className="wm-toggle"><input type="checkbox" checked={embedFonts} disabled={busy} onChange={(event) => setEmbedFonts(event.target.checked)} />{L('Schriften einbetten (grössere Datei)', 'Embed fonts (larger file)')}</label>}
          </div>
          <p className="wm-export-hint">{L('Ausgeschlossene Szenen und der Papierkorb werden nicht exportiert.', 'Excluded scenes and the trash are left out.')}</p>
        </div>
        {busy && <div className="wm-export-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}><span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>}
        {error && <p className="dialog-frame__error" role="alert">{error}</p>}
      </form>
    </DialogFrame>
  )
}
