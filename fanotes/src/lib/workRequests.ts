// Client for the owner-only work-request API ("Fehler & Wünsche", fanotes-site/work-requests-api.mjs).
// Auth and origin come from the sync session helpers; nothing here touches the vault.
import { resolveSyncOrigin, type SyncSession } from './sync/api'

export const WORK_REQUESTS_PATH = '/api/v1/requests'
export const WORK_REQUEST_POLL_MS = 5000
export const WORK_REQUEST_TITLE_MAX = 120
export const WORK_REQUEST_DESCRIPTION_MAX = 4000
export const WORK_REQUEST_MESSAGE_MAX = 2000
export const WORK_REQUEST_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024
export const WORK_REQUEST_LOGS_MAX_BYTES = 256 * 1024

export type WorkRequestKind = 'bug' | 'feature'
export type WorkRequestPriority = 'low' | 'normal' | 'high'
export type WorkRequestStatus = 'queued' | 'picked' | 'working' | 'pr_open' | 'waiting_for_you' | 'merged' | 'rejected' | 'failed'

/** One server event (SSE `data`): `seq` is the SSE id and the Last-Event-ID cursor; `at` is epoch ms. */
export type WorkRequestEvent = { seq: number; at: number; type: string; message: string; percent: number | null; status: WorkRequestStatus | null; from: string | null }
export type WorkRequestPr = { number: number; url: string; ci: string | null }
export type WorkRequest = {
  id: string
  kind: WorkRequestKind
  title: string
  description: string
  priority: WorkRequestPriority
  status: WorkRequestStatus
  percent: number | null
  step: string
  reason: string | null
  pr: WorkRequestPr | null
  /** The owner pressed Übernehmen; the worker merges once CI is green. */
  approved: boolean
  /** Rejected because the owner cancelled it. */
  cancelled: boolean
  createdAt: number
  updatedAt: number
  lastSeq: number
}
export type WorkRequestDetail = { request: WorkRequest; events: WorkRequestEvent[] }

export type WorkRequestDraft = {
  kind: WorkRequestKind
  title: string
  description: string
  priority: WorkRequestPriority
  /** data: URL (PNG/JPEG) as produced by the window capture; sent as raw base64. */
  screenshot?: string | null
  /** Diagnostic events; sent as JSON lines. */
  logs?: unknown[] | null
  version?: string
  platform?: string
}

export class WorkRequestError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'WorkRequestError' }
}

const STATUSES: readonly WorkRequestStatus[] = ['queued', 'picked', 'working', 'pr_open', 'waiting_for_you', 'merged', 'rejected', 'failed']
export const TERMINAL_STATUSES: readonly WorkRequestStatus[] = ['merged', 'rejected', 'failed']

export type StatusTone = 'neutral' | 'active' | 'attention' | 'success' | 'danger'
const STATUS_INFO: Record<WorkRequestStatus, { label: string; tone: StatusTone }> = {
  queued: { label: 'In der Warteschlange', tone: 'neutral' },
  picked: { label: 'Angenommen', tone: 'active' },
  working: { label: 'In Arbeit', tone: 'active' },
  pr_open: { label: 'Änderung bereit', tone: 'active' },
  waiting_for_you: { label: 'Wartet auf dich', tone: 'attention' },
  merged: { label: 'Übernommen', tone: 'success' },
  rejected: { label: 'Abgelehnt', tone: 'danger' },
  failed: { label: 'Fehlgeschlagen', tone: 'danger' },
}

export const normalizeStatus = (value: unknown): WorkRequestStatus =>
  typeof value === 'string' && (STATUSES as readonly string[]).includes(value) ? value as WorkRequestStatus : 'queued'
export const statusInfo = (status: WorkRequestStatus, cancelled = false) => cancelled && status === 'rejected' ? { label: 'Abgebrochen', tone: 'neutral' as StatusTone } : STATUS_INFO[status]
export const isTerminal = (status: WorkRequestStatus) => TERMINAL_STATUSES.includes(status)
/** The owner may still withdraw a request until it is finished. */
export const canCancel = (status: WorkRequestStatus) => !isTerminal(status)
/** The server accepts approval only while the request waits for the owner and was not approved yet. */
export const canApprove = (status: WorkRequestStatus, approved = false) => status === 'waiting_for_you' && !approved
export const canMessage = (status: WorkRequestStatus) => !isTerminal(status)

const str = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const pct = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null
const rec = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

export const parseWorkRequest = (raw: unknown): WorkRequest => {
  const r = rec(raw)
  const prRaw = rec(r.pr)
  const prNumber = Number(prRaw.number)
  const prUrl = str(prRaw.url)
  return {
    id: str(r.id),
    kind: r.type === 'feature' ? 'feature' : 'bug',
    title: str(r.title),
    description: str(r.description),
    priority: r.priority === 'low' || r.priority === 'high' ? r.priority : 'normal',
    status: normalizeStatus(r.status),
    percent: pct(r.percent),
    step: str(r.step),
    reason: str(r.reason) || null,
    pr: Number.isInteger(prNumber) && prNumber > 0 && /^https:\/\//u.test(prUrl) ? { number: prNumber, url: prUrl, ci: str(prRaw.ci) || null } : null,
    approved: r.approved === true,
    cancelled: r.cancelled === true,
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
    lastSeq: num(r.lastSeq),
  }
}

