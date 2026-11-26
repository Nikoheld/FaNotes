import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMenuKeyboard } from '../lib/useMenuKeyboard'
import { PAPER_STYLES, paperStyleLabel } from '../lib/paperStyles'
import type { PaperStyle } from '../types'

type PaperStylePickerProps = {
  value: PaperStyle
  disabled?: boolean
  onChange: (style: PaperStyle) => void
}

export function PaperStylePicker({ value, disabled, onChange }: PaperStylePickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // Focus lands on the current style (listbox pattern); arrows walk the options; Escape or Tab closes and focus returns to the trigger.
  const onMenuKeyDown = useMenuKeyboard(menuRef, open, close, { selector: '[role="option"]:not(:disabled)', initial: '[role="option"][aria-selected="true"]' })

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`paper-picker ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="paper-picker__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Notizhintergrund: ${paperStyleLabel(value)}`}
        title="Hintergrund dieser Notiz"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`paper-picker__swatch paper-${value}`} aria-hidden="true" />
        <span>{paperStyleLabel(value)}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="paper-picker__menu" role="listbox" aria-label="Notizhintergrund" ref={menuRef} onKeyDown={onMenuKeyDown}>
          <span className="paper-picker__hint">Nur für diese Notiz</span>
          {PAPER_STYLES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === value}
              className={option.id === value ? 'is-active' : ''}
              onClick={() => {
                onChange(option.id)
                setOpen(false)
              }}
            >
              <span className={`paper-picker__swatch paper-${option.id}`} aria-hidden="true" />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
