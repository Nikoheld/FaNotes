/**
 * In-memory inverted index over searchable units (a note's text, its
 * handwriting transcript, one PDF page, one worksheet, PDF annotations).
 * Pure TypeScript with no DOM access, so every rule is tested in Node.
 */
import { foldPlain, foldSearch, makeSnippet, matchRanges, parseDocQuery, tokenize, type Snippet } from './text'

export const DOC_INDEX_FORMAT = 'fanotes-doc-index-v1'

export type UnitKind = 'note' | 'ink' | 'pdf-page' | 'worksheet' | 'annotations'
export type UnitSource = 'text' | 'text-layer' | 'ocr' | 'transcript'

export type IndexUnit = {
  /** `${path}#${kind}:${n}` — unique per document. */
  id: string
  path: string
  kind: UnitKind
  /** 1-based PDF page, or worksheet number. */
  page?: number
  /** Worksheet id when the unit is (part of) a worksheet. */
  worksheetId?: string
  source: UnitSource
  /** 0–1, OCR only. */
  confidence?: number
  text: string
}

export type DocStatus = 'indexed' | 'partial' | 'unsupported' | 'failed'

export type UnitIssue = {
  kind: UnitKind
  page?: number
  status: 'empty' | 'failed' | 'skipped'
  reason: string
}

export type DocRecord = {
  path: string
  title: string
  kind: 'note' | 'pdf'
  fingerprint: string
  extractor: number
  status: DocStatus
  /** PDF page count when known. */
  pageCount?: number
  /** Next PDF page to read when `partial`. */
  resumePage?: number
  attempts: number
  nextRetryAt?: number
  reason?: string
  issues: UnitIssue[]
  ocrPages: number
  updatedAt: number
}

export type SearchResult = {
  path: string
  title: string
  unitId: string
  kind: UnitKind
  page?: number
  worksheetId?: string
  source: UnitSource
  confidence?: number
  score: number
  /** Number of matched words in this unit. */
  matches: number
  snippet: Snippet
  /** Other documents with the identical page text. */
  alsoIn: number
  /** 0–1 vertical position for handwriting transcripts with positioned lines. */
  inkY?: number
  /** True when only the title/path matched, not the text. */
  titleOnly: boolean
}

type StoredUnit = IndexUnit & { length: number; tf: Map<string, number>; textKey: string }

const K1 = 1.2
const B = 0.75
const MAX_RESULTS = 40
const titleTokens = (doc: Pick<DocRecord, 'title' | 'path'>) => new Set(tokenize(foldPlain(`${doc.title} ${doc.path.replace(/[/._-]+/gu, ' ')}`)))

const sourceWeight = (unit: Pick<IndexUnit, 'source' | 'confidence'>) => {
  if (unit.source === 'ocr') return 0.55 + 0.45 * (typeof unit.confidence === 'number' ? unit.confidence : 0.6)
  if (unit.source === 'transcript') return 0.85
  return 1
}

const hashText = (text: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
}

const POSITIONED = /^\s*(\d+(?:\.\d+)?)\t(.*)$/u

/** y of the first transcript line containing every term (or the first term). */
export const inkLineY = (transcript: string, terms: readonly string[]) => {
  const lines = transcript.split('\n').filter((line) => line.trim())
  const parsed = lines.map((line) => {
    const match = POSITIONED.exec(line)
    return match ? { y: Math.min(1, Math.max(0, Number(match[1]))), text: foldPlain(match[2] ?? '') } : { y: null, text: foldPlain(line) }
  })
  const hit = (text: string, term: string) => matchRanges(text, [term], 1).length > 0
  let index = parsed.findIndex((line) => terms.every((term) => hit(line.text, term)))
  if (index < 0) index = parsed.findIndex((line) => terms.some((term) => hit(line.text, term)))
  if (index < 0) return undefined
  const y = parsed[index]!.y
  if (y !== null) return y
  return parsed.length === 1 ? 0.15 : index / (parsed.length - 1)
}

export class DocIndex {
  private units = new Map<string, StoredUnit>()
  private docUnits = new Map<string, Set<string>>()
  private docs = new Map<string, DocRecord>()
  private postings = new Map<string, Map<string, number>>()
  /** First two letters → vocabulary, for prefix expansion without sorting. */
  private buckets = new Map<string, Set<string>>()
  private titleCache = new Map<string, Set<string>>()
  private totalLength = 0

