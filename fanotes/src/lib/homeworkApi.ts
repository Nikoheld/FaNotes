import {
  parseHomeworkMarkdown,
  type HomeworkDocument,
  type HomeworkTask,
} from './homeworkStore'

export const HOMEWORK_API_HOST = 'fanotes.fasrv.ch'
export const HOMEWORK_API_ORIGIN = `https://${HOMEWORK_API_HOST}`
export const HOMEWORK_API_MIN_SECRET_LENGTH = 12
export const HOMEWORK_CHANNEL_ID_PATTERN = /^[a-f0-9]{32}$/u

export type HomeworkApiTask = {
  id: string
  title: string
  notes: string
  subject: string
  dueDate: string | null
  dueTime: string | null
  done: boolean
  kind: HomeworkTask['kind']
  priority: HomeworkTask['priority']
  createdAt: string
  updatedAt: string
}

export type HomeworkApiPayload = {
  schemaVersion: 1
  tasks: HomeworkApiTask[]
}

export const homeworkTaskToApiItem = (task: HomeworkTask): HomeworkApiTask => ({
  id: task.id,
  title: task.title,
  notes: task.notes,
  subject: task.subject,
  dueDate: task.dueDate,
  dueTime: task.dueTime,
  done: task.done,
  kind: task.kind,
  priority: task.priority,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
})

export const homeworkDocumentToApiPayload = (document: HomeworkDocument): HomeworkApiPayload => ({
  schemaVersion: 1,
  tasks: document.tasks.map(homeworkTaskToApiItem),
})

export const homeworkMarkdownToApiPayload = (markdown: string): HomeworkApiPayload => (
  homeworkDocumentToApiPayload(parseHomeworkMarkdown(markdown))
)

export const homeworkApiQueryPath = (channelId: string) => `/api/v1/homework/${channelId}`

export const homeworkApiQueryUrl = (channelId: string, origin = HOMEWORK_API_ORIGIN) => (
  `${origin.replace(/\/$/u, '')}${homeworkApiQueryPath(channelId)}`
)

export const generateHomeworkApiChannelId = () => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const generateHomeworkApiSecret = () => {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export const homeworkApiSecretReady = (secret: string) => (
  typeof secret === 'string' && secret.trim().length >= HOMEWORK_API_MIN_SECRET_LENGTH
)

export const homeworkApiOriginFromLocation = (platform?: string) => {
  if (platform === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return HOMEWORK_API_ORIGIN
}

export const publishHomeworkList = async (input: {
  enabled: boolean
  channelId: string
  secret: string
  previousSecret?: string
  document: HomeworkDocument
  origin?: string
}): Promise<{ ok: boolean; status: number }> => {
  if (!HOMEWORK_CHANNEL_ID_PATTERN.test(input.channelId)) return { ok: false, status: 400 }
  const secret = input.secret.trim()
  const previousSecret = input.previousSecret?.trim()
  const authorizationSecret = previousSecret || secret
  const response = await fetch(homeworkApiQueryUrl(input.channelId, input.origin), {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-FaNotes-Homework': '1',
      ...(authorizationSecret ? { Authorization: `Bearer ${authorizationSecret}` } : {}),
    },
    body: JSON.stringify({
      enabled: input.enabled,
      secret,
      previousSecret: previousSecret || undefined,
      tasks: input.enabled ? homeworkDocumentToApiPayload(input.document).tasks : [],
    }),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  return { ok: response.ok, status: response.status }
}
