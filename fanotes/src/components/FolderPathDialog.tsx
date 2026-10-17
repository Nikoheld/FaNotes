import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, FolderInput, FolderPlus, X } from 'lucide-react'

export type FolderPathDialogProps = {
  folderName: string
  folderPath: string
  initialPaths: string[]
  /** Vault folders offered when this device cannot choose an operating-system directory. */
  folderChoices: string[]
  usesVaultFolders: boolean
  busy?: boolean
  error?: string | null
  moved?: number | null
  conflicts?: string[]
  onBrowse: () => Promise<string | null>
  onClose: () => void
  onSave: (paths: string[], moveContents: boolean) => void
}

export function FolderPathDialog({
  folderName,
  folderPath,
  initialPaths,
  folderChoices,
  usesVaultFolders,
  busy = false,
  error = null,
  moved = null,
  conflicts = [],
  onBrowse,
  onClose,
  onSave,
}: FolderPathDialogProps) {
  const titleId = useId()
  const [paths, setPaths] = useState(initialPaths)
  const [draft, setDraft] = useState('')
  const [selectedFolder, setSelectedFolder] = useState('')
  const [moveContents, setMoveContents] = useState(true)
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    setPaths(initialPaths)
    setMoveContents(true)
  }, [initialPaths])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.querySelector<HTMLElement>('button, input, select')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      event.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (opener?.isConnected) opener.focus()
    }
  }, [busy])

  const primaryChanged = (paths[0] ?? '') !== (initialPaths[0] ?? '')
  const availableChoices = folderChoices.filter((choice) => !paths.includes(choice))

  const addPath = (value: string) => {
    const next = value.trim()
    if (!next || paths.includes(next) || paths.length >= 8) return
    setPaths((current) => [...current, next])
    setDraft('')
    setSelectedFolder('')
  }

  const movePath = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= paths.length) return
    setPaths((current) => {
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="confirm-dialog folder-path-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="confirm-dialog-header">
          <span className="confirm-dialog-icon" aria-hidden="true"><FolderInput size={18} /></span>
          <div>
            <p className="eyebrow">Ordnerpfad</p>
            <h3 id={titleId}>{folderName}</h3>
          </div>
          <button type="button" className="icon-button folder-path-dialog__close" aria-label="Schließen" disabled={busy} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="folder-path-dialog__body">
          <p>Der erste Pfad ist der Hauptordner. Neue Notizen entstehen dort.</p>
          <p className="folder-path-dialog__note">
            {usesVaultFolders
              ? 'Im Browser sind das andere Ordner desselben Vaults.'
              : 'Externe Ordner bleiben auf diesem Gerät und werden nicht synchronisiert.'}
          </p>
          {paths.length === 0 ? (
            <p className="folder-path-dialog__empty">Noch kein Pfad. Der Ordner zeigt seinen eigenen Inhalt.</p>
          ) : (
            <ol className="folder-path-dialog__list">
              {paths.map((item, index) => (
                <li key={item}>
                  <span className="folder-path-dialog__role">{index === 0 ? 'Hauptordner' : 'Weiterer Pfad'}</span>
                  <code title={item}>{item}</code>
                  <span className="folder-path-dialog__row-actions">
                    <button type="button" aria-label="Pfad nach oben" disabled={busy || index === 0} onClick={() => movePath(index, -1)}><ArrowUp size={14} /></button>
                    <button type="button" aria-label="Pfad nach unten" disabled={busy || index === paths.length - 1} onClick={() => movePath(index, 1)}><ArrowDown size={14} /></button>
                    <button type="button" aria-label="Pfad entfernen" disabled={busy} onClick={() => setPaths((current) => current.filter((entry) => entry !== item))}><X size={14} /></button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {usesVaultFolders ? (
            <div className="folder-path-dialog__add">
              <select aria-label="Ordner hinzufügen" value={selectedFolder} disabled={busy || paths.length >= 8} onChange={(event) => setSelectedFolder(event.target.value)}>
                <option value="">Ordner hinzufügen</option>
                {availableChoices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
              </select>
              <button type="button" className="secondary-button" disabled={busy || !selectedFolder || paths.length >= 8} onClick={() => addPath(selectedFolder)}>
                <FolderPlus size={14} /> Hinzufügen
              </button>
            </div>
          ) : (
            <form className="folder-path-dialog__add" onSubmit={(event) => { event.preventDefault(); addPath(draft) }}>
              <input
                aria-label="Pfad einfügen"
                placeholder="Pfad einfügen"
                value={draft}
                disabled={busy || paths.length >= 8}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="button" className="secondary-button" disabled={busy || paths.length >= 8} onClick={() => { void onBrowse().then((picked) => { if (picked) addPath(picked) }) }}>
                Durchsuchen
              </button>
              <button type="submit" className="secondary-button" disabled={busy || !draft.trim() || paths.length >= 8}>Hinzufügen</button>
            </form>
          )}
          <label className="folder-path-dialog__move">
            <input
              type="checkbox"
              checked={moveContents}
              disabled={busy || !primaryChanged}
              onChange={(event) => setMoveContents(event.target.checked)}
            />
            Bisherige Dateien in den neuen Hauptordner verschieben
          </label>
          <p className="folder-path-dialog__meta">{folderPath}</p>
          {error && <p className="folder-path-dialog__error" role="alert">{error}</p>}
          {moved !== null && moved > 0 && <p className="folder-path-dialog__report">{moved === 1 ? '1 Datei verschoben.' : `${moved} Dateien verschoben.`}</p>}
          {conflicts.length > 0 && (
            <div className="folder-path-dialog__conflicts" role="status">
              <p>Einige Namen blieben am alten Ort, weil sie schon belegt sind.</p>
              <ul>{conflicts.slice(0, 8).map((conflict) => <li key={conflict}>{conflict}</li>)}</ul>
            </div>
          )}
        </div>
        <footer className="confirm-dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Abbrechen</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => onSave(paths, moveContents && primaryChanged)}>Übernehmen</button>
        </footer>
      </section>
    </div>
  )
}
