import { useRef, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { useModalFocus } from '../lib/useModalFocus'

export type DialogFrameProps = {
  /** Icon inside the header tile (lucide icon, 18 px). */
  icon: ReactNode
  /** Small uppercase line above the title. */
  eyebrow?: ReactNode
  title: ReactNode
  /** The title is user content (a note name): keep it out of the UI translation. */
  dynamicTitle?: boolean
  /** Id of the title; the dialog is labelled by it. */
  titleId: string
  onClose: () => void
  closeLabel?: string
  /** Blocks the close button, Escape and the backdrop (while a job runs that must not be interrupted). */
  locked?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /** Row between header and body that stays put while the body scrolls (tabs). */
  subheader?: ReactNode
  /** Right-aligned action row; use `secondary-button` / `primary-button`. */
  footer?: ReactNode
  /** Reuse a ref the owner needs (gestures, focus). */
  dialogRef?: RefObject<HTMLElement | null>
  backdropStyle?: CSSProperties
  dialogProps?: HTMLAttributes<HTMLElement>
  children: ReactNode
}

/**
 * The one dialog shell of the desktop app: backdrop, rounded panel, header with an icon tile, eyebrow,
 * title and close button, a scrolling body and an optional action row. It owns the keyboard contract
 * (focus moves in, Tab stays inside, Escape closes, focus returns to the opener) and keeps itself inside
 * small windows. ConfirmDialog, NoteExportDialog and FolderPathDialog use the same `confirm-dialog`
 * classes, so every dialog built on this frame matches them.
 */
export function DialogFrame({
  icon, eyebrow, title, dynamicTitle = false, titleId, onClose, closeLabel = 'Schließen', locked = false, size = 'md', className = '', subheader, footer,
  dialogRef, backdropStyle, dialogProps, children,
}: DialogFrameProps) {
  const ownRef = useRef<HTMLElement>(null)
  const ref = dialogRef ?? ownRef
  useModalFocus(ref, { onEscape: locked ? undefined : onClose })
  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      style={backdropStyle}
      onPointerDown={(event) => { if (event.target === event.currentTarget && !locked) onClose() }}
    >
      <section
        {...dialogProps}
        ref={ref}
        className={`confirm-dialog dialog-frame dialog-frame--${size}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={locked || undefined}
        onPointerDown={(event) => { event.stopPropagation(); dialogProps?.onPointerDown?.(event) }}
      >
        <header className="confirm-dialog-header">
          <span className="confirm-dialog-icon" aria-hidden="true">{icon}</span>
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h3 id={titleId} data-i18n-ignore={dynamicTitle ? '' : undefined}>{title}</h3>
          </div>
          <button type="button" className="icon-button dialog-frame__close" aria-label={closeLabel} disabled={locked} onClick={onClose}><X size={16} /></button>
        </header>
        {subheader}
        <div className="dialog-frame__body">{children}</div>
        {footer && <footer className="confirm-dialog-actions">{footer}</footer>}
      </section>
    </div>
  )
}
