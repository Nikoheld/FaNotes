// The vault files the Android app (android/core schulnetz/*, desk/*) and the desktop write, read and
// written here with the same JSON shapes and the same paths. Parsers are as forgiving as the Kotlin ones
// (a broken row is dropped, a broken file reads as empty); serializers keep the Kotlin field order.

export const SCHOOL_VAULT_DIR = '.fanotes/schulnetz/'
export const GRADE_BOOK_PATH = '.fanotes/schulnetz/grade-book.json'
export const HYPOTHETICAL_PATH = '.fanotes/schulnetz/hypothetical.json'
export const COLORS_PATH = '.fanotes/schulnetz/colors.json'
export const HIDDEN_PATH = '.fanotes/schulnetz/hidden-lessons.json'
export const PLANNED_PATH = '.fanotes/schulnetz/planned-absences.json'
/** Not per connection: the app keeps one desk file. */
export const DESK_PATH = '.fanotes/schulnetz/desk.json'
export const HOMEWORK_NOTE_PATH = 'Hausaufgaben.md'
export const CALENDAR_NOTE_PATH = 'Kalender.md'

/** Vault path of a school file in a connection's slot: '' (the first connection) keeps the original path. */
export const slotVaultPath = (slot: string, path: string): string =>
  !slot || !path.startsWith(SCHOOL_VAULT_DIR) ? path : `${SCHOOL_VAULT_DIR}connections/${slot}/${path.slice(SCHOOL_VAULT_DIR.length)}`

const SLOT_PATTERN = /^c[a-z0-9]{6,24}$/u
export const isSlot = (value: string) => value === '' || SLOT_PATTERN.test(value)
/** The connection slots that have files in the vault (from its file list). The first connection's slot is ''. */
export const slotsInVault = (paths: string[]): string[] => {
  const found = new Set<string>()
  for (const path of paths) {
    const match = /^\.fanotes\/schulnetz\/connections\/(c[a-z0-9]{6,24})\//u.exec(path)
    if (match) found.add(match[1])
  }
  return [...found].sort()
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()
export const textOf = (bytes: Uint8Array | null): string | null => (bytes === null ? null : decoder.decode(bytes))
export const bytesOf = (text: string): Uint8Array => encoder.encode(text)

type Json = unknown
const parse = (text: string | null): Json => {
  if (text === null) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}
const isObject = (value: Json): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: Json): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: Json): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const list = (value: Json): Json[] => (Array.isArray(value) ? value : [])

/** A Kotlin Double as text: 1 is written 1.0. */
const dbl = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value))
const q = (value: string): string => JSON.stringify(value)

// ── Grade book ───────────────────────────────────────────────────────────────

export interface OwnGrade { id: string; courseId: string; title: string; mark: number; weight: number; date: string }
export interface CollectivePart { id: string; title: string; mark: number; weight: number }
export interface CollectiveGrade { id: string; courseId: string; title: string; date: string; weight: number; parts: CollectivePart[] }
export interface GradeAdjustment { targetId: string; mark?: number | null; weight?: number | null; excluded: boolean }
export interface GradeBook { own: OwnGrade[]; collective: CollectiveGrade[]; adjustments: GradeAdjustment[]; archivedCourseIds: string[] }

export const emptyGradeBook = (): GradeBook => ({ own: [], collective: [], adjustments: [], archivedCourseIds: [] })

const validMark = (value: number) => Number.isFinite(value) && value >= 1 && value <= 6
const validWeight = (value: number) => Number.isFinite(value) && value > 0

export const cleanAdjustment = (adjustment: GradeAdjustment): GradeAdjustment | null => {
  if (!adjustment.targetId.trim()) return null
  const mark = adjustment.mark != null && validMark(adjustment.mark) ? adjustment.mark : null
  const weight = adjustment.weight != null && validWeight(adjustment.weight) ? adjustment.weight : null
  if (mark === null && weight === null && !adjustment.excluded) return null
  return { targetId: adjustment.targetId, mark, weight, excluded: adjustment.excluded }
}

