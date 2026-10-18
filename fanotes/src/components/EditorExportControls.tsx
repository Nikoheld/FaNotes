import { FileCode, FileDown } from 'lucide-react'

type EditorExportControlsProps = {
  disabled?: boolean
  onExportPdf: () => void
  onExportLatex: () => void
}

/** PDF and LaTeX-code actions for the text editor's note menu. */
export function EditorExportControls({ disabled = false, onExportPdf, onExportLatex }: EditorExportControlsProps) {
  return (
    <>
      <button type="button" role="menuitem" aria-label="Als PDF exportieren" disabled={disabled} onClick={onExportPdf}>
        <span><FileDown aria-hidden="true" size={15} /></span>
        <span><strong>Als PDF exportieren</strong><small>Text und Formeln der Notiz</small></span>
      </button>
      <button type="button" role="menuitem" aria-label="Als LaTeX-Code exportieren" disabled={disabled} onClick={onExportLatex}>
        <span><FileCode aria-hidden="true" size={15} /></span>
        <span><strong>Als LaTeX-Code exportieren</strong><small>LaTeX-Code der Notiz</small></span>
      </button>
    </>
  )
}
