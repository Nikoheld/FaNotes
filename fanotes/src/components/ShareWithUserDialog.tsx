import { Eye, LoaderCircle, Pencil, Share2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { usernameProblem } from '../lib/sync/crypto'
import type { SharePermission } from '../lib/sync/api'
import { userShares } from '../lib/sync/userShares'

export type ShareWithUserTarget = { path: string; kind: 'note' | 'folder'; name: string }

type Props = {
  target: ShareWithUserTarget
  signedIn: boolean
  onClose: () => void
  onOpenAccountSettings: () => void
  toast: (message: string, kind?: 'info' | 'error' | 'success') => void
}

type Found = { username: string; fingerprint: string }

/**
 * Share a note or folder with a FaNotes username. The name is looked up only as an exact, complete match, so the
 * dialog cannot be used to browse accounts: there is no suggestion list and no partial search.
 */
export function ShareWithUserDialog({ target, signedIn, onClose, onOpenAccountSettings, toast }: Props) {
  const state = useSyncExternalStore(userShares.subscribe, userShares.getState, userShares.getState)
  const [name, setName] = useState('')
  const [permission, setPermission] = useState<SharePermission>('read')
  const [found, setFound] = useState<Found | null>(null)
  const [lookupState, setLookupState] = useState<'idle' | 'busy' | 'missing' | 'limited'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setFound(null)
    setError(null)
    const trimmed = name.trim()
    if (usernameProblem(trimmed)) { setLookupState('idle'); return }
    setLookupState('busy')
    let cancelled = false
    // A short pause so typing does not fire one request per key.
    const timer = window.setTimeout(() => {
      userShares.lookup(trimmed).then((result) => {
        if (cancelled) return
        setFound({ username: result.username, fingerprint: result.fingerprint })
        setLookupState('idle')
      }).catch((reason: unknown) => {
        if (cancelled) return
        const status = (reason as { status?: number } | null)?.status
        setLookupState(status === 429 ? 'limited' : 'missing')
      })
    }, 500)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [name])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const existing = state.shares.filter((share) => share.role === 'owner' && share.sourcePath === target.path)

  const submit = async () => {
    if (!found) return
    setBusy(true)
    setError(null)
    try {
      await userShares.share({ path: target.path, kind: target.kind, username: found.username, permission })
      toast(`„${target.name}“ wurde mit ${found.username} geteilt.`, 'success')
      setName('')
      setFound(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Das Teilen hat nicht geklappt.')
    } finally {
      setBusy(false)
    }
  }

  const ready = signedIn && state.ready
  return (
    <div className="modal-backdrop confirm-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="confirm-dialog share-user-dialog" role="dialog" aria-modal="true" aria-labelledby="fanotes-share-user-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="confirm-dialog-header">
          <span className="confirm-dialog-icon"><Share2 size={16} /></span>
          <div><h3 id="fanotes-share-user-title">„{target.name}“ mit einem Benutzer teilen</h3></div>
          <button type="button" className="icon-button" aria-label="Schließen" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="confirm-dialog-body">
          {!ready && (
            <p className="share-user-hint">
              {!signedIn ? 'Dafür brauchst du ein FaNotes-Konto. Es geht ohne E-Mail und ohne Passwort.' : 'Dafür braucht dein Konto einen Benutzernamen.'}{' '}
              <button type="button" className="settings-link-button" onClick={onOpenAccountSettings}>Zu den Konto-Einstellungen</button>
            </p>
          )}
          {ready && (
            <>
              <label className="share-user-field">
                <span>FaNotes-Benutzername</span>
                <input data-i18n-ignore autoFocus type="text" autoComplete="off" spellCheck={false} maxLength={32} value={name} placeholder="genauer Benutzername" onChange={(event) => setName(event.target.value)} />
              </label>
              <p className="share-user-status" role="status" aria-live="polite">
                {lookupState === 'busy' && <><LoaderCircle className="spin" size={13} /> Sucht …</>}
                {found && <span data-i18n-ignore>Gefunden: <strong>{found.username}</strong> · Schlüssel {found.fingerprint}</span>}
                {lookupState === 'missing' && !found && 'Kein Konto mit genau diesem Benutzernamen.'}
                {lookupState === 'limited' && 'Zu viele Suchen. Bitte später erneut versuchen.'}
                {lookupState === 'idle' && !found && name.trim() && usernameProblem(name.trim()) && usernameProblem(name.trim())}
              </p>
              <fieldset className="share-user-permission">
                <legend>Berechtigung für die Person</legend>
                <label><input type="radio" name="share-permission" checked={permission === 'read'} onChange={() => setPermission('read')} /><Eye size={14} /> Nur lesen</label>
                <label><input type="radio" name="share-permission" checked={permission === 'edit'} onChange={() => setPermission('edit')} /><Pencil size={14} /> Bearbeiten</label>
              </fieldset>
              <p className="share-user-hint">Ende-zu-Ende verschlüsselt: Nur du und diese Person können es lesen. Beim ersten Mal muss sie die Freigabe annehmen. Widerrufen wirkt sofort.</p>
              {error && <p className="share-user-error" role="alert"><TriangleAlert size={13} /> {error}</p>}
              {existing.length > 0 && (
                <ul className="share-user-list">
                  {existing.map((share) => (
                    <li key={share.id}>
                      <span data-i18n-ignore>{share.peer}</span>
                      <small>{share.status === 'pending' ? 'wartet auf Annahme' : share.status === 'declined' ? 'abgelehnt' : share.status === 'left' ? 'verlassen' : share.permission === 'edit' ? 'darf bearbeiten' : 'darf lesen'}</small>
                      <button type="button" className="secondary-button" onClick={() => void userShares.remove(share.id).then(() => toast(`Die Freigabe an ${share.peer} wurde widerrufen.`, 'info')).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Widerrufen hat nicht geklappt.'))}>Widerrufen</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Schließen</button>
          {ready && <button type="button" className="primary-button" disabled={busy || !found} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />} Teilen</button>}
        </div>
      </section>
    </div>
  )
}