export const parseWorkRequestEvent = (raw: unknown): WorkRequestEvent => {
  const e = rec(raw)
  const status = typeof e.status === 'string' && (STATUSES as readonly string[]).includes(e.status) ? e.status as WorkRequestStatus : null
  return { seq: num(e.seq), at: num(e.at), type: str(e.type, 'progress'), message: str(e.text), percent: pct(e.percent), status, from: str(e.from) || null }
}

/** German timeline line for one server event; null for events that are not worth showing. */
export const describeEvent = (event: WorkRequestEvent): string | null => {
  if (event.type === 'progress') return event.message || null
  if (event.type === 'message') return `Nachricht an Claude: ${event.message}`
  if (event.type === 'approved') return 'Übernahme freigegeben'
  if (event.type === 'status' && event.status) return `Status: ${statusInfo(event.status).label}`
  return null
}

export const parseWorkRequestList = (raw: unknown): WorkRequest[] => {
  const list = Array.isArray(raw) ? raw : Array.isArray(rec(raw).requests) ? rec(raw).requests as unknown[] : []
  return list.map(parseWorkRequest).filter((item) => item.id).sort((a, b) => b.createdAt - a.createdAt)
}

export const parseWorkRequestDetail = (raw: unknown): WorkRequest => parseWorkRequest(rec(raw).request ?? raw)

export const parseCapabilities = (raw: unknown): boolean => rec(raw).enabled === true

/** The server takes logs as text; one JSON line per diagnostic event. */
export const logsToText = (logs: unknown[]) => logs.map((entry) => JSON.stringify(entry)).join('\n')

export type CiState = 'pending' | 'success' | 'failure'
export const ciLabel = (ci: string | null): string | null =>
  ci === 'success' ? 'bestanden' : ci === 'failure' ? 'fehlgeschlagen' : ci === 'pending' ? 'läuft' : ci ? 'ausstehend' : null

/** Bar value: the latest event's percent, else a fixed value per status. */
export const progressPercent = (request: WorkRequest, events: readonly WorkRequestEvent[]): number | null => {
  if (isTerminal(request.status)) return null
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].percent !== null) return events[i].percent
  const byStatus: Partial<Record<WorkRequestStatus, number>> = { queued: 0, picked: 5, pr_open: 90, waiting_for_you: 95 }
  return request.percent ?? byStatus[request.status] ?? null
}

export type DraftProblem = 'title' | 'description' | 'screenshot' | 'logs'
/** Returns the first problem with a draft, or null when it can be sent. */
export const validateDraft = (draft: WorkRequestDraft): DraftProblem | null => {
  const title = draft.title.trim()
  if (!title || title.length > WORK_REQUEST_TITLE_MAX) return 'title'
  const description = draft.description.trim()
  if (!description || description.length > WORK_REQUEST_DESCRIPTION_MAX) return 'description'
  if (draft.screenshot) {
    if (!/^data:image\/(?:png|jpeg|webp);base64,/u.test(draft.screenshot)) return 'screenshot'
    // base64 length -> bytes
    if (Math.floor((draft.screenshot.length - draft.screenshot.indexOf(',') - 1) * 3 / 4) > WORK_REQUEST_SCREENSHOT_MAX_BYTES) return 'screenshot'
  }
  if (draft.logs && logsToText(draft.logs).length > WORK_REQUEST_LOGS_MAX_BYTES) return 'logs'
  return null
}

export const draftProblemText = (problem: DraftProblem) => ({
  title: `Bitte gib einen Titel an (höchstens ${WORK_REQUEST_TITLE_MAX} Zeichen).`,
  description: `Bitte beschreibe die Anfrage (höchstens ${WORK_REQUEST_DESCRIPTION_MAX} Zeichen).`,
  screenshot: 'Der Screenshot ist zu groß oder hat ein unbekanntes Format.',
  logs: 'Die Protokolle sind zu groß, um sie anzuhängen.',
}[problem])

export type WorkRequestsClientOptions = {
  getSession: () => SyncSession | null
  origin?: string | null
  fetchImpl?: typeof fetch
}

export type Unsubscribe = () => void

export class WorkRequestsClient {
  constructor(private readonly options: WorkRequestsClientOptions) {}

