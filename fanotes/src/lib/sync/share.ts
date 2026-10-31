// Public note and folder links. This is not vault sync: encrypted device sync
// stays on /api/v1/sync. A share uploads the readable title, the markdown, and
// a public drawing of the handwriting. Undo history stays in the vault.
// Collapsed sections are opened first so the page matches the sheet with every
// band open: hidden ink comes back, and the text column uses the editor's pad.

import { deserializeSections, expandSection, readSectionTitle, sectionPoint, sortSections, type InkSection } from '../inkSections'
import { keepMarkOnPage } from '../noteCanvas'
import type { StrokePoint } from '../../../../src/types'

export const SHARE_HOST = 'fanotes.fasrv.ch'
export const SHARE_ORIGIN = `https://${SHARE_HOST}`
export const SHARE_API_PATH = '/api/v1/share'
export const SHARE_VIEW_PATH = '/share/'

export type ShareMode = 'copy' | 'live' | 'edit'

export type ShareInkPoint = { x: number; y: number }

export type ShareInkStroke = {
  color: string
  width: number
  opacity: number
  points: ShareInkPoint[]
}

/**
 * One open band on the public sheet. `top` and `bodyTop` are 0–1 of the page.
 * `width` is the right edge, 0–1, and is omitted when it is the sheet edge.
 * Every band is open: a collapsed body was expanded before upload.
 */
export type ShareInkSection = {
  id: string
  parentId?: string
  title?: string
  top: number
  bodyTop: number
  left?: number
  width?: number
}

/**
 * Where typed lines sit on the sheet, in the same pixels as the editor.
 * `column` is the text pane width. The pad is inside that pane.
 */
export type ShareTextColumn = {
  originX: number
  originY: number
  column: number
  padX: number
  padY: number
  fontSize: number
  lineHeight: number
}

/** Font size, line height, and content width from the settings that wrote the note. */
export type ShareTextLayout = {
  fontSize?: number
  lineHeight?: number
  contentWidth?: number
  readable?: boolean
}

/** 0–1 strokes on the saved page. Pressure samples and undo history are omitted. */
export type ShareInk = {
  width: number
  height: number
  strokes: ShareInkStroke[]
  sections?: ShareInkSection[]
}

export type ShareTextField = {
  page: number
  x: number
  y: number
  width: number
  fontSize: number
  text: string
}

export type ShareEntry = {
  path: string
  kind: 'file' | 'folder'
  content?: string
  ink?: ShareInk
  textFields?: ShareTextField[]
  textColumn?: ShareTextColumn
}

export type ShareVaultNode = {
  relativePath: string
  kind: 'file' | 'folder'
  extension?: string
  children?: ShareVaultNode[]
}

export type ShareNote = {
  path: string
  title: string
  content: string
  ink?: ShareInk
  textFields?: ShareTextField[]
  textColumn?: ShareTextColumn
}

export type SharePayload = {
  schemaVersion: 1
  id: string
  mode: ShareMode
  kind: 'note' | 'folder'
  rootPath: string
  title: string
  notes: ShareNote[]
  updatedAt: string
  stopped?: boolean
  /** People who joined an editable share. Copy and live shares leave this empty. */
  editors?: { name: string; account?: string }[]
  revision?: number
}

export type ShareLinkRecord = {
  id: string
  link: string
  title: string
  rootPath: string
  mode: ShareMode
  kind: 'note' | 'folder'
  createdAt: string
  stopped: boolean
  /** Names the sharer can see. Empty until someone joins an editable share. */
  editors?: string[]
}

export type ShareDirectory = { shares: ShareLinkRecord[] }

export type ShareHttpRequest = {
  method: 'PUT' | 'GET' | 'DELETE' | 'POST'
  url: string
  headers: Record<string, string>
  body: string
}

export type ShareHttpResponse = { status: number; body: string }

/** Narrow upload/fetch boundary. The client builds the request; the port only sends it. */
export type SharePort = {
  exchange(request: ShareHttpRequest): Promise<ShareHttpResponse>
}

const normalizePath = (path: string) => path.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '')

const isInsideFolder = (path: string, folder: string) => {
  const note = normalizePath(path)
  const root = normalizePath(folder)
  return note === root || note.startsWith(`${root}/`)
}