/** GradeBook.normalized() of the Kotlin core. */
export const normalizeGradeBook = (book: GradeBook): GradeBook => ({
  own: book.own.filter((grade) => grade.id.trim() && grade.courseId.trim() && grade.date.trim() && validMark(grade.mark) && validWeight(grade.weight)),
  collective: book.collective.flatMap((grade) => {
    const parts = grade.parts.filter((part) => part.id.trim() && validMark(part.mark) && validWeight(part.weight))
    if (!grade.id.trim() || !grade.courseId.trim() || !grade.date.trim() || !validWeight(grade.weight) || !parts.length) return []
    return [{ ...grade, title: grade.title.trim() ? grade.title : 'Collective grade', parts }]
  }),
  adjustments: book.adjustments.map(cleanAdjustment).filter((item): item is GradeAdjustment => item !== null),
  archivedCourseIds: [...new Set(book.archivedCourseIds.map((id) => id.trim()).filter(Boolean))],
})

export const parseGradeBook = (text: string | null): GradeBook => {
  const root = parse(text)
  if (!isObject(root)) return emptyGradeBook()
  const own = list(root.own).flatMap((item): OwnGrade[] => {
    if (!isObject(item)) return []
    const mark = num(item.mark)
    const id = str(item.id)
    if (mark === undefined || id === undefined) return []
    return [{ id, courseId: str(item.courseId) ?? '', title: str(item.title) ?? '', mark, weight: num(item.weight) ?? 1, date: str(item.date) ?? '' }]
  })
  const collective = list(root.collective).flatMap((item): CollectiveGrade[] => {
    if (!isObject(item)) return []
    const id = str(item.id)
    if (id === undefined) return []
    const parts = list(item.parts).flatMap((partItem): CollectivePart[] => {
      if (!isObject(partItem)) return []
      const mark = num(partItem.mark)
      const partId = str(partItem.id)
      if (mark === undefined || partId === undefined) return []
      return [{ id: partId, title: str(partItem.title) ?? '', mark, weight: num(partItem.weight) ?? 1 }]
    })
    return [{ id, courseId: str(item.courseId) ?? '', title: str(item.title) ?? '', date: str(item.date) ?? '', weight: num(item.weight) ?? 1, parts }]
  })
  const adjustments = list(root.adjustments).flatMap((item): GradeAdjustment[] => {
    if (!isObject(item)) return []
    const targetId = str(item.targetId)
    if (targetId === undefined) return []
    return [{ targetId, mark: num(item.mark) ?? null, weight: num(item.weight) ?? null, excluded: item.excluded === true }]
  })
  const archivedCourseIds = list(root.archived).flatMap((item) => (typeof item === 'string' && item.trim() ? [item] : []))
  return normalizeGradeBook({ own, collective, adjustments, archivedCourseIds })
}

export const serializeGradeBook = (book: GradeBook): string => {
  const clean = normalizeGradeBook(book)
  const own = clean.own.map((g) => `{"id":${q(g.id)},"courseId":${q(g.courseId)},"title":${q(g.title)},"mark":${dbl(g.mark)},"weight":${dbl(g.weight)},"date":${q(g.date)}}`)
  const collective = clean.collective.map((g) => `{"id":${q(g.id)},"courseId":${q(g.courseId)},"title":${q(g.title)},"date":${q(g.date)},"weight":${dbl(g.weight)},"parts":[${g.parts.map((p) => `{"id":${q(p.id)},"title":${q(p.title)},"mark":${dbl(p.mark)},"weight":${dbl(p.weight)}}`).join(',')}]}`)
  const adjustments = clean.adjustments.map((a) => `{"targetId":${q(a.targetId)}${a.mark != null ? `,"mark":${dbl(a.mark)}` : ''}${a.weight != null ? `,"weight":${dbl(a.weight)}` : ''},"excluded":${a.excluded}}`)
  return `{"version":1,"own":[${own.join(',')}],"collective":[${collective.join(',')}],"adjustments":[${adjustments.join(',')}],"archived":[${clean.archivedCourseIds.map(q).join(',')}]}`
}

/** "2026-11-04" or "4.11.2026" to ISO, or null (Kotlin parseGradeDate). */
export const parseGradeDate = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(trimmed)
  const swiss = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u.exec(trimmed)
  const [y, m, d] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : swiss ? [Number(swiss[3]), Number(swiss[2]), Number(swiss[1])] : [0, 0, 0]
  if (!y) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ── What-if marks ────────────────────────────────────────────────────────────

