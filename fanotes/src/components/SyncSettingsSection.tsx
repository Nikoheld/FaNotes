import { Check, Clock, Cloud, CloudOff, Copy, KeyRound, Laptop, LoaderCircle, LogOut, Mail, RefreshCw, Share2, ShieldCheck, Smartphone, Trash2, TriangleAlert, UserPlus } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getUiLocale, translateUiText, uiText } from '../i18n'
import type { SyncEngine, SyncPublicState } from '../lib/sync/engine'
import { failedLabel, syncStatusLabel } from '../lib/sync/status'
import { userShares } from '../lib/sync/userShares'
import type { AppSettings } from '../types'

type Props = {
  engine: SyncEngine
  syncState: SyncPublicState
  settings: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  platform?: string
  /** Opens Settings → Konflikte. */
  onOpenConflicts?: () => void
}

type Notice = { kind: 'success' | 'error'; text: string } | null

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`

const formatWhen = (iso: string | null) => {
  if (!iso) return uiText('noch nie', 'never')
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return uiText('unbekannt', 'unknown')
  return date.toLocaleString(getUiLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

export function SyncSettingsSection({ engine, syncState, settings, update, platform, onOpenConflicts }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [deviceKeyAccounts, setDeviceKeyAccounts] = useState<Array<{ accountId: string; username: string }>>([])
  const [claimName, setClaimName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [addEmailPassword, setAddEmailPassword] = useState('')
  const sharesState = useSyncExternalStore(userShares.subscribe, userShares.getState, userShares.getState)
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
    if (signedIn) return
    let cancelled = false
    void Promise.resolve(engine.deviceKeyAccounts?.() ?? []).then((accounts) => { if (!cancelled) setDeviceKeyAccounts(accounts) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [engine, signedIn, syncState.status])

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
      if (mode === 'register') await engine.createAccount({ username, email, password })
      else await engine.login(username, password)
      setPassword('')
      setPasswordRepeat('')
    }, mode === 'register' ? 'Konto erstellt. Cloud-Sync ist aus, bis du ihn einschaltest.' : 'Angemeldet – die Notizen des Kontos werden geholt.')
  }

  const deviceKeyAccount = syncState.account?.credential === 'device-key'
  const canKeepDeviceKey = (engine.supportsDeviceKey?.() ?? false)
  const noPassword = mode === 'register' && !password && canKeepDeviceKey

  const toggleVaultSync = () => {
    const next = !settings.syncVaultEnabled
    update('syncVaultEnabled', next)
    // The setting reaches the engine through the app's settings reference; let that settle first.
    window.setTimeout(() => engine.vaultSyncChanged(), 0)
  }

  const submitPassword = () => {
    if (nextPassword !== nextPasswordRepeat) {
      setNotice({ kind: 'error', text: 'Die beiden neuen Passwörter stimmen nicht überein.' })
      return
    }
    void run('password', async () => {
      await engine.changePassword(deviceKeyAccount ? '' : currentPassword, nextPassword)
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
          <p>Sync verschlüsselt jede Datei auf diesem Gerät mit einem Schlüssel, den nur dein Passwort (oder der Schlüssel dieses Geräts) entsperrt. Der Server speichert ausschließlich Chiffrate und zufällige IDs – weder Inhalte noch Dateinamen sind dort lesbar. Deshalb kann ein vergessenes Passwort nicht zurückgesetzt werden. Cloud-Sync ist für neue Konten zuerst aus; das Konto selbst dient auch zum direkten Teilen mit anderen Benutzern.</p>
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
            <label><span>{mode === 'register' ? 'Benutzername' : 'Benutzername oder E-Mail-Adresse'}</span><input data-i18n-ignore type="text" autoComplete="username" spellCheck={false} required minLength={3} maxLength={mode === 'register' ? 32 : 254} value={username} placeholder={mode === 'register' ? uiText('z. B. anna.f', 'e.g. anna.f') : uiText('dein Benutzername', 'your username')} onChange={(event) => setUsername(event.target.value)} /></label>
            {mode === 'register' && <small className="sync-form-hint">Andere teilen mit dir über diesen Namen. Er ist einmalig (Gross-/Kleinschreibung egal) und kann später nicht geändert werden.</small>}
            <label><span>{mode === 'register' && canKeepDeviceKey ? 'Passwort (optional)' : 'Passwort'}</span><input data-i18n-ignore type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required={!(mode === 'register' && canKeepDeviceKey)} minLength={mode === 'register' && password ? 10 : 1} value={password} placeholder={mode === 'register' ? uiText('Mindestens 10 Zeichen', 'At least 10 characters') : ''} onChange={(event) => setPassword(event.target.value)} /></label>
            {mode === 'register' && password && <label><span>Passwort wiederholen</span><input data-i18n-ignore type="password" autoComplete="new-password" required value={passwordRepeat} onChange={(event) => setPasswordRepeat(event.target.value)} /></label>}
            {mode === 'register' && <label><span>E-Mail-Adresse (optional)</span><input data-i18n-ignore type="email" autoComplete="email" spellCheck={false} value={email} placeholder="du@example.com" onChange={(event) => setEmail(event.target.value)} /></label>}
            {noPassword && <div className="backup-notice is-error" role="alert"><TriangleAlert size={14} /><span>Ohne Passwort/E-Mail ist dein Konto weg, wenn du dieses Gerät verlierst. Das Konto wird an einen Schlüssel gebunden, der sicher auf diesem Gerät liegt. Du kannst später ein Passwort oder eine E-Mail hinzufügen.</span></div>}
            <label><span>Name dieses Geräts</span><input data-i18n-ignore type="text" maxLength={80} value={settings.syncDeviceName} placeholder={isWeb ? 'Browser' : uiText('z. B. Laptop', 'e.g. Laptop')} onChange={(event) => update('syncDeviceName', event.target.value)} /></label>
            <div className="sync-form-actions">
              <button type="submit" className="primary-button" disabled={busy !== null || !username.trim() || (!password && !(mode === 'register' && canKeepDeviceKey))}>
                {busy === mode ? <LoaderCircle className="spin" size={15} /> : mode === 'register' ? <UserPlus size={15} /> : <KeyRound size={15} />}
                {busy === mode ? 'Schlüssel wird berechnet …' : mode === 'register' ? 'Konto erstellen' : 'Anmelden'}
              </button>
              <small>{mode === 'register' ? (password ? 'Aus dem Passwort wird auf diesem Gerät ein Schlüssel abgeleitet (PBKDF2, 600 000 Runden); der Server sieht das Passwort nie. Cloud-Sync ist zuerst aus und braucht einen eigenen Schalter.' : 'Der Schlüssel entsteht zufällig auf diesem Gerät und liegt im Schlüsselbund des Systems. Cloud-Sync ist zuerst aus und braucht einen eigenen Schalter.') : 'Bereits vorhandene Notizen bleiben erhalten. Gleichnamige Dateien mit anderem Inhalt werden als Konfliktkopie gesichert.'}</small>
            </div>
          </form>
          {mode === 'login' && deviceKeyAccounts.length > 0 && (
            <div className="sync-form">
              {deviceKeyAccounts.map((entry) => (
                <div key={entry.accountId} className="setting-row">
                  <div className="setting-copy"><span data-i18n-ignore>{entry.username}</span><small>Dieses Konto hat kein Passwort. Der Schlüssel liegt auf diesem Gerät.</small></div>
                  <div className="setting-control"><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('device-key', () => engine.loginWithDeviceKey(entry.accountId), 'Angemeldet.')}><KeyRound size={14} /> Mit Gerätschlüssel anmelden</button></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!unavailable && signedIn && syncState.account && (
        <>
          <div id="settings-sync-account" className={`setting-card sync-status-card is-${syncState.status}`}>
            <div className="setting-card-title"><Cloud size={16} /><span>Konto & Status</span></div>
            <div className="sync-status-hero">
              <span className="sync-status-icon">{syncState.status === 'syncing' ? <LoaderCircle className="spin" size={20} /> : syncState.status === 'offline' ? <CloudOff size={20} /> : syncState.status === 'error' ? <TriangleAlert size={20} /> : syncState.status === 'paused' ? <Clock size={20} /> : <ShieldCheck size={20} />}</span>
              <div>
                <strong data-i18n-ignore>{syncState.account.username || syncState.account.email}</strong>
                {syncState.account.username && syncState.account.email && <p data-i18n-ignore>{syncState.account.email}</p>}
                <p data-i18n-ignore>{syncState.vaultSync !== false ? `${translateUiText(syncStatusLabel(syncState))} · ${uiText('Zuletzt', 'Last synced')}: ${formatWhen(syncState.lastSyncAt)}` : translateUiText('Cloud-Sync ist aus – das Konto bleibt für Freigaben angemeldet.')}</p>
                {syncState.error && <p className="sync-status-error">{syncState.error}</p>}
                {usage && <p data-i18n-ignore>{uiText(`${usage.files} Dateien · ${formatBytes(usage.bytes)} von ${formatBytes(usage.quotaBytes)}`, `${usage.files} ${usage.files === 1 ? 'file' : 'files'} · ${formatBytes(usage.bytes)} of ${formatBytes(usage.quotaBytes)}`)}</p>}
                {usage && <div className="sync-usage-bar" aria-hidden><span style={{ width: `${usagePercent}%` }} /></div>}
              </div>
              <div className="update-actions">
                <button type="button" className="primary-button" disabled={syncState.status === 'syncing'} onClick={() => void run('sync', () => engine.syncNow('manual'))}><RefreshCw className={syncState.status === 'syncing' ? 'spin' : ''} size={15} /> Jetzt synchronisieren</button>
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run('logout', () => engine.logout(), 'Abgemeldet. Die Notizen bleiben auf diesem Gerät.')}><LogOut size={15} /> Abmelden</button>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Notizen in der Cloud synchronisieren</span><small>Aus: nichts aus deinem Vault wird hochgeladen; Freigaben an andere funktionieren trotzdem. Ein: alle Notizen werden verschlüsselt mit deinen anderen Geräten abgeglichen.</small></div>
              <div className="setting-control"><button type="button" className={`toggle ${settings.syncVaultEnabled ? 'is-on' : ''}`} role="switch" aria-checked={settings.syncVaultEnabled} aria-label="Notizen in der Cloud synchronisieren" onClick={toggleVaultSync}><span /></button></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Automatisch synchronisieren</span><small>Nach jedem Speichern, beim Fokuswechsel und im Hintergrund jede Minute. Aus: nur über „Jetzt synchronisieren“.</small></div>
              <div className="setting-control"><button type="button" className={`toggle ${settings.syncAutomatic ? 'is-on' : ''}`} role="switch" aria-checked={settings.syncAutomatic} aria-label="Automatisch synchronisieren" onClick={() => update('syncAutomatic', !settings.syncAutomatic)}><span /></button></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Anhänge synchronisieren</span><small>Bilder und andere Dateien neben den Notizen mitnehmen. Aus: nur Notizen (Markdown, .famd, PDFs, leere PDF-Seiten und die Metadaten unter .fanotes).</small></div>
              <div className="setting-control"><button type="button" className={`toggle ${settings.syncAttachments !== false ? 'is-on' : ''}`} role="switch" aria-checked={settings.syncAttachments !== false} aria-label="Anhänge synchronisieren" onClick={() => update('syncAttachments', settings.syncAttachments === false)}><span /></button></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Handschriftmodell synchronisieren</span><small>Persönliche GlyphenWerk-Beispiele als eigene verschlüsselte Datei. Aus: das Modell bleibt auf diesem Gerät.</small></div>
              <div className="setting-control"><button type="button" className={`toggle ${settings.syncHandwritingModel ? 'is-on' : ''}`} role="switch" aria-checked={settings.syncHandwritingModel} aria-label="Handschriftmodell synchronisieren" onClick={() => update('syncHandwritingModel', !settings.syncHandwritingModel)}><span /></button></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Versionsverlauf synchronisieren</span><small>Die lokalen Sicherungen unter .fanotes/history mitnehmen. Aus: der Verlauf bleibt auf diesem Gerät.</small></div>
              <div className="setting-control"><button type="button" className={`toggle ${settings.syncNoteHistory ? 'is-on' : ''}`} role="switch" aria-checked={settings.syncNoteHistory} aria-label="Versionsverlauf synchronisieren" onClick={() => update('syncNoteHistory', !settings.syncNoteHistory)}><span /></button></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Ordner nur auf diesem Gerät</span><small>Ein Ordner je Zeile, zum Beispiel Physik/Buch. Der Rest des Vaults wird weiter synchronisiert.</small></div>
              <div className="setting-control"><textarea value={settings.syncExcludedFolders} rows={3} aria-label="Ordner nur auf diesem Gerät" onChange={(event) => update('syncExcludedFolders', event.target.value)} /></div>
            </div>
            <div className="setting-row">
              <div className="setting-copy"><span>Name dieses Geräts</span><small>Erscheint in der Geräteliste und im Namen von Konfliktkopien.</small></div>
              <div className="setting-control"><input data-i18n-ignore type="text" maxLength={80} value={settings.syncDeviceName} placeholder={isWeb ? 'Browser' : 'z. B. Laptop'} onChange={(event) => update('syncDeviceName', event.target.value)} /></div>
            </div>
          </div>

          <div id="settings-sync-identity" className="setting-card">
            <div className="setting-card-title"><UserPlus size={16} /><span>Benutzername, E-Mail und Passwort</span></div>
            {deviceKeyAccount && (
              <div className="backup-notice is-error" role="alert"><TriangleAlert size={14} /><span>Ohne Passwort/E-Mail ist dein Konto weg, wenn du dieses Gerät verlierst. Füge ein Passwort hinzu (unten), um dich auf anderen Geräten anzumelden.</span></div>
            )}
            {syncState.account.username
              ? <div className="setting-row"><div className="setting-copy"><span>Benutzername</span><small>Damit teilen andere Notizen mit dir. Er ist einmalig und kann nicht geändert werden.</small></div><div className="setting-control"><strong data-i18n-ignore>{syncState.account.username}</strong></div></div>
              : <form className="sync-form" onSubmit={(event) => { event.preventDefault(); void run('claim', async () => { await engine.claimUsername(claimName); setClaimName('') }, 'Benutzername gesetzt. Jetzt kannst du teilen und andere können mit dir teilen.') }}>
                  <label><span>Benutzername wählen</span><input data-i18n-ignore type="text" autoComplete="off" spellCheck={false} required minLength={3} maxLength={32} value={claimName} placeholder={uiText('z. B. anna.f', 'e.g. anna.f')} onChange={(event) => setClaimName(event.target.value)} /></label>
                  <div className="sync-form-actions"><button type="submit" className="primary-button" disabled={busy !== null || !claimName.trim()}>{busy === 'claim' ? <LoaderCircle className="spin" size={15} /> : <UserPlus size={15} />} Benutzernamen festlegen</button><small>Ohne Benutzernamen kann niemand direkt mit deinem Konto teilen. Er kann später nicht geändert werden.</small></div>
                </form>}
            <div className="setting-row">
              <div className="setting-copy"><span>E-Mail-Adresse</span><small>{syncState.account.email ? 'Nur zur Wiederherstellung deines Zugangs. Ein Passwort lässt sich nicht zurücksetzen, weil nur dein Passwort den Schlüssel zu deinen Daten öffnet.' : 'Optional. Du brauchst keine E-Mail-Adresse für dieses Konto.'}</small></div>
              <div className="setting-control"><span data-i18n-ignore>{syncState.account.email || uiText('keine', 'none')}</span></div>
            </div>
            <form className="sync-form" onSubmit={(event) => { event.preventDefault(); void run('email', async () => { await engine.setEmail(addEmail, deviceKeyAccount ? undefined : addEmailPassword); setAddEmail(''); setAddEmailPassword('') }, 'E-Mail-Adresse gespeichert.') }}>
              <label><span>{syncState.account.email ? 'E-Mail-Adresse ändern' : 'E-Mail-Adresse hinzufügen'}</span><input data-i18n-ignore type="email" autoComplete="email" spellCheck={false} required value={addEmail} placeholder="du@example.com" onChange={(event) => setAddEmail(event.target.value)} /></label>
              {!deviceKeyAccount && <label><span>Aktuelles Passwort</span><input data-i18n-ignore type="password" autoComplete="current-password" required value={addEmailPassword} onChange={(event) => setAddEmailPassword(event.target.value)} /></label>}
              <div className="sync-form-actions"><button type="submit" className="secondary-button" disabled={busy !== null || !addEmail.trim() || (!deviceKeyAccount && !addEmailPassword)}>{busy === 'email' ? <LoaderCircle className="spin" size={15} /> : <Mail size={15} />} Speichern</button></div>
            </form>
          </div>

          <div id="settings-sync-shares" className="setting-card">
            <div className="setting-card-title"><Share2 size={16} /><span>Freigaben an Benutzer</span></div>
            {!sharesState.ready && <div className="setting-row"><div className="setting-copy"><span>{syncState.account.username ? 'Freigaben werden vorbereitet …' : 'Noch kein Benutzername'}</span><small>{syncState.account.username ? (sharesState.error ?? 'Einen Moment.') : 'Lege oben einen Benutzernamen fest, um zu teilen und Freigaben zu erhalten.'}</small></div></div>}
            {sharesState.ready && sharesState.shares.length === 0 && <div className="setting-row"><div className="setting-copy"><span>Noch keine Freigaben</span><small>Rechtsklick auf eine Notiz oder einen Ordner → „Mit FaNotes-Benutzer teilen …“. Empfangenes erscheint in der Seitenleiste unter „Mit mir geteilt“.</small></div></div>}
            {sharesState.shares.map((share) => (
              <div key={share.id} className="setting-row">
                <div className="setting-copy">
                  <span data-i18n-ignore>{share.name || 'Geteilte Freigabe ohne Titel'} · {share.role === 'owner' ? `an ${share.peer}` : `von ${share.peer}`}</span>
                  <small>{share.status === 'pending' ? 'Wartet auf Annahme' : share.status === 'declined' ? 'Abgelehnt' : share.status === 'left' ? 'Hat die Freigabe verlassen' : share.permission === 'edit' ? 'Darf bearbeiten' : 'Darf lesen'}{share.problem ? ` · ${share.problem}` : ''}</small>
                </div>
                <div className="setting-control">
                  {share.role === 'owner' && share.status !== 'declined' && share.status !== 'left' && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run(`perm-${share.id}`, () => userShares.setPermission(share.id, share.permission === 'edit' ? 'read' : 'edit'))}>{share.permission === 'edit' ? 'Nur lesen' : 'Bearbeiten erlauben'}</button>}
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run(`share-${share.id}`, () => userShares.remove(share.id), share.role === 'owner' ? 'Freigabe widerrufen. Der Zugriff ist sofort weg.' : 'Freigabe verlassen.')}>{share.role === 'owner' ? 'Widerrufen' : 'Verlassen'}</button>
                </div>
              </div>
            ))}
            {sharesState.blocked.map((name) => (
              <div key={`blocked-${name}`} className="setting-row">
                <div className="setting-copy"><span data-i18n-ignore>{name}</span><small>Blockiert: Freigaben dieser Person kommen nicht bei dir an.</small></div>
                <div className="setting-control"><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run(`unblock-${name}`, () => userShares.unblock(name), 'Blockierung aufgehoben.')}>Entsperren</button></div>
              </div>
            ))}
          </div>

          <div id="settings-sync-devices" className="setting-card">
            <div className="setting-card-title"><Laptop size={16} /><span>Angemeldete Geräte</span></div>
            {!info && <div className="setting-row"><div className="setting-copy"><small>Geräteliste wird geladen …</small></div></div>}
            {info?.devices.map((device) => (
              <div key={device.id} className="setting-row sync-device-row">
                <div className="setting-copy">
                  <span data-i18n-ignore>{device.platform === 'web' || device.platform === 'browser-preview' ? <Smartphone size={13} /> : <Laptop size={13} />} {device.name}{device.current ? <em>{uiText(' · dieses Gerät', ' · this device')}</em> : null}</span>
                  <small>Zuletzt aktiv: {formatWhen(device.lastSeenAt)}</small>
                </div>
                <div className="setting-control">
                  {!device.current && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void run(`device-${device.id}`, () => engine.removeDevice(device.id), `„${device.name}“ wurde abgemeldet.`)}><LogOut size={14} /> Abmelden</button>}
                </div>
              </div>
            ))}
          </div>

          {syncState.failed.length > 0 && (
            <div id="settings-sync-failed" className="setting-card">
              <div className="setting-card-title"><TriangleAlert size={16} /><span data-i18n-ignore>{failedLabel(syncState.failed.length)}</span></div>
              <div className="setting-row">
                <div className="setting-copy">
                  <span>Diese Dateien sind nur auf diesem Gerät</span>
                  <small>Der Sync versucht es bei jedem Durchlauf erneut. Behebe den Grund oder versuche es jetzt noch einmal.</small>
                </div>
                <div className="setting-control">
                  <button type="button" className="secondary-button" disabled={busy !== null || syncState.status === 'syncing'} onClick={() => void run('retry', () => engine.retryFailed())}><RefreshCw className={syncState.status === 'syncing' ? 'spin' : ''} size={14} /> Erneut versuchen</button>
                </div>
              </div>
              <ul className="sync-failed-list" data-i18n-ignore>
                {syncState.failed.slice(0, 50).map((item) => (
                  <li key={item.path}><strong>{item.path}</strong><small>{item.reason}</small></li>
                ))}
                {syncState.failed.length > 50 && <li><small>… und {syncState.failed.length - 50} weitere</small></li>}
              </ul>
            </div>
          )}

          {syncState.openConflicts > 0 && (
            <div id="settings-sync-conflicts" className="setting-card">
              <div className="setting-card-title"><TriangleAlert size={16} /><span>Konflikte</span></div>
              <div className="setting-row">
                <div className="setting-copy">
                  <span>{syncState.openConflicts === 1 ? 'Eine Datei hat zwei Fassungen' : `${syncState.openConflicts} Dateien haben zwei Fassungen`}</span>
                  <small>Beide Fassungen sind gesichert. Vergleiche sie und entscheide, welche auf allen Geräten gilt.</small>
                </div>
                <div className="setting-control">
                  <button type="button" className="secondary-button" onClick={() => onOpenConflicts?.()}>Vergleichen</button>
                </div>
              </div>
            </div>
          )}

          <div id="settings-sync-password" className="setting-card">
            <div className="setting-card-title"><KeyRound size={16} /><span>{deviceKeyAccount ? 'Passwort hinzufügen' : 'Passwort ändern'}</span></div>
            <form className="sync-form" onSubmit={(event) => { event.preventDefault(); submitPassword() }}>
              {!deviceKeyAccount && <label><span>Aktuelles Passwort</span><input data-i18n-ignore type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>}
              <label><span>Neues Passwort</span><input data-i18n-ignore type="password" autoComplete="new-password" required minLength={10} value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} /></label>
              <label><span>Neues Passwort wiederholen</span><input data-i18n-ignore type="password" autoComplete="new-password" required value={nextPasswordRepeat} onChange={(event) => setNextPasswordRepeat(event.target.value)} /></label>
              <div className="sync-form-actions">
                <button type="submit" className="secondary-button" disabled={busy !== null || (!deviceKeyAccount && !currentPassword) || !nextPassword}>{busy === 'password' ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />} {deviceKeyAccount ? 'Passwort hinzufügen' : 'Passwort ändern'}</button>
                <small>{deviceKeyAccount ? 'Danach öffnet das Passwort dein Konto auf jedem Gerät; der Gerätschlüssel wird nicht mehr gebraucht.' : 'Der Vault-Schlüssel wird nur neu verpackt – keine Datei muss neu hochgeladen werden.'}</small>
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
                  : <form className="backup-inline-confirm is-danger" role="alert" onSubmit={(event) => { event.preventDefault(); void run('delete', () => engine.deleteAccount(deviceKeyAccount ? '' : deletePassword), 'Konto und Serverdaten wurden gelöscht.').then((ok) => { if (ok) { setDeleteOpen(false); setDeletePassword('') } }) }}>
                    <span>{deviceKeyAccount ? 'Das Konto und seine Cloud-Daten sind danach unwiderruflich weg.' : 'Zur Bestätigung dein Passwort:'}</span>
                    {!deviceKeyAccount && <input data-i18n-ignore type="password" autoComplete="current-password" required value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} />}
                    <button type="button" className="secondary-button" onClick={() => { setDeleteOpen(false); setDeletePassword('') }}>Abbrechen</button>
                    <button type="submit" className="danger-button" disabled={busy !== null || (!deviceKeyAccount && !deletePassword)}>Endgültig löschen</button>
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
