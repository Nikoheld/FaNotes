import { FileDown } from 'lucide-react'

type EditorExportControlsProps = {
  disabled?: boolean
  onExport: () => void
}

/** The note menu's export entry: it opens the export dialog (PDF, Word, LaTeX, Markdown). */
export function EditorExportControls({ disabled = false, onExport }: EditorExportControlsProps) {
  return (
    <button type="button" role="menuitem" aria-label="Exportieren …" disabled={disabled} onClick={onExport}>
      <span><FileDown aria-hidden="true" size={15} /></span>
      <span><strong>Exportieren …</strong><small>PDF, Word, LaTeX oder Markdown</small></span>
    </button>
  )
}
