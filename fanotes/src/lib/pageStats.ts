/**
 * Per-note statistics that live quietly in the `.famd` payload. Nothing here is
 * shown in the UI; the app records what happens on a page (time, typing, ink,
 * document shape) and writes it back with the note.
 *
 * Everything is pure: the app keeps a `PageStatsSession` per open note in a
 * ref and calls the `record*` helpers, then snapshots to `PageStats` for disk.
 * `parsePageStats` is idempotent so a round trip through JSON is loss-free and
 * `sameJson(parse(x), parse(serialize(parse(x))))` holds for the note
 * standard converter.
 */

export const PAGE_STATS_VERSION = 2

/** A pause longer than this ends a typing burst or an ink burst. */
export const ACTIVITY_GAP_MS = 5_000

export type TypingStats = {
  /** Time inside typing bursts (keystrokes at most `ACTIVITY_GAP_MS` apart). */
  ms: number
  bursts: number
  longestBurstMs: number
  /** Editing transactions that came from the keyboard. */
  keystrokes: number
  charsTyped: number
  charsDeleted: number
  /** Words finished with a space, punctuation or a line break. */
  wordsTyped: number
  /** Line breaks typed. */
  linesTyped: number
  pastes: number
  charsPasted: number
  autocorrects: number
  /** Replacements picked from the spelling menu. */
  suggestionsApplied: number
  undos: number
  redos: number
  lastTypedAt: string | null
}

export type InkSnapshot = {
  strokes: number
  points: number
  lengthMm: number
  penDownMs: number
  savedAt: string | null
}

export type InkStats = {
  /** Pen-on-paper time over all strokes ever drawn on this page. */
  penDownMs: number
  /** Time inside handwriting bursts (strokes at most `ACTIVITY_GAP_MS` apart). */
  ms: number
  bursts: number
  longestBurstMs: number
  /** Strokes ever drawn, including ones erased later. */
  strokes: number
  points: number
  lengthMm: number
  longestStrokeMm: number
  handwritingStrokes: number
  artStrokes: number
  strokesErased: number
  colors: string[]
  brushes: Record<string, number>
  lastStrokeAt: string | null
  /** What is on the page right now, refreshed whenever the ink layer is saved. */
  current: InkSnapshot
}

export type DocumentStats = {
  words: number
  characters: number
  charactersWithoutSpaces: number
  lines: number
  paragraphs: number
  headings: number
  links: number
  images: number
  tasks: number
  tasksDone: number
  codeBlocks: number
  mathBlocks: number
  tables: number
  blockquotes: number
  listItems: number
  readingMinutes: number
  /** Highest word count the document ever reached. */
  peakWords: number
  /** Sum of positive / negative word-count deltas between saves. */
  wordsAdded: number
  wordsRemoved: number
}

export type PageStats = {
  version: number
  createdAt: string
  modifiedAt: string
  firstOpenedAt: string
  lastOpenedAt: string
  lastClosedAt: string | null
  lastSavedAt: string | null
  openCount: number
  saveCount: number
  /** Time the page was the visible, active note. */
  dwellMs: number
  /** Part of `dwellMs` during which the window also had focus. */
  focusMs: number
  longestSessionMs: number
  lastSessionMs: number
  /** Local calendar days (YYYY-MM-DD) on which the page was opened, newest last. */
  activeDays: string[]
  /** Opens per local hour of the day. */
  opensByHour: number[]
  /** Dwell per local hour of the day, in ms. */
  dwellByHour: number[]
  /** Dwell per local weekday (0 = Sunday), in ms. */
  dwellByWeekday: number[]
  typing: TypingStats
  ink: InkStats
  document: DocumentStats
}

export type PageStatsSession = PageStats & {
  active: boolean
  sessionStartedAt: number | null
  /** Dwell accumulated since the current open; feeds `lastSessionMs`. */
  sessionDwellMs: number
  lastTypedAtMs: number | null
  typingBurstStartedAtMs: number | null
  lastStrokeEndedAtMs: number | null
  inkBurstStartedAtMs: number | null
  /** Bumped by every recorded change except dwell; the app persists when it moved past `persistedRevision`. */
  revision: number
  persistedRevision: number
  /** `dwellMs` at the last persist; dwell has its own watermark so the tick stays cheap. */
  persistedDwellMs: number
}

