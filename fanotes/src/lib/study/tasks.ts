/**
 * Assignment ("Auftrag") detection for worksheets and the per-PDF task list.
 * Detection is pure text work so it can be tested with synthetic input; the
 * list itself is stored in the PDF's companion note as an embedded JSON comment.
 */

import { locateEmbeddedJsonComment } from '../embeddedJsonComment'

export type PageLines = { page: number; lines: string[] }

export type StudyTask = {
  id: string
  /** Label shown first: "1", "12", or "" for an unnumbered "Auftrag:". */
  number: string
  title: string
  minutes: number
  page: number
  done: boolean
  spentSec: number
  /** Added or edited by hand; detection never overwrites it. */
  manual: boolean
}

export type StudyTaskList = { tasks: StudyTask[]; removed: string[] }

const KEYWORDS = 'Auftrag|Aufgabe|Task|Exercise|Übung|Uebung|Arbeitsauftrag'
const HEAD = new RegExp(`^\\s*(?:${KEYWORDS})\\s*(?:(\\d{1,3})\\s*[a-z]?\\b|(?=\\s*[:.]))\\s*(?:\\(([^)]{0,60})\\))?\\s*[:.\\-–—)]?\\s*(.*)$`, 'iu')
const UNIT_MIN = 'Minuten|Minute|Min\\.?|min|\'|′'
const UNIT_LESSON = 'Lektionen|Lektion|Lekt\\.?|Doppellektion(?:en)?'
const UNIT_HOUR = 'Stunden|Stunde|Std\\.?|h'
const AMOUNT = `(\\d+(?:[.,]\\d+)?)(?:\\s*[-–]\\s*(\\d+(?:[.,]\\d+)?))?\\s*(${UNIT_MIN}|${UNIT_LESSON}|${UNIT_HOUR})(?![\\p{L}])`
const TIME = new RegExp(AMOUNT, 'iu')
/** Outside parentheses a hint needs "ca." so "Abb. 9 h" is not read as nine hours. */
const TIME_LOOSE = new RegExp(`(?:ca\\.?|circa|ungefähr|etwa)\\s*${AMOUNT}`, 'iu')
const TIME_IN_PARENS = new RegExp(`\\(([^()]*?)\\)`, 'gu')

/** Joins hyphenated line ends: "Hor-\nmonen" -> "Hormonen", keeps "Hemi- und". */
export const dehyphenate = (lines: readonly string[]): string[] => {
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.replace(/­/gu, '').replace(/[ \t]+/gu, ' ').trim()
    const previous = out[out.length - 1]
    if (previous !== undefined && /[\p{L}]-$/u.test(previous) && /^\p{Ll}/u.test(line) && !/^(?:und|oder|bzw|sowie)\b/iu.test(line)) {
      const [first, ...rest] = line.split(' ')
      out[out.length - 1] = `${previous.slice(0, -1)}${first}`
      if (rest.length) out.push(rest.join(' '))
      continue
    }
    out.push(line)
  }
  return out
}

/** Minutes in a hint such as "ca. 20 Minuten", "(10 Min.)", "1 Lektion" or "1.5 h"; 0 when none. */
export const parseTimeHint = (value: string): number => {
  const parenthesised = [...value.matchAll(TIME_IN_PARENS)].map((match) => match[1])
  const found = [...parenthesised.map((candidate) => TIME.exec(candidate)), TIME_LOOSE.exec(value)]
  for (const match of found) {
    if (!match) continue
    const low = Number(match[1].replace(',', '.'))
    const high = match[2] ? Number(match[2].replace(',', '.')) : low
    const amount = (low + high) / 2
    const unit = match[3].toLowerCase()
    const factor = /^(?:lekt|doppel)/u.test(unit) ? (unit.startsWith('doppel') ? 90 : 45) : /^(?:std|stunde|h$)/u.test(unit) ? 60 : 1
    const minutes = Math.round(amount * factor)
    if (minutes > 0 && minutes <= 600) return minutes
  }
  return 0
}

