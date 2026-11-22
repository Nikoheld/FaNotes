import { useModalFocus } from '../lib/useModalFocus'
import { uiText } from '../i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, FolderPlus, ImageIcon, LoaderCircle, NotebookTabs, PenLine, X } from 'lucide-react'
import type { OneNoteImportProgress, OneNoteImportResult, OneNoteScan } from '../types'

type Stage = 'opening' | 'pick' | 'importing' | 'done' | 'error'

type Props = {
  /** Vault-relative folders the notes can go into. */
  folders: string[]
  onClose: () => void
  /** Called once after pages were written, so the app can refresh the tree and open the first note. */
  onImported: (result: OneNoteImportResult) => void
}

const ROOT = ''
const NEW_FOLDER = '\u0000new'

const safeFolderName = (value: string) => value
  .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .replace(/[. ]+$/u, '')
  .trim()
  .slice(0, 120)

export function OneNoteImportDialog({ folders, onClose, onImported }: Props) {
  const dialogRef = useRef<HTMLElement>(null)
  useModalFocus(dialogRef)
  const [stage, setStage] = useState<Stage>('opening')
  const [scan, setScan] = useState<OneNoteScan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [folder, setFolder] = useState(ROOT)
  const [newFolderName, setNewFolderName] = useState('OneNote')
  const [sectionFolders, setSectionFolders] = useState(true)
  const [progress, setProgress] = useState<OneNoteImportProgress | null>(null)
  const [result, setResult] = useState<OneNoteImportResult | null>(null)
  const [error, setError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const sessionRef = useRef<string | null>(null)
  const closedRef = useRef(false)
  const stageRef = useRef<Stage>('opening')
  stageRef.current = stage

  const closeSession = useCallback(() => {
    const id = sessionRef.current
    sessionRef.current = null
    if (id) void window.fanotes.closeOneNote(id).catch(() => undefined)
  }, [])

  const close = useCallback(() => {
    closedRef.current = true
    closeSession()
    onClose()
  }, [closeSession, onClose])

  useEffect(() => {
    let live = true
    void window.fanotes.importOneNote().then((value) => {
      if (!live || closedRef.current) {
        if (value) void window.fanotes.closeOneNote(value.sessionId).catch(() => undefined)
        return
      }
      if (!value) { close(); return }
      sessionRef.current = value.sessionId
      setScan(value)
      // Pages imported earlier start unchecked: importing again would only skip them.
      setSelected(new Set(value.sections.flatMap((section) => section.pages.filter((page) => !page.alreadyImported).map((page) => page.id))))
      setStage('pick')
    }).catch((reason) => {
      if (!live) return
      setError(reason instanceof Error ? reason.message : 'Das OneNote-Notizbuch konnte nicht gelesen werden.')
      setStage('error')
    })
    return () => { live = false }
    // The file dialog opens exactly once per mounted dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => window.fanotes.onOneNoteProgress((value) => setProgress(value)), [])
  useEffect(() => () => { closeSession() }, [closeSession])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || stageRef.current === 'importing') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  const toggle = (ids: string[], on: boolean) => setSelected((current) => {
    const next = new Set(current)
    for (const id of ids) { if (on) next.add(id); else next.delete(id) }
    return next
  })
  const allIds = useMemo(() => scan?.sections.flatMap((section) => section.pages.map((page) => page.id)) ?? [], [scan])

  const destination = useMemo(() => {
    if (folder !== NEW_FOLDER) return folder
    return newFolderName.split('/').map(safeFolderName).filter((segment) => segment && segment !== '.' && segment !== '..').join('/')
  }, [folder, newFolderName])
  const destinationInvalid = folder === NEW_FOLDER && !destination

  const start = async () => {
    if (!scan || !selected.size || destinationInvalid) return
    setStage('importing')
    setProgress({ done: 0, total: selected.size, title: '', status: 'working' })
    setCancelling(false)
    try {
      const outcome = await window.fanotes.importOneNotePages({ sessionId: scan.sessionId, pageIds: allIds.filter((id) => selected.has(id)), destination, sectionFolders })
      setResult(outcome)
      setStage('done')
      if (outcome.imported.length) onImported(outcome)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Der OneNote-Import ist fehlgeschlagen.')
      setStage('error')
    }
  }

  const cancel = () => {
    if (!scan) return
    setCancelling(true)
    void window.fanotes.cancelOneNoteImport(scan.sessionId).catch(() => undefined)
  }

  const folderOptions = useMemo(() => [...new Set(folders)].sort((left, right) => left.localeCompare(right, 'de', { numeric: true })), [folders])

  return (
    <div className="modal-backdrop onenote-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && stage !== 'importing') close() }}>
      <section ref={dialogRef} className="onenote-dialog" role="dialog" aria-modal="true" aria-label="Microsoft OneNote importieren">
        <header>
          <div>
            <span><NotebookTabs size={19} /></span>
            <div>
              <small>Microsoft OneNote</small>
              <h2>{scan ? scan.notebookName : 'Notizbuch importieren'}</h2>
            </div>
          </div>
          <button type="button" className="icon-button" aria-label="Schließen" disabled={stage === 'importing'} onClick={close}><X size={16} /></button>
        </header>

        {stage === 'opening' && <div className="onenote-dialog-state"><LoaderCircle className="spin" size={22} /><strong>Notizbuch wird gelesen …</strong><small>Wähle zuerst die Datei. Große Notizbücher brauchen einen Moment.</small></div>}

        {stage === 'error' && <div className="onenote-dialog-state is-error" role="alert"><AlertTriangle size={22} /><strong>Das hat nicht geklappt</strong><small>{error}</small></div>}

        {stage === 'pick' && scan && <>
          <div className="onenote-dialog-body">
            <div className="onenote-dialog-toolbar">
              <span><b>{selected.size}</b> / {scan.pageCount} Seiten ausgewählt</span>
              <button type="button" className="secondary-button" onClick={() => toggle(allIds, true)}>Alle</button>
              <button type="button" className="secondary-button" onClick={() => setSelected(new Set())}>Keine</button>
            </div>
            <div className="onenote-dialog-tree" role="tree" aria-label="Abschnitte und Seiten">
              {scan.sections.map((section) => {
                const key = section.path.join('/')
                const ids = section.pages.map((page) => page.id)
                const count = ids.filter((id) => selected.has(id)).length
                const open = !collapsed.has(key)
                return (
                  <div key={key || 'root'} className="onenote-dialog-section" role="group">
                    <div className="onenote-dialog-section-head">
                      <button type="button" className="icon-button" aria-label={open ? 'Abschnitt einklappen' : 'Abschnitt ausklappen'} aria-expanded={open} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}>
                        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                      <label>
                        <input type="checkbox" checked={count === ids.length} ref={(input) => { if (input) input.indeterminate = count > 0 && count < ids.length }} onChange={(event) => toggle(ids, event.target.checked)} />
                        <strong data-i18n-ignore>{section.name}</strong>
                        <small>{count}/{ids.length}</small>
                      </label>
                      <button type="button" className="onenote-dialog-link" onClick={() => toggle(ids, true)}>Alle</button>
                      <button type="button" className="onenote-dialog-link" onClick={() => toggle(ids, false)}>Keine</button>
                    </div>
                    {open && section.pages.map((page) => (
                      <label key={page.id} className={`onenote-dialog-page${page.alreadyImported ? ' is-imported' : ''}`} style={{ paddingLeft: 46 + page.depth * 16 }} role="treeitem" aria-selected={selected.has(page.id)}>
                        <input type="checkbox" checked={selected.has(page.id)} onChange={(event) => toggle([page.id], event.target.checked)} />
                        <span className="onenote-dialog-page-title" data-i18n-ignore>{page.title}</span>
                        {page.hasInk && <em title="Enthält Handschrift"><PenLine size={12} />Handschrift</em>}
                        {page.imageCount > 0 && <em title="Enthält Bilder"><ImageIcon size={12} />{page.imageCount}</em>}
                        {page.alreadyImported && <em className="is-done"><Check size={12} />Bereits importiert</em>}
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
            {scan.inkPageCount === 0 && <p className="onenote-dialog-note">Diese Datei enthält keine Handschrift-Daten, deshalb wird keine .famd-Handschrift angelegt.</p>}
            {scan.warnings.map((warning) => <p key={warning} className="onenote-dialog-note">{warning}</p>)}
            <div className="onenote-dialog-destination">
              <label>
                <span>Zielordner</span>
                <select value={folder} onChange={(event) => setFolder(event.target.value)}>
                  <option value={ROOT}>Vault (oberste Ebene)</option>
                  {folderOptions.map((entry) => <option key={entry} value={entry} data-i18n-ignore>{entry}</option>)}
                  <option value={NEW_FOLDER}>Neuer Ordner …</option>
                </select>
              </label>
              {folder === NEW_FOLDER && <label>
                <span><FolderPlus size={12} /> Name oder Pfad des neuen Ordners</span>
                <input type="text" value={newFolderName} maxLength={120} onChange={(event) => setNewFolderName(event.target.value)} aria-invalid={destinationInvalid} />
              </label>}
              <label className="onenote-dialog-check">
                <input type="checkbox" checked={sectionFolders} onChange={(event) => setSectionFolders(event.target.checked)} />
                <span>Abschnitte als Unterordner anlegen</span>
              </label>
            </div>
          </div>
          <footer>
            <small>{destination ? <>Ziel: {destination}</> : 'Ziel: oberste Ebene des Vaults'}</small>
            <div>
              <button type="button" className="secondary-button" onClick={close}>Abbrechen</button>
              <button type="button" className="primary-button" disabled={!selected.size || destinationInvalid} onClick={() => void start()}>Importieren ({selected.size})</button>
            </div>
          </footer>
        </>}

        {stage === 'importing' && <>
          <div className="onenote-dialog-state" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={22} />
            <strong>{cancelling ? 'Wird abgebrochen …' : 'Seiten werden importiert …'}</strong>
            <div className="onenote-dialog-progress" aria-hidden><i style={{ width: `${progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
            <small data-i18n-ignore>{progress ? `${progress.done} ${uiText('von', 'of')} ${progress.total}${progress.title && progress.status === 'working' ? ` · ${progress.title}` : ''}` : ''}</small>
          </div>
          <footer><small>Bereits geschriebene Seiten bleiben erhalten.</small><div><button type="button" className="secondary-button" disabled={cancelling} onClick={cancel}>Abbrechen</button></div></footer>
        </>}

        {stage === 'done' && result && <>
          <div className="onenote-dialog-body onenote-dialog-summary" role="status">
            <div className="onenote-dialog-counts">
              <div><b>{result.imported.length}</b><small>importiert</small></div>
              <div><b>{result.skipped.length}</b><small>übersprungen</small></div>
              <div className={result.failed.length ? 'is-bad' : ''}><b>{result.failed.length}</b><small>fehlgeschlagen</small></div>
            </div>
            {result.cancelled && <p className="onenote-dialog-note">Der Import wurde abgebrochen. Die bis dahin geschriebenen Seiten sind im Vault.</p>}
            <p className="onenote-dialog-note" data-i18n-ignore>
              {result.inkPages
                ? uiText(`Handschrift: ${result.strokeCount} Striche auf ${result.inkPages} ${result.inkPages === 1 ? 'Seite' : 'Seiten'} als .famd übernommen.`, `Handwriting: ${result.strokeCount} ${result.strokeCount === 1 ? 'stroke' : 'strokes'} on ${result.inkPages} ${result.inkPages === 1 ? 'page' : 'pages'} saved as .famd.`)
                : scan && scan.inkPageCount === 0 ? uiText('Diese Datei enthält keine Handschrift-Daten.', 'This file contains no handwriting data.') : uiText('In den gewählten Seiten wurde keine Handschrift gefunden.', 'No handwriting was found in the selected pages.')}
              {result.layoutPages ? uiText(` ${result.layoutPages} Seiten mit Handschrift behalten das OneNote-Layout.`, ` ${result.layoutPages} ${result.layoutPages === 1 ? 'page' : 'pages'} with handwriting keep the OneNote layout.`) : ''}{result.imageCount ? uiText(` Bilder: ${result.imageCount}.`, ` Images: ${result.imageCount}.`) : ''}
            </p>
            {result.skipped.length > 0 && <details><summary>{result.skipped.length} bereits importierte Seiten übersprungen</summary><ul>{result.skipped.map((item) => <li key={item.id} data-i18n-ignore>{item.title}</li>)}</ul></details>}
            {result.failed.length > 0 && <div className="onenote-dialog-errors" role="alert"><strong>Fehler pro Seite</strong><ul>{result.failed.map((item) => <li key={item.id}><b data-i18n-ignore>{item.title}</b>: {item.error}</li>)}</ul></div>}
            {result.warnings.length > 0 && <details><summary>{result.warnings.length} Hinweise</summary><ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
          </div>
          <footer><small>{destination ? <>Ziel: {destination}</> : 'Ziel: oberste Ebene des Vaults'}</small><div><button type="button" className="primary-button" onClick={close}>Fertig</button></div></footer>
        </>}

        {stage === 'error' && <footer><small /><div><button type="button" className="primary-button" onClick={close}>Schließen</button></div></footer>}
      </section>
    </div>
  )
}
