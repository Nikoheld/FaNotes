// Stop autocomplete: a combobox that searches after 250 ms, from 2 characters, with the arrow keys.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createStopSearcher, SEARCH_MIN_CHARS } from '../lib/commute'
import type { Strings } from '../lib/i18n'
import type { Stop } from '../types'
import { stopIcon } from './commute'
import { Icon } from './ui'

export const StopPicker = ({ label, value, onChange, search, t, optional = false, invalid = false, error = '' }: {
  label: string
  value: Stop | null
  onChange: (stop: Stop | null) => void
  search: (query: string) => Promise<Stop[]>
  t: Strings
  optional?: boolean
  invalid?: boolean
  error?: string
}) => {
  const id = useId()
  const [text, setText] = useState(value?.name || '')
  const [results, setResults] = useState<Stop[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [searched, setSearched] = useState(false)
  const searchRef = useRef(search)
  searchRef.current = search

  const searcher = useMemo(() => createStopSearcher((query) => searchRef.current(query), {
    onBusy: setBusy,
    onResult: (stops) => { setResults(stops); setIndex(0); setFailed(false); setSearched(true) },
    onError: () => { setResults([]); setFailed(true); setSearched(true) },
  }), [])
  useEffect(() => () => searcher.cancel(), [searcher])

  const pick = (stop: Stop) => {
    searcher.cancel()
    setText(stop.name)
    setResults([])
    setOpen(false)
    setSearched(false)
    onChange(stop)
  }
  const short = text.trim().length < SEARCH_MIN_CHARS
  const showList = open && !short && (busy || searched || results.length > 0)
  const listId = `${id}-list`

  return (
    <div className="field stop-picker">
      <label className="field-label" htmlFor={`${id}-input`}>{label}</label>
      <div className="stop-input">
        {value ? <span className="stop-type" title={t.stopTypes[value.type] || ''}><Icon name={stopIcon(value.type)} size={18} /></span> : <span className="stop-type muted"><Icon name="search" size={18} /></span>}
        <input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[index] ? `${id}-opt-${index}` : undefined}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          value={text}
          placeholder={t.commuteStopPlaceholder}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            const next = event.target.value
            setText(next)
            setOpen(true)
            setSearched(false)
            // Typing again drops the previous choice: only a stop from the list counts.
            if (value) onChange(null)
            searcher.input(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setIndex(Math.min(results.length - 1, index + 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(Math.max(0, index - 1)) }
            else if (event.key === 'Enter' && showList && results[index]) { event.preventDefault(); pick(results[index]) }
            else if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false) }
          }}
        />
        {optional && (value || text) ? (
          <button type="button" className="icon-button" aria-label={t.commuteClearVia} title={t.commuteClearVia} onClick={() => { searcher.cancel(); setText(''); setResults([]); onChange(null) }}><Icon name="close" size={18} /></button>
        ) : null}
        {busy ? <span className="spinner spinner-small stop-spinner" aria-hidden="true" /> : null}
      </div>
      {showList ? (
        <ul className="stop-list" id={listId} role="listbox" aria-label={label}>
          {results.map((stop, position) => (
            <li key={stop.id} id={`${id}-opt-${position}`} role="option" aria-selected={position === index}>
              <button type="button" tabIndex={-1} className={position === index ? 'selected' : ''} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setIndex(position)} onClick={() => pick(stop)}>
                <Icon name={stopIcon(stop.type)} size={18} />
                <span className="stop-name">{stop.name}</span>
                <span className="stop-kind">{t.stopTypes[stop.type] || t.stopTypes.other}</span>
              </button>
            </li>
          ))}
          {!results.length ? <li className="stop-empty" role="presentation">{busy ? t.commuteSearching : failed ? t.commuteStopFailed : t.commuteNoStops}</li> : null}
        </ul>
      ) : null}
      {error ? <small className="field-error" role="alert">{error}</small> : null}
    </div>
  )
}
