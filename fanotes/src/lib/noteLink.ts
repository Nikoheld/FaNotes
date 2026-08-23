export const NOTE_LINK_STYLE_IDS = ['symbol', 'text', 'symbol-text'] as const

export type NoteLinkStyleId = (typeof NOTE_LINK_STYLE_IDS)[number]

export type NoteLinkStyle = {
  id: NoteLinkStyleId
  label: string
  appearance: 'symbol' | 'text' | 'symbol-text'
  glyph: 'link' | null
}

export type NoteLinkRecord = {
  id: string
  sourcePath: string
  targetPath: string
  page: number
  x: number
  y: number
  style: NoteLinkStyleId
  label: string
}

export type NoteNavState = {
  stack: string[]
  current: string
}

/** Catalog shown in the style picker. Symbol and Text stay visually distinct. */
export const NOTE_LINK_STYLES: readonly NoteLinkStyle[] = [
  { id: 'symbol', label: 'Symbol', appearance: 'symbol', glyph: 'link' },
  { id: 'text', label: 'Text', appearance: 'text', glyph: null },
  { id: 'symbol-text', label: 'Symbol und Text', appearance: 'symbol-text', glyph: 'link' },
]

const STYLE_BY_ID = new Map(NOTE_LINK_STYLES.map((style) => [style.id, style]))
const NOTE_LINK_ID = /^[a-zA-Z0-9._-]{1,96}$/u
const MAX_PATH = 500
const MAX_LABEL = 80

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export const isNoteLinkStyleId = (value: unknown): value is NoteLinkStyleId => (
  value === 'symbol' || value === 'text' || value === 'symbol-text'
)

export const noteLinkStyleById = (value: unknown): NoteLinkStyle => (
  STYLE_BY_ID.get(isNoteLinkStyleId(value) ? value : 'symbol') ?? NOTE_LINK_STYLES[0]
)

/** Stable appearance token written with the record. Symbol and Text never collide. */
export const noteLinkAppearanceToken = (style: unknown): NoteLinkStyle['appearance'] => (
  noteLinkStyleById(style).appearance
)

export const noteStemName = (relativePath: string) => {
  const base = String(relativePath || '').replace(/\\/gu, '/').split('/').pop() || 'Notiz'
  return base.replace(/\.(md|markdown|famd|pdf)$/iu, '') || 'Notiz'
}

export const linkedNoteParent = (sourcePath: string) => {
  const normalized = String(sourcePath || '').replace(/\\/gu, '/').replace(/^\/+/u, '')
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

export const linkedNotePreferredName = (sourcePath: string) => `${noteStemName(sourcePath)} · Notiz`

export const linkedNoteDefaultLabel = (targetPath: string) => noteStemName(targetPath)

const sanitizePath = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const path = value.replace(/\\/gu, '/').replace(/^\/+/u, '').trim()
  if (!path || path.length > MAX_PATH || path.includes('..') || path.includes('\0')) return ''
  return path
}

const sanitizeLabel = (value: unknown, fallback: string) => {
  const label = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (!label) return fallback.slice(0, MAX_LABEL)
  return label.slice(0, MAX_LABEL)
}

const sanitizePage = (value: unknown) => {
  const page = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) return 1
  return page
}

