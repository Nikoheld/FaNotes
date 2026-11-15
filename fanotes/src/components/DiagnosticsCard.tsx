import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { deleteMyDiagnostics, getInstallId, previewDiagnostics, rotateInstallId, sendLogsNow } from '../lib/diagnosticsClient'
import { getUiLanguage } from '../i18n'
import type { AppSettings } from '../types'

const Switch = ({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) => (
  <button type="button" className={`toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
)

/** Opt-in sharing of anonymous usage numbers and scrubbed logs. Off by default. */
export function DiagnosticsCard({ settings, update }: { settings: AppSettings; update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const en = getUiLanguage() === 'en'
  const say = (de: string, english: string) => setNotice(en ? english : de)

  const send = async () => {
    setBusy(true)
    const ok = await sendLogsNow(comment)
    setBusy(false)
    if (ok) { setComment(''); say('Gesendet. Danke!', 'Sent. Thank you!') } else say('Senden nicht möglich. Es wurde nichts gespeichert.', 'Could not send. Nothing was stored.')
  }
  const erase = async () => {
    setBusy(true)
    const ok = await deleteMyDiagnostics()
    setBusy(false)
    setPreview(null)
    if (ok) say('Deine Daten auf dem Server sind gelöscht. Es gibt eine neue Installations-ID.', 'Your data on the server is deleted. A new install ID was created.')
    else say('Der Server war nicht erreichbar. Lokale Zähler sind gelöscht; versuche das Löschen später noch einmal.', 'The server was unreachable. Local counters are deleted; try deleting again later.')
  }

  return (
    <div id="settings-diagnostics" className="setting-card diagnostics-card">
      <div className="setting-card-title"><ShieldCheck size={16} /><span>Diagnose &amp; Verbesserung</span></div>
      <p className="diagnostics-privacy">
        Hilf mit, FaNotes zu verbessern. Beides ist standardmässig aus. Es werden nie Notiztexte, Titel, Dateinamen, Pfade, E-Mail-Adressen, Sync-Schlüssel oder Vault-Inhalte gesendet. Gesendet wird höchstens einmal am Tag an fanotes.fasrv.ch, mit einer zufälligen Installations-ID, die nicht mit deinem Sync-Konto verbunden ist.
      </p>
      <div className="setting-row">
        <div className="setting-copy"><span>Anonyme Nutzungsstatistik senden</span><small>Version, Betriebssystem, wie oft Werkzeuge und Ansichten genutzt werden, Fehlerzahlen, Startzeit und ungefähre Vault-Grösse in Stufen.</small></div>
        <div className="setting-control"><Switch checked={settings.diagnosticsUsage} onChange={(value) => update('diagnosticsUsage', value)} label="Anonyme Nutzungsstatistik senden" /></div>
      </div>
      <div className="setting-row">
        <div className="setting-copy"><span>Logs mitsenden</span><small>Fehlerart, Fehlercode und die Code-Zeilen der App, bei der ein Fehler auftrat, plus ein Kürzel zum Gruppieren. Der Text der Fehlermeldung wird nie gesendet.</small></div>
        <div className="setting-control"><Switch checked={settings.diagnosticsLogs} onChange={(value) => update('diagnosticsLogs', value)} label="Logs mitsenden" /></div>
      </div>
      <div className="setting-row diagnostics-send">
        <div className="setting-copy"><span>Jetzt Logs senden</span><small>Schickt einmalig die letzten Fehler (nur Art, Code und Code-Zeilen), auch wenn die Schalter aus sind. Dein Kommentar wird gesendet, wie du ihn in der Vorschau siehst, nach dem Entfernen von Pfaden, Namen und Zugangsdaten. Er ist optional.</small>
          <textarea value={comment} maxLength={1000} rows={2} placeholder="Was ist passiert? (optional)" aria-label="Kommentar zum Bericht" onChange={(event) => setComment(event.target.value)} />
        </div>
        <div className="setting-control"><button type="button" className="secondary-button" disabled={busy} onClick={() => void send()}>Jetzt Logs senden</button></div>
      </div>
      <div className="setting-row">
        <div className="setting-copy"><span>Vorschau</span><small>Zeigt genau das JSON, das gesendet würde, wenn beide Schalter an sind.</small></div>
        <div className="setting-control diagnostics-actions">
          <button type="button" className="secondary-button" onClick={() => setPreview(preview ? null : JSON.stringify({ daily: previewDiagnostics({ assumeConsent: true }), report: previewDiagnostics({ manual: true, comment }) }, null, 2))}>{preview ? 'Vorschau schliessen' : 'Vorschau'}</button>
        </div>
      </div>
      {preview && <pre className="diagnostics-preview" tabIndex={0} aria-label="Vorschau der Daten" data-i18n-ignore>{preview}</pre>}
      <div className="setting-row">
        <div className="setting-copy"><span>Meine Daten löschen</span><small>Löscht alles, was zu deiner Installations-ID auf dem Server liegt, und erzeugt eine neue ID.</small>
          <code className="diagnostics-id" data-i18n-ignore>{getInstallId().slice(0, 8)}…</code>
        </div>
        <div className="setting-control diagnostics-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void erase()}>Meine Daten löschen</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { rotateInstallId(); setPreview(null); say('Neue Installations-ID erzeugt.', 'New install ID created.') }}>ID erneuern</button>
        </div>
      </div>
      {notice && <p className="diagnostics-notice" role="status" data-i18n-ignore>{notice}</p>}
    </div>
  )
}