export interface HypotheticalGrade { id: string; courseId: string; title: string; mark: number; weight: number }

export const parseHypothetical = (text: string | null): HypotheticalGrade[] => {
  const root = parse(text)
  if (!isObject(root)) return []
  return list(root.grades).flatMap((item): HypotheticalGrade[] => {
    if (!isObject(item)) return []
    const mark = num(item.mark)
    const id = str(item.id)
    if (mark === undefined || id === undefined) return []
    return [{ id, courseId: str(item.courseId) ?? '', title: str(item.title) ?? '', mark, weight: num(item.weight) ?? 1 }]
  })
}

export const serializeHypothetical = (grades: HypotheticalGrade[]): string =>
  `{"version":1,"grades":[${grades.map((g) => `{"id":${q(g.id)},"courseId":${q(g.courseId)},"title":${q(g.title)},"mark":${dbl(g.mark)},"weight":${dbl(g.weight)}}`).join(',')}]}`

// ── Hidden lessons ───────────────────────────────────────────────────────────

export interface HiddenLesson { id: string; mode: 'once' | 'series'; eventId: string; date: string; subject: string; weekday: number; start: string }

export const parseHiddenLessons = (text: string | null): HiddenLesson[] => {
  const root = parse(text)
  if (!isObject(root)) return []
  return list(root.items).flatMap((item): HiddenLesson[] => {
    if (!isObject(item)) return []
    const id = str(item.id) ?? ''
    if (!id.trim()) return []
    return [{ id, mode: item.mode === 'once' ? 'once' : 'series', eventId: str(item.eventId) ?? '', date: str(item.date) ?? '', subject: str(item.subject) ?? '', weekday: Math.trunc(num(item.weekday) ?? 0), start: str(item.start) ?? '' }]
  })
}

export const serializeHiddenLessons = (rules: HiddenLesson[]): string =>
  `{"items":[${rules.map((r) => `{"id":${q(r.id)},"mode":${q(r.mode)},"eventId":${q(r.eventId)},"date":${q(r.date)},"subject":${q(r.subject)},"weekday":${r.weekday},"start":${q(r.start)}}`).join(',')}]}`

// ── Planned absences ─────────────────────────────────────────────────────────

export interface PlannedAbsence { id: string; date: string; start: string; end: string; subject: string; lessonId: string; createdAt: number }

const validDay = (raw: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw.trim())
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
}

export const parsePlannedAbsences = (text: string | null): PlannedAbsence[] => {
  const root = parse(text)
  if (!isObject(root)) return []
  return list(root.items).flatMap((item): PlannedAbsence[] => {
    if (!isObject(item)) return []
    const id = str(item.id) ?? ''
    const date = str(item.date) ?? ''
    if (!id.trim() || !validDay(date)) return []
    return [{ id, date, start: str(item.start) ?? '', end: str(item.end) ?? '', subject: str(item.subject) ?? '', lessonId: str(item.lessonId) ?? '', createdAt: Math.trunc(num(item.createdAt) ?? 0) }]
  })
}

export const serializePlannedAbsences = (items: PlannedAbsence[]): string =>
  `{"items":[${items.map((i) => `{"id":${q(i.id)},"date":${q(i.date)},"start":${q(i.start)},"end":${q(i.end)},"subject":${q(i.subject)},"lessonId":${q(i.lessonId)},"createdAt":${Math.trunc(i.createdAt)}}`).join(',')}]}`

// ── Colours and the desk file ────────────────────────────────────────────────

export const parseColors = (text: string | null): Record<string, string> => {
  const root = parse(text)
  if (!isObject(root)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(root)) if (typeof value === 'string') out[key] = value
  return out
}

export interface DeskSettings { courseAliases: Record<string, string>; gradeDecimals: number; showPluspunkte: boolean; gradeSort: string }

