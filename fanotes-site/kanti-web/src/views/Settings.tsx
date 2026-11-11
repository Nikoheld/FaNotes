import { useState } from 'react'
import { THEME_IDS } from '../lib/palette'
import { permission, requestPermission } from '../lib/notify'
import { useKanti } from '../state'
import { Banner, Button, Card, Dialog, Icon, SectionLabel, Toggle } from '../components/ui'
import { ago } from './common'
import { PairingPanel } from './SignIn'
import type { AlertSettings, Connection } from '../types'

const ALERT_GROUPS: (keyof AlertSettings)[][] = [
  ['gradeNew', 'gradeChanged'],
  ['lessonCancelled', 'lessonChanged'],
  ['examNew', 'examMoved', 'examCancelled', 'examRoom'],
  ['absences', 'deadlines', 'appointmentNew', 'messageNew'],
]

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

  return (
    <div className="view view-settings">
      <div className="columns columns-even">
        <div className="column">
          <SectionLabel>{t.appearance}</SectionLabel>
          <Card className="form">
            <div className="field">
              <span className="field-label">{t.theme}</span>
              <div className="theme-grid" role="radiogroup" aria-label={t.theme}>
                {THEME_IDS.map((id) => (
                  <button type="button" role="radio" aria-checked={prefs.theme === id} key={id} className={`theme-swatch theme-${id}${prefs.theme === id ? ' selected' : ''}`} onClick={() => setPrefs({ theme: id })}>
                    <span className="swatch" aria-hidden="true" />{t.themeNames[id]}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span className="field-label">{t.accent}</span>
              <input type="color" value={prefs.accent} disabled={prefs.theme === 'snow'} onChange={(event) => setPrefs({ accent: event.target.value })} />
            </label>
            <Toggle checked={prefs.snowfall} onChange={(value) => setPrefs({ snowfall: value })} label={t.snowfall} disabled={prefs.theme !== 'snow'} />
            <Toggle checked={prefs.showWeekend} onChange={(value) => setPrefs({ showWeekend: value })} label={kanti.language === 'de' ? 'Wochenende im Stundenplan' : 'Weekend in the timetable'} />
            <Toggle checked={prefs.showMensa} onChange={(value) => setPrefs({ showMensa: value })} label={t.mensaSetting} />
            <label className="field">
              <span className="field-label">{t.language}</span>
              <select value={prefs.language} onChange={(event) => setPrefs({ language: event.target.value as 'auto' | 'de' | 'en' })}>
                <option value="auto">{t.languageAuto}</option>
                <option value="de">Deutsch</option>
                <option value="en">English</option>
              </select>
            </label>
          </Card>

          <SectionLabel>{t.alerts}</SectionLabel>
          <Card className="form">
            <Toggle
              checked={prefs.browserAlerts && browserPermission === 'granted'}
              onChange={toggleBrowserAlerts}
              label={t.browserAlerts}
              detail={browserPermission === 'denied' ? t.browserAlertsBlocked : t.browserAlertsBody}
              disabled={browserPermission === 'unsupported' || browserPermission === 'denied' || demo}
            />
            {linked ? (
              <>
                <p className="muted small">{t.alertsShared}{active ? ` (${active.label})` : ''}</p>
                <Toggle checked={settings.enabled !== false} onChange={(value) => save({ enabled: value })} label={t.alertNames.enabled} />
                {ALERT_GROUPS.map((group) => (
                  <div className="toggle-group" key={group.join()}>
                    {group.map((name) => <Toggle key={name} checked={settings[name] !== false} disabled={settings.enabled === false} onChange={(value) => save({ [name]: value })} label={t.alertNames[name] || name} />)}
                  </div>
                ))}
                <Toggle checked={settings.guessGrades === true} onChange={(value) => save({ guessGrades: value })} label={t.guessGrades} detail={t.guessGradesBody} />
              </>
            ) : null}
            {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
          </Card>
        </div>

        <div className="column">
          <SectionLabel action={demo ? null : <Button tone="outline" icon="plus" onClick={() => setAdding(true)}>{t.addConnection}</Button>}>{t.connections}</SectionLabel>
          <Card className="list">
            {connections.map((connection) => (
              <div key={connection.id} className={`connection-row${connection.id === active?.id ? ' active' : ''}`}>
                <span className={`provider provider-${connection.provider}`} aria-hidden="true">{connection.provider === 'tam' ? 'T' : 'S'}</span>
                <span className="connection-main">
                  <strong>{connection.label}</strong>
                  <small>{[connection.provider === 'tam' ? t.tam : t.schulnetz, connection.source === 'fanotes' ? t.sourceFanotes : connection.source === 'pair' ? t.sourcePair : '', connection.lastPollAt ? t.lastUpdated(ago(connection.lastPollAt, t)) : ''].filter(Boolean).join(' · ')}</small>
                </span>
                {connection.id === active?.id ? <span className="muted small">{t.shown}</span> : <Button tone="quiet" onClick={() => kanti.select(connection.id)}>{t.show}</Button>}
                {demo ? null : (
                  <>
                    <Button tone="quiet" onClick={() => setRenaming(connection)}>{t.rename}</Button>
                    <Button tone="quiet" onClick={() => setRemoving(connection)} aria-label={t.removeHere}><Icon name="close" size={18} /></Button>
                  </>
                )}
              </div>
            ))}
          </Card>

          <SectionLabel>{t.account}</SectionLabel>
          <Card className="form">
            <p className="muted small">{t.privacyNote}</p>
            <div className="link-row">
              <a href="https://fanotes.fasrv.ch/kantiplus/datenschutz/" target="_blank" rel="noopener noreferrer"><Icon name="open" size={16} /> {t.privacy}</a>
              <a href="https://fanotes.fasrv.ch/kantiplus/konto-loeschen/" target="_blank" rel="noopener noreferrer"><Icon name="open" size={16} /> {t.deleteAccount}</a>
            </div>
            {demo ? <Button tone="outline" icon="close" onClick={kanti.endDemo}>{t.demoEnd}</Button> : (
              <>
                <Button tone="danger" icon="logout" onClick={() => kanti.logout()}>{t.signOut}</Button>
                <p className="muted small">{t.signedOutNote}</p>
              </>
            )}
          </Card>
        </div>
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
