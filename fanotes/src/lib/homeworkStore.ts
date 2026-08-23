export type HomeworkKind = 'homework' | 'appointment'
export type HomeworkPriority = 'normal' | 'high'

export type HomeworkTask = {
  id: string
  title: string
  notes: string
  subject: string
  dueDate: string | null
  dueTime: string | null
  done: boolean
  kind: HomeworkKind
  priority: HomeworkPriority
  createdAt: string
  updatedAt: string
}

export type HomeworkDocument = {
  version: 1
  tasks: HomeworkTask[]
  /** Ids last seen on the published API replica. Local-only; never sent as a task list. */
  publishedIds?: string[]
}

export type HomeworkTaskPatch = Partial<Pick<HomeworkTask, 'title' | 'notes' | 'subject' | 'dueDate' | 'dueTime' | 'done' | 'kind' | 'priority'>>

export const HOMEWORK_NOTE_PATH = 'Hausaufgaben.md'
export const HOMEWORK_NOTE_TITLE = 'Hausaufgaben'

const MARKER_START = '<!-- fanotes-homework-v1'
const MARKER_END = '-->'

const emptyDocument = (): HomeworkDocument => ({ version: 1, tasks: [] })

const isIsoDate = (value: unknown): value is string => (
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
)

const isIsoTime = (value: unknown): value is string => (
  typeof value === 'string' && /^\d{2}:\d{2}$/u.test(value)
)

const sanitizeTask = (raw: unknown): HomeworkTask | null => {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<HomeworkTask>
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  if (!title || title.length > 240) return null
  const id = typeof candidate.id === 'string' && candidate.id.trim()
    ? candidate.id.trim().slice(0, 80)
    : crypto.randomUUID()
  const now = new Date().toISOString()
  return {
    id,
    title: title.slice(0, 240),
    notes: typeof candidate.notes === 'string' ? candidate.notes.slice(0, 4_000) : '',
    subject: typeof candidate.subject === 'string' ? candidate.subject.trim().slice(0, 80) : '',
    dueDate: isIsoDate(candidate.dueDate) ? candidate.dueDate : null,
    dueTime: isIsoTime(candidate.dueTime) ? candidate.dueTime : null,
    done: Boolean(candidate.done),
    kind: candidate.kind === 'appointment' ? 'appointment' : 'homework',
    priority: candidate.priority === 'high' ? 'high' : 'normal',
    createdAt: typeof candidate.createdAt === 'string' && Date.parse(candidate.createdAt)
      ? candidate.createdAt
      : now,
    updatedAt: typeof candidate.updatedAt === 'string' && Date.parse(candidate.updatedAt)
      ? candidate.updatedAt
      : now,
  }
}

const sanitizePublishedIds = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const ids = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 80))
    .slice(0, 2_000)
  return ids.length ? ids : undefined
}

export const parseHomeworkMarkdown = (markdown: string): HomeworkDocument => {
  if (typeof markdown !== 'string' || !markdown.includes(MARKER_START)) return emptyDocument()
  const start = markdown.indexOf(MARKER_START)
  const end = markdown.indexOf(MARKER_END, start + MARKER_START.length)
  if (start < 0 || end < 0) return emptyDocument()
  const jsonText = markdown.slice(start + MARKER_START.length, end).trim()
  try {
    const parsed = JSON.parse(jsonText) as Partial<HomeworkDocument>
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(sanitizeTask).filter((task): task is HomeworkTask => Boolean(task))
      : []
    const publishedIds = sanitizePublishedIds(parsed.publishedIds)
    return { version: 1, tasks, ...(publishedIds ? { publishedIds } : {}) }
  } catch {
    return emptyDocument()
  }
}

export const serializeHomeworkMarkdown = (document: HomeworkDocument): string => {
  const publishedIds = sanitizePublishedIds(document.publishedIds)
  const payload: HomeworkDocument = {
    version: 1,
    tasks: document.tasks.map((task) => sanitizeTask(task)).filter((task): task is HomeworkTask => Boolean(task)),
    ...(publishedIds ? { publishedIds } : {}),
  }
  const json = JSON.stringify(payload, null, 2)
  return [
    `# ${HOMEWORK_NOTE_TITLE}`,
    '',
    'Diese Notiz wird von der **Hausaufgaben-Ansicht** in FaNotes verwaltet.',
    'Trage Aufgaben und Termine dort ein – sie bleiben in deinem lokalen Vault.',
    '',
    `${MARKER_START}`,
    json,
    MARKER_END,
    '',
  ].join('\n')
}