/** The part of the app's desk.json the browser uses: subject aliases and the grade display settings. */
export const parseDeskSettings = (text: string | null): DeskSettings => {
  const root = parse(text)
  const out: DeskSettings = { courseAliases: {}, gradeDecimals: 2, showPluspunkte: true, gradeSort: 'name' }
  if (!isObject(root)) return out
  if (isObject(root.courseAliases)) {
    for (const [key, value] of Object.entries(root.courseAliases)) if (key.trim() && typeof value === 'string' && value.trim()) out.courseAliases[key.toLowerCase()] = value
  }
  const decimals = num(root.gradeDecimals)
  if (decimals !== undefined) out.gradeDecimals = Math.min(3, Math.max(0, Math.trunc(decimals)))
  out.showPluspunkte = root.showPluspunkte !== false
  out.gradeSort = str(root.gradeSort)?.trim() || 'name'
  return out
}

// ── Own tasks (Hausaufgaben.md) ──────────────────────────────────────────────

const HOMEWORK_START = '<!-- fanotes-homework-v1'
const MARKER_END = '-->'

export interface HomeworkTask {
  id: string; title: string; notes: string; subject: string; dueDate: string | null; dueTime: string | null
  done: boolean; kind: 'homework' | 'appointment'; priority: 'normal' | 'high'; createdAt: string; updatedAt: string
}
export interface HomeworkDocument { tasks: HomeworkTask[]; publishedIds: string[] }

/** `null`: the marker is there but does not parse. The file must then stay as it is. */
export const loadHomework = (markdown: string | null): HomeworkDocument | null => {
  if (markdown === null) return { tasks: [], publishedIds: [] }
  const start = markdown.indexOf(HOMEWORK_START)
  if (start < 0) return { tasks: [], publishedIds: [] }
  const end = markdown.indexOf(MARKER_END, start + HOMEWORK_START.length)
  if (end < 0) return null
  const root = parse(markdown.slice(start + HOMEWORK_START.length, end).trim())
  if (!isObject(root)) return null
  const tasks = list(root.tasks).flatMap((item): HomeworkTask[] => {
    if (!isObject(item)) return []
    const title = (str(item.title) ?? '').trim()
    if (!title) return []
    const dueDate = str(item.dueDate)
    const dueTime = str(item.dueTime)
    return [{
      id: (str(item.id) ?? '').trim().slice(0, 80) || newId(),
      title: title.slice(0, 240),
      notes: (str(item.notes) ?? '').slice(0, 4000),
      subject: (str(item.subject) ?? '').trim().slice(0, 80),
      dueDate: dueDate && /^\d{4}-\d{2}-\d{2}$/u.test(dueDate) ? dueDate : null,
      dueTime: dueTime && /^\d{2}:\d{2}$/u.test(dueTime) ? dueTime : null,
      done: item.done === true,
      kind: item.kind === 'appointment' ? 'appointment' : 'homework',
      priority: item.priority === 'high' ? 'high' : 'normal',
      createdAt: str(item.createdAt) ?? '',
      updatedAt: str(item.updatedAt) ?? '',
    }]
  })
  return { tasks, publishedIds: list(root.publishedIds).filter((item): item is string => typeof item === 'string') }
}

/** The Kotlin json(): only backslash, quote, newline and carriage return are escaped. */
const kq = (value: string) => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n').replace(/\r/gu, '\\r')}"`

export const serializeHomework = (document: HomeworkDocument): string => {
  const tasks = document.tasks.map((task) => `{"id":${kq(task.id)},"title":${kq(task.title)},"notes":${kq(task.notes)},"subject":${kq(task.subject)},"dueDate":${task.dueDate ? kq(task.dueDate) : 'null'},"dueTime":${task.dueTime ? kq(task.dueTime) : 'null'},"done":${task.done},"kind":${kq(task.kind)},"priority":${kq(task.priority)},"createdAt":${kq(task.createdAt)},"updatedAt":${kq(task.updatedAt)}}`).join(',\n')
  const published = document.publishedIds.length ? `,"publishedIds":[${document.publishedIds.map(kq).join(',')}]` : ''
  return `# Hausaufgaben

Diese Notiz wird von der **Hausaufgaben-Ansicht** in FaNotes verwaltet.
Trage Aufgaben und Termine dort ein – sie bleiben in deinem lokalen Vault.

${HOMEWORK_START}
{
  "version": 1,
  "tasks": [
${tasks}
  ]${published}
}
${MARKER_END}
`
}

// ── Own calendar (Kalender.md) ───────────────────────────────────────────────

