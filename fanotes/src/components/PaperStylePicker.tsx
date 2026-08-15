import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
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
        <div className="paper-picker__menu" role="listbox" aria-label="Notizhintergrund">
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
