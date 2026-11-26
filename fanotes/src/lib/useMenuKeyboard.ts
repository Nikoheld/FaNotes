import { useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

const ITEMS = '[role="menuitem"]:not(:disabled), button:not(:disabled)'

const items = (menu: HTMLElement, selector: string) => [...menu.querySelectorAll<HTMLElement>(selector)]
  .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')

/**
 * Keyboard contract of a menu or popover list: focus moves to the first item when it opens, ArrowUp/ArrowDown
 * (wrapping), Home and End move between items, Tab closes it, and focus goes back to the element that
 * opened it. Escape and outside clicks stay with the owner. Spread the returned handler on the menu element.
 */
export type MenuKeyboardOptions = {
  /** What counts as an item (default: menu items and buttons). Popovers with form controls pass their own. */
  selector?: string
  /**
   * `close` (default): Tab closes the menu. `edge`: Tab moves between the items and closes the popover only
   * when it leaves the first or last one, so a popover with several inputs stays usable.
   */
  tab?: 'close' | 'edge'
  /** Focus this element first instead of the first item (a text field that is the main action). */
  initial?: string
}

export function useMenuKeyboard(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void, options: MenuKeyboardOptions = {}) {
  const selector = options.selector ?? ITEMS
  const tabMode = options.tab ?? 'close'
  const initial = options.initial
  useEffect(() => {
    if (!active) return undefined
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    let frame = 0
    let tries = 0
    const focusFirst = () => {
      const menu = ref.current
      const first = menu ? ((initial ? menu.querySelector<HTMLElement>(initial) : null) ?? items(menu, selector)[0]) : undefined
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
  }, [active, ref, selector, initial])
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const menu = ref.current
    if (!menu || event.defaultPrevented) return
    const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, select')
    if (event.key === 'Tab') {
      if (tabMode === 'close') { onClose(); return }
      const nodes = items(menu, selector)
      const at = nodes.indexOf(document.activeElement as HTMLElement)
      if (!nodes.length || (event.shiftKey ? at <= 0 : at === nodes.length - 1)) onClose()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    // Home and End belong to a text field's caret.
    if (typing && (event.key === 'Home' || event.key === 'End')) return
    const nodes = items(menu, selector)
    if (!nodes.length) return
    event.preventDefault()
    const index = nodes.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? nodes.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % nodes.length
          : (index <= 0 ? nodes.length - 1 : index - 1)
    nodes[next]?.focus()
  }, [onClose, ref, selector, tabMode])
}
