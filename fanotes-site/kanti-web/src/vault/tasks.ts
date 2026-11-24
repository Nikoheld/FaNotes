// Own tasks (Hausaufgaben.md): ordering and buckets as in android/core desk/HomeworkPlanner.kt.
import { newId, type HomeworkDocument, type HomeworkTask } from './files'

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'undated' | 'done'

export const classifyTask = (task: HomeworkTask, today: string): TaskBucket => {
  if (task.done) return 'done'
  if (!task.dueDate) return 'undated'
  return task.dueDate < today ? 'overdue' : task.dueDate === today ? 'today' : 'upcoming'
}

/** Due date with the time inside its day (no time = the end of the day), or null. */
const dueMoment = (task: HomeworkTask): string | null => (task.dueDate ? `${task.dueDate}T${task.dueTime || '23:59'}` : null)

/** Open tasks first, important ones before normal, then the earliest due moment, then the title. */
export const sortTasks = (tasks: HomeworkTask[]): HomeworkTask[] => [...tasks].sort((left, right) => {
  if (left.done !== right.done) return left.done ? 1 : -1
  if (left.priority !== right.priority) return left.priority === 'high' ? -1 : 1
  const a = dueMoment(left)
  const b = dueMoment(right)
  if (a === null && b === null) return left.title.localeCompare(right.title, 'de', { sensitivity: 'base' })
  if (a === null) return 1
  if (b === null) return -1
  return a === b ? left.title.localeCompare(right.title, 'de', { sensitivity: 'base' }) : a < b ? -1 : 1
})

/** Fields the composer accepts: a trimmed title of at most 240 characters, a real date and time, or null for a blank title. */
export const prepareTask = (input: { title: string; notes?: string; subject?: string; dueDate?: string; dueTime?: string; kind?: string; priority?: string }) => {
  const title = input.title.trim().slice(0, 240)
  if (!title) return null
  const date = (input.dueDate || '').trim()
  const time = (input.dueTime || '').trim()
  return {
    title,
    notes: (input.notes || '').slice(0, 4000),
    subject: (input.subject || '').trim().slice(0, 80),
    dueDate: /^\d{4}-\d{2}-\d{2}$/u.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? date : null,
    dueTime: /^([01]\d|2[0-3]):[0-5]\d$/u.test(time) ? time : null,
    kind: input.kind === 'appointment' ? 'appointment' as const : 'homework' as const,
    priority: input.priority === 'high' ? 'high' as const : 'normal' as const,
  }
}

// ── Changes to the task document (pure; the vault applies them to the file's fresh content) ──


export type TaskInput = NonNullable<ReturnType<typeof prepareTask>>

/** Adds a task or replaces the one with the same id (Kotlin saveHomeworkTask). */
export const upsertTask = (document: HomeworkDocument, input: TaskInput, id: string | null, now: string): HomeworkDocument => {
  const existing = id ? document.tasks.find((task) => task.id === id) : undefined
  if (existing) return { ...document, tasks: document.tasks.map((task) => (task.id === existing.id ? { ...existing, ...input, updatedAt: now, createdAt: existing.createdAt || now } : task)) }
  const task = { id: id || newId(), ...input, done: false, createdAt: now, updatedAt: now }
  return { ...document, tasks: [...document.tasks, task] }
}

export const deleteTask = (document: HomeworkDocument, id: string): HomeworkDocument => ({ ...document, tasks: document.tasks.filter((task) => task.id !== id) })

export const setTaskDone = (document: HomeworkDocument, id: string, done: boolean, now: string): HomeworkDocument => ({
  ...document, tasks: document.tasks.map((task) => (task.id === id ? { ...task, done, updatedAt: now } : task)),
})

/** A local copy of one school assignment; null when that title, subject and due date are already there (Kotlin appendSchoolAssignment). */
export const appendSchoolAssignment = (document: HomeworkDocument, input: { title: string; subject: string; dueDate: string | null; notes: string }, id: string, now: string): HomeworkDocument | null => {
  if (document.tasks.some((task) => task.title === input.title && task.subject === input.subject && task.dueDate === input.dueDate)) return null
  const task = { id, title: input.title, notes: input.notes.slice(0, 4000), subject: input.subject, dueDate: input.dueDate, dueTime: null, done: false, kind: 'homework' as const, priority: 'normal' as const, createdAt: now, updatedAt: now }
  return { ...document, tasks: [...document.tasks, task] }
}
