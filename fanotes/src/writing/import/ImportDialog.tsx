// Import dialog: pick or drop a DOCX, Markdown or text file, see what it
// contains, then create a new story from it (`onImport`; the caller saves it).
import { FileUp } from 'lucide-react'
import { useState } from 'react'
import { DialogFrame } from '../../components/DialogFrame'
import { runsText } from '../model/runs'
import type { BinderNode } from '../model/types'
import { L, formatNumber } from '../ui/i18n'
import { IMPORT_ACCEPT, importStory, type ImportedStory } from './index'
import '../export/export.css'

export type ImportDialogProps = {
  /** Creates the story (e.g. writes `Name.story/`); the dialog closes when it resolves. */
  onImport: (story: ImportedStory, fileName: string) => Promise<void> | void
  onClose: () => void
}

const count = (nodes: BinderNode[], kind: BinderNode['kind']): number => nodes.reduce((sum, node) => sum + (node.kind === kind ? 1 : 0) + count(node.children ?? [], kind), 0)

export function ImportDialog(props: ImportDialogProps) {
  const [story, setStory] = useState<{ value: ImportedStory; fileName: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [over, setOver] = useState(false)
  const read = async (file: File | undefined) => {
    if (!file) return
    setError('')
    setBusy(true)
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error(L('Die Datei ist zu gross (über 200 MB).', 'The file is too large (over 200 MB).'))
      const value = await importStory(new Uint8Array(await file.arrayBuffer()), file.name)
      setStory({ value, fileName: file.name })
    } catch (failure) {
      setStory(null)
      setError(`${L('Die Datei konnte nicht gelesen werden', 'The file could not be read')}: ${failure instanceof Error ? failure.message : String(failure)}`)
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    if (!story) return
    setBusy(true)
    try {
      await props.onImport(story.value, story.fileName)
      props.onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  const words = story ? story.value.scenes.reduce((sum, scene) => sum + scene.paragraphs.reduce((total, paragraph) => total + (runsText(paragraph.runs).match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0), 0) : 0
  return (
    <DialogFrame
      icon={<FileUp size={18} />}
      eyebrow={L('Importieren', 'Import')}
      title={L('Geschichte importieren', 'Import story')}
      titleId="wm-import-title"
      closeLabel={L('Schliessen', 'Close')}
      size="md"
      className="wm-export"
      onClose={props.onClose}
      footer={(
        <>
          <button type="button" className="secondary-button" onClick={props.onClose}>{L('Abbrechen', 'Cancel')}</button>
          <button type="submit" form="wm-import-form" className="primary-button" disabled={busy || !story}>{L('Als neue Geschichte anlegen', 'Create new story')}</button>
        </>
      )}
    >
      <form id="wm-import-form" className="wm-export-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void confirm() }}>
        <label className={`wm-import-drop${over ? ' is-over' : ''}`} onDragOver={(event) => { event.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={(event) => { event.preventDefault(); setOver(false); void read(event.dataTransfer.files[0]) }}>
          <input type="file" accept={IMPORT_ACCEPT} disabled={busy} onChange={(event) => void read(event.target.files?.[0])} />
          <strong>{story ? story.fileName : L('Datei wählen oder hierher ziehen', 'Choose a file or drop it here')}</strong>
          <span>{L('Word (.docx), Markdown (.md) oder Text (.txt)', 'Word (.docx), Markdown (.md) or text (.txt)')}</span>
        </label>
        <p className="wm-export-hint">{L('Überschriften werden zu Kapiteln und Szenen, «* * *» zu Szenenwechseln. Fussnoten, Kommentare und Hervorhebungen bleiben erhalten.', 'Headings become chapters and scenes, “* * *” becomes a scene break. Footnotes, comments and emphasis are kept.')}</p>
        {busy && <div className="wm-export-progress" role="progressbar" aria-label={L('Wird gelesen', 'Reading')}><span style={{ width: '60%' }} /></div>}
        {story && (
          <p className="wm-import-summary" data-i18n-ignore>
            <strong>{story.value.manifest.title}</strong>{story.value.manifest.author ? ` · ${story.value.manifest.author}` : ''}<br />
            {count(story.value.manifest.binder, 'part') ? `${count(story.value.manifest.binder, 'part')} ${L('Teile', 'parts')}, ` : ''}
            {count(story.value.manifest.binder, 'chapter')} {L('Kapitel', 'chapters')}, {count(story.value.manifest.binder, 'scene')} {L('Szenen', 'scenes')}, {formatNumber(words)} {L('Wörter', 'words')} · {story.value.manifest.language}
          </p>
        )}
        {error && <p className="dialog-frame__error" role="alert">{error}</p>}
      </form>
    </DialogFrame>
  )
}