export const shareNoteTitle = (path: string, content: string) => {
  for (const line of content.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(line)
    if (heading) return heading[1].trim()
  }
  const base = normalizePath(path).split('/').pop() || path
  return base.replace(/\.md$/iu, '')
}

export const shareViewUrl = (id: string, origin = SHARE_ORIGIN) => (
  `${origin.replace(/\/$/u, '')}${SHARE_VIEW_PATH}?id=${encodeURIComponent(id)}`
)

export const shareApiUrl = (id: string, origin = SHARE_ORIGIN) => (
  `${origin.replace(/\/$/u, '')}${SHARE_API_PATH}/${encodeURIComponent(id)}`
)

export const resolveShareOrigin = () => {
  const platform = typeof window !== 'undefined' ? window.fanotes?.platform : undefined
  if ((platform === 'web' || platform === 'browser-preview') && typeof window !== 'undefined' && window.location?.origin?.startsWith('http')) {
    return window.location.origin
  }
  return SHARE_ORIGIN
}

export const createShareId = () => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const SHARE_INK_STROKES = 2500
const SHARE_INK_POINTS = 40_000

const finiteNumber = (value: unknown) => {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

const roundUnit = (value: number) => Math.round(Math.max(-0.25, Math.min(1.25, value)) * 10000) / 10000

const drawingRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.drawingJson !== 'string') return record
  try {
    const parsed = JSON.parse(record.drawingJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

const thinPoints = (points: ShareInkPoint[], budget: number) => {
  if (points.length <= budget) return points
  const step = Math.ceil(points.length / budget)
  const next: ShareInkPoint[] = []
  for (let index = 0; index < points.length; index += step) next.push(points[index])
  const last = points[points.length - 1]
  if (next[next.length - 1] !== last) next.push(last)
  return next
}

/** Editor column. Matches `--paper-width` (at most 900) and the text pad. */
const SHARE_COLUMN_MAX = 900
const SHARE_COLUMN_MIN = 540
const SHARE_COLUMN = 820
const SHARE_PAD_X = 72
const SHARE_PAD_Y = 78
const SHARE_TEXT_SLACK = 144
const SHARE_FONT_SIZE = 16
const SHARE_LINE_HEIGHT = 1.72
const SHARE_SECTIONS = 80

type ShareStrokeDraft = {
  color?: unknown
  width?: unknown
  baseWidth?: unknown
  opacity?: unknown
  points: StrokePoint[]
}

const readOrigin = (value: unknown) => {
  const number = finiteNumber(value)
  if (number === null || number < 0) return 0
  return Math.min(20000, Math.round(number))
}

const readSheetExtent = (record: Record<string, unknown>) => {
  const widthNumber = finiteNumber(record.width ?? record.sourceWidth)
  const heightNumber = finiteNumber(record.height ?? record.sourceHeight)
  return {
    width: widthNumber !== null && widthNumber >= 200 && widthNumber <= 24000 ? Math.round(widthNumber) : 900,
    height: heightNumber !== null && heightNumber >= 200 && heightNumber <= 80000 ? Math.round(heightNumber) : 1273,
  }
}

const penPoint = (x: number, y: number): StrokePoint => sectionPoint(x, y)

const draftStrokes = (value: unknown): ShareStrokeDraft[] => {
  if (!Array.isArray(value)) return []
  const strokes: ShareStrokeDraft[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const raw = entry as { color?: unknown; width?: unknown; baseWidth?: unknown; opacity?: unknown; points?: unknown }
    if (!Array.isArray(raw.points)) continue
    const points: StrokePoint[] = []
    for (const point of raw.points) {
      if (!point || typeof point !== 'object') continue
      const sample = point as { x?: unknown; y?: unknown }
      const x = finiteNumber(sample.x)
      const y = finiteNumber(sample.y)
      if (x === null || y === null) continue
      points.push(penPoint(x, y))
    }
    if (!points.length) continue
    strokes.push({ color: raw.color, width: raw.width, baseWidth: raw.baseWidth, opacity: raw.opacity, points })
  }
  return strokes
}

const publishStrokes = (drafts: readonly ShareStrokeDraft[]): ShareInkStroke[] => {
  const strokes: ShareInkStroke[] = []
  let pointsUsed = 0
  for (const raw of drafts) {
    if (strokes.length >= SHARE_INK_STROKES || pointsUsed >= SHARE_INK_POINTS) break
    const points = raw.points.map((point) => ({ x: roundUnit(point.x), y: roundUnit(point.y) }))
    if (!points.length) continue
    const budget = Math.min(500, SHARE_INK_POINTS - pointsUsed)
    const kept = thinPoints(points, budget)
    if (!kept.length) continue
    const widthValue = finiteNumber(raw.width ?? raw.baseWidth)
    const opacityValue = finiteNumber(raw.opacity)
    strokes.push({
      color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/u.test(raw.color) ? raw.color : '#20222b',
      width: widthValue !== null ? Math.max(0.5, Math.min(48, widthValue)) : 3.5,
      opacity: opacityValue !== null ? Math.max(0.08, Math.min(1, opacityValue)) : 1,
      points: kept,
    })
    pointsUsed += kept.length
  }
  return strokes
}

const publishSections = (sections: readonly InkSection<ShareStrokeDraft>[]): ShareInkSection[] => {
  const list: ShareInkSection[] = []
  for (const section of sortSections(sections)) {
    if (section.collapsed) continue
    const top = roundUnit(section.top.y)
    const bodyTop = roundUnit(section.bodyTop.y)
    if (!(bodyTop > top)) continue
    const title = readSectionTitle(section.title)
    const left = section.left > 0 ? roundUnit(section.left) : 0
    const right = section.width < 1 ? roundUnit(section.width) : 1
    if (!(right > left)) continue
    list.push({
      id: section.id.slice(0, 64),
      ...(section.parentId ? { parentId: section.parentId.slice(0, 64) } : {}),
      ...(title ? { title } : {}),
      top,
      bodyTop,
      ...(left ? { left } : {}),
      ...(right !== 1 ? { width: right } : {}),
    })
    if (list.length >= SHARE_SECTIONS) break
  }
  return list
}

/** Grow the bottom of the sheet and keep every mark on the same pixel. Hidden ink stays in its own box. */
const growShareSheet = (
  height: number,
  addPx: number,
  strokes: readonly ShareStrokeDraft[],
  sections: readonly InkSection<ShareStrokeDraft>[],
  fields: unknown,
) => {
  const next = height + addPx
  if (!(addPx > 0) || !(next > height)) return { height, fields }
  const move = (point: { y: number }) => {
    point.y = keepMarkOnPage(point.y, height, next, 0)
  }
  for (const stroke of strokes) for (const point of stroke.points) move(point)
  for (const section of sections) {
    move(section.top)
    move(section.bodyTop)
  }
  const remapped = Array.isArray(fields)
    ? fields.map((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return field
      const y = finiteNumber((field as { y?: unknown }).y)
      if (y === null) return field
      return { ...(field as Record<string, unknown>), y: keepMarkOnPage(y, height, next, 0) }
    })
    : fields
  return { height: next, fields: remapped }
}

/**
 * Opens every collapsed band the way the board does: grow by the hidden body,
 * then put that ink and its subsections back. The result is the open sheet.
 */
const openShareDrawing = (record: Record<string, unknown>, fieldsValue: unknown) => {
  const extent = readSheetExtent(record)
  let height = extent.height
  let fields = fieldsValue
  const live = { strokes: draftStrokes(record.strokes) }
  const sections = deserializeSections<ShareStrokeDraft>(record.sections, draftStrokes)
  const visit = (fn: (stroke: ShareStrokeDraft) => void) => {
    for (const stroke of live.strokes) fn(stroke)
  }
  for (let guard = 0; guard < SHARE_SECTIONS && height < 80000; guard += 1) {
    const section = sections.find((entry) => entry.collapsed)
    if (!section) break
    const hiddenPx = Math.max(0, section.hidden?.heightPx ?? 0)
    const room = Math.max(0, 80000 - height)
    // The expand shifts by the whole hidden body. A partial grow would overlap the ink below it.
    if (hiddenPx > room) break
    const growPx = hiddenPx
    if (growPx > 0) {
      const grown = growShareSheet(height, growPx, live.strokes, sections, fields)
      height = grown.height
      fields = grown.fields
    }
    live.strokes = expandSection(
      live.strokes,
      sections,
      section,
      { width: extent.width, height },
      visit,
      (stroke, points) => ({ ...stroke, points }),
    )
  }
  return { width: extent.width, height, strokes: live.strokes, sections, fields, originX: readOrigin(record.sourceOriginX), originY: readOrigin(record.sourceOriginY) }
}

export const shareSourceLineCount = (content: string) => (
  String(content ?? '').replace(/\r\n/g, '\n').split('\n').length
)

export const shareTextColumnFor = (
  originX: number,
  originY: number,
  layout?: ShareTextLayout,
): ShareTextColumn => {
  const content = finiteNumber(layout?.contentWidth)
  const fontSize = finiteNumber(layout?.fontSize)
  const lineHeight = finiteNumber(layout?.lineHeight)
  const readable = layout?.readable !== false
  const column = readable
    ? Math.min(SHARE_COLUMN_MAX, Math.max(SHARE_COLUMN_MIN, content !== null ? Math.round(content) : SHARE_COLUMN))
    : SHARE_COLUMN_MAX
  return {
    originX: readOrigin(originX),
    originY: readOrigin(originY),
    column,
    padX: SHARE_PAD_X,
    padY: SHARE_PAD_Y,
    fontSize: fontSize !== null ? Math.max(12, Math.min(26, Math.round(fontSize))) : SHARE_FONT_SIZE,
    lineHeight: lineHeight !== null ? Math.max(1.3, Math.min(2.2, Math.round(lineHeight * 100) / 100)) : SHARE_LINE_HEIGHT,
  }
}

const sanitizeTextColumn = (value: unknown): ShareTextColumn | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<ShareTextColumn>
  return shareTextColumnFor(readOrigin(raw.originX), readOrigin(raw.originY), {
    contentWidth: raw.column,
    fontSize: raw.fontSize,
    lineHeight: raw.lineHeight,
    readable: true,
  })
}

const shareInkFromOpen = (
  width: number,
  height: number,
  strokes: readonly ShareStrokeDraft[],
  sections: readonly InkSection<ShareStrokeDraft>[],
): ShareInk | undefined => {
  const published = publishStrokes(strokes)
  const bands = publishSections(sections)
  if (!published.length && !bands.length) return undefined
  return {
    width,
    height: Math.max(200, Math.min(80000, Math.round(height))),
    strokes: published,
    ...(bands.length ? { sections: bands } : {}),
  }
}

/**
 * Public ink for one note. A vault drawing is opened so collapsed handwriting
 * is on the sheet. A page that was already opened stays as it is.
 */
export const publicShareInk = (value: unknown): ShareInk | undefined => {
  const record = drawingRecord(value)
  if (!record || (!Array.isArray(record.strokes) && !Array.isArray(record.sections))) return undefined
  const opened = openShareDrawing(record, undefined)
  return shareInkFromOpen(opened.width, opened.height, opened.strokes, opened.sections)
}

/** Ink, text fields, and the text column for one companion, on the open sheet. */
export const sharePageFromCompanion = (
  inkValue: unknown,
  fieldsValue: unknown,
  content: string,
  layout?: ShareTextLayout,
): { ink?: ShareInk; textFields: ShareTextField[]; textColumn?: ShareTextColumn } => {
  const record = drawingRecord(inkValue)
  if (!record) {
    const textFields = publicShareTextFields(fieldsValue)
    return { textFields, ...(textFields.length ? { textColumn: shareTextColumnFor(0, 0, layout) } : {}) }
  }
  const opened = openShareDrawing(record, fieldsValue)
  let { height, fields } = opened
  const textColumn = shareTextColumnFor(opened.originX, opened.originY, layout)
  const textBottom = textColumn.originY + textColumn.padY + shareSourceLineCount(content) * textColumn.fontSize * textColumn.lineHeight + SHARE_TEXT_SLACK
  const needed = Math.ceil(textBottom)
  if (needed > height && height < 80000) {
    const grown = growShareSheet(height, Math.min(needed, 80000) - height, opened.strokes, opened.sections, fields)
    height = grown.height
    fields = grown.fields
  }
  const ink = shareInkFromOpen(opened.width, height, opened.strokes, opened.sections)
  const textFields = publicShareTextFields(fields)
  return {
    ...(ink ? { ink } : {}),
    textFields,
    ...((ink || textFields.length) ? { textColumn } : {}),
  }
}

export const publicShareTextFields = (value: unknown): ShareTextField[] => {
  if (!Array.isArray(value)) return []
  const fields: ShareTextField[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const raw = entry as { page?: unknown; x?: unknown; y?: unknown; width?: unknown; fontSize?: unknown; text?: unknown }
    const text = typeof raw.text === 'string' ? raw.text.slice(0, 8000) : ''
    if (!text.trim()) continue
    const page = finiteNumber(raw.page)
    const x = finiteNumber(raw.x)
    const y = finiteNumber(raw.y)
    const width = finiteNumber(raw.width)
    const fontSize = finiteNumber(raw.fontSize)
    fields.push({
      page: page !== null && Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1,
      x: x !== null ? Math.max(0, Math.min(1, x)) : 0.5,
      y: y !== null ? Math.max(0, Math.min(1, y)) : 0.5,
      width: width !== null ? Math.max(0.12, Math.min(0.92, width)) : 0.32,
      fontSize: fontSize !== null && Number.isInteger(fontSize) && fontSize >= 10 && fontSize <= 48 ? fontSize : 16,
      text,
    })
    if (fields.length >= 200) break
  }
  return fields
}

const shareNoteFrom = (path: string, content: string, entry: ShareEntry): ShareNote => {
  // A companion that loadShareEntries already opened carries its text column.
  // A raw drawing still opens here, so a direct publish keeps hidden ink.
  const prepared = entry.textColumn
    ? null
    : sharePageFromCompanion(entry.ink, entry.textFields, content)
  const ink = prepared ? prepared.ink : publicShareInk(entry.ink)
  const textFields = prepared ? prepared.textFields : publicShareTextFields(entry.textFields)
  const textColumn = sanitizeTextColumn(entry.textColumn) ?? prepared?.textColumn
  return {
    path,
    title: shareNoteTitle(path, content),
    content,
    ...(ink ? { ink } : {}),
    ...(textFields.length ? { textFields } : {}),
    ...(textColumn && (ink || textFields.length) ? { textColumn } : {}),
  }
}

/** One note, or every markdown note under a folder, including nested folders. */
export const collectShareNotes = (entries: readonly ShareEntry[], rootPath: string) => {
  const root = normalizePath(rootPath)
  const match = entries.find((entry) => normalizePath(entry.path) === root)
  const nested = entries.some((entry) => entry.kind !== 'folder' && isInsideFolder(entry.path, root) && normalizePath(entry.path) !== root)
  const kind: 'note' | 'folder' = match?.kind === 'folder' || (!match && nested) ? 'folder' : 'note'
  if (kind === 'note') {
    const file = entries.find((entry) => normalizePath(entry.path) === root && entry.kind !== 'folder' && typeof entry.content === 'string')
    if (!file || typeof file.content !== 'string') {
      return { kind, title: shareNoteTitle(root, ''), rootPath: root, notes: [] as ShareNote[] }
    }
    const title = shareNoteTitle(root, file.content)
    return { kind, title, rootPath: root, notes: [shareNoteFrom(root, file.content, file)] }
  }
  const notes = entries
    .filter((entry) => entry.kind !== 'folder' && typeof entry.content === 'string' && isInsideFolder(entry.path, root))
    .map((entry) => shareNoteFrom(normalizePath(entry.path), entry.content ?? '', entry))
    .sort((left, right) => left.path.localeCompare(right.path, 'de'))
  const title = root.split('/').pop() || root
  return { kind, title, rootPath: root, notes }
}

export const flattenShareVault = (nodes: readonly ShareVaultNode[]): Array<{ path: string; kind: 'file' | 'folder'; extension?: string }> => {
  const flat: Array<{ path: string; kind: 'file' | 'folder'; extension?: string }> = []
  const walk = (list: readonly ShareVaultNode[]) => {
    for (const node of list) {
      flat.push({ path: node.relativePath, kind: node.kind, extension: node.extension })
      if (node.children?.length) walk(node.children)
    }
  }
  walk(nodes)
  return flat
}

const isMarkdownPath = (path: string, extension?: string) => extension === 'md' || path.toLowerCase().endsWith('.md')

export const loadShareEntries = async (
  nodes: readonly ShareVaultNode[],
  readFile: (path: string) => Promise<string>,
  readCompanion?: (path: string) => Promise<{ ink?: unknown; textFields?: unknown } | null>,
  layout?: ShareTextLayout,
): Promise<ShareEntry[]> => {
  const entries: ShareEntry[] = []
  for (const node of flattenShareVault(nodes)) {
    if (node.kind === 'folder') {
      entries.push({ path: node.path, kind: 'folder' })
      continue
    }
    if (!isMarkdownPath(node.path, node.extension)) continue
    const content = await readFile(node.path)
    const companion = readCompanion ? await readCompanion(node.path).catch(() => null) : null
    const page = sharePageFromCompanion(companion?.ink, companion?.textFields, content, layout)
    entries.push({
      path: node.path,
      kind: 'file',
      content,
      ...(page.ink ? { ink: page.ink } : {}),
      ...(page.textFields.length ? { textFields: page.textFields } : {}),
      ...(page.textColumn ? { textColumn: page.textColumn } : {}),
    })
  }
  return entries
}

export const buildShareUpload = (payload: SharePayload, origin = SHARE_ORIGIN): ShareHttpRequest => ({
  method: 'PUT',
  url: shareApiUrl(payload.id, origin),
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FaNotes-Share': '1' },
  body: JSON.stringify(payload),
})

export const buildShareFetch = (id: string, origin = SHARE_ORIGIN): ShareHttpRequest => ({
  method: 'GET',
  url: shareApiUrl(id, origin),
  headers: { Accept: 'application/json', 'X-FaNotes-Share': '1' },
  body: '',
})

export const buildShareRevoke = (id: string, origin = SHARE_ORIGIN): ShareHttpRequest => ({
  method: 'DELETE',
  url: shareApiUrl(id, origin),
  headers: { Accept: 'application/json', 'X-FaNotes-Share': '1' },
  body: '',
})

export const parseSharePayload = (body: string): SharePayload | null => {
  try {
    const parsed = JSON.parse(body) as Partial<SharePayload>
    if (parsed.schemaVersion !== 1 || typeof parsed.id !== 'string' || !Array.isArray(parsed.notes)) return null
    if (parsed.mode !== 'copy' && parsed.mode !== 'live' && parsed.mode !== 'edit') return null
    const notes = parsed.notes.flatMap((note) => {
      if (!note || typeof note.content !== 'string' || typeof note.path !== 'string') return []
      const ink = publicShareInk((note as { ink?: unknown }).ink)
      const textFields = publicShareTextFields((note as { textFields?: unknown }).textFields)
      const textColumn = sanitizeTextColumn((note as { textColumn?: unknown }).textColumn)
      return [{
        path: note.path,
        title: typeof note.title === 'string' ? note.title : shareNoteTitle(note.path, note.content),
        content: note.content,
        ...(ink ? { ink } : {}),
        ...(textFields.length ? { textFields } : {}),
        ...(textColumn && (ink || textFields.length) ? { textColumn } : {}),
      }]
    })
    return {
      schemaVersion: 1,
      id: parsed.id,
      mode: parsed.mode,
      kind: parsed.kind === 'folder' ? 'folder' : 'note',
      rootPath: typeof parsed.rootPath === 'string' ? parsed.rootPath : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      notes,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      stopped: Boolean(parsed.stopped),
      ...(Number.isInteger(parsed.revision) ? { revision: parsed.revision } : {}),
      ...(Array.isArray((parsed as { editors?: unknown }).editors) ? { editors: (parsed as { editors: { name?: unknown; account?: unknown }[] }).editors.flatMap((editor) => {
        if (!editor || typeof editor.name !== 'string' || !editor.name.trim()) return []
        const name = editor.name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80)
        if (!name) return []
        const account = typeof editor.account === 'string' ? editor.account.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80) : ''
        return [{ name, ...(account ? { account } : {}) }]
      }) } : {}),
    }
  } catch {
    return null
  }
}