const CALENDAR_START = '<!-- fanotes-calendar-v1'

export interface CalendarDef { id: string; name: string; color: string; visible: boolean }
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export interface CalendarEvent {
  id: string; calendarId: string; title: string; start: string; end: string; allDay: boolean
  location: string; notes: string; notePath: string; recurrence: Recurrence; recurrenceUntil: string | null; exceptionDates: string[]
}
export interface CalendarDocument { calendars: CalendarDef[]; events: CalendarEvent[] }

export const emptyCalendar = (): CalendarDocument => ({
  calendars: [
    { id: 'personal', name: 'Persönlich', color: '#7f6df2', visible: true },
    { id: 'school', name: 'Schule', color: '#3d8bfd', visible: true },
    { id: 'work', name: 'Arbeit', color: '#2f9e6b', visible: true },
  ],
  events: [],
})

export const newId = (): string => globalThis.crypto.randomUUID()

export const loadCalendar = (markdown: string | null): CalendarDocument | null => {
  if (markdown === null) return emptyCalendar()
  const start = markdown.indexOf(CALENDAR_START)
  if (start < 0) return emptyCalendar()
  const end = markdown.indexOf(MARKER_END, start + CALENDAR_START.length)
  if (end < 0) return null
  const root = parse(markdown.slice(start + CALENDAR_START.length, end).trim())
  if (!isObject(root)) return null
  const parsedCalendars = list(root.calendars).flatMap((item): CalendarDef[] => {
    if (!isObject(item)) return []
    const name = (str(item.name) ?? '').trim()
    if (!name) return []
    return [{ id: str(item.id) ?? name, name, color: str(item.color) ?? '#2a6f97', visible: item.visible !== false }]
  })
  const calendars = parsedCalendars.length ? parsedCalendars : emptyCalendar().calendars
  const ids = new Set(calendars.map((calendar) => calendar.id))
  const events = list(root.events).flatMap((item): CalendarEvent[] => {
    if (!isObject(item)) return []
    const title = (str(item.title) ?? '').trim()
    const calendarId = str(item.calendarId) ?? ''
    const eventStart = str(item.start) ?? ''
    const eventEnd = str(item.end) ?? ''
    if (!title || !ids.has(calendarId) || !eventStart) return []
    const recurrence = str(item.recurrence)
    return [{
      id: str(item.id) ?? newId(), calendarId, title, start: eventStart, end: eventEnd.trim() ? eventEnd : eventStart,
      allDay: item.allDay !== false, location: str(item.location) ?? '', notes: str(item.notes) ?? '', notePath: str(item.notePath) ?? '',
      recurrence: recurrence === 'daily' || recurrence === 'weekly' || recurrence === 'monthly' || recurrence === 'yearly' ? recurrence : 'none',
      recurrenceUntil: str(item.recurrenceUntil) ?? null,
      exceptionDates: list(item.exceptionDates).filter((value): value is string => typeof value === 'string'),
    }]
  })
  return { calendars, events }
}

export const serializeCalendar = (document: CalendarDocument): string => {
  const calendars = document.calendars.map((c) => `{"id":${kq(c.id)},"name":${kq(c.name)},"color":${kq(c.color)},"visible":${c.visible}}`).join(',\n')
  const events = document.events.map((e) => `{"id":${kq(e.id)},"calendarId":${kq(e.calendarId)},"title":${kq(e.title)},"start":${kq(e.start)},"end":${kq(e.end)},"allDay":${e.allDay},"location":${kq(e.location)},"notes":${kq(e.notes)},"notePath":${kq(e.notePath)},"recurrence":${kq(e.recurrence)},"recurrenceUntil":${e.recurrenceUntil ? kq(e.recurrenceUntil) : 'null'},"exceptionDates":[${e.exceptionDates.map(kq).join(',')}]}`).join(',\n')
  return `# Kalender

Diese Notiz wird von der **Kalender-Ansicht** in FaNotes verwaltet.
Termine bleiben lokal in deinem Vault. Ziehe sie im Kalender — nicht in dieser Datei.

${CALENDAR_START}
{
  "version": 1,
  "calendars": [
${calendars}
  ],
  "events": [
${events}
  ]
}
${MARKER_END}
`
}
