import { AlertTriangle, LoaderCircle, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SearchHit } from '../types'
import type { SearchResult } from '../lib/docSearch/docIndex'
import type { IndexerProgress } from '../lib/docSearch/indexer'
import { docSearch } from '../lib/docSearch/service'

export const hitLabel = (hit: Pick<SearchHit, 'unit' | 'page' | 'source' | 'confidence'>) => {
  const where = hit.unit === 'pdf-page' ? `Seite ${hit.page ?? '?'}`
    : hit.unit === 'worksheet' ? `Arbeitsblatt ${hit.page ?? ''}`.trim()
      : hit.unit === 'ink' ? 'Handschrift-Abschrift'
        : hit.unit === 'annotations' ? 'Anmerkungen'
          : 'Notiz'
  if (hit.source === 'ocr') return `${where} · Texterkennung${typeof hit.confidence === 'number' ? ` ~${Math.round(hit.confidence * 100)} %` : ''}`
  return where
}

const toHit = (result: SearchResult, query: string): SearchHit => {
  const [first] = result.snippet.highlights
  return {
    relativePath: result.path,
    title: result.title,
    excerpt: result.snippet.text || (result.titleOnly ? `Dateiname · ${result.path}` : ''),
    matches: Math.max(1, result.matches),
    kind: 'note',
    unit: result.kind,
    source: result.source,
    ...(result.page !== undefined ? { page: result.page } : {}),
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    ...(result.snippet.highlights.length ? { highlights: result.snippet.highlights } : {}),
    ...(result.alsoIn ? { alsoIn: result.alsoIn } : {}),
    ...(result.inkY !== undefined ? { inkAnchor: { y: result.inkY } } : {}),
    // The PDF view searches literally; give it the word as written on the page.
    query: first ? result.snippet.text.slice(first[0], first[1]) : query,
  }
}

/** Index results for a query; recomputed when the index changes. */
export const useDocIndexHits = (query: string, version: number) => useMemo(() => {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []
  return docSearch.search(trimmed).map((result) => toHit(result, trimmed))
  // `version` changes when indexing commits new text.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [query, version])

const REASONS: Record<string, string> = {
  'no-letters': 'keine Schrift erkannt',
  'worksheet-missing': 'Arbeitsblatt fehlt',
  'pdf-worksheet-typed-text-only': 'PDF-Arbeitsblatt: nur getippte Felder',
}
const reasonText = (reason = '') => REASONS[reason] ?? (reason.startsWith('ocr') ? 'Texterkennung fehlgeschlagen' : reason)
const unitName = (kind: string, page?: number) => (kind === 'pdf-page' ? `Seite ${page}` : kind === 'worksheet' ? `Arbeitsblatt ${page}` : kind)

/** Index state, progress, pause/resume, retry, rebuild and what could not be read. */
export function DocSearchStatus({ onIndexChanged }: { onIndexChanged: () => void }) {
  const [progress, setProgress] = useState<IndexerProgress | null>(() => docSearch.progress())
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let units = -1
    let timer: number | null = null
    const unsubscribe = docSearch.subscribe((next) => {
      setProgress(next)
      if (next.counts.units !== units) {
        units = next.counts.units
        if (timer === null) timer = window.setTimeout(() => { timer = null; onIndexChanged() }, 700)
      }
    })
    return () => { unsubscribe(); if (timer !== null) window.clearTimeout(timer) }
  }, [onIndexChanged])
  const problems = useMemo(() => (open ? docSearch.issues() : []), [open, progress])
  if (!progress) return null
  const { counts } = progress
  const working = progress.state === 'indexing' || progress.state === 'scanning' || progress.state === 'loading'
  const paused = progress.state === 'paused'
  const problemCount = counts.unsupported + counts.failed + counts.issues
  const searchable = counts.indexed + counts.partial
  let line: string
  if (progress.state === 'loading') line = 'Suchindex wird geladen …'
  else if (paused) line = `Lesen pausiert · ${searchable} von ${progress.total || searchable} Dokumenten durchsuchbar`
  else if (working && progress.current) {
    const page = progress.current.pageCount ? ` · Seite ${progress.current.page ?? 1}/${progress.current.pageCount}` : ''
    line = `Liest „${progress.current.title}“${page} · noch ${progress.pending}`
  } else if (working) line = 'Vault wird geprüft …'
  else if (progress.state === 'error') line = progress.lastError ?? 'Der Suchindex konnte nicht aktualisiert werden.'
  else line = `${searchable} Dokumente mit Inhalt durchsuchbar${counts.ocrPages ? ` · ${counts.ocrPages} Seiten per Texterkennung` : ''}`
  return (
    <div className={`doc-search-status ${working ? 'is-working' : ''}`}>
      <div className="doc-search-status-row">
        {working && !paused ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : null}
        <span className="doc-search-status-text" role="status" aria-live="polite">{line}</span>
        {working || paused ? (
          <button type="button" className="doc-search-mini" onClick={() => (paused ? docSearch.resume() : docSearch.pause())} aria-label={paused ? 'Lesen fortsetzen' : 'Lesen pausieren'} title={paused ? 'Fortsetzen' : 'Pausieren'}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
        ) : null}
        {problemCount > 0 ? (
          <button type="button" className="doc-search-mini doc-search-issues-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <AlertTriangle size={13} aria-hidden="true" /> {problemCount} {problemCount === 1 ? 'Hinweis' : 'Hinweise'}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="doc-search-issues">
          <p>Diese Inhalte sind nicht oder nur teilweise durchsuchbar. Handschrift wird nur über ihre Abschrift gefunden; gescannte Seiten liest eine lokale Texterkennung, die Fehler machen kann.</p>
          <ul>
            {problems.slice(0, 50).map((doc) => (
              <li key={doc.path}>
                <strong>{doc.title}</strong>
                {doc.status === 'unsupported' ? <span> — nicht lesbar: {doc.reason}</span> : null}
                {doc.status === 'failed' ? <span> — Fehler, neuer Versuch später: {doc.reason}</span> : null}
                {doc.issues.length ? <span> — {doc.issues.slice(0, 6).map((issue) => `${unitName(issue.kind, issue.page)}: ${reasonText(issue.reason)}`).join(', ')}{doc.issues.length > 6 ? ` … (+${doc.issues.length - 6})` : ''}</span> : null}
              </li>
            ))}
          </ul>
          <div className="doc-search-issue-actions">
            <button type="button" onClick={() => docSearch.retry()}><RotateCcw size={13} aria-hidden="true" /> Erneut versuchen</button>
            <button type="button" onClick={() => docSearch.rebuild()}><RefreshCw size={13} aria-hidden="true" /> Index neu aufbauen</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