  get documentCount() { return this.docs.size }
  get unitCount() { return this.units.size }

  getDoc(path: string) { return this.docs.get(path) }
  listDocs() { return [...this.docs.values()] }
  unitsOf(path: string) { return [...(this.docUnits.get(path) ?? [])].map((id) => this.units.get(id)!).filter(Boolean) as IndexUnit[] }

  setDoc(doc: DocRecord) {
    this.docs.set(doc.path, { ...doc, issues: [...doc.issues] })
    this.titleCache.delete(doc.path)
  }

  addUnit(unit: IndexUnit) {
    if (this.units.has(unit.id)) this.removeUnit(unit.id)
    const folded = foldPlain(unit.text)
    const tokens = tokenize(folded)
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    const stored: StoredUnit = { ...unit, length: tokens.length, tf, textKey: hashText(folded) }
    this.units.set(unit.id, stored)
    let set = this.docUnits.get(unit.path)
    if (!set) { set = new Set(); this.docUnits.set(unit.path, set) }
    set.add(unit.id)
    this.totalLength += tokens.length
    for (const [token, count] of tf) {
      let posting = this.postings.get(token)
      if (!posting) {
        posting = new Map()
        this.postings.set(token, posting)
        const key = token.slice(0, 2)
        let bucket = this.buckets.get(key)
        if (!bucket) { bucket = new Set(); this.buckets.set(key, bucket) }
        bucket.add(token)
      }
      posting.set(unit.id, count)
    }
  }

  private removeUnit(id: string) {
    const unit = this.units.get(id)
    if (!unit) return
    for (const token of unit.tf.keys()) {
      const posting = this.postings.get(token)
      if (!posting) continue
      posting.delete(id)
      if (!posting.size) {
        this.postings.delete(token)
        this.buckets.get(token.slice(0, 2))?.delete(token)
      }
    }
    this.totalLength -= unit.length
    this.units.delete(id)
    this.docUnits.get(unit.path)?.delete(id)
  }

  /** Removes a document's units (and the record unless `keepRecord`). */
  removeDoc(path: string, keepRecord = false) {
    for (const id of [...(this.docUnits.get(path) ?? [])]) this.removeUnit(id)
    this.docUnits.delete(path)
    if (!keepRecord) {
      this.docs.delete(path)
      this.titleCache.delete(path)
    }
  }

  clear() {
    this.units.clear(); this.docUnits.clear(); this.docs.clear(); this.postings.clear(); this.buckets.clear(); this.titleCache.clear()
    this.totalLength = 0
  }

  private expand(term: string) {
    const bucket = term.length >= 2 ? this.buckets.get(term.slice(0, 2)) : null
    const candidates = bucket ?? (() => {
      const all = new Set<string>()
      for (const [key, set] of this.buckets) if (key.startsWith(term)) for (const token of set) all.add(token)
      return all
    })()
    const out: Array<{ token: string; weight: number }> = []
    for (const token of candidates) {
      if (token === term) out.push({ token, weight: 1 })
      else if (token.startsWith(term)) out.push({ token, weight: 0.6 })
    }
    return out
  }

  private titleOf(path: string) {
    let cached = this.titleCache.get(path)
    if (!cached) {
      const doc = this.docs.get(path)
      cached = doc ? titleTokens(doc) : new Set()
      this.titleCache.set(path, cached)
    }
    return cached
  }

