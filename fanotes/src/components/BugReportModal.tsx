import { Bug, LoaderCircle, Send, X } from 'lucide-react'
import { useState } from 'react'
import { diagnosticLog, submitBugReport } from '../lib/bugReport'

type BugReportModalProps = {
  version: string
  platform: string
  onClose: () => void
  onSent?: () => void
}

export function BugReportModal({ version, platform, onClose, onSent }: BugReportModalProps) {
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await submitBugReport({
        description,
        events: diagnosticLog.snapshot(),
        version,
        platform,
      })
      if (!result.ok) {
        setError(result.status === 400
          ? 'Bitte beschreibe den Fehler kurz. Die letzten fünf Minuten müssen am Bericht hängen.'
          : 'Der Bericht konnte nicht gesendet werden. Prüfe die Verbindung zu fanotes.fasrv.ch.')
        return
      }
      onSent?.()
      onClose()
    } catch {
      setError('Der Bericht konnte nicht gesendet werden. Prüfe die Verbindung zu fanotes.fasrv.ch.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="settings-modal bug-report-modal" role="dialog" aria-modal="true" aria-label="Fehler melden" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div className="settings-heading">
            <Bug size={18} />
            <div>
              <strong>Fehler melden</strong>
              <small>Die letzten fünf Minuten (Stift, Notiz, Werkzeug) werden automatisch angehängt und nur an fanotes.fasrv.ch geschickt.</small>
            </div>
          </div>
          <button type="button" className="icon-button" aria-label="Schließen" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="settings-body bug-report-body">
          <label className="bug-report-label" htmlFor="bug-report-description">Was ist passiert?</label>
          <textarea
            id="bug-report-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Kurz beschreiben, z. B. Stift springt nach oben beim Schreiben."
            rows={5}
            maxLength={2000}
          />
          {error && <div className="settings-inline-error" role="alert">{error}</div>}
          <div className="bug-report-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Abbrechen</button>
            <button type="button" className="primary-button" disabled={busy || !description.trim()} onClick={() => void send()}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
              {busy ? 'Wird gesendet …' : 'Bericht senden'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
