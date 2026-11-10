// Per-browser conveniences (theme, language, last view). Storage can be missing or throw (private
// windows, blocked site data); the page then simply starts with the defaults.

export interface Prefs {
  theme: string
  accent: string
  language: 'auto' | 'de' | 'en'
  snowfall: boolean
  onboarded: boolean
  activeConnection: string
  browserAlerts: boolean
  compactTimetable: boolean
  showWeekend: boolean
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  accent: '#2a6f97',
  language: 'auto',
  snowfall: true,
  onboarded: false,
  activeConnection: '',
  browserAlerts: false,
  compactTimetable: false,
  showWeekend: false,
}

const KEY = 'kanti-web:prefs'

export const loadPrefs = (storage: Pick<Storage, 'getItem'> | null = safeStorage()): Prefs => {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<Prefs>
    const out = { ...DEFAULT_PREFS }
    for (const key of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
      if (typeof parsed[key] === typeof DEFAULT_PREFS[key]) (out as Record<string, unknown>)[key] = parsed[key]
    }
    return out
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export const savePrefs = (prefs: Prefs, storage: Pick<Storage, 'setItem'> | null = safeStorage()) => {
  try { storage?.setItem(KEY, JSON.stringify(prefs)) } catch { /* storage refused: keep it in memory */ }
}

export function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

/** The change-feed position per connection, so a notice is shown once per browser. */
export const readCursor = (connectionId: string): number | null => {
  try {
    const raw = safeStorage()?.getItem(`kanti-web:cursor:${connectionId}`)
    const value = raw == null ? NaN : Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}
export const writeCursor = (connectionId: string, revision: number) => {
  try { safeStorage()?.setItem(`kanti-web:cursor:${connectionId}`, String(revision)) } catch { /* ignore */ }
}