export const MAX_ACTIVE_DAYS = 400
export const MAX_INK_COLORS = 32
export const MAX_INK_BRUSHES = 24

const toIso = (ms: number) => new Date(ms).toISOString()

const parseIsoMs = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

const isoOrNull = (value: unknown) => {
  const ms = parseIsoMs(value)
  return ms == null ? null : toIso(ms)
}

const count = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

const millimetres = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number * 10) / 10 : 0
}

const countArray = (value: unknown, length: number) => {
  const source = Array.isArray(value) ? value : []
  return Array.from({ length }, (_, index) => count(source[index]))
}

const record = (value: unknown) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
)

const localDay = (ms: number) => {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

export const emptyTypingStats = (): TypingStats => ({
  ms: 0,
  bursts: 0,
  longestBurstMs: 0,
  keystrokes: 0,
  charsTyped: 0,
  charsDeleted: 0,
  wordsTyped: 0,
  linesTyped: 0,
  pastes: 0,
  charsPasted: 0,
  autocorrects: 0,
  suggestionsApplied: 0,
  undos: 0,
  redos: 0,
  lastTypedAt: null,
})

export const emptyInkSnapshot = (): InkSnapshot => ({
  strokes: 0,
  points: 0,
  lengthMm: 0,
  penDownMs: 0,
  savedAt: null,
})

export const emptyInkStats = (): InkStats => ({
  penDownMs: 0,
  ms: 0,
  bursts: 0,
  longestBurstMs: 0,
  strokes: 0,
  points: 0,
  lengthMm: 0,
  longestStrokeMm: 0,
  handwritingStrokes: 0,
  artStrokes: 0,
  strokesErased: 0,
  colors: [],
  brushes: {},
  lastStrokeAt: null,
  current: emptyInkSnapshot(),
})

export const emptyDocumentStats = (): DocumentStats => ({
  words: 0,
  characters: 0,
  charactersWithoutSpaces: 0,
  lines: 0,
  paragraphs: 0,
  headings: 0,
  links: 0,
  images: 0,
  tasks: 0,
  tasksDone: 0,
  codeBlocks: 0,
  mathBlocks: 0,
  tables: 0,
  blockquotes: 0,
  listItems: 0,
  readingMinutes: 0,
  peakWords: 0,
  wordsAdded: 0,
  wordsRemoved: 0,
})

export const emptyPageStats = (now: number): PageStats => {
  const at = toIso(now)
  return {
    version: PAGE_STATS_VERSION,
    createdAt: at,
    modifiedAt: at,
    firstOpenedAt: at,
    lastOpenedAt: at,
    lastClosedAt: null,
    lastSavedAt: null,
    openCount: 0,
    saveCount: 0,
    dwellMs: 0,
    focusMs: 0,
    longestSessionMs: 0,
    lastSessionMs: 0,
    activeDays: [],
    opensByHour: Array.from({ length: 24 }, () => 0),
    dwellByHour: Array.from({ length: 24 }, () => 0),
    dwellByWeekday: Array.from({ length: 7 }, () => 0),
    typing: emptyTypingStats(),
    ink: emptyInkStats(),
    document: emptyDocumentStats(),
  }
}

const parseTyping = (input: unknown): TypingStats => {
  const raw = record(input)
  return {
    ms: count(raw.ms),
    bursts: count(raw.bursts),
    longestBurstMs: count(raw.longestBurstMs),
    keystrokes: count(raw.keystrokes),
    charsTyped: count(raw.charsTyped),
    charsDeleted: count(raw.charsDeleted),
    wordsTyped: count(raw.wordsTyped),
    linesTyped: count(raw.linesTyped),
    pastes: count(raw.pastes),
    charsPasted: count(raw.charsPasted),
    autocorrects: count(raw.autocorrects),
    suggestionsApplied: count(raw.suggestionsApplied),
    undos: count(raw.undos),
    redos: count(raw.redos),
    lastTypedAt: isoOrNull(raw.lastTypedAt),
  }
}

const parseInkSnapshot = (input: unknown): InkSnapshot => {
  const raw = record(input)
  return {
    strokes: count(raw.strokes),
    points: count(raw.points),
    lengthMm: millimetres(raw.lengthMm),
    penDownMs: count(raw.penDownMs),
    savedAt: isoOrNull(raw.savedAt),
  }
}

const parseInk = (input: unknown): InkStats => {
  const raw = record(input)
  const colors = Array.isArray(raw.colors)
    ? raw.colors.filter((color): color is string => typeof color === 'string' && color.length > 0 && color.length <= 32).slice(-MAX_INK_COLORS)
    : []
  const brushes: Record<string, number> = {}
  for (const [name, uses] of Object.entries(record(raw.brushes)).slice(0, MAX_INK_BRUSHES)) {
    const number = count(uses)
    if (number > 0) brushes[name] = number
  }
  return {
    penDownMs: count(raw.penDownMs),
    ms: count(raw.ms),
    bursts: count(raw.bursts),
    longestBurstMs: count(raw.longestBurstMs),
    strokes: count(raw.strokes),
    points: count(raw.points),
    lengthMm: millimetres(raw.lengthMm),
    longestStrokeMm: millimetres(raw.longestStrokeMm),
    handwritingStrokes: count(raw.handwritingStrokes),
    artStrokes: count(raw.artStrokes),
    strokesErased: count(raw.strokesErased),
    colors,
    brushes,
    lastStrokeAt: isoOrNull(raw.lastStrokeAt),
    current: parseInkSnapshot(raw.current),
  }
}

const parseDocument = (input: unknown): DocumentStats => {
  const raw = record(input)
  return {
    words: count(raw.words),
    characters: count(raw.characters),
    charactersWithoutSpaces: count(raw.charactersWithoutSpaces),
    lines: count(raw.lines),
    paragraphs: count(raw.paragraphs),
    headings: count(raw.headings),
    links: count(raw.links),
    images: count(raw.images),
    tasks: count(raw.tasks),
    tasksDone: count(raw.tasksDone),
    codeBlocks: count(raw.codeBlocks),
    mathBlocks: count(raw.mathBlocks),
    tables: count(raw.tables),
    blockquotes: count(raw.blockquotes),
    listItems: count(raw.listItems),
    readingMinutes: count(raw.readingMinutes),
    peakWords: count(raw.peakWords),
    wordsAdded: count(raw.wordsAdded),
    wordsRemoved: count(raw.wordsRemoved),
  }
}

/** Accepts the legacy five-field record as well as the current shape. */
export const parsePageStats = (input: unknown, now = Date.now()): PageStats => {
  const raw = record(input)
  const created = parseIsoMs(raw.createdAt) ?? now
  const modified = parseIsoMs(raw.modifiedAt) ?? created
  const lastOpened = parseIsoMs(raw.lastOpenedAt) ?? created
  const firstOpened = parseIsoMs(raw.firstOpenedAt) ?? Math.min(created, lastOpened)
  const dwellMs = count(raw.dwellMs)
  const activeDays = Array.isArray(raw.activeDays)
    ? raw.activeDays.filter((day): day is string => typeof day === 'string' && DAY_PATTERN.test(day)).slice(-MAX_ACTIVE_DAYS)
    : []
  const document = parseDocument(raw.document)
  return {
    version: PAGE_STATS_VERSION,
    createdAt: toIso(created),
    modifiedAt: toIso(modified),
    firstOpenedAt: toIso(firstOpened),
    lastOpenedAt: toIso(lastOpened),
    lastClosedAt: isoOrNull(raw.lastClosedAt),
    lastSavedAt: isoOrNull(raw.lastSavedAt),
    openCount: count(raw.openCount),
    saveCount: count(raw.saveCount),
    dwellMs,
    focusMs: Math.min(dwellMs, count(raw.focusMs)),
    longestSessionMs: count(raw.longestSessionMs),
    lastSessionMs: count(raw.lastSessionMs),
    activeDays,
    opensByHour: countArray(raw.opensByHour, 24),
    dwellByHour: countArray(raw.dwellByHour, 24),
    dwellByWeekday: countArray(raw.dwellByWeekday, 7),
    typing: parseTyping(raw.typing),
    ink: parseInk(raw.ink),
    document: { ...document, peakWords: Math.max(document.peakWords, document.words) },
  }
}

const withDay = (days: string[], day: string) => {
  if (days[days.length - 1] === day || days.includes(day)) return days
  const next = [...days, day]
  return next.length > MAX_ACTIVE_DAYS ? next.slice(next.length - MAX_ACTIVE_DAYS) : next
}

const bumped = <T extends PageStatsSession>(session: T): T => ({ ...session, revision: session.revision + 1 })

export const openPageStats = (state: PageStats | PageStatsSession, now: number): PageStatsSession => {
  const opensByHour = [...state.opensByHour]
  opensByHour[new Date(now).getHours()] += 1
  const previous = 'revision' in state ? state : null
  return {
    ...state,
    lastOpenedAt: toIso(now),
    openCount: state.openCount + 1,
    activeDays: withDay(state.activeDays, localDay(now)),
    opensByHour,
    active: true,
    sessionStartedAt: now,
    sessionDwellMs: 0,
    lastTypedAtMs: null,
    typingBurstStartedAtMs: null,
    lastStrokeEndedAtMs: null,
    inkBurstStartedAtMs: null,
    // Opening alone is not worth a write: the open count reaches the disk with
    // the next persist, and flicking through notes leaves their files alone.
    revision: previous?.revision ?? 0,
    persistedRevision: previous?.persistedRevision ?? 0,
    persistedDwellMs: previous?.persistedDwellMs ?? state.dwellMs,
  }
}

/**
 * Books the time since the last tick as dwell while the page is active. Dwell
 * is attributed to the local hour and weekday in which the tick happens, so a
 * one-second tick stays exact enough for the histograms.
 */
export const tickPageStats = (
  session: PageStatsSession,
  now: number,
  active: boolean,
  focused = true,
): PageStatsSession => {
  if (!session.active || session.sessionStartedAt == null) {
    return active
      ? { ...session, active: true, sessionStartedAt: now }
      : session.active || session.sessionStartedAt != null
        ? { ...session, active: false, sessionStartedAt: null }
        : session
  }
  const extra = Math.max(0, now - session.sessionStartedAt)
  const date = new Date(now)
  const dwellByHour = [...session.dwellByHour]
  dwellByHour[date.getHours()] += extra
  const dwellByWeekday = [...session.dwellByWeekday]
  dwellByWeekday[date.getDay()] += extra
  const sessionDwellMs = session.sessionDwellMs + extra
  return {
    ...session,
    dwellMs: session.dwellMs + extra,
    focusMs: session.focusMs + (focused ? extra : 0),
    dwellByHour,
    dwellByWeekday,
    sessionDwellMs,
    lastSessionMs: sessionDwellMs,
    longestSessionMs: Math.max(session.longestSessionMs, sessionDwellMs),
    active,
    sessionStartedAt: active ? now : null,
  }
}

export const closePageStats = (session: PageStatsSession, now: number): PageStats => {
  const next = tickPageStats(session, now, false)
  return { ...snapshotPageStats(next), lastClosedAt: toIso(now) }
}

export const touchPageModified = <T extends PageStats>(stats: T, now: number): T => ({
  ...stats,
  modifiedAt: toIso(now),
})

/* ---------- typing ---------- */

export type EditActivity = {
  kind: 'type' | 'delete' | 'paste' | 'autocorrect' | 'suggestion' | 'undo' | 'redo' | 'other'
  inserted: number
  deleted: number
  /** Words the edit finished (a boundary typed right after a word character). */
  wordsCompleted: number
  /** Line breaks the edit inserted. */
  lineBreaks: number
}

type BurstTotals = { ms: number; bursts: number; longestBurstMs: number }

/**
 * Extends the running burst when `now` follows the previous event closely
 * enough, otherwise opens a new one. Returns the updated totals and the start
 * of the burst `now` belongs to.
 */
const extendBurst = (
  lastAtMs: number | null,
  burstStartedAtMs: number | null,
  now: number,
  totals: BurstTotals,
): BurstTotals & { burstStartedAtMs: number } => {
  if (lastAtMs != null && now - lastAtMs <= ACTIVITY_GAP_MS) {
    const startedAt = burstStartedAtMs ?? lastAtMs
    return {
      ms: totals.ms + Math.max(0, now - lastAtMs),
      bursts: totals.bursts,
      longestBurstMs: Math.max(totals.longestBurstMs, now - startedAt),
      burstStartedAtMs: startedAt,
    }
  }
  return { ms: totals.ms, bursts: totals.bursts + 1, longestBurstMs: totals.longestBurstMs, burstStartedAtMs: now }
}

export const recordEditActivity = (session: PageStatsSession, activity: EditActivity, now: number): PageStatsSession => {
  const typing = { ...session.typing }
  const userInput = activity.kind === 'type' || activity.kind === 'delete' || activity.kind === 'paste'
  let typingBurstStartedAtMs = session.typingBurstStartedAtMs
  if (userInput) {
    const burst = extendBurst(session.lastTypedAtMs, session.typingBurstStartedAtMs, now, typing)
    typing.ms = burst.ms
    typing.bursts = burst.bursts
    typing.longestBurstMs = burst.longestBurstMs
    typing.keystrokes += 1
    typing.lastTypedAt = toIso(now)
    typingBurstStartedAtMs = burst.burstStartedAtMs
  }
  switch (activity.kind) {
    case 'type':
    case 'delete':
      typing.charsTyped += activity.inserted
      typing.charsDeleted += activity.deleted
      break
    case 'paste':
      typing.pastes += 1
      typing.charsPasted += activity.inserted
      typing.charsDeleted += activity.deleted
      break
    case 'autocorrect':
      typing.autocorrects += 1
      break
    case 'suggestion':
      typing.suggestionsApplied += 1
      break
    case 'undo':
      typing.undos += 1
      break
    case 'redo':
      typing.redos += 1
      break
    default:
      break
  }
  typing.wordsTyped += activity.wordsCompleted
  typing.linesTyped += activity.lineBreaks
  return bumped({
    ...touchPageModified(session, now),
    typing,
    lastTypedAtMs: userInput ? now : session.lastTypedAtMs,
    typingBurstStartedAtMs,
  })
}

/* ---------- ink ---------- */

export type InkStrokeActivity = {
  durationMs: number
  lengthMm: number
  points: number
  purpose: 'handwriting' | 'art'
  color?: string
  brush?: string
  /** Wall-clock end of the stroke; defaults to `now`. */
  endedAt?: number
}

export const recordInkStroke = (session: PageStatsSession, stroke: InkStrokeActivity, now: number): PageStatsSession => {
  const ink = { ...session.ink, brushes: { ...session.ink.brushes } }
  const endedAt = stroke.endedAt ?? now
  const durationMs = Math.max(0, Math.floor(stroke.durationMs))
  // The gap between strokes is measured from the previous pen-up to this
  // pen-down; the stroke's own duration is always handwriting time.
  const startedAt = endedAt - durationMs
  const burst = extendBurst(session.lastStrokeEndedAtMs, session.inkBurstStartedAtMs, startedAt, ink)
  ink.ms = burst.ms + durationMs
  ink.bursts = burst.bursts
  ink.longestBurstMs = Math.max(burst.longestBurstMs, endedAt - burst.burstStartedAtMs)
  ink.penDownMs += durationMs
  ink.strokes += 1
  ink.points += Math.max(0, Math.floor(stroke.points))
  const lengthMm = Math.max(0, stroke.lengthMm)
  ink.lengthMm = Math.round((ink.lengthMm + lengthMm) * 10) / 10
  ink.longestStrokeMm = Math.max(ink.longestStrokeMm, Math.round(lengthMm * 10) / 10)
  if (stroke.purpose === 'art') ink.artStrokes += 1
  else ink.handwritingStrokes += 1
  if (stroke.color && !ink.colors.includes(stroke.color)) {
    ink.colors = [...ink.colors, stroke.color].slice(-MAX_INK_COLORS)
  }
  const brush = stroke.brush ?? (stroke.purpose === 'art' ? 'art' : 'pen')
  if (brush in ink.brushes || Object.keys(ink.brushes).length < MAX_INK_BRUSHES) {
    ink.brushes[brush] = (ink.brushes[brush] ?? 0) + 1
  }
  ink.lastStrokeAt = toIso(endedAt)
  return bumped({
    ...touchPageModified(session, now),
    ink,
    lastStrokeEndedAtMs: endedAt,
    inkBurstStartedAtMs: burst.burstStartedAtMs,
  })
}

export const recordInkErased = (session: PageStatsSession, removed: number, now: number): PageStatsSession => {
  const strokes = Math.max(0, Math.floor(removed))
  if (!strokes) return session
  return bumped({
    ...touchPageModified(session, now),
    ink: { ...session.ink, strokesErased: session.ink.strokesErased + strokes },
  })
}

export type InkSummary = Omit<InkSnapshot, 'savedAt'>

/** Refreshes `ink.current` with what the saved ink layer contains right now. */
export const recordInkSnapshot = (session: PageStatsSession, summary: InkSummary, now: number): PageStatsSession => bumped({
  ...session,
  ink: {
    ...session.ink,
    current: {
      strokes: count(summary.strokes),
      points: count(summary.points),
      lengthMm: millimetres(summary.lengthMm),
      penDownMs: count(summary.penDownMs),
      savedAt: toIso(now),
    },
  },
})

/** 900 source px span the 210 mm of an A4 sheet (see draftingTools). */
const MM_PER_SOURCE_PX = 210 / 900

type SummarisableStroke = {
  points: ReadonlyArray<{ x: number; y: number; t?: number }>
}

/** Length in millimetres of a stroke stored as 0–1 fractions of a sheet. */
export const strokeLengthMm = (stroke: SummarisableStroke, sourceWidth: number, sourceHeight: number) => {
  let length = 0
  const points = stroke.points
  for (let index = 1; index < points.length; index += 1) {
    const dx = (points[index].x - points[index - 1].x) * sourceWidth
    const dy = (points[index].y - points[index - 1].y) * sourceHeight
    length += Math.hypot(dx, dy)
  }
  return length * MM_PER_SOURCE_PX
}

export const strokeDurationMs = (stroke: SummarisableStroke) => {
  const first = stroke.points[0]?.t
  const last = stroke.points[stroke.points.length - 1]?.t
  if (typeof first !== 'number' || typeof last !== 'number' || !Number.isFinite(first) || !Number.isFinite(last)) return 0
  return Math.max(0, last - first)
}

export const summarizeInkStrokes = (
  strokes: ReadonlyArray<SummarisableStroke>,
  sourceWidth: number,
  sourceHeight: number,
): InkSummary => {
  let points = 0
  let lengthMm = 0
  let penDownMs = 0
  for (const stroke of strokes) {
    points += stroke.points.length
    lengthMm += strokeLengthMm(stroke, sourceWidth, sourceHeight)
    penDownMs += strokeDurationMs(stroke)
  }
  return { strokes: strokes.length, points, lengthMm: Math.round(lengthMm * 10) / 10, penDownMs: Math.floor(penDownMs) }
}

/* ---------- document ---------- */

const FENCE = /^(```|~~~)/u
const MATH_FENCE = /^\$\$/u
const HEADING = /^#{1,6}\s/u
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/u
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s/u
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u
const BLOCKQUOTE = /^\s*>/u
const IMAGE = /!\[[^\]]*\]\([^)]*\)/gu
const LINK = /(?<!!)\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\]|https?:\/\/\S+/gu
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu

export const measureDocument = (markdown: string): Omit<DocumentStats, 'peakWords' | 'wordsAdded' | 'wordsRemoved'> => {
  const text = typeof markdown === 'string' ? markdown : ''
  const lines = text.length ? text.split('\n') : []
  let headings = 0
  let listItems = 0
  let tasks = 0
  let tasksDone = 0
  let codeBlocks = 0
  let mathBlocks = 0
  let tables = 0
  let blockquotes = 0
  let paragraphs = 0
  let inCode = false
  let inMath = false
  let inParagraph = false
  let previousLine = ''
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!inCode) codeBlocks += 1
      inCode = !inCode
      inParagraph = false
      previousLine = line
      continue
    }
    if (inCode) { previousLine = line; continue }
    if (MATH_FENCE.test(line.trim())) {
      // `$$ … $$` on one line is one block; an opening fence starts a block.
      const closesOnSameLine = line.trim().length > 2 && line.trim().endsWith('$$')
      if (!inMath) mathBlocks += 1
      if (!closesOnSameLine) inMath = !inMath
      inParagraph = false
      previousLine = line
      continue
    }
    if (inMath) { previousLine = line; continue }
    const blank = line.trim().length === 0
    if (blank) { inParagraph = false; previousLine = line; continue }
    if (HEADING.test(line)) { headings += 1; inParagraph = false; previousLine = line; continue }
    if (TABLE_SEPARATOR.test(line) && previousLine.includes('|')) { tables += 1; inParagraph = false; previousLine = line; continue }
    if (BLOCKQUOTE.test(line)) blockquotes += inParagraph ? 0 : 1
    if (TASK.test(line)) {
      tasks += 1
      if (/\[(x|X)\]/u.test(line.slice(0, line.indexOf(']') + 1))) tasksDone += 1
      listItems += 1
    } else if (LIST_ITEM.test(line)) {
      listItems += 1
    } else if (!inParagraph && !BLOCKQUOTE.test(line) && !line.includes('|')) {
      paragraphs += 1
    }
    inParagraph = true
    previousLine = line
  }
  const words = text.match(WORD)?.length ?? 0
  const images = text.match(IMAGE)?.length ?? 0
  const links = text.replace(IMAGE, '').match(LINK)?.length ?? 0
  return {
    words,
    characters: text.length,
    charactersWithoutSpaces: text.replace(/\s/gu, '').length,
    lines: lines.length,
    paragraphs,
    headings,
    links,
    images,
    tasks,
    tasksDone,
    codeBlocks,
    mathBlocks,
    tables,
    blockquotes,
    listItems,
    readingMinutes: words ? Math.max(1, Math.ceil(words / 210)) : 0,
  }
}

/** Books a save: the document shape now, word deltas since the last save. */
export const recordDocumentSaved = (session: PageStatsSession, markdown: string, now: number): PageStatsSession => {
  const measured = measureDocument(markdown)
  const previous = session.document
  const delta = measured.words - previous.words
  const document: DocumentStats = {
    ...measured,
    peakWords: Math.max(previous.peakWords, measured.words),
    wordsAdded: previous.wordsAdded + (delta > 0 ? delta : 0),
    wordsRemoved: previous.wordsRemoved + (delta < 0 ? -delta : 0),
  }
  return bumped({
    ...session,
    document,
    saveCount: session.saveCount + 1,
    lastSavedAt: toIso(now),
  })
}

export const markPageStatsPersisted = (session: PageStatsSession, revision = session.revision, dwellMs = session.dwellMs): PageStatsSession => ({
  ...session,
  persistedRevision: Math.max(session.persistedRevision, revision),
  persistedDwellMs: Math.max(session.persistedDwellMs, dwellMs),
})

/**
 * True when something worth writing happened since the last persist. Dwell
 * alone only counts once it grew by `minDwellDeltaMs`, so flicking through
 * notes does not rewrite every file it passes.
 */
export const pageStatsNeedPersist = (session: PageStatsSession, minDwellDeltaMs = 0) => (
  session.revision !== session.persistedRevision || session.dwellMs - session.persistedDwellMs > minDwellDeltaMs
)

export const formatPageDwell = (dwellMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(dwellMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} h ${minutes} min`
  if (minutes > 0) return `${minutes} min ${seconds} s`
  return `${seconds} s`
}

export const snapshotPageStats = (session: PageStatsSession): PageStats => ({
  version: PAGE_STATS_VERSION,
  createdAt: session.createdAt,
  modifiedAt: session.modifiedAt,
  firstOpenedAt: session.firstOpenedAt,
  lastOpenedAt: session.lastOpenedAt,
  lastClosedAt: session.lastClosedAt,
  lastSavedAt: session.lastSavedAt,
  openCount: session.openCount,
  saveCount: session.saveCount,
  dwellMs: session.dwellMs,
  focusMs: session.focusMs,
  longestSessionMs: session.longestSessionMs,
  lastSessionMs: session.lastSessionMs,
  activeDays: session.activeDays,
  opensByHour: session.opensByHour,
  dwellByHour: session.dwellByHour,
  dwellByWeekday: session.dwellByWeekday,
  typing: session.typing,
  ink: session.ink,
  document: session.document,
})

/** Wraps persisted stats as an idle (not open) session. */
export const idlePageStatsSession = (stats: PageStats): PageStatsSession => ({
  ...stats,
  active: false,
  sessionStartedAt: null,
  sessionDwellMs: 0,
  lastTypedAtMs: null,
  typingBurstStartedAtMs: null,
  lastStrokeEndedAtMs: null,
  inkBurstStartedAtMs: null,
  revision: 0,
  persistedRevision: 0,
  persistedDwellMs: stats.dwellMs,
})
