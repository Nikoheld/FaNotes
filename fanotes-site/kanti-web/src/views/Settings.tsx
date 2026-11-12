import { useState, type CSSProperties, type ReactNode } from 'react'
import { THEME_IDS, hex, kantiPalette, type KantiPalette } from '../lib/palette'
import { permission, requestPermission } from '../lib/notify'
import { useKanti } from '../state'
import { Banner, Button, Card, Dialog, Icon, Tag, Toggle } from '../components/ui'
import { ago } from './common'
import { PairingPanel } from './SignIn'
import type { AlertSettings, Connection } from '../types'

const ALERT_GROUPS: (keyof AlertSettings)[][] = [
  ['gradeNew', 'gradeChanged'],
  ['lessonCancelled', 'lessonChanged'],
  ['examNew', 'examMoved', 'examCancelled', 'examRoom'],
  ['absences', 'deadlines', 'appointmentNew', 'messageNew'],
]

const COMMUTE_ALERTS: (keyof AlertSettings)[] = ['commuteDelay', 'commuteCancelled', 'commuteLessonEnd']

export const Settings = () => {
  const kanti = useKanti()
  const { t, prefs, setPrefs, data, demo, connections, active } = kanti
  const [browserPermission, setBrowserPermission] = useState(permission())
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<Connection | null>(null)
  const [removing, setRemoving] = useState<Connection | null>(null)
  const [error, setError] = useState('')
  const settings = data.status?.settings || {}
  const linked = data.status?.linked === true && !demo
  const save = async (patch: Partial<AlertSettings>) => {
    setError('')
    try { await kanti.saveSettings(patch) } catch (failure) { setError(failure instanceof Error ? failure.message : t.error) }
  }
  const toggleBrowserAlerts = async (on: boolean) => {
    if (!on) { setPrefs({ browserAlerts: false }); return }
    const result = await requestPermission()
    setBrowserPermission(result)
    setPrefs({ browserAlerts: result === 'granted' })
  }

  const systemDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  const appearance = (
      <Group title={t.appearance} body={t.appearanceBody}>
        <div className="setting-block">
          <span className="field-label" id="theme-label">{t.theme}</span>
          <div className="theme-grid" role="radiogroup" aria-labelledby="theme-label">
            {THEME_IDS.map((id) => (
              <button type="button" role="radio" aria-checked={prefs.theme === id} key={id} className={`theme-swatch theme-${id}${prefs.theme === id ? ' selected' : ''}`} onClick={() => setPrefs({ theme: id })}>
                <ThemePreview id={id} accent={prefs.accent} systemDark={systemDark} />
                <span className="theme-name">{t.themeNames[id]}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="setting-row">
          <span className="setting-text">{t.accent}</span>
          <span className="accent-control"><span className="tabular accent-hex">{prefs.accent.toUpperCase()}</span><input type="color" value={prefs.accent} disabled={prefs.theme === 'snow'} onChange={(event) => setPrefs({ accent: event.target.value })} /></span>
        </label>
        <Toggle checked={prefs.snowfall} onChange={(value) => setPrefs({ snowfall: value })} label={t.snowfall} disabled={prefs.theme !== 'snow'} />
        <Toggle checked={prefs.showWeekend} onChange={(value) => setPrefs({ showWeekend: value })} label={kanti.language === 'de' ? 'Wochenende im Stundenplan' : 'Weekend in the timetable'} />
        <Toggle checked={prefs.showMensa} onChange={(value) => setPrefs({ showMensa: value })} label={t.mensaSetting} />
        <label className="setting-row">
          <span className="setting-text">{t.language}</span>
          <select value={prefs.language} onChange={(event) => setPrefs({ language: event.target.value as 'auto' | 'de' | 'en' })}>
            <option value="auto">{t.languageAuto}</option>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </label>
      </Group>
  )
  const alertGroup = (
      <Group title={t.alerts} body={t.alertsBody}>
        <Toggle
          checked={prefs.browserAlerts && browserPermission === 'granted'}
          onChange={toggleBrowserAlerts}
          label={t.browserAlerts}
          detail={browserPermission === 'denied' ? t.browserAlertsBlocked : t.browserAlertsBody}
          disabled={browserPermission === 'unsupported' || browserPermission === 'denied' || demo}
        />
        {linked ? (
          <>
            <p className="settings-note"><Icon name="info" size={16} />{t.alertsShared}{active ? ` (${active.label})` : ''}</p>
            <Toggle checked={settings.enabled !== false} onChange={(value) => save({ enabled: value })} label={t.alertNames.enabled} />
            {ALERT_GROUPS.map((group) => (
              <div className="toggle-group" key={group.join()}>
                {group.map((name) => <Toggle key={name} checked={settings[name] !== false} disabled={settings.enabled === false} onChange={(value) => save({ [name]: value })} label={t.alertNames[name] || name} />)}
              </div>
            ))}
            <div className="toggle-group">
              <p className="toggle-heading">{t.commuteSettingsGroup}</p>
              <Toggle checked={settings.commute !== false} onChange={(value) => save({ commute: value })} label={t.alertNames.commute} detail={t.commuteSettingsBody} />
              {COMMUTE_ALERTS.map((name) => <Toggle key={name} checked={settings[name] !== false} disabled={settings.commute === false} onChange={(value) => save({ [name]: value })} label={t.alertNames[name] || name} />)}
            </div>
            <Toggle checked={settings.guessGrades === true} onChange={(value) => save({ guessGrades: value })} label={t.guessGrades} detail={t.guessGradesBody} />
          </>
        ) : null}
        {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
      </Group>
  )
  const connectionGroup = (
      <Group title={t.connections} body={t.connectionsBody} action={demo ? null : <Button tone="outline" icon="plus" onClick={() => setAdding(true)}>{t.addConnection}</Button>} flush>
        {connections.map((connection) => (
          <div key={connection.id} className={`connection-row${connection.id === active?.id ? ' active' : ''}`}>
            <span className={`provider provider-${connection.provider}`} aria-hidden="true">{connection.provider === 'tam' ? 'T' : 'S'}</span>
            <span className="connection-main">
              <strong>{connection.label}</strong>
              <small>{[connection.provider === 'tam' ? t.tam : t.schulnetz, connection.source === 'fanotes' ? t.sourceFanotes : connection.source === 'pair' ? t.sourcePair : '', connection.lastPollAt ? t.lastUpdated(ago(connection.lastPollAt, t)) : ''].filter(Boolean).join(' · ')}</small>
            </span>
            <span className="connection-actions">
              {connection.id === active?.id ? <Tag tone="success"><span className="cap">{t.shown}</span></Tag> : <Button tone="quiet" className="button-small" onClick={() => kanti.select(connection.id)}>{t.show}</Button>}
              {demo ? null : (
                <>
                  <Button tone="quiet" className="button-small" onClick={() => setRenaming(connection)}>{t.rename}</Button>
                  <Button tone="quiet" className="button-small" onClick={() => setRemoving(connection)} aria-label={t.removeHere}><Icon name="close" size={18} /></Button>
                </>
              )}
            </span>
          </div>
        ))}
      </Group>
  )
  const accountGroup = (
      <Group title={t.account} body={t.accountBody}>
        <p className="settings-note"><Icon name="info" size={16} />{t.privacyNote}</p>
        <div className="link-list">
          <a href="https://fanotes.fasrv.ch/kantiplus/datenschutz/" target="_blank" rel="noopener noreferrer"><Icon name="open" size={18} /><span>{t.privacy}</span></a>
          <a href="https://fanotes.fasrv.ch/kantiplus/konto-loeschen/" target="_blank" rel="noopener noreferrer"><Icon name="open" size={18} /><span>{t.deleteAccount}</span></a>
        </div>
        <div className="signout">
          {demo ? <Button tone="outline" icon="close" onClick={kanti.endDemo}>{t.demoEnd}</Button> : (
            <>
              <Button tone="danger" icon="logout" onClick={() => kanti.logout()}>{t.signOut}</Button>
              <p className="muted small">{t.signedOutNote}</p>
            </>
          )}
        </div>
      </Group>
  )
  return (
    <div className="view view-settings">
      <div className="columns columns-even">
        {/* A linked account has a long list of alerts: they get a column of their own, the rest balance it. */}
        <div className="column">{appearance}{linked ? <>{connectionGroup}{accountGroup}</> : null}</div>
        <div className="column">{linked ? alertGroup : <>{connectionGroup}{alertGroup}{accountGroup}</>}</div>
      </div>

      {adding ? <Dialog title={t.addConnection} onClose={() => setAdding(false)} wide><PairingPanel onDone={async () => { setAdding(false); await kanti.start() }} /></Dialog> : null}
      {renaming ? <RenameDialog connection={renaming} onClose={() => setRenaming(null)} /> : null}
      {removing ? (
        <Dialog title={t.removeHere} onClose={() => setRemoving(null)}>
          <p>{t.removeConfirm(removing.label)}</p>
          <div className="dialog-actions">
            <Button tone="quiet" onClick={() => setRemoving(null)}>{t.cancel}</Button>
            <Button tone="danger" onClick={async () => { const target = removing; setRemoving(null); await kanti.remove(target.id) }}>{t.removeHere}</Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

/** A titled group of settings: heading and one-line description above a single card. */
const Group = ({ title, body, action, flush = false, children }: { title: string; body: string; action?: ReactNode; flush?: boolean; children: ReactNode }) => (
  <section className="settings-group">
    <header className="settings-head">
      <div><h2>{title}</h2><p>{body}</p></div>
      {action}
    </header>
    <Card className={`settings-card${flush ? ' flush' : ''}`}>{children}</Card>
  </section>
)

/** A miniature window painted with a theme's own colours (from the palette, not hard-coded). */
const MiniWindow = ({ palette, half = false }: { palette: KantiPalette; half?: boolean }) => (
  <span
    className={`mini${half ? ' mini-half' : ''}`}
    style={{ '--m-bg': hex(palette.background), '--m-surface': hex(palette.surface), '--m-sunken': hex(palette.sunken), '--m-hair': hex(palette.hairline), '--m-text': hex(palette.muted), '--m-accent': hex(palette.accent), '--m-ok': hex(palette.success) } as CSSProperties}
  >
    <span className="mini-side"><i /><i /><i /></span>
    <span className="mini-body"><span className="mini-card"><b /><b /></span><span className="mini-card mini-card-short"><b /></span><span className="mini-accent" /></span>
  </span>
)

const ThemePreview = ({ id, accent, systemDark }: { id: string; accent: string; systemDark: boolean }) => (
  <span className="theme-preview" aria-hidden="true">
    {id === 'system' ? (
      <>
        <MiniWindow palette={kantiPalette('light', false, accent)} />
        <MiniWindow palette={kantiPalette('dark', true, accent)} half />
      </>
    ) : <MiniWindow palette={kantiPalette(id, systemDark, accent)} />}
  </span>
)

const RenameDialog = ({ connection, onClose }: { connection: Connection; onClose: () => void }) => {
  const kanti = useKanti()
  const [label, setLabel] = useState(connection.label)
  return (
    <Dialog title={kanti.t.rename} onClose={onClose}>
      <form className="form" onSubmit={async (event) => { event.preventDefault(); await kanti.rename(connection.id, label); onClose() }}>
        <label className="field"><span className="field-label">{kanti.t.title}</span><input value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} autoFocus /></label>
        <div className="dialog-actions"><Button tone="quiet" onClick={onClose}>{kanti.t.cancel}</Button><Button type="submit">{kanti.t.save}</Button></div>
      </form>
    </Dialog>
  )
}
