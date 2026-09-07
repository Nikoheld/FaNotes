import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { TriangleAlert } from 'lucide-react'
import { confirmDialogKeyAction, confirmDialogTabTarget } from '../lib/confirmUx'

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
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The safe action takes focus: an Enter still travelling from the editor or
    // the file tree must never confirm a delete, and the pen/keyboard stays in
    // the dialog until it is answered.
    cancelRef.current?.focus()
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (confirmDialogKeyAction(event.key) !== 'cancel') return
      event.preventDefault()
      event.stopPropagation()
      onCancelRef.current()
    }
    window.addEventListener('keydown', onWindowKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onWindowKeyDown, true)
      if (opener?.isConnected) opener.focus()
    }
  }, [open])

  if (!open) return null

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const target = confirmDialogTabTarget(buttons.length, buttons.indexOf(document.activeElement as HTMLButtonElement), event.shiftKey)
    if (target === null) return
    event.preventDefault()
    buttons[target]?.focus()
  }

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        ref={dialogRef}
        className={`confirm-dialog${danger ? ' is-danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fanotes-confirm-title"
        aria-describedby="fanotes-confirm-message"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <header className="confirm-dialog-header">
          <span className="confirm-dialog-icon" aria-hidden="true"><TriangleAlert size={18} /></span>
          <div>
            <p className="eyebrow">{danger ? 'Achtung' : 'Bestätigen'}</p>
            <h3 id="fanotes-confirm-title">{title}</h3>
          </div>
        </header>
        <div className="confirm-dialog-body">
          <p id="fanotes-confirm-message">{message}</p>
        </div>
        <footer className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}