export const emptyShareDirectory = (): ShareDirectory => ({ shares: [] })

export const parseShareDirectory = (raw: string | null | undefined): ShareDirectory => {
  if (!raw) return emptyShareDirectory()
  try {
    const parsed = JSON.parse(raw) as { shares?: unknown }
    if (!parsed || !Array.isArray(parsed.shares)) return emptyShareDirectory()
    const shares = parsed.shares.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const record = item as Partial<ShareLinkRecord>
      if (typeof record.id !== 'string' || typeof record.link !== 'string') return []
      return [{
        id: record.id,
        link: record.link,
        title: typeof record.title === 'string' ? record.title : record.id,
        rootPath: typeof record.rootPath === 'string' ? record.rootPath : '',
        mode: record.mode === 'live' ? 'live' as const : record.mode === 'edit' ? 'edit' as const : 'copy' as const,
        ...(Array.isArray((record as { editors?: unknown }).editors)
          ? { editors: (record as { editors: unknown[] }).editors.filter((name): name is string => typeof name === 'string' && name.trim().length > 0).slice(0, 80) }
          : {}),
        kind: record.kind === 'folder' ? 'folder' as const : 'note' as const,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        stopped: Boolean(record.stopped),
      }]
    })
    return { shares }
  } catch {
    return emptyShareDirectory()
  }
}

