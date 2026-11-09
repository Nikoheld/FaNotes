import { AlertTriangle, LoaderCircle, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SearchHit } from '../types'
import type { SearchResult } from '../lib/docSearch/docIndex'
import type { IndexerProgress } from '../lib/docSearch/indexer'
import { docSearch } from '../lib/docSearch/service'
import { getUiLanguage } from '../i18n'

/** German or English, picked at render time (the DOM catalogue cannot map strings with counts). */
const L = (de: string, en: string) => (getUiLanguage() === 'en' ? en : de)

export const hitLabel = (hit: Pick<SearchHit, 'unit' | 'page' | 'source' | 'confidence'>) => {
  const where = hit.unit === 'pdf-page' ? `${L('Seite', 'Page')} ${hit.page ?? '?'}`
    : hit.unit === 'worksheet' ? `${L('Arbeitsblatt', 'Worksheet')} ${hit.page ?? ''}`.trim()
      : hit.unit === 'ink' ? L('Handschrift-Abschrift', 'Handwriting transcript')
        : hit.unit === 'annotations' ? L('Anmerkungen', 'Annotations')
          : L('Notiz', 'Note')
  if (hit.source === 'ocr') return `${where} · ${L('Texterkennung', 'Text recognition')}${typeof hit.confidence === 'number' ? ` ~${Math.round(hit.confidence * 100)} %` : ''}`
  return where
}

const toHit = (result: SearchResult, query: string): SearchHit => {
  const [first] = result.snippet.highlights
  return {
    relativePath: result.path,
    title: result.title,
    excerpt: result.snippet.text || (result.titleOnly ? `${L('Dateiname', 'File name')} · ${result.path}` : ''),
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

const reasonText = (reason = '') => {
  const known: Record<string, [string, string]> = {
    'no-letters': ['keine Schrift erkannt', 'no text recognised'],
    'worksheet-missing': ['Arbeitsblatt fehlt', 'worksheet missing'],
    'pdf-worksheet-typed-text-only': ['PDF-Arbeitsblatt: nur getippte Felder', 'PDF worksheet: typed fields only'],
  }
  const entry = known[reason]
  if (entry) return L(entry[0], entry[1])
  return reason.startsWith('ocr') ? L('Texterkennung fehlgeschlagen', 'text recognition failed') : reason
}
/** Reasons the indexer stores for whole documents (German) shown in the UI language. */
const docReason = (reason = '') => {
  const known: Record<string, string> = {
    'Passwortgeschützt': 'password protected',
    'Datei grösser als 96 MB': 'file larger than 96 MB',
    'Beschädigte oder ungültige PDF': 'damaged or invalid PDF',
    'Keine Fortschritte beim Lesen': 'no progress while reading',
  }
  return getUiLanguage() === 'en' ? known[reason] ?? reason.replace(/^Mehr als (\d+) Seiten$/u, 'more than $1 pages') : reason
}
const unitName = (kind: string, page?: number) => (kind === 'pdf-page' ? `${L('Seite', 'Page')} ${page}` : kind === 'worksheet' ? `${L('Arbeitsblatt', 'Worksheet')} ${page}` : kind)

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
  const of = progress.total || searchable
  let line: string
  if (progress.state === 'loading') line = L('Suchindex wird geladen …', 'Loading search index …')
  else if (paused) line = L(`Lesen pausiert · ${searchable} von ${of} Dokumenten durchsuchbar`, `Reading paused · ${searchable} of ${of} documents searchable`)
  else if (working && progress.current) {
    const page = progress.current.pageCount ? ` · ${L('Seite', 'page')} ${progress.current.page ?? 1}/${progress.current.pageCount}` : ''
    line = L(`Liest „${progress.current.title}“${page} · noch ${progress.pending}`, `Reading “${progress.current.title}”${page} · ${progress.pending} left`)
  } else if (working) line = L('Vault wird geprüft …', 'Checking vault …')
  else if (progress.state === 'error') line = progress.lastError ?? L('Der Suchindex konnte nicht aktualisiert werden.', 'The search index could not be updated.')
  else line = L(
    `${searchable} Dokumente mit Inhalt durchsuchbar${counts.ocrPages ? ` · ${counts.ocrPages} Seiten per Texterkennung` : ''}`,
    `${searchable} documents searchable by content${counts.ocrPages ? ` · ${counts.ocrPages} pages by text recognition` : ''}`,
  )
  return (
    <div className={`doc-search-status ${working ? 'is-working' : ''}`}>
      <div className="doc-search-status-row">
        {working && !paused ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : null}
        <span className="doc-search-status-text" role="status" aria-live="polite">{line}</span>
        {working || paused ? (
          <button type="button" className="doc-search-mini" onClick={() => (paused ? docSearch.resume() : docSearch.pause())} aria-label={paused ? L('Lesen fortsetzen', 'Resume reading') : L('Lesen pausieren', 'Pause reading')} title={paused ? L('Fortsetzen', 'Resume') : L('Pausieren', 'Pause')}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
        ) : null}
        {problemCount > 0 ? (
          <button type="button" className="doc-search-mini doc-search-issues-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <AlertTriangle size={13} aria-hidden="true" /> {problemCount} {problemCount === 1 ? L('Hinweis', 'notice') : L('Hinweise', 'notices')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="doc-search-issues">
          <p>{L('Diese Inhalte sind nicht oder nur teilweise durchsuchbar. Handschrift wird nur über ihre Abschrift gefunden; gescannte Seiten liest eine lokale Texterkennung, die Fehler machen kann.', 'These items are not, or only partly, searchable. Handwriting is found only through its transcript; scanned pages are read by local text recognition, which can make mistakes.')}</p>
          <ul>
            {problems.slice(0, 50).map((doc) => (
              <li key={doc.path}>
                <strong>{doc.title}</strong>
                {doc.status === 'unsupported' ? <span> — {L('nicht lesbar', 'not readable')}: {docReason(doc.reason)}</span> : null}
                {doc.status === 'failed' ? <span> — {L('Fehler, neuer Versuch später', 'error, will retry later')}: {docReason(doc.reason)}</span> : null}
                {doc.issues.length ? <span> — {doc.issues.slice(0, 6).map((issue) => `${unitName(issue.kind, issue.page)}: ${reasonText(issue.reason)}`).join(', ')}{doc.issues.length > 6 ? ` … (+${doc.issues.length - 6})` : ''}</span> : null}
              </li>
            ))}
          </ul>
          <div className="doc-search-issue-actions">
            <button type="button" onClick={() => docSearch.retry()}><RotateCcw size={13} aria-hidden="true" /> {L('Erneut versuchen', 'Retry')}</button>
            <button type="button" onClick={() => docSearch.rebuild()}><RefreshCw size={13} aria-hidden="true" /> {L('Index neu aufbauen', 'Rebuild index')}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