  private async call(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; accept?: string; lastEventId?: number } = {}): Promise<Response> {
    const session = this.options.getSession()
    if (!session) throw new WorkRequestError(401, 'Nicht angemeldet.')
    const headers = new Headers({ Authorization: `Bearer ${session.token}`, 'X-FaNotes-Account': session.accountId })
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    if (init.accept) headers.set('Accept', init.accept)
    if (init.lastEventId) headers.set('Last-Event-ID', String(init.lastEventId))
    const doFetch = this.options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    let response: Response
    try {
      response = await doFetch(`${this.options.origin ?? resolveSyncOrigin()}${WORK_REQUESTS_PATH}${path}`, {
        method: init.method ?? 'GET', headers, credentials: 'omit', cache: 'no-store', signal: init.signal,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new WorkRequestError(0, 'Der Server ist nicht erreichbar.')
    }
    if (!response.ok) {
      let message = `Der Server antwortete mit ${response.status}.`
      try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string') message = body.error } catch { /* not JSON */ }
      throw new WorkRequestError(response.status, message)
    }
    return response
  }

  /** True when the signed-in account may use work requests. Any failure counts as "not allowed". */
  async capabilities(): Promise<boolean> {
    try { return parseCapabilities(await (await this.call('/capabilities')).json()) } catch { return false }
  }

  async create(draft: WorkRequestDraft): Promise<WorkRequest> {
    const problem = validateDraft(draft)
    if (problem) throw new WorkRequestError(400, draftProblemText(problem))
    const body = {
      type: draft.kind,
      title: draft.title.trim(),
      description: draft.description.trim(),
      priority: draft.priority,
      screenshot: draft.screenshot ? draft.screenshot.slice(draft.screenshot.indexOf(',') + 1) : undefined,
      logs: draft.logs?.length ? logsToText(draft.logs) : undefined,
      version: draft.version,
      platform: draft.platform,
    }
    const raw = await (await this.call('', { method: 'POST', body })).json() as unknown
    return parseWorkRequest(rec(raw).request ?? raw)
  }

  async list(): Promise<WorkRequest[]> { return parseWorkRequestList(await (await this.call('')).json()) }
  async detail(id: string): Promise<WorkRequest> { return parseWorkRequestDetail(await (await this.call(`/${encodeURIComponent(id)}`)).json()) }
  async approve(id: string): Promise<void> { await this.call(`/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} }) }
  async cancel(id: string): Promise<void> { await this.call(`/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }) }
  async message(id: string, text: string): Promise<void> {
    const body = text.trim()
    if (!body || body.length > WORK_REQUEST_MESSAGE_MAX) throw new WorkRequestError(400, 'Bitte schreibe eine kurze Nachricht.')
    await this.call(`/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text: body } })
  }

  /**
   * Live progress for one request. The server pushes SSE from /:id/events (replayed from Last-Event-ID, closed after
   * a terminal status); the stream is read with fetch because EventSource cannot send the Authorization header.
   * Each event extends the timeline and triggers a detail refresh so the status is always server truth. A stream
   * that ends early (proxy timeout) is reopened with Last-Event-ID; when it cannot be opened, polling every 5 s
   * takes over (progress steps are then derived from the request's `step`) until finished or unsubscribed.
   */
  subscribe(id: string, onUpdate: (detail: WorkRequestDetail) => void, onError?: (error: unknown) => void, pollMs = WORK_REQUEST_POLL_MS): Unsubscribe {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const abort = new AbortController()
    let request: WorkRequest | null = null
    const events: WorkRequestEvent[] = []
    let lastSeq = 0
    let lastStep = ''
    const push = () => { if (request && !stopped) onUpdate({ request, events: [...events] }) }
    const refresh = async () => {
      try {
        request = await this.detail(id)
        // Polling cannot see single events: derive a progress line when the step changed.
        if (request.step && request.step !== lastStep && !events.some((e) => e.message === request!.step)) {
          events.push({ seq: -events.length - 1, at: request.updatedAt, type: 'progress', message: request.step, percent: request.percent, status: null, from: null })
        }
        lastStep = request.step
        push()
        return isTerminal(request.status)
      } catch (error) {
        if (!stopped) onError?.(error)
        return false
      }
    }
    const poll = () => {
      if (stopped || timer) return
      const tick = async () => {
        timer = null
        if (stopped) return
        const done = await refresh()
        if (!done && !stopped) timer = setTimeout(() => void tick(), pollMs)
      }
      timer = setTimeout(() => void tick(), pollMs)
    }
    const readStream = async (): Promise<'terminal' | 'ended'> => {
      const response = await this.call(`/${encodeURIComponent(id)}/events`, { signal: abort.signal, accept: 'text/event-stream', lastEventId: lastSeq })
      if (!response.body || !/text\/event-stream/iu.test(response.headers.get('Content-Type') ?? '')) throw new Error('no stream')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done || stopped) return 'ended'
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/u)
        buffer = blocks.pop() ?? ''
        let changed = false
        for (const block of blocks) {
          const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          let parsed: WorkRequestEvent
          try { parsed = parseWorkRequestEvent(JSON.parse(data)) } catch { continue }
          if (parsed.seq <= lastSeq) continue
          lastSeq = parsed.seq
          events.push(parsed)
          changed = true
        }
        if (changed && await refresh()) return 'terminal'
      }
    }
    void (async () => {
      if (await refresh()) return
      try {
        for (let attempt = 0; attempt < 20 && !stopped; attempt += 1) {
          if (await readStream() === 'terminal') return
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (await refresh()) return
        }
      } catch { /* fall through to polling */ }
      poll()
    })()
    return () => { stopped = true; abort.abort(); if (timer) clearTimeout(timer) }
  }
}