export const serializeShareDirectory = (directory: ShareDirectory) => JSON.stringify(directory)

export const rememberShare = (directory: ShareDirectory, record: ShareLinkRecord): ShareDirectory => ({
  shares: [record, ...directory.shares.filter((share) => share.id !== record.id)].slice(0, 30),
})

export const markShareStopped = (directory: ShareDirectory, id: string): ShareDirectory => ({
  shares: directory.shares.map((share) => share.id === id ? { ...share, stopped: true } : share),
})

export const listRecentShares = (directory: ShareDirectory) => directory.shares

export function createFetchSharePort(fetchImpl: typeof fetch = fetch): SharePort {
  return {
    async exchange(request) {
      let response: Response
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'DELETE' ? undefined : request.body,
          cache: 'no-store',
        })
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        throw new Error(aborted ? 'Die Freigabe-Anfrage wurde abgebrochen.' : 'Der Freigabe-Server ist nicht erreichbar.')
      }
      return { status: response.status, body: await response.text() }
    },
  }
}

export async function publishShare(input: {
  entries: readonly ShareEntry[]
  rootPath: string
  mode: ShareMode
  port: SharePort
  origin?: string
  id?: string
  now?: string
  directory?: ShareDirectory
}): Promise<{ record: ShareLinkRecord; directory: ShareDirectory; request: ShareHttpRequest; payload: SharePayload }> {
  const origin = input.origin ?? resolveShareOrigin()
  const collected = collectShareNotes(input.entries, input.rootPath)
  const payload: SharePayload = {
    schemaVersion: 1,
    id: input.id ?? createShareId(),
    mode: input.mode,
    kind: collected.kind,
    rootPath: collected.rootPath,
    title: collected.title,
    notes: collected.notes,
    updatedAt: input.now ?? new Date().toISOString(),
  }
  const request = buildShareUpload(payload, origin)
  const response = await input.port.exchange(request)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Freigabe wurde nicht angenommen (${response.status}).`)
  }
  const record: ShareLinkRecord = {
    id: payload.id,
    link: shareViewUrl(payload.id, origin),
    title: payload.title,
    rootPath: payload.rootPath,
    mode: payload.mode,
    kind: payload.kind,
    createdAt: payload.updatedAt,
    stopped: false,
  }
  return { record, directory: rememberShare(input.directory ?? emptyShareDirectory(), record), request, payload }
}

/** A copy returns the uploaded snapshot. A live share resolves the same paths against the current notes. */
export async function readShare(input: {
  id: string
  port: SharePort
  origin?: string
  entries?: readonly ShareEntry[]
}): Promise<SharePayload | null> {
  const origin = input.origin ?? resolveShareOrigin()
  const response = await input.port.exchange(buildShareFetch(input.id, origin))
  if (response.status === 404 || response.status === 410 || !response.body) return null
  const payload = parseSharePayload(response.body)
  if (!payload || payload.stopped) return null
  if (payload.mode === 'live' && input.entries) {
    const fresh = collectShareNotes(input.entries, payload.rootPath)
    return { ...payload, kind: fresh.kind, title: fresh.title, notes: fresh.notes }
  }
  return payload
}

export async function stopShare(input: {
  id: string
  port: SharePort
  origin?: string
  directory?: ShareDirectory
}): Promise<ShareDirectory> {
  // A save may already have queued a live upload. Drop it before the revoke
  // so that upload cannot put the notes back on this link.
  cancelQueuedLiveShareRefresh()
  const origin = input.origin ?? resolveShareOrigin()
  const response = await input.port.exchange(buildShareRevoke(input.id, origin))
  if (response.status >= 400) throw new Error(`Freigabe konnte nicht beendet werden (${response.status}).`)
  return markShareStopped(input.directory ?? emptyShareDirectory(), input.id)
}

/** Push the current notes for every live share. Copies stay as they were uploaded. A stop ends this refresh before the next upload. */
export async function refreshLiveShares(input: {
  entries: readonly ShareEntry[]
  directory: ShareDirectory
  port: SharePort
  origin?: string
  now?: string
}): Promise<void> {
  const origin = input.origin ?? resolveShareOrigin()
  const revision = liveRefreshGeneration
  for (const share of input.directory.shares) {
    if (revision !== liveRefreshGeneration) return
    if (share.stopped || share.mode !== 'live') continue
    const collected = collectShareNotes(input.entries, share.rootPath)
    const payload: SharePayload = {
      schemaVersion: 1,
      id: share.id,
      mode: 'live',
      kind: collected.kind,
      rootPath: collected.rootPath,
      title: collected.title,
      notes: collected.notes,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    if (revision !== liveRefreshGeneration) return
    const response = await input.port.exchange(buildShareUpload(payload, origin))
    if (revision !== liveRefreshGeneration) return
    if (response.status === 410) continue
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Live-Freigabe wurde nicht aktualisiert (${response.status}).`)
    }
  }
}

