import { Bug, LoaderCircle, Send } from 'lucide-react'
import { useState } from 'react'
import { DialogFrame } from './DialogFrame'
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
    <DialogFrame
      icon={<Bug size={18} />}
      eyebrow="Rückmeldung"
      title="Fehler melden"
      titleId="bug-report-title"
      onClose={onClose}
      size="md"
      className="bug-report-dialog"
      footer={(
        <>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Abbrechen</button>
          <button type="button" className="primary-button" disabled={busy || !description.trim()} onClick={() => void send()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
            {busy ? 'Wird gesendet …' : 'Bericht senden'}
          </button>
        </>
      )}
    >
      <p className="dialog-frame__lede">Die letzten fünf Minuten (Stift, Notiz, Werkzeug) werden automatisch angehängt und nur an fanotes.fasrv.ch geschickt.</p>
      <label className="bug-report-label" htmlFor="bug-report-description">Was ist passiert?</label>
      <textarea
        id="bug-report-description"
        data-autofocus=""
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="Kurz beschreiben, z. B. Stift springt nach oben beim Schreiben."
        rows={5}
        maxLength={2000}
      />
      {error && <div className="dialog-frame__error" role="alert">{error}</div>}
    </DialogFrame>
  )
}
