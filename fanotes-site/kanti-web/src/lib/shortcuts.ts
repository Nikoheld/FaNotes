// Keyboard shortcuts. The mapping is pure (key event in, action out) so it is tested without a page.

export type View = 'today' | 'timetable' | 'grades' | 'agenda' | 'absences' | 'updates' | 'mensa' | 'commute' | 'settings'
/** Every view in menu order, the optional Mensa included. */
export const ALL_VIEWS: View[] = ['today', 'timetable', 'grades', 'agenda', 'absences', 'updates', 'mensa', 'commute', 'settings']
/** The views in the menu while the Mensa is off (the default); the number keys count along this list. */
export const VIEWS: View[] = ALL_VIEWS.filter((view) => view !== 'mensa')
/** The views the menu, the number keys and the search offer: Mensa only when the person switched it on. */
export const visibleViews = (showMensa: boolean): View[] => (showMensa ? ALL_VIEWS : VIEWS)

export type Action =
  | { type: 'view'; view: View }
  | { type: 'search' }
  | { type: 'help' }
  | { type: 'refresh' }
  | { type: 'previous' }
  | { type: 'next' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'today' }
  | { type: 'connection' }
  | { type: 'escape' }

export interface KeyInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  /** True while focus is in a text field: only Escape and the search chord count then. */
  typing?: boolean
}

const LETTERS: Record<string, View> = { h: 'today', s: 'timetable', n: 'grades', p: 'agenda', a: 'absences', m: 'updates', l: 'mensa', w: 'commute', e: 'settings' }

/** `pending` is true right after a lone "g": the next letter picks a view (g h, g s, …). */
export const shortcutFor = (input: KeyInput, pending = false, views: View[] = VIEWS): Action | 'g' | null => {
  const key = input.key
  if (key === 'Escape') return { type: 'escape' }
  if ((input.ctrlKey || input.metaKey) && !input.altKey && key.toLowerCase() === 'k') return { type: 'search' }
  if (input.typing || input.ctrlKey || input.metaKey || input.altKey) return null
  if (pending) {
    const view = LETTERS[key.toLowerCase()]
    return view && views.includes(view) ? { type: 'view', view } : null
  }
  if (/^[1-9]$/u.test(key)) return views[Number(key) - 1] ? { type: 'view', view: views[Number(key) - 1] } : null
  if (key === ',') return { type: 'view', view: 'settings' }
  switch (key) {
    case 'g': return 'g'
    case '/': return { type: 'search' }
    case '?': return { type: 'help' }
    case 'r': return { type: 'refresh' }
    case 't': return { type: 'today' }
    case 'c': return { type: 'connection' }
    case 'ArrowLeft': case 'j': return { type: 'previous' }
    case 'ArrowRight': case 'k': return { type: 'next' }
    case 'ArrowUp': return { type: 'up' }
    case 'ArrowDown': return { type: 'down' }
    default: return null
  }
}

export const isTypingTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  const tag = element.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true
}
