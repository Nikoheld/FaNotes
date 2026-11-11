// Half-class (Halbklasse) groups: port of core HalfClassGroups.kt. A student's timetable lists the
// lessons of all groups; the browser-local choice hides the other groups.
import { eventLabel, isCancelled, isLesson } from '@shared/schulnetz-logic'
import type { AgendaEvent } from '../types'

export interface GroupOption { label: string; title: string; lessonsPerWeek: number; teacher: string }
export interface GroupSet { key: string; options: GroupOption[] }
export type GroupChoices = Record<string, string[]>

const lower = (text: string) => text.trim().toLowerCase()

/** Name families: -Sem1/-Sem2, "<name> <n>.<m>" and spf/spm (also SPF_.../SPM_...). */
export const groupFamily = (label: string): string | null => {
  const text = lower(label)
  let match = /^(.+?)[-_]sem([12])$/u.exec(text)
  if (match) return `${match[1].trim()}|sem`
  match = /^(.+?)\s+(\d+)\.(\d+)$/u.exec(text)
  if (match) return `${match[1].trim()} ${match[2]}`
  if (/^sp[fm](?:[_\s-].*)?$/u.test(text)) return 'sp'
  return null
}

/** Monday-based week number key of a "YYYY-MM-DD" day, to count lessons per week. */
const weekKey = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return ''
  const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * 86400000)
  return monday.toISOString().slice(0, 10)
}

export const detectGroupSets = (lessons: AgendaEvent[]): GroupSet[] => {
  const byLabel = new Map<string, AgendaEvent[]>()
  const names = new Map<string, string>()
  for (const event of lessons) {
    if (!isLesson(event) || isCancelled(event)) continue
    const label = eventLabel(event).trim()
    if (!label) continue
    const id = lower(label)
    if (!names.has(id)) names.set(id, label)
    byLabel.set(id, [...(byLabel.get(id) || []), event])
  }
  if (byLabel.size < 2) return []
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string
    parent.set(x, root)
    return root
  }
  const union = (a: string, b: string) => { parent.set(find(a), find(b)) }

  // Source a: time overlap.
  const slots = new Map<string, string[]>()
  for (const [id, events] of byLabel) {
    for (const start of new Set(events.map((event) => event.start.trim()))) slots.set(start, [...(slots.get(start) || []), id])
  }
  const shared = new Map<string, number>()
  for (const ids of slots.values()) {
    const sorted = [...ids].sort()
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
      const pair = `${sorted[i]}\u0000${sorted[j]}`
      shared.set(pair, (shared.get(pair) || 0) + 1)
    }
  }
  for (const [pair, count] of shared) {
    const [a, b] = pair.split('\u0000')
    const smaller = Math.min(byLabel.get(a)!.length, byLabel.get(b)!.length)
    if (count >= 2 && count * 2 >= smaller) union(a, b)
  }
  // Source b: name families.
  const families = new Map<string, string[]>()
  for (const id of byLabel.keys()) {
    const family = groupFamily(names.get(id)!)
    if (family) families.set(family, [...(families.get(family) || []), id])
  }
  for (const members of families.values()) if (members.length >= 2) for (const other of members.slice(1)) union(members[0], other)

  const groups = new Map<string, string[]>()
  for (const id of byLabel.keys()) groups.set(find(id), [...(groups.get(find(id)) || []), id])
  const sets: GroupSet[] = []
  for (const ids of groups.values()) {
    if (ids.length < 2 || ids.some((id) => byLabel.get(id)!.length < 2)) continue
    const sorted = [...ids].sort()
    const options = sorted.map((id): GroupOption => {
      const events = byLabel.get(id)!
      const weeks = Math.max(1, new Set(events.map((event) => weekKey(event.start.slice(0, 10))).filter(Boolean)).size)
      const counts = new Map<string, number>()
      for (const event of events) {
        const teacher = (event.teachers || []).filter((name) => name.trim()).join(', ')
        if (teacher) counts.set(teacher, (counts.get(teacher) || 0) + 1)
      }
      const teacher = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
      return { label: names.get(id)!, title: names.get(id)!, lessonsPerWeek: Math.max(1, Math.round(events.length / weeks)), teacher }
    })
    sets.push({ key: sorted.join('|'), options })
  }
  return sets.sort((a, b) => a.key.localeCompare(b.key))
}

/** Lowercased chosen labels of a set that really are its options; empty means show all. */
export const chosenLabels = (set: GroupSet, choices: GroupChoices): Set<string> => {
  const valid = new Set(set.options.map((option) => lower(option.label)))
  return new Set((choices[set.key] || []).map(lower).filter((label) => valid.has(label)))
}

/** True for a lesson of a non-chosen course; exams and sets without a valid choice are never hidden. */
export const lessonHiddenByGroup = (event: AgendaEvent, sets: GroupSet[], choices: GroupChoices): boolean => {
  if (!Object.keys(choices).length || !sets.length || !isLesson(event)) return false
  const label = lower(eventLabel(event))
  for (const set of sets) {
    if (!set.options.some((option) => lower(option.label) === label)) continue
    const chosen = chosenLabels(set, choices)
    return chosen.size > 0 && !chosen.has(label)
  }
  return false
}

export const visibleLessons = (events: AgendaEvent[], choices: GroupChoices): AgendaEvent[] => {
  if (!Object.values(choices).some((labels) => labels.length)) return events
  const sets = detectGroupSets(events)
  return events.filter((event) => !lessonHiddenByGroup(event, sets, choices))
}
