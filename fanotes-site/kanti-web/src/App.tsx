import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { allEntries, weekMonday } from './lib/agenda'
import { courseSummaries } from './lib/grades'
import { dateLabel } from './lib/i18n'
import { kantiPalette, paletteVariables } from './lib/palette'
import { search, type Hit } from './lib/search'
import { isTypingTarget, shortcutFor, VIEWS, type View } from './lib/shortcuts'
import { useKanti } from './state'
import { Banner, Button, Dialog, Icon, IconButton, Kbd, Logo, type IconName } from './components/ui'
import { ago } from './views/common'
import { Absences } from './views/Absences'
import { Agenda } from './views/Agenda'
import { Grades } from './views/Grades'
import { Settings } from './views/Settings'
import { SignIn } from './views/SignIn'
import { Timetable } from './views/Timetable'
import { Today } from './views/Today'
import { Updates } from './views/Updates'
import { zurichToday } from '@shared/schulnetz-logic'

const ICONS: Record<View, IconName> = { today: 'today', timetable: 'timetable', grades: 'grades', agenda: 'agenda', absences: 'absences', updates: 'updates', settings: 'settings' }

/** The theme as CSS variables on the root, following the system light/dark switch for "system". */
const useTheme = () => {
  const { prefs } = useKanti()
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(query.matches)
    query?.addEventListener('change', onChange)
    return () => query?.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    const palette = kantiPalette(prefs.theme, systemDark, prefs.accent)
    const root = document.documentElement
    for (const [name, value] of Object.entries(paletteVariables(palette))) root.style.setProperty(name, value)
    root.dataset.theme = palette.id
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `#${palette.background.toString(16).padStart(6, '0')}`)
  }, [prefs.theme, prefs.accent, systemDark])
}

const Onboarding = ({ onDone }: { onDone: () => void }) => {
  const { t } = useKanti()
  const [step, setStep] = useState(0)
  const last = step === t.onboardingTitles.length - 1
  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-label={t.onboardingTitles[step]}>
      <div className="onboarding-card">
        <Logo size={64} />
        <div className="onboarding-dots" aria-hidden="true">{t.onboardingTitles.map((title, index) => <span key={title} className={index === step ? 'on' : ''} />)}</div>
        <h1>{t.onboardingTitles[step]}</h1>
        <p>{t.onboardingBodies[step]}</p>
        {step === 2 ? <p className="muted small"><Kbd>1</Kbd>–<Kbd>7</Kbd> {t.keyNav} · <Kbd>←</Kbd> <Kbd>→</Kbd> {t.keyWeek} · <Kbd>/</Kbd> {t.keySearch} · <Kbd>?</Kbd> {t.keyHelp}</p> : null}
        <div className="onboarding-actions">
          <Button tone="quiet" onClick={onDone}>{t.skip}</Button>
          <Button onClick={() => (last ? onDone() : setStep(step + 1))} autoFocus>{last ? t.start : t.next}</Button>
        </div>
      </div>
    </div>
  )
}

const ShortcutHelp = ({ onClose }: { onClose: () => void }) => {
  const { t } = useKanti()
  const rows: [string[], string][] = [
    [['1', '…', '7'], t.keyNav],
    [['g', 'h / s / n / p / a / m / e'], t.keyNav],
    [['←', '→'], t.keyWeek],
    [['↑', '↓'], t.grades],
    [['t'], t.keyToday],
    [['/'], t.keySearch],
    [['Ctrl', 'K'], t.keySearch],
    [['r'], t.keyRefresh],
    [['c'], t.keyConnection],
    [['?'], t.keyHelp],
    [['Esc'], t.keyEscape],
  ]
  return (
    <Dialog title={t.shortcuts} onClose={onClose}>
      <table className="shortcuts">
        <tbody>{rows.map(([keys, label]) => <tr key={keys.join() + label}><td>{keys.map((key) => (key === '…' ? ' … ' : <Kbd key={key}>{key}</Kbd>))}</td><td>{label}</td></tr>)}</tbody>
      </table>
      <p className="muted small">{VIEWS.map((view, index) => `${index + 1} ${t[view]}`).join(' · ')}</p>
    </Dialog>
  )
}

