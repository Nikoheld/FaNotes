/**
 * Incremental, resumable background indexing. The host lists documents with
 * a fingerprint, an extractor turns one document into units, a store persists
 * them. One document is processed at a time; units are committed in batches so
 * a pause, a crash or a closed window loses at most one batch.
 */
import { DocIndex, type DocRecord, type IndexUnit, type UnitIssue } from './docIndex'

/** Bump when extraction changes; every document is then read again. */
export const EXTRACTOR_VERSION = 1
export const RETRY_BASE_MS = 60_000
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000
/** OCR pages per document per pass, so one scanned book cannot starve the rest. */
export const OCR_PAGES_PER_PASS = 8

export type DocSource = {
  path: string
  title: string
  kind: 'note' | 'pdf'
  /** Changes whenever the document or anything indexed with it changes. */
  fingerprint: string
  modifiedAt?: number
}

export type ExtractContext = {
  /** First PDF page to read (1 when starting over). */
  resumePage: number
  /** OCR pages allowed in this pass. */
  ocrBudget: number
  shouldStop: () => boolean
  /** Waits while the user is typing or writing; call before expensive steps. */
  pause: () => Promise<void>
  /** Units already committed for this document (earlier batches and passes). */
  previousUnits: () => IndexUnit[]
  /** Commits a batch. `nextPage` is where a resumed pass would continue. */
  commit: (units: IndexUnit[], progress?: { nextPage?: number; pageCount?: number; ocrPages?: number }) => Promise<void>
  issue: (issue: UnitIssue) => void
}

export type ExtractOutcome =
  | { status: 'done'; pageCount?: number }
  /** Stopped or out of OCR budget; continue at `resumePage` next pass. */
  | { status: 'partial'; resumePage: number; pageCount?: number }
  /** Will not work until the file changes (encrypted, damaged, too large). */
  | { status: 'unsupported'; reason: string }
  /** Transient; retried with backoff. */
  | { status: 'failed'; reason: string }

export type DocExtractor = {
  extract: (source: DocSource, context: ExtractContext) => Promise<ExtractOutcome>
}

export type DocIndexStore = {
  load: () => Promise<{ docs: DocRecord[]; units: IndexUnit[] } | null>
  saveDoc: (doc: DocRecord) => Promise<void>
  addUnits: (units: IndexUnit[]) => Promise<void>
  removeUnits: (path: string) => Promise<void>
  removeDoc: (path: string) => Promise<void>
  clear: () => Promise<void>
}

export type IndexerState = 'idle' | 'loading' | 'scanning' | 'indexing' | 'paused' | 'error'

export type IndexerProgress = {
  state: IndexerState
  /** Documents found in the vault in the last scan. */
  total: number
  /** Documents that still need work in this pass. */
  pending: number
  current?: { path: string; title: string; page?: number; pageCount?: number }
  counts: {
    indexed: number
    partial: number
    unsupported: number
    failed: number
    units: number
    ocrPages: number
    issues: number
  }
  lastError?: string
}

export const retryDelay = (attempts: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))

type Options = {
  index?: DocIndex
  store: DocIndexStore
  list: () => Promise<DocSource[]>
  extractor: DocExtractor
  now?: () => number
  /** Awaited between documents and batches: idle time, user activity, pause. */
  gate?: () => Promise<void>
  onProgress?: (progress: IndexerProgress) => void
  ocrPagesPerPass?: number
}

export class DocIndexer {
  readonly index: DocIndex
  private readonly options: Options
  private readonly now: () => number
  private running: Promise<void> | null = null
  private rerun = false
  private paused = false
  private stopToken = 0
  private state: IndexerState = 'idle'
  private total = 0
  private pending = 0
  private current: IndexerProgress['current']
  private lastError: string | undefined
  private loaded = false

  constructor(options: Options) {
    this.options = options
    this.index = options.index ?? new DocIndex()
    this.now = options.now ?? Date.now
  }

  get isPaused() { return this.paused }

