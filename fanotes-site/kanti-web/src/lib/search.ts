// One search over everything the snapshot holds. Pure, so it is tested without a page.
import type { Entry } from './agenda'
import type { CourseSummary } from './grades'
import type { Snapshot } from '../types'

export type Hit =
  | { type: 'course'; key: string; title: string; detail: string }
  | { type: 'entry'; key: string; title: string; detail: string; day: string; kind: Entry['kind'] }
  | { type: 'message'; key: string; title: string; detail: string }
  | { type: 'view'; key: string; title: string; detail: string }

const fold = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/gu, '')

export const search = (query: string, input: { entries: Entry[]; courses: CourseSummary[]; snapshot: Snapshot | null; views: { id: string; title: string }[]; today: string }, limit = 30): Hit[] => {
  const needle = fold(query.trim())
  if (!needle) return input.views.map((view) => ({ type: 'view', key: view.id, title: view.title, detail: '' }))
  const words = needle.split(/\s+/u).filter(Boolean)
  const matches = (...fields: string[]) => {
    const blob = fold(fields.join(' '))
    return words.every((word) => blob.includes(word))
  }
  const hits: Hit[] = []
  for (const view of input.views) if (matches(view.title)) hits.push({ type: 'view', key: view.id, title: view.title, detail: '' })
  for (const course of input.courses) if (matches(course.label, course.key)) hits.push({ type: 'course', key: course.key, title: course.label, detail: '' })
  // Upcoming entries first, then the past, one row per subject and day.
  const seen = new Set<string>()
  const entries = [...input.entries].sort((left, right) => {
    const leftPast = left.day < input.today
    const rightPast = right.day < input.today
    if (leftPast !== rightPast) return leftPast ? 1 : -1
    return leftPast ? right.day.localeCompare(left.day) : left.day.localeCompare(right.day)
  })
  for (const entry of entries) {
    if (!matches(entry.title, entry.room, entry.teachers.join(' '), entry.comment, entry.kind === 'exam' ? 'prüfung exam' : '')) continue
    const identity = `${entry.kind}:${entry.title}:${entry.day}`
    if (seen.has(identity)) continue
    seen.add(identity)
    hits.push({ type: 'entry', key: entry.key, title: entry.title, detail: [entry.start, entry.room].filter(Boolean).join(' · '), day: entry.day, kind: entry.kind })
    if (hits.length >= limit) break
  }
  for (const message of input.snapshot?.messages || []) {
    if (matches(message.title, message.body)) hits.push({ type: 'message', key: message.id, title: message.title, detail: message.at.slice(0, 10) })
  }
  return hits.slice(0, limit)
}