const CommandPalette = ({ onClose }: { onClose: () => void }) => {
  const kanti = useKanti()
  const { t, data, language } = kanti
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const entries = useMemo(() => allEntries(data.snapshot), [data.snapshot])
  const courses = useMemo(() => courseSummaries(data.snapshot?.grades || []), [data.snapshot])
  const today = zurichToday()
  const hits = useMemo(() => search(query, { entries, courses, snapshot: data.snapshot, today, views: VIEWS.map((view) => ({ id: view, title: t[view] })) }), [query, entries, courses, data.snapshot, today, t])
  const open = (hit: Hit) => {
    onClose()
    if (hit.type === 'view') kanti.navigate(hit.key as View)
    if (hit.type === 'course') kanti.navigate('grades', { fach: hit.key })
    if (hit.type === 'entry') kanti.navigate('timetable', { woche: weekMonday(hit.day), eintrag: hit.key })
    if (hit.type === 'message') kanti.navigate('updates')
  }
  return (
    <div className="backdrop backdrop-top" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t.search}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            placeholder={t.searchPlaceholder}
            onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(Math.min(hits.length - 1, index + 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(Math.max(0, index - 1)) }
              if (event.key === 'Enter' && hits[index]) open(hits[index])
              if (event.key === 'Escape') onClose()
            }}
            aria-label={t.search}
          />
        </div>
        <ul className="palette-results" role="listbox">
          {hits.length ? hits.map((hit, position) => (
            <li key={`${hit.type}:${hit.key}`} role="option" aria-selected={position === index}>
              <button type="button" className={position === index ? 'selected' : ''} onMouseEnter={() => setIndex(position)} onClick={() => open(hit)}>
                <Icon name={hit.type === 'course' ? 'grades' : hit.type === 'entry' ? (hit.kind === 'exam' ? 'agenda' : 'timetable') : hit.type === 'message' ? 'updates' : ICONS[hit.key as View] || 'right'} size={18} />
                <span className="palette-title">{hit.title}</span>
                <span className="palette-detail">{hit.type === 'entry' ? `${dateLabel(hit.day, language)} ${hit.detail}` : hit.detail}</span>
              </button>
            </li>
          )) : <li className="palette-empty">{t.noResults}</li>}
        </ul>
      </div>
    </div>
  )
}

