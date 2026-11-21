import { ShieldCheck } from 'lucide-react'
import './diagnostics.css'

/** One-time, non-blocking notice after "Daten senden" was switched on by the update (or on a fresh install). */
export function SendDataNotice({ onDismiss, onTurnOff, onOpenSettings }: { onDismiss: () => void; onTurnOff: () => void; onOpenSettings: () => void }) {
  return (
    <div className="send-data-notice" role="status" aria-live="polite">
      <strong><ShieldCheck size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />FaNotes sendet jetzt anonyme Diagnosedaten, um die App zu verbessern</strong>
      <span>Nie Notizinhalte, Dateinamen oder Pfade. Du kannst es jederzeit in den Einstellungen ändern.</span>
      <div className="send-data-notice-actions">
        <button type="button" className="primary-button" onClick={onTurnOff}>Ausschalten</button>
        <button type="button" className="secondary-button" onClick={onOpenSettings}>Einstellungen</button>
        <button type="button" className="secondary-button" onClick={onDismiss}>OK</button>
      </div>
    </div>
  )
}
