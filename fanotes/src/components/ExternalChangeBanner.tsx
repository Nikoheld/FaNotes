import { useEffect, useRef, useState, type FormEvent } from 'react'
import { TriangleAlert } from 'lucide-react'

export type ExternalChangeBannerProps = {
  /** `deleted`: the note's file is gone. `conflict`: the file was edited outside while the tab holds unsaved text. */
  kind: 'deleted' | 'conflict'
  title: string
  /** A PDF note cannot be written again from its text. */
  canRestore: boolean
  busy: boolean
  onRestore: () => void
  onSaveAs: (name: string) => void
  onKeepMine: () => void
  onLoadExternal: () => void
  onCloseTab: () => void
}

/**
 * Shown above a note whose file was deleted or edited outside FaNotes. The tab
 * keeps its text and saves nothing until one of these buttons settles it.
 */
export function ExternalChangeBanner({ kind, title, canRestore, busy, onRestore, onSaveAs, onKeepMine, onLoadExternal, onCloseTab }: ExternalChangeBannerProps) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState(title)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (naming) nameRef.current?.select()
  }, [naming])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    onSaveAs(name)
  }

  return (
    <section className={`external-banner is-${kind}`} role="alert" aria-label={kind === 'deleted' ? 'Datei wurde ausserhalb von FaNotes gelöscht' : 'Datei wurde ausserhalb von FaNotes geändert'}>
      <TriangleAlert aria-hidden="true" size={16} />
      <div className="external-banner__text">
        <strong>{kind === 'deleted' ? 'Datei wurde ausserhalb von FaNotes gelöscht' : 'Datei wurde ausserhalb von FaNotes geändert'}</strong>
        <span>
          {kind === 'deleted'
            ? 'Der Text bleibt in diesem Tab erhalten. Automatisches Speichern ist pausiert, bis du die Notiz wiederherstellst oder unter einem neuen Namen speicherst.'
            : 'Du hast ungespeicherte Änderungen. Beide Fassungen bleiben erhalten, automatisches Speichern ist pausiert. Die Fassung, die du nicht behältst, wird als Konfliktkopie neben der Notiz gesichert.'}
        </span>
      </div>
      {kind === 'conflict' && (
        <div className="external-banner__actions">
          <button type="button" className="primary-button" disabled={busy} onClick={onKeepMine}>Meine Fassung behalten</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={onLoadExternal}>Externe Fassung laden</button>
        </div>
      )}
      {kind === 'deleted' && !naming && (
        <div className="external-banner__actions">
          {canRestore && <button type="button" className="primary-button" disabled={busy} onClick={onRestore}>Wiederherstellen</button>}
          {canRestore && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setName(title); setNaming(true) }}>Speichern unter …</button>}
          {!canRestore && <button type="button" className="secondary-button" disabled={busy} onClick={onCloseTab}>Tab schließen</button>}
        </div>
      )}
      {kind === 'deleted' && naming && (
        <form className="external-banner__actions external-banner__form" onSubmit={submit}>
          <input
            ref={nameRef}
            value={name}
            maxLength={120}
            aria-label="Name der neuen Notiz"
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setNaming(false) } }}
          />
          <button type="submit" className="primary-button" disabled={busy || !name.trim()}>Speichern</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setNaming(false)}>Abbrechen</button>
        </form>
      )}
    </section>
  )
}
