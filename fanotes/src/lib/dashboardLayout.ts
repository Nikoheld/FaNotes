/** Pure start-dashboard layout. No React and no settings I/O. */

export const DASHBOARD_CARD_KINDS = ['clock', 'date', 'note', 'subject'] as const
export type DashboardCardKind = (typeof DASHBOARD_CARD_KINDS)[number]

export type DashboardNote = { path: string; title: string }
export type DashboardSubject = { id: string; name: string; color?: string }

export type DashboardCard = {
  id: string
  kind: DashboardCardKind
  x: number
  y: number
  width: number
  height: number
  notePath: string
  subjectId: string
}

export type DashboardLayout = { cards: DashboardCard[] }

export type DashboardTarget = {
  kind: DashboardCardKind
  notePath?: string
  subjectId?: string
}

export type DashboardStartDecision = {
  surface: 'onboarding' | 'note'
  openLastNote: boolean
}

type TreeNode = {
  name?: string
  relativePath?: string
  kind?: string
  color?: string
  children?: TreeNode[]
}

const LAYOUT_VERSION = 1
const MIN_WIDTH = 200
const MAX_WIDTH = 900
const MIN_HEIGHT = 160
const MAX_HEIGHT = 640
const MAX_POSITION = 2400

const DEFAULT_CARDS: Array<Pick<DashboardCard, 'id' | 'kind' | 'x' | 'y' | 'width' | 'height'>> = [
  { id: 'clock', kind: 'clock', x: 20, y: 16, width: 680, height: 268 },
  { id: 'date', kind: 'date', x: 716, y: 16, width: 440, height: 268 },
  { id: 'note', kind: 'note', x: 20, y: 300, width: 720, height: 340 },
  { id: 'subject', kind: 'subject', x: 756, y: 300, width: 400, height: 340 },
]

const isKind = (value: unknown): value is DashboardCardKind => (
  typeof value === 'string' && (DASHBOARD_CARD_KINDS as readonly string[]).includes(value)
)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const finite = (value: unknown, fallback: number) => (
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
)

const cleanText = (value: unknown, max: number) => {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\0/gu, '').trim()
  return text.length > max ? text.slice(0, max) : text
}

const noteTitle = (name: string) => name.replace(/\.(md|markdown|pdf)$/iu, '')

export const dashboardNotesFromTree = (entries: TreeNode[] | null | undefined): DashboardNote[] => {
  const notes: DashboardNote[] = []
  const walk = (nodes: TreeNode[] | undefined) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const path = cleanText(node.relativePath, 1024)
      if (node.kind === 'file' && path && /\.(md|markdown|pdf)$/iu.test(path)) {
        notes.push({ path, title: noteTitle(cleanText(node.name, 240) || path) })
      }
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(entries ?? undefined)
  return notes
}

export const dashboardSubjectsFromTree = (entries: TreeNode[] | null | undefined): DashboardSubject[] => {
  if (!Array.isArray(entries)) return []
  const subjects: DashboardSubject[] = []
  for (const node of entries) {
    if (!node || node.kind !== 'folder') continue
    const id = cleanText(node.relativePath, 240)
    const name = cleanText(node.name, 240)
    if (!id || !name) continue
    const color = typeof node.color === 'string' && /^#[\da-f]{6}$/iu.test(node.color) ? node.color : undefined
    subjects.push(color ? { id, name, color } : { id, name })
  }
  return subjects
}

/** Onboarding stays first when it is required. Otherwise the last note opens. */
export const chooseStartSurface = (onboardingRequired: boolean): DashboardStartDecision => (
  onboardingRequired
    ? { surface: 'onboarding', openLastNote: false }
    : { surface: 'note', openLastNote: true }
)

export const formatDashboardClock = (time: Date) => {
  const hours = String(time.getHours()).padStart(2, '0')
  const minutes = String(time.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export const formatDashboardDate = (time: Date) => {
  const day = String(time.getDate()).padStart(2, '0')
  const month = String(time.getMonth() + 1).padStart(2, '0')
  return `${day}.${month}.${time.getFullYear()}`
}

export const formatDashboardLongDate = (time: Date, locale: string) => {
  try {
    return time.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })
  } catch {
    return formatDashboardDate(time)
  }
}

const withTargets = (card: DashboardCard, notes: DashboardNote[], subjects: DashboardSubject[]): DashboardCard => ({
  ...card,
  notePath: card.notePath || notes[0]?.path || '',
  subjectId: card.subjectId || subjects[0]?.id || '',
})

export const defaultDashboardLayout = (notes: DashboardNote[], subjects: DashboardSubject[]): DashboardLayout => ({
  cards: DEFAULT_CARDS.map((card) => withTargets({
    ...card,
    notePath: card.kind === 'note' ? notes[0]?.path || '' : '',
    subjectId: card.kind === 'subject' ? subjects[0]?.id || '' : '',
  }, notes, subjects)),
})