const clip = (value: string, max: number) => {
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/u, '')} …`
}

const stripTime = (value: string) => value
  .replace(/\(\s*(?:ca\.?|circa)?\s*\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+)?\s*(?:Minuten|Minute|Min\.?|min|Lektionen|Lektion|Std\.?|Stunden|Stunde|h)\s*\)/giu, '')
  .replace(/\s{2,}/gu, ' ')
  .trim()

/** A page whose text arrived as one long line gets a break before each "Auftrag 7". */
const splitCollapsed = (lines: readonly string[]) => lines.flatMap((line) => (
  line.length > 160 ? line.split(new RegExp(`(?<=\\S)\\s+(?=(?:${KEYWORDS})\\s*\\d{1,3}\\s*[:.(])`, 'u')) : [line]
))

const BODY_LINES = 4

/**
 * Finds assignments: lines starting with Auftrag / Aufgabe / Task / Exercise,
 * optionally numbered, optionally followed by a time hint. The first heading
 * per number wins, so a later "Auftrag 4 ..." sentence is not a second task.
 */
export const detectTasks = (pages: readonly PageLines[]): StudyTask[] => {
  const tasks: StudyTask[] = []
  const seen = new Set<string>()
  let unnumbered = 0
  for (const entry of pages) {
    const lines = dehyphenate(splitCollapsed(entry.lines))
    for (let index = 0; index < lines.length; index += 1) {
      const head = HEAD.exec(lines[index])
      if (!head) continue
      const number = head[1] ?? ''
      // "Aufgabe der Hormone" is prose, not a heading: it needs a number or a colon.
      if (!number && !/^\s*(?:\p{L}+)\s*[:.]/u.test(lines[index])) continue
      const key = number ? `n${Number(number)}` : ''
      if (key && seen.has(key)) continue
      const body = [head[3]]
      let cursor = index + 1
      while (!parseTimeHint(body.join(' ')) && cursor < lines.length && body.length < BODY_LINES && lines[cursor] && !HEAD.test(lines[cursor]) && !/^\d+(?:\.\d+)+\s/u.test(lines[cursor])) {
        body.push(lines[cursor])
        cursor += 1
        if (parseTimeHint(body.join(' '))) break
      }
      const raw = body.join(' ')
      const minutes = parseTimeHint(`${head[2] ?? ''} ${raw}`) || parseTimeHint(head[2] ?? '')
      const title = clip(stripTime(raw) || (number ? `Auftrag ${number}` : 'Auftrag'), 140)
      if (key) seen.add(key)
      else unnumbered += 1
      const id = number ? `auftrag-${Number(number)}` : `auftrag-p${entry.page}-${unnumbered}`
      tasks.push({ id, number: number ? String(Number(number)) : '', title, minutes, page: entry.page, done: false, spentSec: 0, manual: false })
    }
  }
  return tasks
}

// -- stored list ---------------------------------------------------------------

export const TASKS_START = '<!-- fanotes-tasks-v1'
const TASKS_END = '-->'
/** The marker must end there: a renamed `fanotes-tasks-v1-broken` comment is not ours any more. */
const MARKER = /<!-- fanotes-tasks-v1(?![-\w])/gu

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

const parseTaskList = (json: string): StudyTaskList | null => {
  try {
    const parsed = JSON.parse(json) as { tasks?: unknown; removed?: unknown }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).slice(0, 300).flatMap((entry): StudyTask[] => {
      if (!entry || typeof entry !== 'object') return []
      const task = entry as Record<string, unknown>
      const id = text(task.id, 80)
      const page = Number(task.page)
      if (!id) return []
      return [{
        id,
        number: text(task.number, 8),
        title: text(task.title, 400),
        minutes: Math.max(0, Math.min(600, Math.round(Number(task.minutes) || 0))),
        page: Number.isInteger(page) && page >= 1 && page <= 5000 ? page : 1,
        done: task.done === true,
        spentSec: Math.max(0, Math.min(86_400 * 7, Math.round(Number(task.spentSec) || 0))),
        manual: task.manual === true,
      }]
    })
    const removed = (Array.isArray(parsed.removed) ? parsed.removed : []).slice(0, 300).filter((id): id is string => typeof id === 'string')
    return { tasks, removed }
  } catch {
    return null
  }
}

type TaskComment = {
  start: number
  /** End of the comment, or null when it never closes (everything after it would be swallowed). */
  end: number | null
  /** The parsed list; null for a comment that is not valid. */
  list: StudyTaskList | null
}

/** Every `fanotes-tasks-v1` comment in the note, valid or not, in order. */
const findTaskComments = (markdown: string): TaskComment[] => {
  const starts = [...markdown.matchAll(MARKER)].map((match) => match.index ?? 0)
  return starts.map((start, index): TaskComment => {
    const located = locateEmbeddedJsonComment(markdown.slice(start), TASKS_START)
    if (located) {
      const list = parseTaskList(markdown.slice(start + located.jsonStart, start + located.jsonEnd))
      return { start, end: start + located.end, list }
    }
    // Broken: it only counts as closed when its own "-->" comes before the next marker.
    const limit = index + 1 < starts.length ? starts[index + 1] : markdown.length
    const close = markdown.indexOf(TASKS_END, start + TASKS_START.length)
    return { start, end: close >= 0 && close + TASKS_END.length <= limit ? close + TASKS_END.length : null, list: null }
  })
}

/** The stored list. A broken comment is skipped when a later one is valid. */
export const readTaskList = (markdown: string): StudyTaskList | null => {
  for (const comment of findTaskComments(markdown)) if (comment.list) return comment.list
  return null
}

/** Removes a comment together with the line break it was written with, nothing else. */
const removeComment = (markdown: string, start: number, end: number) => {
  let before = markdown.slice(0, start)
  const after = markdown.slice(end)
  if (before.endsWith('\n') && after.startsWith('\n')) before = before.slice(0, -1)
  return `${before}${after}`
}

/**
 * Stores the list as exactly one comment: the first valid one is replaced in place, further valid ones are
 * removed, and invalid ones are kept as `fanotes-tasks-v1-broken` so their text can be recovered.
 * Returns null (and changes nothing) when an invalid comment never closes: renaming it would not
 * stop it from swallowing the rest of the note, so the user has to repair that by hand.
 */
export const writeTaskList = (markdown: string, list: StudyTaskList): string | null => {
  const comments = findTaskComments(markdown)
  if (comments.some((comment) => !comment.list && comment.end === null)) return null
  const empty = !list.tasks.length && !list.removed.length
  const block = `${TASKS_START}\n${JSON.stringify(list, null, 1)}\n${TASKS_END}`
  let output = markdown
  let placed = false
  // From the back, so earlier offsets stay valid.
  for (const comment of [...comments].reverse()) {
    if (!comment.list) {
      output = `${output.slice(0, comment.start)}${TASKS_START}-broken${output.slice(comment.start + TASKS_START.length)}`
      continue
    }
    const end = comment.end as number
    const first = comments.find((entry) => entry.list) === comment
    if (first && !empty) {
      output = `${output.slice(0, comment.start)}${block}${output.slice(end)}`
      placed = true
    } else {
      output = removeComment(output, comment.start, end)
    }
  }
  if (empty || placed) return output
  return `${output.replace(/\s*$/u, '')}\n${block}\n`
}

const numberOrder = (task: StudyTask) => (task.number ? Number(task.number) : Number.MAX_SAFE_INTEGER)

export const sortTasks = (tasks: readonly StudyTask[]) => [...tasks].sort((a, b) => (
  a.page - b.page || numberOrder(a) - numberOrder(b) || a.id.localeCompare(b.id)
))

/** Detected tasks merged into the stored list: progress and manual edits survive a re-scan. */
export const mergeDetected = (stored: StudyTaskList | null, detected: readonly StudyTask[]): StudyTaskList => {
  const list = stored ?? { tasks: [], removed: [] }
  const byId = new Map(list.tasks.map((task) => [task.id, task]))
  const removed = new Set(list.removed)
  const merged = list.tasks.filter((task) => !removed.has(task.id))
  for (const task of detected) {
    if (removed.has(task.id)) continue
    const known = byId.get(task.id)
    if (known) {
      if (!known.manual) {
        const index = merged.indexOf(known)
        merged[index] = { ...known, title: task.title, minutes: known.minutes || task.minutes, page: task.page, number: task.number }
      }
      continue
    }
    merged.push(task)
  }
  return { tasks: sortTasks(merged), removed: [...removed] }
}

export const taskProgress = (tasks: readonly StudyTask[]) => {
  const total = tasks.length
  const done = tasks.filter((task) => task.done).length
  const planned = tasks.reduce((sum, task) => sum + task.minutes, 0)
  const remaining = tasks.filter((task) => !task.done).reduce((sum, task) => sum + Math.max(0, task.minutes * 60 - task.spentSec), 0)
  return { total, done, ratio: total ? done / total : 0, plannedMinutes: planned, remainingMinutes: Math.ceil(remaining / 60) }
}

export const newManualTask = (tasks: readonly StudyTask[], page: number): StudyTask => {
  const highest = tasks.reduce((max, task) => Math.max(max, Number(task.number) || 0), 0)
  const number = String(highest + 1)
  return { id: `manual-${Date.now().toString(36)}-${number}`, number, title: '', minutes: 0, page: Math.max(1, page), done: false, spentSec: 0, manual: true }
}

export const formatClock = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds))
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  return hours ? `${hours}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}
