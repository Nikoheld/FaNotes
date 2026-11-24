import type { CalendarEvent } from './files'
import type { OwnData } from './own'

/** The stored event behind an own entry. */
export const loadCalendarEvent = (own: OwnData, id: string): CalendarEvent | null => own.calendar.events.find((event) => event.id === id) ?? null