const Sidebar = () => {
  const kanti = useKanti()
  const { t, route, connections, active, data, demo } = kanti
  return (
    <nav className="sidebar" aria-label="Kanti+">
      <div className="brand"><Logo size={34} /><span className="brand-name">Kanti+</span></div>
      {connections.length > 1 ? (
        <label className="connection-switch">
          <span className="sr-only">{t.connections}</span>
          <select value={active?.id || ''} onChange={(event) => kanti.select(event.target.value)}>
            {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
          </select>
        </label>
      ) : active ? <p className="connection-name">{active.label}</p> : null}
      <ul className="nav">
        {VIEWS.map((view, index) => (
          <li key={view}>
            <a
              href={view === 'today' ? '/' : undefined}
              className={route.view === view ? 'active' : ''}
              aria-current={route.view === view ? 'page' : undefined}
              onClick={(event) => { event.preventDefault(); kanti.navigate(view) }}
              role="link"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter') kanti.navigate(view) }}
            >
              <Icon name={ICONS[view]} />
              <span className="nav-label">{t[view]}</span>
              <Kbd>{index + 1}</Kbd>
            </a>
          </li>
        ))}
      </ul>
      <div className="sidebar-foot">
        {demo ? <span className="demo-badge">Demo</span> : data.snapshot?.fetchedAt ? <small className="muted">{t.lastUpdated(ago(data.snapshot.fetchedAt, t))}</small> : null}
      </div>
    </nav>
  )
}

export const App = () => {
  const kanti = useKanti()
  useTheme()
  const { t, route, phase, data, active, demo, prefs } = kanti
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const pending = useRef(false)
  const pendingTimer = useRef(0)

  useEffect(() => { document.documentElement.lang = kanti.language }, [kanti.language])
  useEffect(() => { document.title = phase === 'ready' ? `${t[route.view]} · Kanti+` : 'Kanti+' }, [route.view, phase, t])

  useEffect(() => {
    if (phase !== 'ready') return
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('.backdrop, .onboarding') && event.key !== 'Escape' && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) return
      const action = shortcutFor({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, typing: isTypingTarget(event.target) }, pending.current)
      pending.current = false
      window.clearTimeout(pendingTimer.current)
      if (action === 'g') {
        pending.current = true
        pendingTimer.current = window.setTimeout(() => { pending.current = false }, 1200)
        return
      }
      if (!action) return
      if (action.type === 'escape') { setPalette(false); setHelp(false); return }
      event.preventDefault()
      switch (action.type) {
        case 'view': kanti.navigate(action.view); break
        case 'search': setPalette(true); break
        case 'help': setHelp(true); break
        case 'refresh': void kanti.refresh(); break
        case 'connection': kanti.cycleConnection(); break
        case 'today':
          if (route.view === 'timetable') window.dispatchEvent(new CustomEvent('kanti:action', { detail: 'today' }))
          else kanti.navigate('today')
          break
        default: window.dispatchEvent(new CustomEvent('kanti:action', { detail: action.type }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, kanti, route.view])

  if (phase === 'loading') return <div className="boot"><Logo size={56} /></div>
  if (phase === 'signedOut') {
    return (
      <>
        <SignIn />
        {!prefs.onboarded ? <Onboarding onDone={() => kanti.setPrefs({ onboarded: true })} /> : null}
      </>
    )
  }

  const views: Record<View, ComponentType> = { today: Today, timetable: Timetable, grades: Grades, agenda: Agenda, absences: Absences, updates: Updates, settings: Settings }
  const Current = views[route.view]
  const status = data.status
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{t[route.view]}</h1>
            {active && kanti.connections.length > 1 ? <span className="muted">{active.label}</span> : null}
          </div>
          <button type="button" className="search-box" onClick={() => setPalette(true)}>
            <Icon name="search" size={18} /><span>{t.search}</span><Kbd>/</Kbd>
          </button>
          <div className="topbar-actions">
            {!demo ? <IconButton icon="refresh" label={`${t.refresh} (r)`} onClick={() => void kanti.refresh()} /> : null}
            <IconButton icon="keyboard" label={`${t.shortcuts} (?)`} onClick={() => setHelp(true)} />
          </div>
        </header>
        <div className="banners">
          {demo ? <Banner tone="warning" icon="play" action={<Button tone="outline" onClick={kanti.endDemo}>{t.demoEnd}</Button>}>{t.demoActive}</Banner> : null}
          {kanti.offline ? <Banner tone="warning" icon="warning">{t.offline}</Banner> : null}
          {status?.needsReauth ? <Banner tone="warning" icon="phone">{t.reauth}</Banner> : null}
          {status && !status.linked && !demo ? <Banner icon="info">{t.notLinked}</Banner> : null}
          {data.error && !kanti.offline ? <Banner tone="danger" icon="warning" action={<Button tone="outline" onClick={() => void kanti.refresh()}>{t.tryAgain}</Button>}>{data.error}</Banner> : null}
          {data.snapshot?.readErrors?.length ? <Banner tone="warning" icon="info">{t.readErrors}: {data.snapshot.readErrors.join(' · ')}</Banner> : null}
        </div>
        {data.loading && !data.snapshot ? <div className="loading"><span className="spinner" /></div> : <Current />}
        <footer className="foot">
          <span>{data.snapshot?.fetchedAt ? t.lastUpdated(dateLabel(data.snapshot.fetchedAt.slice(0, 10), kanti.language) + ' ' + new Date(data.snapshot.fetchedAt).toLocaleTimeString(kanti.language === 'de' ? 'de-CH' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' })) : ''}</span>
          <a href="https://fanotes.fasrv.ch/kantiplus/datenschutz/" target="_blank" rel="noopener noreferrer">{t.privacy}</a>
        </footer>
      </main>
      <nav className="bottombar" aria-label="Kanti+">
        {VIEWS.filter((view) => view !== 'absences' && view !== 'updates').map((view) => (
          <button type="button" key={view} className={route.view === view ? 'active' : ''} onClick={() => kanti.navigate(view)} aria-label={t[view]}>
            <Icon name={ICONS[view]} /><span>{t[view]}</span>
          </button>
        ))}
      </nav>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
    </div>
  )
}
