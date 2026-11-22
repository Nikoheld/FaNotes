import { useEffect, useRef, type RefObject } from 'react'

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

const tabbables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(TABBABLE)]
  .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')

type ModalFocusOptions = {
  /** Called on Escape when the key was not already handled (omit when the dialog closes itself). */
  onEscape?: () => void
  /** Set to false while the dialog is not shown (components that stay mounted). */
  active?: boolean
}

/**
 * Keyboard contract of a modal dialog: focus moves into it on open (unless the dialog already focused
 * something), Tab and Shift+Tab wrap inside it, Escape can close it, and focus returns to the element
 * that opened it when it closes. Nested dialogs are left alone: the trap only acts while focus is inside
 * this dialog or nowhere in particular.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, { onEscape, active = true }: ModalFocusOptions = {}) {
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  useEffect(() => {
    if (!active) return undefined
    const dialog = ref.current
    if (!dialog) return undefined
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    if (!dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? tabbables(dialog)[0]
      if (first) first.focus()
      else {
        if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')
        dialog.focus()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const current = document.activeElement
      const inside = Boolean(current && dialog.contains(current))
      if (!inside && current && current !== document.body) return
      if (event.key === 'Escape') {
        if (escapeRef.current) { event.preventDefault(); escapeRef.current() }
        return
      }
      if (event.key !== 'Tab') return
      const nodes = tabbables(dialog)
      if (!nodes.length) { event.preventDefault(); dialog.focus(); return }
      const index = inside ? nodes.indexOf(current as HTMLElement) : -1
      const next = event.shiftKey
        ? (index <= 0 ? nodes[nodes.length - 1] : null)
        : (index === -1 || index === nodes.length - 1 ? nodes[0] : null)
      if (next) { event.preventDefault(); next.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [active, ref])
}
