import { expandOccurrences, type CalendarDocument } from './calendarModel'

export type CalendarReminder = {
  key: string
  title: string
  startsAt: string
  minutesUntil: number
}

/** Events that start within the lead window while the app is open. */
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
    .filter((occurrence) => !occurrence.event.title.startsWith('✓ '))
    .filter((occurrence) => occurrence.start.getTime() >= from.getTime() && occurrence.start.getTime() <= to.getTime())
    .map((occurrence) => ({
      key: occurrence.key,
      title: occurrence.event.title,
      startsAt: occurrence.start.toISOString(),
      minutesUntil: Math.max(0, Math.round((occurrence.start.getTime() - now.getTime()) / 60_000)),
    }))
}
