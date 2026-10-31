import { Share2 } from 'lucide-react'
import { useEffect } from 'react'
import { editorNames } from '../lib/sync/shareEdit'
import {
  listRecentShares,
  readShare,
  stopShare as shareStopControl,
  type ShareDirectory,
  type ShareMode,
  type SharePort,
} from '../lib/sync/share'

export type ShareTarget = { path: string; kind: 'file' | 'folder' }

/** Recent-shares stop button. Same function the publish client uses to revoke a link. */
export { shareStopControl }

export function ShareSettingsPage({
  mode,
  onModeChange,
  directory,
  targets,
  selectedPath,
  onSelectPath,
  publishing,
  lastLink,
  notice,
  onPublish,
  onDirectory,
  port,
  origin,
}: {
  mode: ShareMode
  onModeChange: (mode: ShareMode) => void
  directory: ShareDirectory
  targets: ShareTarget[]
  selectedPath: string
  onSelectPath: (path: string) => void
  publishing: boolean
  lastLink: string | null
  notice: string | null
  onPublish: () => void
  onDirectory: (directory: ShareDirectory) => void
  port: SharePort
  origin?: string
}) {
  const shares = listRecentShares(directory)
  useEffect(() => {
    const pending = shares.filter((item) => item.mode === 'edit' && !item.stopped)
    if (!pending.length) return
    let cancelled = false
    void Promise.all(pending.map(async (item) => {
      const payload = await readShare({ id: item.id, port, origin }).catch(() => null)
      return { id: item.id, names: editorNames(payload?.editors) }
    })).then((rows) => {
      if (cancelled) return
      let changed = false
      const next = {
        shares: directory.shares.map((item) => {
          const row = rows.find((entry) => entry.id === item.id)
          if (!row) return item
          const current = item.editors ?? []
          if (current.join('\n') === row.names.join('\n')) return item
          changed = true
          return { ...item, editors: row.names }
        }),
      }
      if (changed) onDirectory(next)
    })
    return () => { cancelled = true }
  }, [directory, onDirectory, origin, port, shares])
  return (
    <>
      <div id="settings-share" className="setting-card">
        <div className="setting-card-title"><Share2 size={16} /><span>Öffentliche Freigabe</span></div>
        <div className="setting-row">
          <div className="setting-copy">
            <span>Kopie oder Live</span>
            <small>Eine Kopie bleibt so, wie sie hochgeladen wurde.</small>
            <small>Eine Live-Freigabe zeigt spätere Änderungen.</small>
            <small>Eine gemeinsame Freigabe kann gleichzeitig bearbeitet werden.</small>
            <small>Der private Vault-Sync bleibt verschlüsselt und ist kein öffentlicher Link.</small>
          </div>
          <div className="setting-control">
            <div className="segmented compact" role="group" aria-label="Freigabeart">
              <button type="button" className={mode === 'copy' ? 'active' : ''} onClick={() => onModeChange('copy')}>Kopie</button>
              <button type="button" className={mode === 'live' ? 'active' : ''} onClick={() => onModeChange('live')}>Live</button>
              <button type="button" className={mode === 'edit' ? 'active' : ''} onClick={() => onModeChange('edit')}>Gemeinsam</button>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <span>Notiz oder Ordner</span>
            <small>Ein Ordner enthält jede Notiz darin, auch in verschachtelten Ordnern.</small>
          </div>
          <div className="setting-control">
            <select aria-label="Notiz oder Ordner" value={selectedPath} onChange={(event) => onSelectPath(event.target.value)}>
              <option value="">Auswählen</option>
              {targets.map((target) => (
                <option key={`${target.kind}:${target.path}`} value={target.path}>
                  {target.kind === 'folder' ? `${target.path}/` : target.path}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <span>Link erstellen</span>
            <small>Der Link zeigt Titel und geschriebenen Text im Browser.</small>
          </div>
          <div className="setting-control share-publish-control">
            <button type="button" className="primary-button" disabled={!selectedPath || publishing} onClick={onPublish}>Link erstellen</button>
            {lastLink && <input data-i18n-ignore readOnly value={lastLink} aria-label="Freigabe-Link" onFocus={(event) => event.currentTarget.select()} />}
          </div>
        </div>
        {notice && <p className="share-notice" role="status">{notice}</p>}
      </div>
      <div id="settings-share-recent" className="setting-card">
        <div className="setting-card-title"><Share2 size={16} /><span>Letzte Freigaben</span></div>
        {shares.length === 0 && <p className="share-empty">Keine Freigabe</p>}
        <ul className="share-recent-list">
          {shares.map((item) => (
            <li key={item.id}>
              <span>
                <b>{item.title}</b>
                <small>{item.mode === 'live' ? 'Live' : item.mode === 'edit' ? 'Gemeinsam' : 'Kopie'} · {item.kind === 'folder' ? 'Ordner' : 'Notiz'}{item.stopped ? ' · Beendet' : ''}</small>
                {item.mode === 'edit' && item.editors && item.editors.length > 0 && (
                  <small><span>Personen, die bearbeiten können</span>: <span data-i18n-ignore>{item.editors.join(', ')}</span></small>
                )}
                {!item.stopped && <small className="share-link" data-i18n-ignore>{item.link}</small>}
              </span>
              {!item.stopped && (
                <button
                  type="button"
                  className="secondary-button share-stop"
                  data-share-stop={item.id}
                  onClick={() => { void shareStopControl({ id: item.id, port, directory, origin }).then(onDirectory) }}
                >
                  Beenden
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
