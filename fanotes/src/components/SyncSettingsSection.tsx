import { Check, Cloud, CloudOff, KeyRound, Laptop, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Smartphone, Trash2, TriangleAlert, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getUiLocale } from '../i18n'
import type { SyncEngine, SyncPublicState } from '../lib/sync/engine'
import { syncStatusLabel } from '../lib/sync/status'
import type { AppSettings } from '../types'

type Props = {
  engine: SyncEngine
  syncState: SyncPublicState
  settings: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  platform?: string
}

type Notice = { kind: 'success' | 'error'; text: string } | null

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`

const formatWhen = (iso: string | null) => {
  if (!iso) return 'noch nie'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'unbekannt'
  return date.toLocaleString(getUiLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

export function SyncSettingsSection({ engine, syncState, settings, update, platform }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordRepeat, setPasswordRepeat] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [nextPasswordRepeat, setNextPasswordRepeat] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const signedIn = Boolean(syncState.account)
  const unavailable = syncState.status === 'unavailable'

  useEffect(() => {
    if (!signedIn) return
    void engine.refreshAccount().catch(() => undefined)
  }, [engine, signedIn, syncState.lastSyncAt])

  const run = async (label: string, task: () => Promise<void>, success?: string) => {
    setBusy(label)
    setNotice(null)
    try {
      await task()
      if (success) setNotice({ kind: 'success', text: success })
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Das hat nicht geklappt.' })
      return false
    } finally {
      setBusy(null)
    }
  }

  const submitAccount = () => {
    if (mode === 'register' && password !== passwordRepeat) {
      setNotice({ kind: 'error', text: 'Die beiden Passwörter stimmen nicht überein.' })
      return
    }
    void run(mode, async () => {
      if (mode === 'register') await engine.register(email, password)
      else await engine.login(email, password)
      setPassword('')
      setPasswordRepeat('')
    }, mode === 'register' ? 'Konto erstellt – dieses Gerät synchronisiert ab jetzt.' : 'Angemeldet – die Notizen des Kontos werden geholt.')
  }

  const submitPassword = () => {
    if (nextPassword !== nextPasswordRepeat) {
      setNotice({ kind: 'error', text: 'Die beiden neuen Passwörter stimmen nicht überein.' })
      return
    }
    void run('password', async () => {
      await engine.changePassword(currentPassword, nextPassword)
      setCurrentPassword('')
      setNextPassword('')
      setNextPasswordRepeat('')
    }, 'Passwort geändert. Alle anderen Geräte müssen sich neu anmelden.')
  }

  const info = syncState.info
  const usage = info?.usage
  const usagePercent = usage && usage.quotaBytes > 0 ? Math.min(100, Math.round((usage.bytes / usage.quotaBytes) * 100)) : 0
  const isWeb = platform === 'web' || platform === 'browser-preview'

  return (
    <>
      <div id="settings-sync-overview" className="setting-callout">
        <span>{signedIn ? <ShieldCheck size={18} /> : <Cloud size={18} />}</span>
        <div>
          <strong>Deine Notizen auf allen Geräten – Ende-zu-Ende verschlüsselt</strong>
          <p>Sync verschlüsselt jede Datei auf diesem Gerät mit einem Schlüssel, den nur dein Passwort entsperrt. Der Server speichert ausschließlich Chiffrate und zufällige IDs – weder Inhalte noch Dateinamen sind dort lesbar. Deshalb kann ein vergessenes Passwort nicht zurückgesetzt werden.</p>
        </div>
      </div>

      {notice && <div className={`backup-notice is-${notice.kind}`} role="status">{notice.kind === 'success' ? <Check size={14} /> : <TriangleAlert size={14} />}<span>{notice.text}</span></div>}

      {unavailable && <div className="setting-card"><div className="setting-card-title"><CloudOff size={16} /><span>Nicht verfügbar</span></div><div className="setting-row"><div className="setting-copy"><span>Sync steht in dieser Umgebung nicht zur Verfügung.</span><small>Die Anwendung stellt keinen Dateizugriff für den Sync bereit.</small></div></div></div>}

      {!unavailable && !signedIn && (
        <div id="settings-sync-account" className="setting-card sync-account-card">
          <div className="setting-card-title"><KeyRound size={16} /><span>{mode === 'login' ? 'Anmelden' : 'Konto erstellen'}</span>
            <div className="sync-mode-switch" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-active' : ''} onClick={() => { setMode('login'); setNotice(null) }}>Anmelden</button>
              <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-active' : ''} onClick={() => { setMode('register'); setNotice(null) }}>Konto erstellen</button>
            </div>
          </div>
          <form className="sync-form" onSubmit={(event) => { event.preventDefault(); submitAccount() }}>
            <label><span>E-Mail-Adresse</span><input data-i18n-ignore type="email" autoComplete="username" spellCheck={false} required value={email} placeholder="du@example.com" onChange={(event) => setEmail(event.target.value)} /></label>
            <label><span>Passwort</span><input data-i18n-ignore type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={mode === 'register' ? 10 : 1} value={password} placeholder={mode === 'register' ? 'Mindestens 10 Zeichen' : ''} onChange={(event) => setPassword(event.target.value)} /></label>
            {mode === 'register' && <label><span>Passwort wiederholen</span><input data-i18n-ignore type="password" autoComplete="new-password" required value={passwordRepeat} onChange={(event) => setPasswordRepeat(event.target.value)} /></label>}
            <label><span>Name dieses Geräts</span><input data-i18n-ignore type="text" maxLength={80} value={settings.syncDeviceName} placeholder={isWeb ? 'Browser' : 'z. B. Laptop'} onChange={(event) => update('syncDeviceName', event.target.value)} /></label>
            <div className="sync-form-actions">
              <button type="submit" className="primary-button" disabled={busy !== null || !email.trim() || !password}>
                {busy === mode ? <LoaderCircle className="spin" size={15} /> : mode === 'register' ? <UserPlus size={15} /> : <KeyRound size={15} />}
                {busy === mode ? 'Schlüssel wird berechnet …' : mode === 'register' ? 'Konto erstellen' : 'Anmelden'}
              </button>
              <small>{mode === 'register' ? 'Aus dem Passwort wird auf diesem Gerät ein Schlüssel abgeleitet (PBKDF2, 600 000 Runden); der Server sieht das Passwort nie.' : 'Bereits vorhandene Notizen bleiben erhalten. Gleichnamige Dateien mit anderem Inhalt werden als Konfliktkopie gesichert.'}</small>
            </div>
          </form>
        </div>
      )}

      {!unavailable && signedIn && syncState.account && (
        <>
          <div id="settings-sync-account" className={`setting-card sync-status-card is-${syncState.status}`}>
            <div className="setting-card-title"><Cloud size={16} /><span>Konto & Status</span></div>
            <div className="sync-status-hero">
              <span className="sync-status-icon">{syncState.status === 'syncing' ? <LoaderCircle className="spin" size={20} /> : syncState.status === 'offline' ? <CloudOff size={20} /> : syncState.status === 'error' ? <TriangleAlert size={20} /> : <ShieldCheck size={20} />}</span>
              <div>
                <strong data-i18n-ignore>{syncState.account.email}</strong>
                <p>{syncStatusLabel(syncState)} · Zuletzt: {formatWhen(syncState.lastSyncAt)}</p>
                {syncState.error && <p className="sync-status-error">{syncState.error}</p>}
                {usage && <p data-i18n-ignore>{usage.files} Dateien · {formatBytes(usage.bytes)} von {formatBytes(usage.quotaBytes)}</p>}
                {usage && <div className="sync-usage-bar" aria-hidden><span style={{ width: `${usagePercent}%` }} /></div>}
              </div>
              <div className="update-actions">
                <button type="button" className="primary-button" disabled={syncState.status === 'syncing'} onClick={() => void run('sync', () => engine.syncNow('manual'))}><RefreshCw className={syncState.status === 'syncing' ? 'spin' : ''} size={15} /> Jetzt synchronisieren</button>
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('logout', () => engine.logout(), 'Abgemeldet. Die Notizen bleiben auf diesem Gerät.')}><LogOut size={15} /> Abmelden</button>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Automatisch synchronisieren</span><small>Nach jedem Speichern, beim Fokuswechsel und im Hintergrund jede Minute. Aus: nur über „Jetzt synchronisieren“.</small></div>
              <div className="setting-control"><button type="button" className={`toggle ${settings.syncAutomatic ? 'is-on' : ''}`} role="switch" aria-checked={settings.syncAutomatic} aria-label="Automatisch synchronisieren" onClick={() => update('syncAutomatic', !settings.syncAutomatic)}><span /></button></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Name dieses Geräts</span><small>Erscheint in der Geräteliste und im Namen von Konfliktkopien.</small></div>
              <div className="setting-control"><input data-i18n-ignore type="text" maxLength={80} value={settings.syncDeviceName} placeholder={isWeb ? 'Browser' : 'z. B. Laptop'} onChange={(event) => update('syncDeviceName', event.target.value)} /></div>
            </div>
          </div>

          <div id="settings-sync-devices" className="setting-card">
            <div className="setting-card-title"><Laptop size={16} /><span>Angemeldete Geräte</span></div>
            {!info && <div className="setting-row"><div className="setting-copy"><small>Geräteliste wird geladen …</small></div></div>}
            {info?.devices.map((device) => (
              <div key={device.id} className="setting-row sync-device-row">
                <div className="setting-copy">
                  <span data-i18n-ignore>{device.platform === 'web' || device.platform === 'browser-preview' ? <Smartphone size={13} /> : <Laptop size={13} />} {device.name}{device.current ? <em> · dieses Gerät</em> : null}</span>
                  <small>Zuletzt aktiv: {formatWhen(device.lastSeenAt)}</small>
                </div>
                <div className="setting-control">
                  {!device.current && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run(`device-${device.id}`, () => engine.removeDevice(device.id), `„${device.name}“ wurde abgemeldet.`)}><LogOut size={14} /> Abmelden</button>}
                </div>
              </div>
            ))}
          </div>

          {syncState.conflicts.length > 0 && (
            <div id="settings-sync-conflicts" className="setting-card">
              <div className="setting-card-title"><TriangleAlert size={16} /><span>Konfliktkopien</span><button type="button" className="sync-card-action" onClick={() => engine.clearConflicts()}>Liste leeren</button></div>
              {syncState.conflicts.slice().reverse().map((conflict) => (
                <div key={`${conflict.copyPath}-${conflict.at}`} className="setting-row">
                  <div className="setting-copy"><span data-i18n-ignore>{conflict.path}</span><small>Lokale Fassung gesichert als „{conflict.copyPath}“ · {formatWhen(conflict.at)}</small></div>
                </div>
              ))}
            </div>
          )}

          <div id="settings-sync-password" className="setting-card">
            <div className="setting-card-title"><KeyRound size={16} /><span>Passwort ändern</span></div>
            <form className="sync-form" onSubmit={(event) => { event.preventDefault(); submitPassword() }}>
              <label><span>Aktuelles Passwort</span><input data-i18n-ignore type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
              <label><span>Neues Passwort</span><input data-i18n-ignore type="password" autoComplete="new-password" required minLength={10} value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} /></label>
              <label><span>Neues Passwort wiederholen</span><input data-i18n-ignore type="password" autoComplete="new-password" required value={nextPasswordRepeat} onChange={(event) => setNextPasswordRepeat(event.target.value)} /></label>
              <div className="sync-form-actions">
                <button type="submit" className="secondary-button" disabled={busy !== null || !currentPassword || !nextPassword}>{busy === 'password' ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />} Passwort ändern</button>
                <small>Der Vault-Schlüssel wird nur neu verpackt – keine Datei muss neu hochgeladen werden.</small>
              </div>
            </form>
          </div>

          <div id="settings-sync-delete" className="setting-card">
            <div className="setting-card-title"><Trash2 size={16} /><span>Konto löschen</span></div>
            <div className="setting-row">
              <div className="setting-copy"><span>Konto und alle Daten auf dem Server löschen</span><small>Die Notizen auf deinen Geräten bleiben erhalten. Andere Geräte werden abgemeldet.</small></div>
              <div className="setting-control">
                {!deleteOpen
                  ? <button type="button" className="backup-delete-button" disabled={busy !== null} onClick={() => setDeleteOpen(true)}><Trash2 size={14} /> Konto löschen</button>
                  : <form className="backup-inline-confirm is-danger" role="alert" onSubmit={(event) => { event.preventDefault(); void run('delete', () => engine.deleteAccount(deletePassword), 'Konto und Serverdaten wurden gelöscht.').then((ok) => { if (ok) { setDeleteOpen(false); setDeletePassword('') } }) }}>
                    <span>Zur Bestätigung dein Passwort:</span>
                    <input data-i18n-ignore type="password" autoComplete="current-password" required value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} />
                    <button type="button" className="secondary-button" onClick={() => { setDeleteOpen(false); setDeletePassword('') }}>Abbrechen</button>
                    <button type="submit" className="danger-button" disabled={busy !== null || !deletePassword}>Endgültig löschen</button>
                  </form>}
              </div>
            </div>
          </div>
        </>
      )}

      {!unavailable && syncState.log.length > 0 && (
        <div id="settings-sync-log" className="setting-card">
          <div className="setting-card-title"><RefreshCw size={16} /><span>Protokoll</span><button type="button" className="sync-card-action" onClick={() => setLogOpen((value) => !value)}>{logOpen ? 'Einklappen' : `${syncState.log.length} Einträge`}</button></div>
          {logOpen && <ul className="sync-log">{syncState.log.slice().reverse().slice(0, 40).map((entry) => <li key={`${entry.at}-${entry.text}`} className={`is-${entry.level}`}><time>{formatWhen(entry.at)}</time><span data-i18n-ignore>{entry.text}</span></li>)}</ul>}
        </div>
      )}
    </>
  )
}
