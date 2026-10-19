/** Top bars whose labels a page drag must not highlight. */
export const TOP_CHROME_SELECTORS = [
  '.ribbon',
  '.tabs-bar',
  '.editor-toolbar',
  '.pdf-note-toolbar',
  '.pdf-note-search',
  '.subject-book-pdf-toolbar',
  '.subject-book-pane-bar',
  '.split-pane-head',
] as const

/** Text the user can still select by pressing on it. Controls stay excluded. */
export const CHROME_LABEL_SELECTOR = [
  '.ribbon-brand strong',
  '.ribbon-brand > span',
  '.pdf-note-identity strong',
  '.pdf-note-identity small',
  '.pdf-note-pager > span',
  '.pdf-note-search small',
  '.note-breadcrumbs b',
  '.subject-book-pane-bar strong',
  '.split-pane-head strong',
].join(', ')

export const CHROME_FIELD_SELECTOR = 'input, textarea, [contenteditable="true"]'
export const CHROME_CONTROL_SELECTOR = 'button, a, select'

/** Present on <html> only while a drag that did not start on a label is down. */
export const CHROME_SELECT_SUPPRESS_CLASS = 'is-suppress-chrome-select'

type ClosestNode = {
  closest: (selector: string) => unknown
}

const closestNode = (target: EventTarget | null): ClosestNode | null => {
  if (!target || typeof target !== 'object') return null
  const node = target as ClosestNode & { nodeType?: number; parentElement?: ClosestNode | null }
  if (typeof node.closest === 'function') return node
  if (node.nodeType === 3 && node.parentElement && typeof node.parentElement.closest === 'function') {
    return node.parentElement
  }
  return null
}

/**
 * True when this press must not pull top-bar labels into the selection.
 * A press on the label itself, or in a field, stays selectable.
 */
export const shouldSuppressChromeSelect = (target: EventTarget | null) => {
  const element = closestNode(target)
  if (!element) return true
  if (element.closest(CHROME_FIELD_SELECTOR)) return false
  if (element.closest(CHROME_LABEL_SELECTOR) && !element.closest(CHROME_CONTROL_SELECTOR)) return false
  return true
}

/** Stop page and button drags from highlighting top-bar labels. */
export const installChromeTextSelect = (owner: Document = document) => {
  const root = owner.documentElement
  let token = 0
  const apply = (event: PointerEvent) => {
    if (event.button !== 0) return
    token += 1
    root.classList.toggle(CHROME_SELECT_SUPPRESS_CLASS, shouldSuppressChromeSelect(event.target))
    // The selection starts on the following move, so the used value must be current.
    void root.offsetWidth
  }
  const release = () => {
    const generation = token
    owner.defaultView?.requestAnimationFrame(() => {
      if (generation !== token) return
      root.classList.remove(CHROME_SELECT_SUPPRESS_CLASS)
    })
  }
  owner.addEventListener('pointerdown', apply, true)
  owner.addEventListener('pointerup', release, true)
  owner.addEventListener('pointercancel', release, true)
  return () => {
    token += 1
    root.classList.remove(CHROME_SELECT_SUPPRESS_CLASS)
    owner.removeEventListener('pointerdown', apply, true)
    owner.removeEventListener('pointerup', release, true)
    owner.removeEventListener('pointercancel', release, true)
  }
}
