// The Mensa menu of the Alte Kanti for the Heute column (optional, off by default).
export interface MensaMenu { name: string; description: string; label: string; price: number | null; studentPrice: number | null }
export interface MensaDay { date: string; weekday: string; closed: boolean; note: string; menus: MensaMenu[] }
export interface MensaFeed { fetchedAt: string | null; stale: boolean; day: MensaDay | null; days: MensaDay[] }

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Reads the server body defensively; anything unusable becomes an empty feed. */
export const toMensaFeed = (value: unknown): MensaFeed => {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const days: MensaDay[] = []
  for (const row of Array.isArray(raw.days) ? raw.days : []) {
    const day = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
    const date = str(day.date)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue
    const menus: MensaMenu[] = []
    for (const item of Array.isArray(day.menus) ? day.menus : []) {
      const menu = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const name = str(menu.name)
      if (name) menus.push({ name, description: str(menu.description), label: str(menu.label), price: num(menu.price), studentPrice: num(menu.studentPrice) })
    }
    days.push({ date, weekday: str(day.weekday), closed: day.closed === true || menus.length === 0, note: str(day.note), menus })
  }
  return { fetchedAt: str(raw.fetchedAt) || null, stale: raw.stale === true, day: null, days }
}

const zurich = (now: Date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay()
const nextDate = (date: string) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }

/** The date the Today card aims at: today, or the next school day after 14:00 and on weekends. */
export const mensaTargetDate = (now: Date): string => {
  const local = zurich(now)
  let target = local.date
  if (weekdayOf(target) === 0 || weekdayOf(target) === 6 || local.hour >= 14) {
    do { target = nextDate(target) } while (weekdayOf(target) === 0 || weekdayOf(target) === 6)
  }
  return target
}

/** Today's menu; after 14:00 or on a weekend the next school day's; null when that day is not known. */
export const pickMensaDay = (days: MensaDay[], now: Date): MensaDay | null => {
  const target = mensaTargetDate(now)
  return days.find((day) => day.date === target) || null
}

/** One school day of the week view; `day` is null when the feed has nothing for it. */
export interface MensaWeekSlot { date: string; day: MensaDay | null; nextWeek: boolean }

const addDays = (date: string, count: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10) }
const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7))

/**
 * Monday to Friday of the current week, then next week's when the feed knows at least one of its days
 * (the app's mensaWeekSlots). On a weekend the "current" week is the one that just ended.
 */
export const mensaWeekSlots = (days: MensaDay[], today: string): MensaWeekSlot[] => {
  const byDate = new Map(days.map((day) => [day.date, day]))
  const week = (monday: string, nextWeek: boolean): MensaWeekSlot[] => [0, 1, 2, 3, 4].map((offset) => { const date = addDays(monday, offset); return { date, day: byDate.get(date) || null, nextWeek } })
  const monday = mondayOf(today)
  const next = week(addDays(monday, 7), true)
  return [...week(monday, false), ...(next.some((slot) => slot.day) ? next : [])]
}

/** The date to select first: the one the Today card shows; else today if listed, else the closest earlier day, else the first. */
export const mensaPreselectedDate = (slots: MensaWeekSlot[], now: Date): string | null => {
  if (!slots.length) return null
  const target = mensaTargetDate(now)
  const dates = slots.map((slot) => slot.date)
  if (dates.includes(target)) return target
  const today = zurich(now).date
  if (dates.includes(today)) return today
  return [...dates].reverse().find((date) => date < target) || dates[0]
}

export const mensaPrice = (value: number) => value.toFixed(2)
