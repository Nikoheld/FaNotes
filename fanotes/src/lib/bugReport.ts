export const BUG_REPORT_WINDOW_MS = 5 * 60 * 1000
/** Keeps a full 5-minute pen stream under the fasrv/nginx 256 KiB POST cap. */
export const BUG_REPORT_MAX_EVENTS = 900
export const BUG_REPORT_MAX_BODY_BYTES = 256 * 1024
export const BUG_REPORT_PEN_SAMPLE_MS = 400
export const BUG_REPORT_HOST = 'fanotes.fasrv.ch'
export const BUG_REPORT_ORIGIN = `https://${BUG_REPORT_HOST}`
export const BUG_REPORT_PATH = '/api/v1/bug-report'

const compactCoord = (value: number) => Math.round(value * 10_000) / 10_000
const compactPx = (value: number) => Math.round(value)

export type BugReportEvent = {
  at: number
  kind: 'pen' | 'note' | 'tool' | 'error' | 'app' | 'text'
  noteId?: string
  x?: number
  y?: number
  pointerType?: string
  tool?: string
  version?: string
  platform?: string
  message?: string
  pageW?: number
  pageH?: number
  padX?: number
  padY?: number
  camX?: number
  camY?: number
  grew?: boolean
  jump?: boolean
  paperX?: number
  paperY?: number
  edX?: number
  edY?: number
  slip?: boolean
  back?: boolean
}

export type PenDiagnosticLayout = {
  pageW: number
  pageH: number
  padX: number
  padY: number
  camX: number
  camY: number
  grew?: boolean
  jump?: boolean
}

/** Compact reconstructable paint-layout snapshot for one diagnostic pen sample. */
export const buildPenDiagnosticEvent = (input: {
  at: number
  noteId?: string
  x: number
  y: number
  pointerType?: string
  tool?: string
  version?: string
  platform?: string
} & PenDiagnosticLayout): BugReportEvent => {
  const event: BugReportEvent = {
    at: input.at,
    kind: 'pen',
    noteId: input.noteId,
    x: compactCoord(input.x),
    y: compactCoord(input.y),
    pointerType: input.pointerType,
    tool: input.tool,
    version: input.version,
    platform: input.platform,
    pageW: compactPx(input.pageW),
    pageH: compactPx(input.pageH),
    padX: compactPx(input.padX),
    padY: compactPx(input.padY),
    camX: compactPx(input.camX),
    camY: compactPx(input.camY),
  }
  if (input.grew) event.grew = true
  if (input.jump) event.jump = true
  return event
}

export type TextMotionLayout = {
  paperX: number
  paperY: number
  camX: number
  camY: number
  padX: number
  padY: number
  edX: number
  edY: number
  slip?: boolean
  back?: boolean
  pageW?: number
  pageH?: number
}

/** Compact reconstructable ghost-text snapshot: visual vs paper vs camera vs editor layer. */
export const buildTextMotionDiagnosticEvent = (input: {
  at: number
  noteId?: string
  visualX: number
  visualY: number
  version?: string
  platform?: string
} & TextMotionLayout): BugReportEvent => {
  const event: BugReportEvent = {
    at: input.at,
    kind: 'text',
    noteId: input.noteId,
    x: compactCoord(input.visualX),
    y: compactCoord(input.visualY),
    version: input.version,
    platform: input.platform,
    paperX: compactPx(input.paperX),
    paperY: compactPx(input.paperY),
    camX: compactPx(input.camX),
    camY: compactPx(input.camY),
    padX: compactPx(input.padX),
    padY: compactPx(input.padY),
    edX: compactPx(input.edX),
    edY: compactPx(input.edY),
  }
  if (Number.isFinite(input.pageW)) event.pageW = compactPx(input.pageW as number)
  if (Number.isFinite(input.pageH)) event.pageH = compactPx(input.pageH as number)
  if (input.slip) event.slip = true
  if (input.back) event.back = true
  return event
}

export type BugReportPayload = {
  schemaVersion: 1
  description: string
  events: BugReportEvent[]
  version: string
  platform: string
  sentAt: number
}

export const pruneBugReportWindow = (
  events: BugReportEvent[],
  now: number,
  windowMs = BUG_REPORT_WINDOW_MS,
) => {
  const cutoff = now - windowMs
  const kept = events.filter((event) => Number.isFinite(event?.at) && event.at >= cutoff && event.at <= now)
  return kept.length > BUG_REPORT_MAX_EVENTS ? kept.slice(-BUG_REPORT_MAX_EVENTS) : kept
}

export const recordBugReportEvent = (
  events: BugReportEvent[],
  event: BugReportEvent,
  now = event.at,
  windowMs = BUG_REPORT_WINDOW_MS,
) => pruneBugReportWindow([...events, event], now, windowMs)

export const createBugReportLog = (windowMs = BUG_REPORT_WINDOW_MS) => {
  let events: BugReportEvent[] = []
  return {
    record(event: BugReportEvent, now = Date.now()) {
      events = recordBugReportEvent(events, event, now, windowMs)
      return events
    },
    snapshot(now = Date.now()) {
      events = pruneBugReportWindow(events, now, windowMs)
      return events.slice()
    },
  }
}

export const diagnosticLog = createBugReportLog()

let lastTextMotionDiagAt = 0

export const recordTextMotionDiagnostic = (
  event: BugReportEvent,
  now = Date.now(),
) => {
  if (!event.slip && !event.back && now - lastTextMotionDiagAt < BUG_REPORT_PEN_SAMPLE_MS) return
  lastTextMotionDiagAt = now
  diagnosticLog.record(event, now)
}

export const bugReportSubmitTarget = (origin = BUG_REPORT_ORIGIN) => {
  try {
    const parsed = new URL(String(origin || BUG_REPORT_ORIGIN))
    if (parsed.hostname === BUG_REPORT_HOST && parsed.protocol === 'https:') {
      return { url: `${parsed.origin}${BUG_REPORT_PATH}`, host: BUG_REPORT_HOST }
    }
  } catch { /* fall back to the shipped fasrv host */ }
  return { url: `${BUG_REPORT_ORIGIN}${BUG_REPORT_PATH}`, host: BUG_REPORT_HOST }
}

export const buildBugReportPayload = (input: {
  description: string
  events: BugReportEvent[]
  version: string
  platform: string
  now?: number
}): BugReportPayload => ({
  schemaVersion: 1,
  description: String(input.description || '').trim(),
  events: pruneBugReportWindow(input.events, input.now ?? Date.now()),
  version: String(input.version || ''),
  platform: String(input.platform || ''),
  sentAt: input.now ?? Date.now(),
})

export const buildBugReportRequest = (input: {
  description: string
  events: BugReportEvent[]
  version: string
  platform: string
  now?: number
  origin?: string
}) => {
  const target = bugReportSubmitTarget(input.origin)
  return {
    url: target.url,
    host: target.host,
    body: buildBugReportPayload(input),
  }
}

export const submitBugReport = async (input: {
  description: string
  events: BugReportEvent[]
  version: string
  platform: string
  origin?: string
}) => {
  const request = buildBugReportRequest(input)
  const response = await fetch(request.url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request.body),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  return { ok: response.ok, status: response.status, host: request.host, url: request.url }
}
