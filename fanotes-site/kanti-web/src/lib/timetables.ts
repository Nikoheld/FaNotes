import { addDays } from './agenda'
import type { GridEntry } from '../components/WeekGrid'

// Other classes' and rooms' timetables (the school's PDF, served per connection by the server).
// Pure helpers only; the views and the API client use them.

export interface TimetableSummary {
  available: boolean
  uploadedAt?: string
  semester?: string
  classes?: { code: string; teacher: string }[]
  rooms?: string[]
}

export interface RoomEntry { day: number; start: string; end: string; class: string; subject: string; teacher: string }
export interface RoomWeek { room: string; entries: RoomEntry[] }

export interface ClassEntry { day: number; start: string; end: string; subject: string; teacher: string; room: string; footnote: string }
export interface ClassFootnote { nr: string; teacher: string; subject: string; room: string; classes: string[]; classesTruncated?: boolean }
export interface ClassWeek { class: string; teacher: string; semester: string; entries: ClassEntry[]; footnotes: ClassFootnote[] }

export interface AdminIndex {
  available: boolean
  uploadedAt?: string
  semester?: string
  classes?: { code: string; teacher: string; page: number }[]
  rooms?: number
  warnings?: string[]
  warningCount?: number
}
export interface AdminUploadResult { uploadedAt: string; classes: number; rooms: number; warnings: string[]; warningCount?: number }

export const CLASS_CODE = /^G\d{2}[A-Z]{1,2}$/u
export const ROOM_NAME = /^[A-Za-z0-9_.\- ]{1,24}$/u

/** Only the Alte Kanti (Schulnetz path /aksa) has the school's timetable PDF. */
export const isAksaConnection = (baseUrl: string | undefined): boolean => {
  try { return /^\/aksa\/?$/iu.test(new URL(baseUrl || '').pathname) } catch { return false }
}

/** The summary the UI works with: unusable answers count as "not available". */
export const readSummary = (value: unknown): TimetableSummary => {
  if (!value || typeof value !== 'object') return { available: false }
  const raw = value as Record<string, unknown>
  if (raw.available !== true) return { available: false }
  const classes = Array.isArray(raw.classes)
    ? raw.classes.flatMap((item) => {
      const code = item && typeof item === 'object' ? String((item as { code?: unknown }).code ?? '') : ''
      return CLASS_CODE.test(code) ? [{ code, teacher: String((item as { teacher?: unknown }).teacher ?? '') }] : []
    })
    : []
  const rooms = Array.isArray(raw.rooms) ? raw.rooms.map(String).filter((name) => ROOM_NAME.test(name)) : []
  return { available: classes.length > 0 || rooms.length > 0, uploadedAt: String(raw.uploadedAt ?? ''), semester: String(raw.semester ?? ''), classes, rooms }
}

/** A room's week as day columns (1 = Monday … 5 = Friday), each sorted by time then class. */
export const roomDays = (entries: RoomEntry[]): { day: number; entries: RoomEntry[] }[] => {
  const days = [1, 2, 3, 4, 5].map((day) => ({
    day,
    entries: entries.filter((entry) => entry.day === day).sort((a, b) => a.start.localeCompare(b.start) || a.class.localeCompare(b.class)),
  }))
  return days
}

/** The distinct start times of a room's week, for the rows of a table. */
export const roomStarts = (entries: RoomEntry[]): string[] => [...new Set(entries.map((entry) => entry.start))].sort()

/** Entries of one table cell; several classes may share the room (a footnote lists a whole group). */
export const cellEntries = (entries: RoomEntry[], day: number, start: string): RoomEntry[] =>
  entries.filter((entry) => entry.day === day && entry.start === start)

/** "G26A, G26B, G26F" folded to one label per subject+teacher group inside a cell. */
export const cellLabel = (cell: RoomEntry[]): { text: string; classes: string }[] => {
  const groups = new Map<string, { subject: string; teacher: string; classes: string[] }>()
  for (const entry of cell) {
    const key = `${entry.subject}\u0000${entry.teacher}`
    const group = groups.get(key) || { subject: entry.subject, teacher: entry.teacher, classes: [] }
    group.classes.push(entry.class)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({ text: [group.subject, group.teacher].filter(Boolean).join(' · '), classes: group.classes.join(', ') }))
}

const lessonEntry = (key: string, monday: string, day: number, start: string, end: string, title: string, room: string, teachers: string[]): GridEntry => ({
  key, kind: 'lesson', day: addDays(monday, day - 1), start, end, title, room, teachers: teachers.filter(Boolean),
  comment: '', cancelled: false, substitution: false, marker: '', substitute: '',
})

/** A class's generic week as grid entries on the dates of the week starting at `monday` (Monday = day 1). */
export const classGridEntries = (week: ClassWeek, monday: string): GridEntry[] =>
  week.entries
    .filter((entry) => entry.day >= 1 && entry.day <= 5)
    .map((entry, index) => lessonEntry(`class:${week.class}:${index}`, monday, entry.day, entry.start, entry.end, entry.subject, entry.room, [entry.teacher]))

/** A room's generic week; where the own grid shows the room, this shows the classes that use it. */
export const roomGridEntries = (week: RoomWeek, monday: string): GridEntry[] => {
  const groups = new Map<string, { day: number; start: string; end: string; subject: string; teacher: string; classes: string[] }>()
  for (const entry of week.entries) {
    if (entry.day < 1 || entry.day > 5) continue
    const key = [entry.day, entry.start, entry.end, entry.subject, entry.teacher].join('\u0000')
    const group = groups.get(key) || { day: entry.day, start: entry.start, end: entry.end, subject: entry.subject, teacher: entry.teacher, classes: [] }
    group.classes.push(entry.class)
    groups.set(key, group)
  }
  return [...groups.values()].map((group, index) => lessonEntry(`room:${week.room}:${index}`, monday, group.day, group.start, group.end, group.subject, group.classes.join(', '), [group.teacher]))
}
