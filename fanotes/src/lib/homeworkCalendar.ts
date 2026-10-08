import {
  CALENDAR_COLORS,
  createEvent,
  dateKey,
  parseCalendarMarkdown,
  parseDateKey,
  sanitizeCalendarDocument,
  serializeCalendarMarkdown,
  upsertEvent,
  type CalendarDocument,
  type CalendarEvent,
} from './calendarModel'
import {
  HOMEWORK_NOTE_PATH,
  type HomeworkDocument,
  type HomeworkTask,
} from './homeworkStore'

export const HOMEWORK_CALENDAR_NAME = 'Hausaufgaben'
export const homeworkEventId = (taskId: string) => `hw:${taskId}`
export const isHomeworkEventId = (id: string) => id.startsWith('hw:')

const ensureHomeworkCalendar = (document: CalendarDocument): CalendarDocument => {
  if (document.calendars.some((calendar) => calendar.name === HOMEWORK_CALENDAR_NAME)) return document
  return sanitizeCalendarDocument({
    ...document,
    calendars: [
      ...document.calendars,
      {
        id: 'homework',
        name: HOMEWORK_CALENDAR_NAME,
        color: CALENDAR_COLORS[4],
        visible: true,
      },
    ],
  })
}

const eventForTask = (calendarId: string, task: HomeworkTask): CalendarEvent | null => {
  if (!task.dueDate) return null
  const day = parseDateKey(task.dueDate)
  if (!day) return null
  const done = task.done
  const title = done ? `✓ ${task.title}` : task.title
  if (task.dueTime) {
    const [hours, minutes] = task.dueTime.split(':').map((part) => Number(part))
    const start = new Date(day)
    start.setHours(hours || 0, minutes || 0, 0, 0)
    const end = new Date(start.getTime() + 45 * 60_000)
    return {
      ...createEvent({
        calendarId,
        title,
        start,
        end,
        allDay: false,
        notes: task.notes,
        notePath: HOMEWORK_NOTE_PATH,
      }),
      id: homeworkEventId(task.id),
    }
  }
  const start = day
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return {
    ...createEvent({
      calendarId,
      title,
      start,
      end,
      allDay: true,
      notes: task.notes,
      notePath: HOMEWORK_NOTE_PATH,
    }),
    id: homeworkEventId(task.id),
  }
}

/** Due homework becomes events on the Hausaufgaben calendar. Done tasks stay, marked with a check. */
export const applyHomeworkToCalendar = (calendar: CalendarDocument, homework: HomeworkDocument): CalendarDocument => {
  const withCalendar = ensureHomeworkCalendar(calendar)
  const calendarId = withCalendar.calendars.find((entry) => entry.name === HOMEWORK_CALENDAR_NAME)?.id
  if (!calendarId) return withCalendar
  const wanted = new Map<string, CalendarEvent>()
  for (const task of homework.tasks) {
    const event = eventForTask(calendarId, task)
    if (event) wanted.set(event.id, event)
  }
  const kept = withCalendar.events.filter((event) => !isHomeworkEventId(event.id) || wanted.has(event.id))
  let next: CalendarDocument = { ...withCalendar, events: kept }
  for (const event of wanted.values()) next = upsertEvent(next, event)
  return next
}

export const calendarMarkdownWithHomework = (calendarMarkdown: string, homework: HomeworkDocument) => (
  serializeCalendarMarkdown(applyHomeworkToCalendar(parseCalendarMarkdown(calendarMarkdown), homework))
)

export const homeworkDueKey = (task: HomeworkTask) => task.dueDate ? dateKey(parseDateKey(task.dueDate) ?? new Date(task.dueDate)) : ''