const replaceCard = (layout: DashboardLayout, id: string, update: (card: DashboardCard) => DashboardCard): DashboardLayout => ({
  cards: layout.cards.map((card) => card.id === id ? update(card) : card),
})

export const moveDashboardCard = (layout: DashboardLayout, id: string, x: number, y: number): DashboardLayout => (
  replaceCard(layout, id, (card) => ({
    ...card,
    x: clamp(finite(x, card.x), 0, MAX_POSITION),
    y: clamp(finite(y, card.y), 0, MAX_POSITION),
  }))
)

export const resizeDashboardCard = (layout: DashboardLayout, id: string, width: number, height: number): DashboardLayout => (
  replaceCard(layout, id, (card) => ({
    ...card,
    width: clamp(finite(width, card.width), MIN_WIDTH, MAX_WIDTH),
    height: clamp(finite(height, card.height), MIN_HEIGHT, MAX_HEIGHT),
  }))
)

export const retargetDashboardCard = (layout: DashboardLayout, id: string, target: DashboardTarget): DashboardLayout => (
  replaceCard(layout, id, (card) => ({
    ...card,
    kind: isKind(target.kind) ? target.kind : card.kind,
    notePath: typeof target.notePath === 'string' ? cleanText(target.notePath, 1024) : card.notePath,
    subjectId: typeof target.subjectId === 'string' ? cleanText(target.subjectId, 240) : card.subjectId,
  }))
)

export const addDashboardCard = (
  layout: DashboardLayout,
  kind: DashboardCardKind,
  notes: DashboardNote[],
  subjects: DashboardSubject[],
): DashboardLayout => {
  const used = new Set(layout.cards.map((card) => card.id))
  let number = layout.cards.length + 1
  while (used.has(`card-${number}`)) number += 1
  const offset = layout.cards.length
  const card = withTargets({
    id: `card-${number}`,
    kind: isKind(kind) ? kind : 'clock',
    x: clamp(48 + (offset % 6) * 28, 0, MAX_POSITION),
    y: clamp(48 + (offset % 5) * 28, 0, MAX_POSITION),
    width: 320,
    height: 220,
    notePath: '',
    subjectId: '',
  }, notes, subjects)
  return { cards: [...layout.cards, card] }
}

export const removeDashboardCard = (layout: DashboardLayout, id: string): DashboardLayout => ({
  cards: layout.cards.filter((card) => card.id !== id),
})

/** The note card opens through the same callback the dashboard button uses. */
export const activateDashboardNote = (card: DashboardCard, onOpenNote: (notePath: string) => void) => {
  if (card.kind !== 'note' || !card.notePath) return
  onOpenNote(card.notePath)
}

export const serializeDashboardLayout = (layout: DashboardLayout): string => JSON.stringify({
  version: LAYOUT_VERSION,
  cards: layout.cards.map((card) => ({
    id: card.id,
    kind: card.kind,
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
    notePath: card.notePath,
    subjectId: card.subjectId,
  })),
})

const sanitizeCard = (value: unknown): DashboardCard | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = cleanText(raw.id, 40)
  if (!/^[A-Za-z0-9-]{1,40}$/u.test(id) || !isKind(raw.kind)) return null
  return {
    id,
    kind: raw.kind,
    x: clamp(finite(raw.x, 32), 0, MAX_POSITION),
    y: clamp(finite(raw.y, 32), 0, MAX_POSITION),
    width: clamp(finite(raw.width, 320), MIN_WIDTH, MAX_WIDTH),
    height: clamp(finite(raw.height, 220), MIN_HEIGHT, MAX_HEIGHT),
    notePath: cleanText(raw.notePath, 1024),
    subjectId: cleanText(raw.subjectId, 240),
  }
}

/** A missing payload is the default set. A saved payload reloads those cards. */
export const parseDashboardLayout = (
  payload: unknown,
  notes: DashboardNote[],
  subjects: DashboardSubject[],
): DashboardLayout => {
  if (payload == null || payload === '') return defaultDashboardLayout(notes, subjects)
  let raw: unknown = payload
  if (typeof payload === 'string') {
    try {
      raw = JSON.parse(payload)
    } catch {
      return defaultDashboardLayout(notes, subjects)
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultDashboardLayout(notes, subjects)
  const record = raw as { version?: unknown; cards?: unknown }
  if (record.version !== LAYOUT_VERSION || !Array.isArray(record.cards)) return defaultDashboardLayout(notes, subjects)
  const seen = new Set<string>()
  const cards: DashboardCard[] = []
  for (const entry of record.cards) {
    const card = sanitizeCard(entry)
    if (!card || seen.has(card.id)) continue
    seen.add(card.id)
    cards.push(card)
  }
  return { cards }
}
