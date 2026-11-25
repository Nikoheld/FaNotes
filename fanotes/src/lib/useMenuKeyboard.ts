import { useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

const ITEMS = '[role="menuitem"]:not(:disabled), button:not(:disabled)'

const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>(ITEMS)]
  .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')

/**
 * Keyboard contract of a menu or popover list: focus moves to the first item when it opens, ArrowUp/ArrowDown
 * (wrapping), Home and End move between items, Tab closes it, and focus goes back to the element that
 * opened it. Escape and outside clicks stay with the owner. Spread the returned handler on the menu element.
 */
export function useMenuKeyboard(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return undefined
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    let frame = 0
    let tries = 0
    const focusFirst = () => {
      const menu = ref.current
      const first = menu ? items(menu)[0] : undefined
      if (first) { first.focus({ preventScroll: true }); return }
      // The menu is measured and placed on the first frames (hidden until then): try again shortly.
      if (tries++ < 8) frame = window.requestAnimationFrame(focusFirst)
    }
    frame = window.requestAnimationFrame(focusFirst)
    return () => {
      window.cancelAnimationFrame(frame)
      const current = document.activeElement
      if (opener?.isConnected && (!current || current === document.body || ref.current?.contains(current))) opener.focus({ preventScroll: true })
    }
  }, [active, ref])
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const menu = ref.current
    if (!menu) return
    if (event.key === 'Tab') { onClose(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const nodes = items(menu)
    if (!nodes.length) return
    event.preventDefault()
    const index = nodes.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? nodes.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % nodes.length
          : (index <= 0 ? nodes.length - 1 : index - 1)
    nodes[next]?.focus()
  }, [onClose, ref])
}
