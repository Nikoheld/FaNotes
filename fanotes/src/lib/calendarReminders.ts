import { expandOccurrences, type CalendarDocument } from './calendarModel'

export type ReminderLanguage = 'de' | 'en'

export type CalendarReminder = {
  key: string
  title: string
  startsAt: string
  minutesUntil: number
}

/** Timed events that start within the lead window. An all-day event has no clock, so it does not announce midnight. */
export const dueReminders = (
  document: CalendarDocument,
  now: Date,
  leadMinutes = 15,
): CalendarReminder[] => {
  const from = new Date(now.getTime() - 60_000)
  const to = new Date(now.getTime() + leadMinutes * 60_000)
  const hidden = new Set(document.calendars.filter((calendar) => !calendar.visible).map((calendar) => calendar.id))
  return expandOccurrences(document, from, to)
    .filter((occurrence) => !hidden.has(occurrence.event.calendarId))
    .filter((occurrence) => !occurrence.event.allDay)
    .filter((occurrence) => !occurrence.event.title.startsWith('✓ '))
    .filter((occurrence) => occurrence.start.getTime() >= from.getTime() && occurrence.start.getTime() <= to.getTime())
    .map((occurrence) => ({
      key: occurrence.key,
      title: occurrence.event.title,
      startsAt: occurrence.start.toISOString(),
      minutesUntil: Math.max(0, Math.round((occurrence.start.getTime() - now.getTime()) / 60_000)),
    }))
}

/** The line shown above the calendar. The title is the user's event name. */
export const formatReminder = (reminder: Pick<CalendarReminder, 'title' | 'minutesUntil'>, language: ReminderLanguage): string => {
  const title = reminder.title.trim() || (language === 'en' ? 'Event' : 'Termin')
  const minutes = Math.max(0, Math.round(reminder.minutesUntil))
  if (language === 'en') {
    if (minutes === 0) return `${title} starts now.`
    if (minutes === 1) return `${title} starts in 1 minute.`
    return `${title} starts in ${minutes} minutes.`
  }
  if (minutes === 0) return `${title} beginnt jetzt.`
  return `${title} beginnt in ${minutes} min.`
}

export const formatMoreReminders = (count: number, language: ReminderLanguage): string => {
  const extra = Math.max(0, Math.floor(count))
  if (extra <= 0) return ''
  if (language === 'en') return extra === 1 ? '1 more event.' : `${extra} more events.`
  return extra === 1 ? 'Noch 1 Termin.' : `Noch ${extra} Termine.`
}
