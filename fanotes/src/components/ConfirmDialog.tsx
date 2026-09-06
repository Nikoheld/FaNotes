import { TriangleAlert } from 'lucide-react'

export type ConfirmDialogProps = {
  open: boolean
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title = 'Bitte bestätigen',
  message,
  confirmLabel = 'Ja',
  cancelLabel = 'Abbrechen',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null
  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        className="settings-modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fanotes-confirm-title"
        aria-describedby="fanotes-confirm-message"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">{danger ? 'Achtung' : 'Bestätigen'}</p>
            <h3 id="fanotes-confirm-title">{title}</h3>
          </div>
        </header>
        <div className="confirm-dialog-body">
          <TriangleAlert size={18} aria-hidden="true" />
          <p id="fanotes-confirm-message">{message}</p>
        </div>
        <footer className="confirm-dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}