export function liveShareRevision(): number {
  return liveRefreshGeneration
}

/** The Teilen page reads the vault, then uploads live shares. Stop cancels it, including while the vault is still being read. */
export async function refreshSharesOpenedInSettings(input: {
  loadEntries: () => Promise<readonly ShareEntry[]>
  readDirectory: () => string
  port: SharePort
  origin?: string
  onEntries?: (entries: readonly ShareEntry[]) => void
}): Promise<'ok' | 'skipped' | 'read-failed' | 'upload-failed'> {
  const revision = liveRefreshGeneration
  let entries: readonly ShareEntry[]
  try {
    entries = await input.loadEntries()
  } catch {
    return revision === liveRefreshGeneration ? 'read-failed' : 'skipped'
  }
  if (revision !== liveRefreshGeneration) return 'skipped'
  input.onEntries?.(entries)
  const directory = readShareDirectorySetting(input.readDirectory)
  if (!directoryHasLiveShare(directory) || revision !== liveRefreshGeneration) return 'ok'
  try {
    await refreshLiveShares({ entries, directory, port: input.port, origin: input.origin })
  } catch {
    return revision === liveRefreshGeneration ? 'upload-failed' : 'skipped'
  }
  return revision === liveRefreshGeneration ? 'ok' : 'skipped'
}

