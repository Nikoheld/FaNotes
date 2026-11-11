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
  showMensa: boolean
  /** Half-class choice per group-set key (browser-local; not synced with the app). */
  groupChoices: Record<string, string[]>
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
  showMensa: false,
  groupChoices: {},
}

const KEY = 'kanti-web:prefs'

export const loadPrefs = (storage: Pick<Storage, 'getItem'> | null = safeStorage()): Prefs => {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<Prefs>
    const out = { ...DEFAULT_PREFS }
    for (const key of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
      if (key !== 'groupChoices' && typeof parsed[key] === typeof DEFAULT_PREFS[key]) (out as Record<string, unknown>)[key] = parsed[key]
    }
    out.groupChoices = cleanChoices(parsed.groupChoices)
    return out
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

const cleanChoices = (raw: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const labels = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
    if (key && labels.length) out[key] = labels
  }
  return out
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
