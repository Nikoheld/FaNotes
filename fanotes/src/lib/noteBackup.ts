export const NOTE_BACKUP_LIMIT = 40
export const NOTE_BACKUP_MAX_CHARS = 2 * 1024 * 1024
const BACKUP_ID = /^[a-zA-Z0-9._-]{1,96}$/u
const MAX_PATH = 500

export type NoteBackupSnapshot = {
  id: string
  notePath: string
  createdAt: string
  content: string
}

export type NoteBackupPolicy = {
  visible: boolean
  snapshot: boolean
  restore: boolean
}

export type NoteBackupAction =
  | { kind: 'snapshot' }
  | { kind: 'restore'; id: string }

const sanitizePath = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const path = value.replace(/\\/gu, '/').replace(/^\/+/u, '').trim()
  if (!path || path.length > MAX_PATH || path.includes('..') || path.includes('\0')) return ''
  return path
}

const sanitizeContent = (value: unknown) => {
  if (typeof value !== 'string') return ''
  return value.length > NOTE_BACKUP_MAX_CHARS ? value.slice(0, NOTE_BACKUP_MAX_CHARS) : value
}

const sanitizeCreatedAt = (value: unknown) => {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return new Date().toISOString()
}

export const newNoteBackupId = () => (
  `nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
)

export const emptyNoteBackups = (): NoteBackupSnapshot[] => []

export const sanitizeNoteBackup = (value: unknown): NoteBackupSnapshot | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const notePath = sanitizePath(raw.notePath)
  if (!notePath) return null
  const id = typeof raw.id === 'string' && BACKUP_ID.test(raw.id) ? raw.id : newNoteBackupId()
  return {
    id,
    notePath,
    createdAt: sanitizeCreatedAt(raw.createdAt),
    content: sanitizeContent(raw.content),
  }
}

export const parseNoteBackups = (value: unknown): NoteBackupSnapshot[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const snapshots: NoteBackupSnapshot[] = []
  for (const entry of value) {
    const snapshot = sanitizeNoteBackup(entry)
    if (!snapshot || seen.has(snapshot.id)) continue
    seen.add(snapshot.id)
    snapshots.push(snapshot)
  }
  return snapshots.slice(-NOTE_BACKUP_LIMIT)
}

export const serializeNoteBackups = (list: NoteBackupSnapshot[] | null | undefined) => (
  parseNoteBackups(list).map((snapshot) => ({
    id: snapshot.id,
    notePath: snapshot.notePath,
    createdAt: snapshot.createdAt,
    content: snapshot.content,
  }))
)

export const listNoteBackups = (list: unknown, notePath?: string) => {
  const snapshots = parseNoteBackups(list)
  const path = sanitizePath(notePath)
  if (!path) return snapshots
  return snapshots.filter((snapshot) => snapshot.notePath === path)
}

export const createNoteBackup = (
  list: unknown,
  input: { notePath: string; content: string; id?: string; createdAt?: string },
): { list: NoteBackupSnapshot[]; snapshot: NoteBackupSnapshot } => {
  const snapshot = sanitizeNoteBackup({
    id: input.id,
    notePath: input.notePath,
    content: input.content,
    createdAt: input.createdAt,
  })
  if (!snapshot) throw new Error('Das Backup konnte nicht erstellt werden.')
  const others = parseNoteBackups(list).filter((item) => item.id !== snapshot.id)
  return { list: [...others, snapshot].slice(-NOTE_BACKUP_LIMIT), snapshot }
}

export const restoreNoteBackup = (list: unknown, id: unknown, notePath?: string) => {
  if (typeof id !== 'string' || !BACKUP_ID.test(id)) return null
  const snapshot = listNoteBackups(list, notePath).find((item) => item.id === id)
  return snapshot ? snapshot.content : null
}

export const noteBackupControlPolicy = (experimentalOn: unknown, snapshotCount: unknown): NoteBackupPolicy => {
  const on = experimentalOn === true
  const count = typeof snapshotCount === 'number' && Number.isFinite(snapshotCount)
    ? Math.max(0, Math.floor(snapshotCount))
    : Array.isArray(snapshotCount) ? snapshotCount.length : 0
  if (!on) return { visible: false, snapshot: false, restore: false }
  return { visible: true, snapshot: true, restore: count >= 1 }
}

export const noteBackupActions = (experimentalOn: unknown, list: unknown, notePath?: string): NoteBackupAction[] => {
  const snapshots = listNoteBackups(list, notePath)
  const policy = noteBackupControlPolicy(experimentalOn, snapshots.length)
  if (!policy.visible || !policy.snapshot) return []
  const actions: NoteBackupAction[] = [{ kind: 'snapshot' }]
  if (policy.restore) {
    for (const snapshot of snapshots) actions.push({ kind: 'restore', id: snapshot.id })
  }
  return actions
}
