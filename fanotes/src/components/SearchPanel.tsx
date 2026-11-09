import { FilePenLine, FileText, LoaderCircle, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SearchHit } from '../types'
import { DocSearchStatus, hitLabel, useDocIndexHits } from './DocSearchStatus'
import './docSearch.css'

const markExcerpt = (text: string, ranges: Array<[number, number]>) => {
  const parts: ReactNode[] = []
  let at = 0
  ranges.forEach(([start, end], index) => {
    if (start < at || end > text.length) return
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>)
    at = end
  })
  parts.push(text.slice(at))
  return parts
}

/** Existing-search hits for documents the index did not already return. */
const props_hits = (hits: SearchHit[], indexHits: SearchHit[]) => {
  if (!indexHits.length) return hits
  const covered = new Set(indexHits.map((hit) => hit.relativePath))
  return hits.filter((hit) => hit.kind === 'drawing' || !covered.has(hit.relativePath))
}

export function SearchPanel({
  query,
  hits: hostHitsInput,
  loading,
  failed = false,
  onQueryChange,
  onOpen,
  onClose,
}: {
  query: string
  hits: SearchHit[]
  loading: boolean
  failed?: boolean
  onQueryChange: (value: string) => void
  onOpen: (hit: SearchHit) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])
  // Document index (PDF pages, scans, worksheets) first; the existing search
  // keeps drawings and anything the index has not read yet.
  const [indexVersion, setIndexVersion] = useState(0)
  const bumpIndex = useCallback(() => setIndexVersion((value) => value + 1), [])
  const indexHits = useDocIndexHits(query, indexVersion)
  const hits = useMemo(() => [...indexHits, ...props_hits(hostHitsInput, indexHits)], [indexHits, hostHitsInput])
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { resultRefs.current.length = hits.length }, [hits.length])
  const focusResult = (index: number) => {
    if (!hits.length) return
    resultRefs.current[(index + hits.length) % hits.length]?.focus()
  }
  return (
    <aside className="search-panel" aria-label="Vault-Suche">
      <header><div><span className="eyebrow">Im gesamten Vault</span><h3>Notizen durchsuchen</h3></div><button className="icon-button" type="button" title="Suche schließen (Esc)" aria-label="Suche schließen" onClick={onClose}><X size={17} /></button></header>
      <div className="sidebar-search" role="search"><Search aria-hidden="true" size={15} /><input ref={inputRef} value={query} aria-label="Suchbegriff" placeholder="Text, Dateinamen, Handschrift …" onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown' && hits.length) { event.preventDefault(); focusResult(0) } }} />{loading && <LoaderCircle className="spin" aria-label="Suche läuft" size={15} />}{query && !loading && <button className="search-clear" type="button" aria-label="Suchbegriff löschen" title="Suche leeren" onClick={() => onQueryChange('')}><X size={13} /></button>}</div>
      <DocSearchStatus onIndexChanged={bumpIndex} />
      <div className="search-summary" aria-live="polite">{failed && !loading ? 'Die Suche ist fehlgeschlagen.' : query.trim().length >= 2 && !loading ? `${hits.length} ${hits.length === 1 ? 'Treffer' : 'Treffer'}` : 'Text und unsichtbare Handschrift'}</div>
      <div className="search-results">
        {query.trim().length < 2 && <div className="empty-mini"><Search size={22} /><strong>Finde alles wieder</strong><p>Tippe mindestens zwei Zeichen. Auch noch nicht konvertierte Handschrift wird durchsucht.</p></div>}
        {query.trim().length >= 2 && !loading && failed && <div className="empty-mini"><p>Die Suche ist fehlgeschlagen.</p></div>}
        {query.trim().length >= 2 && !loading && !failed && !hits.length && <div className="empty-mini"><p>Keine Treffer für „{query}“.</p></div>}
        {hits.map((hit, index) => (
          <button ref={(element) => { resultRefs.current[index] = element }} type="button" key={`${hit.kind ?? 'note'}:${hit.relativePath}:${hit.unit ?? ''}:${hit.page ?? ''}:${index}`} onClick={() => onOpen(hit)} onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); focusResult(index + 1) }
            if (event.key === 'ArrowUp') { event.preventDefault(); if (index === 0) inputRef.current?.focus(); else focusResult(index - 1) }
          }}>
            <span className="search-result-title">{hit.kind === 'drawing' ? <FilePenLine size={14} /> : <FileText size={14} />}<strong>{hit.title}</strong><b>{hit.matches}</b></span>
            <small>{hit.kind === 'drawing' ? 'Handschrift-Seite · unsichtbar transkribiert' : hit.unit ? <><span className="doc-hit-where">{hitLabel(hit)}</span> · {hit.relativePath}</> : hit.relativePath}</small>
            <p>{hit.highlights?.length ? markExcerpt(hit.excerpt, hit.highlights) : hit.excerpt}</p>
            {hit.alsoIn ? <small className="doc-hit-also">Gleicher Text auch in {hit.alsoIn} {hit.alsoIn === 1 ? 'weiteren Datei' : 'weiteren Dateien'}</small> : null}
          </button>
        ))}
      </div>
      <footer><kbd>↑</kbd><kbd>↓</kbd><span>Ergebnis wählen</span><kbd>Esc</kbd><span>Schließen</span></footer>
    </aside>
  )
}
