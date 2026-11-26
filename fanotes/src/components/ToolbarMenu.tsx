import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMenuKeyboard } from '../lib/useMenuKeyboard'

// Items of a popover: actions, inputs and the one tabbable cell of a roving grid.
const POPOVER_ITEMS = '[role="menuitem"]:not(:disabled), button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled)'

type ToolbarMenuProps = {
  /** Tooltip and accessible name of the trigger. */
  label: string
  icon: ReactNode
  children: ReactNode
  disabled?: boolean
  /** Render the popover open on first paint (static markup checks). */
  defaultOpen?: boolean
  className?: string
  /** The popover holds form controls (sliders, inputs) that need their own press. */
  panelLabel?: string
}

/**
 * One icon button that opens a small popover. The popover is portalled to the body and
 * positioned from the trigger, so toolbars that clip their overflow (or sit on the side
 * of the window) never cut it off. Shared by the formatting bar, the text-box bar and
 * the PDF bar so all of them look and behave the same.
 */
export function ToolbarMenu({ label, icon, children, disabled = false, defaultOpen = false, className = '', panelLabel }: ToolbarMenuProps) {
  const [open, setOpen] = useState(defaultOpen)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return undefined
    const update = () => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (!trigger || !panel) return
      const rect = trigger.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = Math.min(panel.scrollHeight, window.innerHeight - 16)
      // A trigger inside a vertical bar opens to the side; otherwise below.
      const side = Boolean(trigger.closest('.is-vertical'))
      let left = side ? rect.right + 6 : rect.left
      let top = side ? rect.top : rect.bottom + 4
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
      setPlace({ left, top, maxHeight: window.innerHeight - 16 })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open, children])

  const closePanel = useCallback(() => setOpen(false), [])
  // Focus enters the popover, the arrow keys walk its controls, Escape and leaving it close it and focus returns to the button.
  const onPanelKeyDown = useMenuKeyboard(panelRef, open, closePanel, { selector: POPOVER_ITEMS, tab: 'edge' })

  useEffect(() => {
    if (!open) return undefined
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key) }
  }, [open])

  const panel = open ? (
    <div
      ref={panelRef}
      className="ftb-popover"
      role="menu"
      aria-label={panelLabel ?? label}
      onKeyDown={onPanelKeyDown}
      style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }}
      onClick={(event) => {
        // A plain action button closes the menu; controls inside keep it open.
        if (event.target instanceof Element && event.target.closest('[data-menu-close]')) setOpen(false)
      }}
    >
      {children}
    </div>
  ) : null

  return (
    <span className={`ftb-menu ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className={open ? 'is-open' : ''}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
      </button>
      {panel && (typeof document === 'undefined' ? panel : createPortal(panel, document.body))}
    </span>
  )
}
