// Exit motion for overlays without a library. React unmounts dialogs, menus and toasts instantly, so a
// MutationObserver puts an inert, non-interactive clone of the removed node back for one short fade-out
// (CSS class .motion-ghost in motion.css, opacity/transform only). The clone never receives focus or
// pointer input, carries no ids and is gone after EXIT_MS at the latest. Only overlay classes listed here
// are cloned: in-flow content (the note, the file tree, tabs) is never kept around.

const GHOST_SELECTOR = [
  '.modal-backdrop',
  '.file-tree__context-menu',
  '.ftb-popover',
  '.editor-more-menu',
  '.toast',
  '.search-panel',
].join(',')

const EXIT_MS = 140
const MAX_GHOSTS = 4

export const motionDisabled = (): boolean => {
  if (typeof document === 'undefined') return true
  if (document.documentElement.classList.contains('motion-off')) return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const makeInert = (ghost: Element) => {
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  ghost.removeAttribute('role')
  ghost.removeAttribute('aria-modal')
  const nodes = [ghost, ...ghost.querySelectorAll('*')]
  for (const node of nodes) {
    node.removeAttribute('id')
    if (node !== ghost && node.getAttribute('role') === 'dialog') node.removeAttribute('role')
    if (node.matches('a, button, input, select, textarea, [tabindex], [contenteditable]')) node.setAttribute('tabindex', '-1')
  }
}

export const installExitMotion = () => {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
  let live = 0
  const observer = new MutationObserver((records) => {
    if (motionDisabled() || document.hidden) return
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || live >= MAX_GHOSTS) continue
        const element = node as Element
        if (element.classList.contains('motion-ghost') || !element.matches(GHOST_SELECTOR)) continue
        const parent = record.target as Element
        if (!parent.isConnected) continue
        const ghost = element.cloneNode(true) as HTMLElement
        makeInert(ghost)
        ghost.classList.add('motion-ghost')
        const before = record.nextSibling && record.nextSibling.parentNode === parent ? record.nextSibling : null
        parent.insertBefore(ghost, before)
        live += 1
        let done = false
        const remove = () => { if (done) return; done = true; live -= 1; ghost.remove() }
        ghost.addEventListener('animationend', (event) => { if (event.target === ghost) remove() })
        window.setTimeout(remove, EXIT_MS + 60)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