let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null
let liveRefreshGeneration = 0

const readShareDirectorySetting = (settingsRecent: string | (() => string)) => (
  parseShareDirectory(typeof settingsRecent === 'function' ? settingsRecent() : settingsRecent)
)

const directoryHasLiveShare = (directory: ShareDirectory) => (
  directory.shares.some((share) => share.mode === 'live' && !share.stopped)
)

/** Drop a pending live upload, including one whose request has not been sent yet. */
export function cancelQueuedLiveShareRefresh() {
  liveRefreshGeneration += 1
  if (liveRefreshTimer !== null) {
    clearTimeout(liveRefreshTimer)
    liveRefreshTimer = null
  }
}

/** Debounced push after a local save. No-op when nothing is shared live. Never throws into the save path. */
export function queueLiveShareRefresh(input: {
  settingsRecent: string | (() => string)
  loadEntries: () => Promise<readonly ShareEntry[]>
  port?: SharePort
  origin?: string
}) {
  const directory = readShareDirectorySetting(input.settingsRecent)
  if (!directoryHasLiveShare(directory)) {
    cancelQueuedLiveShareRefresh()
    return
  }
  cancelQueuedLiveShareRefresh()
  const generation = liveRefreshGeneration
  const loadEntries = input.loadEntries
  const port = input.port
  const origin = input.origin
  liveRefreshTimer = setTimeout(() => {
    if (generation !== liveRefreshGeneration) return
    liveRefreshTimer = null
    void loadEntries()
      .then((entries) => {
        if (generation !== liveRefreshGeneration) return
        const current = readShareDirectorySetting(input.settingsRecent)
        if (!directoryHasLiveShare(current)) return
        return refreshLiveShares({
          entries,
          directory: current,
          port: port ?? createFetchSharePort(),
          origin,
        })
      })
      .catch(() => undefined)
  }, 1500)
}