  search(raw: string, limit = MAX_RESULTS): SearchResult[] {
    const { terms } = parseDocQuery(raw)
    if (!terms.length || !this.units.size) return []
    const unitCount = this.units.size
    const avg = this.totalLength / Math.max(1, unitCount) || 1
    // term → unit → effective tf
    const perTerm: Array<Map<string, number>> = []
    const idf: number[] = []
    for (const term of terms) {
      const hits = new Map<string, number>()
      for (const { token, weight } of this.expand(term)) {
        for (const [unitId, count] of this.postings.get(token) ?? []) hits.set(unitId, (hits.get(unitId) ?? 0) + count * weight)
      }
      perTerm.push(hits)
      idf.push(Math.log(1 + (unitCount - hits.size + 0.5) / (hits.size + 0.5)))
    }
    const titleMatch = (path: string, term: string) => {
      for (const token of this.titleOf(path)) if (token.startsWith(term)) return true
      return false
    }
    // Candidate units: every term in the text, or in the document's title/path.
    const candidates = new Set<string>()
    for (const map of perTerm) for (const id of map.keys()) candidates.add(id)
    const titleOnlyDocs = new Set<string>()
    for (const path of this.docs.keys()) if (terms.every((term) => titleMatch(path, term))) titleOnlyDocs.add(path)
    const scored: SearchResult[] = []
    const seenDocTitleOnly = new Set<string>()
    const consider = (unit: StoredUnit, titleOnly: boolean) => {
      const doc = this.docs.get(unit.path)
      if (!doc) return
      let score = 0
      let matches = 0
      for (let index = 0; index < terms.length; index += 1) {
        const tf = perTerm[index]!.get(unit.id) ?? 0
        if (tf > 0) {
          score += idf[index]! * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * unit.length / avg))
          matches += Math.round(tf)
        }
        if (titleMatch(unit.path, terms[index]!)) score += 0.8 * idf[index]!
      }
      score *= sourceWeight(unit)
      if (titleOnly) score *= 0.5
      scored.push({
        path: unit.path,
        title: doc.title,
        unitId: unit.id,
        kind: unit.kind,
        ...(unit.page !== undefined ? { page: unit.page } : {}),
        ...(unit.worksheetId ? { worksheetId: unit.worksheetId } : {}),
        source: unit.source,
        ...(unit.confidence !== undefined ? { confidence: unit.confidence } : {}),
        score,
        matches: titleOnly ? 0 : matches,
        snippet: { text: '', highlights: [] },
        alsoIn: 0,
        titleOnly,
      })
    }
    for (const id of candidates) {
      const unit = this.units.get(id)!
      const textAll = perTerm.every((map) => map.has(id))
      const withTitle = textAll || perTerm.every((map, index) => map.has(id) || titleMatch(unit.path, terms[index]!))
      if (!withTitle) continue
      consider(unit, false)
    }
    // Documents found only by their title: one result at their first unit.
    for (const path of titleOnlyDocs) {
      if (scored.some((result) => result.path === path) || seenDocTitleOnly.has(path)) continue
      const first = [...(this.docUnits.get(path) ?? [])].map((id) => this.units.get(id)!).sort((a, b) => (a.page ?? 0) - (b.page ?? 0))[0]
      if (first) { seenDocTitleOnly.add(path); consider(first, true) }
    }
    scored.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, 'de') || (left.page ?? 0) - (right.page ?? 0))
    // Identical page text in several files shows once; pages inside one file stay separate.
    const byText = new Map<string, SearchResult>()
    const out: SearchResult[] = []
    for (const result of scored) {
      const unit = this.units.get(result.unitId)!
      const key = unit.length >= 3 ? unit.textKey : `${unit.id}`
      const first = byText.get(key)
      if (first && first.path !== result.path) { first.alsoIn += 1; continue }
      if (!first) byText.set(key, result)
      out.push(result)
      if (out.length >= limit) break
    }
    // Snippets only for what is shown.
    for (const result of out) {
      const unit = this.units.get(result.unitId)!
      const readable = unit.kind === 'ink' ? unit.text.replace(/^[ \t]*\d+(?:\.\d+)?\t/gmu, '') : unit.text
      result.snippet = makeSnippet(readable, terms)
      if (!result.titleOnly) result.matches = Math.max(result.matches, result.snippet.matched ?? 0)
      if (unit.kind === 'ink') {
        const y = inkLineY(unit.text, terms)
        if (y !== undefined) result.inkY = y
      }
    }
    return out
  }

  /** Plain data for persistence and tests. */
  snapshot() {
    return {
      format: DOC_INDEX_FORMAT,
      docs: this.listDocs(),
      units: [...this.units.values()].map(({ length: _length, tf: _tf, textKey: _key, ...unit }) => unit as IndexUnit),
    }
  }

  static fromSnapshot(snapshot: { docs: DocRecord[]; units: IndexUnit[] } | null | undefined) {
    const index = new DocIndex()
    if (!snapshot) return index
    for (const doc of snapshot.docs ?? []) index.setDoc(doc)
    for (const unit of snapshot.units ?? []) if (index.docs.has(unit.path)) index.addUnit(unit)
    return index
  }
}