const sanitizeCoord = (value: unknown) => {
  if (!isFiniteNumber(value)) return 0.5
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export const newNoteLinkId = () => (
  `nl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
)

export const sanitizeNoteLink = (value: unknown): NoteLinkRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const sourcePath = sanitizePath(raw.sourcePath)
  const targetPath = sanitizePath(raw.targetPath)
  if (!sourcePath || !targetPath || sourcePath === targetPath) return null
  if (!/\.md$/iu.test(targetPath)) return null
  const id = typeof raw.id === 'string' && NOTE_LINK_ID.test(raw.id) ? raw.id : newNoteLinkId()
  const style = isNoteLinkStyleId(raw.style) ? raw.style : 'symbol'
  const label = sanitizeLabel(raw.label, linkedNoteDefaultLabel(targetPath))
  return {
    id,
    sourcePath,
    targetPath,
    page: sanitizePage(raw.page),
    x: sanitizeCoord(raw.x),
    y: sanitizeCoord(raw.y),
    style,
    label,
  }
}

export const parseNoteLinks = (value: unknown): NoteLinkRecord[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const links: NoteLinkRecord[] = []
  for (const entry of value) {
    const link = sanitizeNoteLink(entry)
    if (!link || seen.has(link.id)) continue
    seen.add(link.id)
    links.push(link)
  }
  return links
}

export const serializeNoteLinks = (links: NoteLinkRecord[] | null | undefined) => (
  parseNoteLinks(links).map((link) => ({
    id: link.id,
    sourcePath: link.sourcePath,
    targetPath: link.targetPath,
    page: link.page,
    x: link.x,
    y: link.y,
    style: link.style,
    label: link.label,
    appearance: noteLinkAppearanceToken(link.style),
  }))
)

export const placeNewNoteLink = (
  input: {
    sourcePath: string
    page?: number
    x: number
    y: number
    style?: unknown
    label?: string
    id?: string
  },
  created: { targetPath: string },
): NoteLinkRecord => {
  const sourcePath = sanitizePath(input.sourcePath)
  const targetPath = sanitizePath(created?.targetPath)
  if (!sourcePath) throw new Error('Die Verlinkung braucht eine Quellnotiz.')
  if (!targetPath || targetPath === sourcePath || !/\.md$/iu.test(targetPath)) {
    throw new Error('Die Verlinkung muss auf eine neue Markdown-Notiz zeigen.')
  }
  const link = sanitizeNoteLink({
    id: input.id,
    sourcePath,
    targetPath,
    page: input.page ?? 1,
    x: input.x,
    y: input.y,
    style: input.style,
    label: input.label ?? linkedNoteDefaultLabel(targetPath),
  })
  if (!link) throw new Error('Die Verlinkung konnte nicht gesetzt werden.')
  return link
}

export const activateNoteLink = (link: NoteLinkRecord | null | undefined) => {
  const target = sanitizePath(link?.targetPath)
  const source = sanitizePath(link?.sourcePath)
  if (!target || !source || target === source || !/\.md$/iu.test(target)) return null
  return target
}

export const restyleNoteLink = (link: NoteLinkRecord, style: unknown): NoteLinkRecord => {
  const next = sanitizeNoteLink({ ...link, style })
  if (!next) throw new Error('Der Verlinkungsstil ist ungültig.')
  return next
}

/** Drop one placed marker. The linked note file stays in the vault. */
export const removeNoteLink = (links: NoteLinkRecord[] | null | undefined, id: string): NoteLinkRecord[] => {
  const list = parseNoteLinks(links)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key || !NOTE_LINK_ID.test(key)) throw new Error('Diese Verlinkung gibt es nicht.')
  const next = list.filter((link) => link.id !== key)
  if (next.length === list.length) throw new Error('Diese Verlinkung gibt es nicht.')
  return next
}

export const emptyNoteNavStack = (): string[] => []

export const followNoteNav = (stack: string[] | null | undefined, fromPath: string, toPath: string): NoteNavState => {
  const currentStack = Array.isArray(stack) ? stack.filter((path) => typeof path === 'string' && path) : []
  const from = sanitizePath(fromPath)
  const to = sanitizePath(toPath)
  if (!to) return { stack: currentStack, current: from }
  if (!from || from === to) return { stack: currentStack, current: to }
  return { stack: [...currentStack, from], current: to }
}

export const goBackNoteNav = (stack: string[] | null | undefined, current: string): NoteNavState => {
  const currentStack = Array.isArray(stack) ? stack.filter((path) => typeof path === 'string' && path) : []
  const here = sanitizePath(current)
  if (!currentStack.length) return { stack: currentStack, current: here }
  const next = [...currentStack]
  const previous = sanitizePath(next.pop())
  if (!previous) return { stack: next, current: here }
  return { stack: next, current: previous }
}

export const noteLinkPointFromRect = (
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
) => {
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  return {
    x: sanitizeCoord((clientX - rect.left) / width),
    y: sanitizeCoord((clientY - rect.top) / height),
  }
}

type NoteLinkHitBox = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

type NoteLinkHitPage = {
  getBoundingClientRect: () => NoteLinkHitBox
  dataset?: { pdfPage?: string }
  getAttribute?: (name: string) => string | null
}

type NoteLinkHitHost = {
  querySelectorAll?: (selector: string) => ArrayLike<NoteLinkHitPage>
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number }
  closest?: (selector: string) => NoteLinkHitHost | null
}

const pageIndexFromNode = (page: NoteLinkHitPage) => {
  const raw = page.dataset?.pdfPage ?? page.getAttribute?.('data-pdf-page') ?? ''
  const pageIndex = Number(raw)
  return Number.isSafeInteger(pageIndex) && pageIndex >= 1 ? pageIndex : 1
}

/** Pages live on `.unified-paper`, not on the overlay node (it has no descendants). */
export const noteLinkPageHost = (overlay: NoteLinkHitHost) => (
  overlay.closest?.('.unified-paper') ?? null
)

/** Resolve a click on the overlay to a PDF page (or page 1 on markdown paper). */
export const noteLinkPageAtPoint = (
  clientX: number,
  clientY: number,
  overlay: NoteLinkHitHost,
): { page: number; x: number; y: number } => {
  const paper = noteLinkPageHost(overlay)
  const pages = paper?.querySelectorAll?.('[data-pdf-page]') ?? []
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    const rect = page.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    return { page: pageIndexFromNode(page), ...noteLinkPointFromRect(clientX, clientY, rect) }
  }
  const fallback = paper?.getBoundingClientRect?.() ?? overlay.getBoundingClientRect?.() ?? {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  }
  return { page: 1, ...noteLinkPointFromRect(clientX, clientY, fallback) }
}