export const createHomeworkTask = (input: {
  title: string
  notes?: string
  subject?: string
  dueDate?: string | null
  dueTime?: string | null
  kind?: HomeworkKind
  priority?: HomeworkPriority
  done?: boolean
  id?: string
}): HomeworkTask => {
  const now = new Date().toISOString()
  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 80) : crypto.randomUUID(),
    title: input.title.trim().slice(0, 240),
    notes: (input.notes ?? '').slice(0, 4_000),
    subject: (input.subject ?? '').trim().slice(0, 80),
    dueDate: isIsoDate(input.dueDate) ? input.dueDate : null,
    dueTime: isIsoTime(input.dueTime) ? input.dueTime : null,
    done: Boolean(input.done),
    kind: input.kind === 'appointment' ? 'appointment' : 'homework',
    priority: input.priority === 'high' ? 'high' : 'normal',
    createdAt: now,
    updatedAt: now,
  }
}

const withPublishedIds = (document: HomeworkDocument, tasks: HomeworkTask[]): HomeworkDocument => ({
  version: 1,
  tasks,
  ...(document.publishedIds ? { publishedIds: document.publishedIds } : {}),
})

export const rememberPublishedHomeworkIds = (document: HomeworkDocument, ids: readonly string[]): HomeworkDocument => {
  const publishedIds = sanitizePublishedIds([...ids])
  return {
    version: 1,
    tasks: document.tasks,
    ...(publishedIds ? { publishedIds } : {}),
  }
}

export const addHomeworkTask = (document: HomeworkDocument, input: Parameters<typeof createHomeworkTask>[0]) => {
  const task = createHomeworkTask(input)
  return { document: withPublishedIds(document, [task, ...document.tasks]), task }
}

export const patchHomeworkTask = (
  document: HomeworkDocument,
  id: string,
  patch: HomeworkTaskPatch,
): HomeworkDocument | null => {
  const index = document.tasks.findIndex((task) => task.id === id)
  if (index < 0) return null
  const current = document.tasks[index]
  const next = sanitizeTask({
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  })
  if (!next) return null
  const tasks = document.tasks.slice()
  tasks[index] = next
  return withPublishedIds(document, tasks)
}

/** Appointments and homework share `done` — the API must be able to complete both. */
export const setHomeworkTaskDone = (document: HomeworkDocument, id: string, done: boolean) => (
  patchHomeworkTask(document, id, { done })
)

export const removeHomeworkTask = (document: HomeworkDocument, id: string): HomeworkDocument | null => {
  if (!document.tasks.some((task) => task.id === id)) return null
  return withPublishedIds(document, document.tasks.filter((task) => task.id !== id))
}

const newerTimestamp = (left: string, right: string) => {
  const leftAt = Date.parse(left)
  const rightAt = Date.parse(right)
  if (!Number.isFinite(leftAt)) return false
  if (!Number.isFinite(rightAt)) return true
  return leftAt >= rightAt
}

export const mergeHomeworkFromRemote = (
  local: HomeworkDocument,
  remoteTasks: HomeworkTask[],
): HomeworkDocument => {
  const published = new Set(sanitizePublishedIds(local.publishedIds) ?? [])
  const localById = new Map(local.tasks.map((task) => [task.id, task]))
  const remoteById = new Map(remoteTasks.map((task) => [task.id, task]))
  const merged: HomeworkTask[] = []
  const seen = new Set<string>()
  for (const remote of remoteTasks) {
    seen.add(remote.id)
    const current = localById.get(remote.id)
    merged.push(current && newerTimestamp(current.updatedAt, remote.updatedAt) ? current : remote)
  }
  for (const localTask of local.tasks) {
    if (seen.has(localTask.id)) continue
    if (published.has(localTask.id) && !remoteById.has(localTask.id)) continue
    merged.push(localTask)
  }
  return withPublishedIds({ ...local, tasks: merged }, merged)
}

export const taskDueTimestamp = (task: HomeworkTask): number | null => {
  if (!task.dueDate) return null
  const time = task.dueTime && isIsoTime(task.dueTime) ? task.dueTime : '23:59'
  const parsed = Date.parse(`${task.dueDate}T${time}:00`)
  return Number.isFinite(parsed) ? parsed : null
}

export type HomeworkBucket = 'overdue' | 'today' | 'upcoming' | 'undated' | 'done'

export const classifyHomeworkTask = (task: HomeworkTask, now = new Date()): HomeworkBucket => {
  if (task.done) return 'done'
  const due = taskDueTimestamp(task)
  if (due === null) return 'undated'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const endOfToday = startOfToday + 24 * 60 * 60 * 1000 - 1
  if (due < startOfToday) return 'overdue'
  if (due <= endOfToday) return 'today'
  return 'upcoming'
}

export const sortHomeworkTasks = (tasks: HomeworkTask[]): HomeworkTask[] => (
  [...tasks].sort((left, right) => {
    if (left.done !== right.done) return left.done ? 1 : -1
    if (left.priority !== right.priority) return left.priority === 'high' ? -1 : 1
    const leftDue = taskDueTimestamp(left)
    const rightDue = taskDueTimestamp(right)
    if (leftDue === null && rightDue === null) return left.title.localeCompare(right.title, 'de')
    if (leftDue === null) return 1
    if (rightDue === null) return -1
    if (leftDue !== rightDue) return leftDue - rightDue
    return left.title.localeCompare(right.title, 'de')
  })
)
