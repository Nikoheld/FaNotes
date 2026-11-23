import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { deleteMyDiagnostics, getInstallStatus, previewManualReport, previewQueuedDiagnostics, rotateInstallId, sendLogsNow } from '../lib/diagnosticsClient'
import { getUiLanguage } from '../i18n'
import type { AppSettings } from '../types'
import './diagnostics.css'

const Switch = ({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) => (
  <button type="button" className={`toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
)

type CategoryKey = 'diagnosticsCrashes' | 'diagnosticsLogs' | 'diagnosticsPerf' | 'diagnosticsUsage'
const CATEGORIES: Array<{ key: CategoryKey; title: string; detail: string }> = [
  { key: 'diagnosticsCrashes', title: 'Absturzberichte', detail: 'Wenn FaNotes oder ein Teil davon abstürzt: Art des Absturzes, Fehlercode und die betroffenen Code-Zeilen der App.' },
  { key: 'diagnosticsLogs', title: 'Fehlerdiagnose', detail: 'Fehlerart, Fehlercode und Code-Zeilen bei Fehlern in der App, plus ein Kürzel zum Gruppieren. Der Text der Fehlermeldung wird nie gesendet.' },
  { key: 'diagnosticsPerf', title: 'Leistungsdaten', detail: 'Startzeit, Stift-Latenz (Median und obere Perzentile), Speicherverbrauch und Hänger (Anzahl, Dauer, grobe Art), höchstens einmal am Tag.' },
  { key: 'diagnosticsUsage', title: 'Nutzungsstatistik', detail: 'Version, Betriebssystem, wie oft Werkzeuge und Ansichten genutzt werden und die ungefähre Vault-Größe in Stufen.' },
]

/** "Daten senden": master switch plus one switch per category. On by default; turning it off deletes the queue. */
export function DiagnosticsCard({ settings, update }: { settings: AppSettings; update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [installId, setInstallId] = useState('')
  const en = getUiLanguage() === 'en'
  const say = (de: string, english: string) => setNotice(en ? english : de)
  const master = settings.diagnosticsEnabled
  useEffect(() => { void getInstallStatus().then((status) => setInstallId(status?.installId ?? '')) }, [])

  const send = async () => {
    setBusy(true)
    const ok = await sendLogsNow(comment)
    setBusy(false)
    if (ok) { setComment(''); say('Gesendet. Danke!', 'Sent. Thank you!') } else say('Senden fehlgeschlagen. Prüfe deine Internetverbindung und versuche es später noch einmal.', 'Sending failed. Check your internet connection and try again later.')
  }
  const erase = async () => {
    setBusy(true)
    const ok = await deleteMyDiagnostics()
    setBusy(false)
    setPreview(null)
    setInstallId((await getInstallStatus())?.installId ?? '')
    if (ok) say('Deine Daten auf dem Server sind gelöscht. Es gibt eine neue Installations-ID.', 'Your data on the server is deleted. A new install ID was created.')
    else say('Der Server war nicht erreichbar. Auf diesem Gerät ist alles Vorgemerkte gelöscht, die schon gesendeten Daten liegen aber noch auf dem Server. Wähle später noch einmal „Meine Daten löschen“.', 'The server could not be reached. Everything queued on this device is deleted, but the data already sent is still on the server. Choose “Delete my data” again later.')
  }
  const showPreview = async () => {
    if (preview) { setPreview(null); return }
    const queued = await previewQueuedDiagnostics()
    setPreview(JSON.stringify({ nextBatch: queued, report: previewManualReport(comment) }, null, 2))
  }

  return (
    <div id="settings-diagnostics" className="setting-card diagnostics-card">
      <div className="setting-card-title"><ShieldCheck size={16} /><span>Daten senden</span></div>
      <p className="diagnostics-privacy">
        FaNotes sendet anonyme Diagnosedaten, damit die App besser wird. Das ist standardmäßig an und hier jederzeit abschaltbar. Es werden nie Notizinhalte, Dateinamen, Vault-Pfade, OCR-Text, Handschrift, Benutzernamen, E-Mail-Adressen oder Zugangsdaten gesendet.
      </p>
      <div className="setting-row">
        <div className="setting-copy"><span>Daten senden</span><small>Hauptschalter für alles darunter. Ausgeschaltet wird sofort nichts mehr gesendet und alles Vorgemerkte auf diesem Gerät gelöscht.</small></div>
        <div className="setting-control"><Switch checked={master} onChange={(value) => update('diagnosticsEnabled', value)} label="Daten senden" /></div>
      </div>
      {CATEGORIES.map((category) => (
        <div className={`setting-row ${master ? '' : 'is-disabled'}`} key={category.key}>
          <div className="setting-copy"><span>{category.title}</span><small>{category.detail}</small></div>
          <div className="setting-control"><Switch checked={settings[category.key]} disabled={!master} onChange={(value) => update(category.key, value)} label={category.title} /></div>
        </div>
      ))}
      <details className="diagnostics-details">
        <summary>Was wird gesendet?</summary>
        <div>
          <p>Gesendet wird gebündelt und komprimiert, höchstens einmal am Tag, nur wenn du gerade nicht aktiv arbeitest und eine Internetverbindung besteht. Ein Absturzbericht kann früher folgen, höchstens einmal pro Stunde. Im Leerlauf laufen keine zusätzlichen Timer.</p>
          <ul>
            <li>Absturzberichte: Art (z. B. unbehandelte Ausnahme, Renderer oder Hilfsprozess beendet), Fehlerklasse, Fehlercode, Beendigungsgrund und bis zu vier Code-Zeilen der App (Dateiname der App und Zeilennummer, ohne Pfad), Anzahl.</li>
            <li>Fehlerdiagnose: Fehlerklasse, Fehlercode, Code-Zeilen der App und ein Kürzel; nie der Text der Meldung.</li>
            <li>Leistungsdaten: Startzeit, Stift-Latenz (Median, 90. und 99. Perzentil), Speicherverbrauch in Stufen von 10 MB, Hänger über 0,5 s (Anzahl, längste Dauer, 95. Perzentil, Verteilung auf Sync, Speichern, Index, Öffnen und Sonstiges, Verzögerung des Hauptprozesses; keine Namen, Pfade oder Inhalte).</li>
            <li>Nutzungsstatistik: Zähler für Werkzeuge und Ansichten, Anzahl Notizen und Vault-Größe in groben Stufen, ein anonymer Start-Zähler.</li>
            <li>Immer dabei: zufällige Installations-ID (nicht mit Sync-Konto oder E-Mail verbunden, jederzeit erneuerbar), App-Version, Betriebssystem, Architektur und Sprache.</li>
          </ul>
          <p>Nie gesendet werden: Notizinhalte, Titel, Dateinamen, Vault-Pfade, OCR-Text, Handschrift, Benutzernamen, E-Mail-Adressen, Tokens und Schlüssel. Pfade und Namen werden aus Fehlerspuren entfernt. Der Server speichert keine IP-Adressen. Genaue Beschreibung: fanotes/docs/DIAGNOSTICS.md</p>
        </div>
      </details>
      <div className="setting-row diagnostics-send">
        <div className="setting-copy"><span>Jetzt Logs senden</span><small>Schickt einmalig die letzten Fehler (nur Art, Code und Code-Zeilen), auch wenn die Schalter aus sind. Dein Kommentar wird gesendet, wie du ihn in der Vorschau siehst, nach dem Entfernen von Pfaden, Namen und Zugangsdaten. Er ist optional.</small>
          <textarea value={comment} maxLength={1000} rows={2} placeholder="Was ist passiert? (optional)" aria-label="Kommentar zum Bericht" onChange={(event) => setComment(event.target.value)} />
        </div>
        <div className="setting-control"><button type="button" className="secondary-button" disabled={busy} onClick={() => void send()}>Jetzt Logs senden</button></div>
      </div>
      <div className="setting-row">
        <div className="setting-copy"><span>Vorschau</span><small>Zeigt genau das JSON, das als Nächstes gesendet würde, und den Inhalt eines manuellen Berichts.</small></div>
        <div className="setting-control diagnostics-actions">
          <button type="button" className="secondary-button" onClick={() => void showPreview()}>{preview ? 'Vorschau schließen' : 'Vorschau'}</button>
        </div>
      </div>
      {preview && <pre className="diagnostics-preview" tabIndex={0} aria-label="Vorschau der Daten" data-i18n-ignore>{preview}</pre>}
      <div className="setting-row">
        <div className="setting-copy"><span>Meine Daten löschen</span><small>Löscht alles, was zu deiner Installations-ID auf dem Server liegt, und erzeugt eine neue ID.</small>
          {installId && <code className="diagnostics-id" data-i18n-ignore>{installId.slice(0, 8)}…</code>}
        </div>
        <div className="setting-control diagnostics-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void erase()}>Meine Daten löschen</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void rotateInstallId().then(() => getInstallStatus()).then((status) => setInstallId(status?.installId ?? '')); setPreview(null); say('Neue Installations-ID erzeugt.', 'New install ID created.') }}>ID erneuern</button>
        </div>
      </div>
      {notice && <p className="diagnostics-notice" role="status" data-i18n-ignore>{notice}</p>}
    </div>
  )
}