  progress(): IndexerProgress {
    const counts = { indexed: 0, partial: 0, unsupported: 0, failed: 0, units: this.index.unitCount, ocrPages: 0, issues: 0 }
    for (const doc of this.index.listDocs()) {
      counts[doc.status] += 1
      counts.ocrPages += doc.ocrPages
      counts.issues += doc.issues.length
    }
    return {
      state: this.paused && this.state !== 'loading' ? 'paused' : this.state,
      total: this.total,
      pending: this.pending,
      ...(this.current ? { current: this.current } : {}),
      counts,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  private emit() { this.options.onProgress?.(this.progress()) }

  /** Loads the persisted index. A damaged store is cleared and rebuilt. */
  async load() {
    if (this.loaded) return
    this.state = 'loading'
    this.emit()
    try {
      const snapshot = await this.options.store.load()
      const restored = DocIndex.fromSnapshot(snapshot)
      this.index.clear()
      for (const doc of restored.listDocs()) {
        this.index.setDoc(doc)
        for (const unit of restored.unitsOf(doc.path)) this.index.addUnit(unit)
      }
    } catch (error) {
      this.lastError = `Index beschädigt, wird neu aufgebaut: ${error instanceof Error ? error.message : String(error)}`
      this.index.clear()
      await this.options.store.clear().catch(() => undefined)
    }
    this.loaded = true
    this.state = 'idle'
    this.emit()
  }

  /** Starts a pass, or queues one more if a pass is running. Never runs two at once. */
  schedule(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = (async () => {
      try {
        if (!this.loaded) await this.load()
        do {
          this.rerun = false
          const more = await this.runPass()
          if (more) this.rerun = true
        } while (this.rerun && !this.paused)
      } finally {
        this.running = null
        this.current = undefined
        if (this.state !== 'error') this.state = 'idle'
        this.emit()
      }
    })()
    return this.running
  }

  pause() { this.paused = true; this.stopToken += 1; this.emit() }
  resume() { this.paused = false; this.emit(); return this.schedule() }
  /** Stops the running pass after the current batch. */
  cancel() { this.stopToken += 1 }

  /** Retries failed documents now instead of after their backoff. */
  retryFailed() {
    for (const doc of this.index.listDocs()) {
      if (doc.status === 'failed' || doc.status === 'unsupported') {
        const next: DocRecord = { ...doc, nextRetryAt: 0, fingerprint: doc.status === 'unsupported' ? '' : doc.fingerprint }
        this.index.setDoc(next)
      }
    }
    return this.schedule()
  }

  /** Throws the whole index away and reads everything again. */
  async rebuild() {
    this.cancel()
    await this.running?.catch(() => undefined)
    this.index.clear()
    await this.options.store.clear()
    return this.schedule()
  }

  private needsWork(doc: DocRecord | undefined, source: DocSource, now: number) {
    if (!doc) return true
    if (doc.fingerprint !== source.fingerprint || doc.extractor !== EXTRACTOR_VERSION) return true
    if (doc.status === 'partial') return true
    if (doc.status === 'failed') return (doc.nextRetryAt ?? 0) <= now
    return false
  }

  /** One pass over the vault. Returns true when documents are still partial. */
  private async runPass(): Promise<boolean> {
    const token = this.stopToken
    const stopped = () => this.paused || token !== this.stopToken
    this.state = 'scanning'
    this.emit()
    let sources: DocSource[]
    try {
      sources = await this.options.list()
    } catch (error) {
      this.state = 'error'
      this.lastError = `Vault konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`
      return false
    }
    this.lastError = undefined
    const byPath = new Map<string, DocSource>()
    for (const source of sources) if (!byPath.has(source.path)) byPath.set(source.path, source)
    this.total = byPath.size
    // Deleted, moved or trashed documents leave the index.
    for (const doc of this.index.listDocs()) {
      if (byPath.has(doc.path)) continue
      this.index.removeDoc(doc.path)
      await this.options.store.removeDoc(doc.path).catch(() => undefined)
    }
    const now = this.now()
    const queue = [...byPath.values()]
      .filter((source) => this.needsWork(this.index.getDoc(source.path), source, now))
      .sort((left, right) => (
        (left.kind === 'note' ? 0 : 1) - (right.kind === 'note' ? 0 : 1)
        || (this.index.getDoc(left.path)?.status === 'partial' ? 1 : 0) - (this.index.getDoc(right.path)?.status === 'partial' ? 1 : 0)
        || (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0)
      ))
    this.pending = queue.length
    this.state = 'indexing'
    this.emit()
    let partialLeft = false
    for (const source of queue) {
      if (stopped()) return false
      await this.options.gate?.()
      if (stopped()) return false
      const outcome = await this.processOne(source, stopped)
      if (outcome === 'partial') partialLeft = true
      this.pending = Math.max(0, this.pending - 1)
      this.emit()
    }
    return partialLeft
  }

  private async processOne(source: DocSource, stopped: () => boolean): Promise<'done' | 'partial' | 'other'> {
    const store = this.options.store
    const previous = this.index.getDoc(source.path)
    const resuming = Boolean(previous && previous.status === 'partial' && previous.fingerprint === source.fingerprint && previous.extractor === EXTRACTOR_VERSION)
    if (!resuming) {
      // Edited, new or changed: old text goes first, so nothing stale stays searchable.
      this.index.removeDoc(source.path, true)
      await store.removeUnits(source.path).catch(() => undefined)
    }
    const record: DocRecord = {
      path: source.path,
      title: source.title,
      kind: source.kind,
      fingerprint: source.fingerprint,
      extractor: EXTRACTOR_VERSION,
      status: 'partial',
      ...(resuming && previous?.pageCount ? { pageCount: previous.pageCount } : {}),
      resumePage: resuming ? previous?.resumePage ?? 1 : 1,
      attempts: resuming ? previous?.attempts ?? 0 : (previous?.fingerprint === source.fingerprint ? previous?.attempts ?? 0 : 0),
      issues: resuming ? [...(previous?.issues ?? [])] : [],
      ocrPages: resuming ? previous?.ocrPages ?? 0 : 0,
      updatedAt: this.now(),
    }
    this.index.setDoc(record)
    this.current = { path: source.path, title: source.title, page: record.resumePage, ...(record.pageCount ? { pageCount: record.pageCount } : {}) }
    this.emit()
    const startPage = record.resumePage ?? 1
    let outcome: ExtractOutcome
    try {
      outcome = await this.options.extractor.extract(source, {
        resumePage: startPage,
        ocrBudget: this.options.ocrPagesPerPass ?? OCR_PAGES_PER_PASS,
        shouldStop: stopped,
        pause: async () => { await this.options.gate?.() },
        previousUnits: () => this.index.unitsOf(source.path),
        issue: (issue) => {
          if (record.issues.length < 500 && !record.issues.some((known) => known.kind === issue.kind && known.page === issue.page && known.reason === issue.reason)) record.issues.push(issue)
        },
        commit: async (units, progress) => {
          for (const unit of units) {
            if (unit.path !== source.path) continue
            this.index.addUnit(unit)
          }
          if (progress?.nextPage) record.resumePage = progress.nextPage
          if (progress?.pageCount) record.pageCount = progress.pageCount
          if (progress?.ocrPages) record.ocrPages += progress.ocrPages
          record.updatedAt = this.now()
          this.index.setDoc(record)
          await store.addUnits(units.filter((unit) => unit.path === source.path))
          await store.saveDoc(record)
          this.current = { path: source.path, title: source.title, page: record.resumePage, ...(record.pageCount ? { pageCount: record.pageCount } : {}) }
          this.emit()
          await this.options.gate?.()
        },
      })
    } catch (error) {
      outcome = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    let result: 'done' | 'partial' | 'other' = 'other'
    if (outcome.status === 'done') {
      record.status = 'indexed'
      delete record.resumePage
      record.attempts = 0
      delete record.nextRetryAt
      delete record.reason
      if (outcome.pageCount) record.pageCount = outcome.pageCount
      result = 'done'
    } else if (outcome.status === 'partial') {
      if (outcome.pageCount) record.pageCount = outcome.pageCount
      if (outcome.resumePage <= startPage && !stopped()) {
        // No progress although nobody asked to stop: treat as a transient failure.
        record.status = 'failed'
        record.attempts += 1
        record.nextRetryAt = this.now() + retryDelay(record.attempts)
        record.reason = 'Keine Fortschritte beim Lesen'
      } else {
        record.status = 'partial'
        record.resumePage = outcome.resumePage
        result = 'partial'
      }
    } else if (outcome.status === 'unsupported') {
      this.index.removeDoc(source.path, true)
      await store.removeUnits(source.path).catch(() => undefined)
      record.status = 'unsupported'
      record.reason = outcome.reason
      delete record.resumePage
    } else {
      record.status = 'failed'
      record.attempts += 1
      record.nextRetryAt = this.now() + retryDelay(record.attempts)
      record.reason = outcome.reason
    }
    record.updatedAt = this.now()
    this.index.setDoc(record)
    await store.saveDoc(record).catch(() => undefined)
    return result
  }
}
