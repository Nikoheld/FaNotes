import { BarChart3, BookOpenCheck, Cloud, FileText, Flame, GraduationCap, HardDrive, Layers, PenLine, Timer } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { getUiLanguage, getUiLocale } from '../i18n'
import type { SyncPublicState } from '../lib/sync/engine'
import type { AppSettings } from '../types'
import { recordFeature } from '../lib/diagnosticsClient'
import { loadVaultStats, type StatsProgress } from '../lib/vaultStatsLoader'
import type { HeatCell, StatsKind, StatsFileRow, VaultStats } from '../lib/vaultStats.mjs'
import { DiagnosticsCard } from './DiagnosticsCard'
import './statistics.css'

const KIND_LABELS: Array<{ kind: StatsKind; label: string; color: string }> = [
  { kind: 'markdown', label: 'Markdown', color: 'var(--accent-readable)' },
  { kind: 'handwriting', label: 'Handschrift', color: 'var(--stat-2)' },
  { kind: 'pdf', label: 'PDF', color: 'var(--stat-3)' },
  { kind: 'story', label: 'Geschichten', color: 'var(--stat-4)' },
  { kind: 'image', label: 'Bilder', color: 'var(--stat-5)' },
]
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const useFormat = () => {
  const locale = getUiLocale()
  const en = getUiLanguage() === 'en'
  return useMemo(() => {
    const number = new Intl.NumberFormat(locale)
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    return {
      en,
      n: (value: number) => number.format(Math.round(value)),
      bytes: (value: number) => {
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        const exponent = value > 0 ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))) : 0
        return `${new Intl.NumberFormat(locale, { maximumFractionDigits: exponent > 1 ? 1 : 0 }).format(value / 1024 ** exponent)} ${units[exponent]}`
      },
      duration: (ms: number) => {
        const minutes = Math.round(ms / 60_000)
        if (minutes < 60) return `${minutes} min`
        const hours = Math.floor(minutes / 60)
        return `${number.format(hours)} h ${minutes % 60} min`
      },
      date: (value: number | string) => date.format(typeof value === 'string' ? new Date(`${value}T12:00:00`) : new Date(value)),
      dateTime: (value: number | string) => dateTime.format(new Date(value)),
    }
  }, [locale, en])
}

type Fmt = ReturnType<typeof useFormat>

const Tile = ({ icon, value, label, hint }: { icon: React.ReactNode; value: string; label: string; hint?: string }) => (
  <div className="stat-tile">
    <span className="stat-tile-icon" aria-hidden="true">{icon}</span>
    <strong>{value}</strong>
    <small>{label}</small>
    {hint && <em data-i18n-ignore>{hint}</em>}
  </div>
)

const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="stat-skeleton" aria-hidden="true">{Array.from({ length: rows }, (_, index) => <i key={index} />)}</div>
)

const Card = ({ icon, title, children, id }: { icon: React.ReactNode; title: string; children: React.ReactNode; id?: string }) => {
  const headingId = useId()
  return (
    <section id={id} className="setting-card stat-card" aria-labelledby={headingId}><div className="setting-card-title">{icon}<h3 id={headingId}>{title}</h3></div><div className="stat-card-body">{children}</div></section>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="stat-empty">{children}</p>

function Heatmap({ cells, fmt }: { cells: HeatCell[]; fmt: Fmt }) {
  const size = 11
  const gap = 3
  const columns = cells.length / 7
  const months: Array<{ x: number; label: string }> = []
  let lastMonth = -1
  for (let column = 0; column < columns; column += 1) {
    const cell = cells[column * 7]
    const month = Number(cell.date.slice(5, 7))
    if (month !== lastMonth && column < columns - 2) {
      lastMonth = month
      months.push({ x: column * (size + gap), label: new Intl.DateTimeFormat(getUiLocale(), { month: 'short' }).format(new Date(`${cell.date}T12:00:00`)) })
    }
  }
  const total = cells.filter((cell) => !cell.future && cell.count > 0).length
  const perMonth = new Map<string, number>()
  for (const cell of cells) if (!cell.future && cell.count > 0) perMonth.set(cell.date.slice(0, 7), (perMonth.get(cell.date.slice(0, 7)) ?? 0) + 1)
  const monthFormat = new Intl.DateTimeFormat(getUiLocale(), { month: 'long', year: 'numeric' })
  const label = fmt.en ? `Activity calendar of the last year, ${total} active days` : `Aktivitätskalender des letzten Jahres, ${total} aktive Tage`
  return (
    <figure className="stat-heatmap">
      <svg role="img" aria-label={label} viewBox={`0 0 ${columns * (size + gap)} ${7 * (size + gap) + 14}`} preserveAspectRatio="xMinYMin meet">
        {months.map((month) => <text key={month.x} x={month.x} y={9} className="stat-axis" data-i18n-ignore>{month.label}</text>)}
        <g transform="translate(0 14)">
          {cells.map((cell, index) => (
            <rect key={cell.date} x={Math.floor(index / 7) * (size + gap)} y={(index % 7) * (size + gap)} width={size} height={size} rx={2.5} className={`stat-cell level-${cell.level}${cell.future ? ' is-future' : ''}`}>
              {!cell.future && <title>{`${fmt.date(cell.date)}: ${cell.count}${cell.words > 0 ? ` · ${fmt.n(cell.words)} ${fmt.en ? 'words' : 'Wörter'}` : ''}`}</title>}
            </rect>
          ))}
        </g>
      </svg>
      <ul className="sr-only" aria-label={fmt.en ? 'Active days per month' : 'Aktive Tage pro Monat'} data-i18n-ignore>
        {[...perMonth].map(([month, days]) => <li key={month}>{monthFormat.format(new Date(`${month}-15T12:00:00`))}: {days} {fmt.en ? (days === 1 ? 'active day' : 'active days') : (days === 1 ? 'aktiver Tag' : 'aktive Tage')}</li>)}
      </ul>
      <figcaption className="stat-legend" aria-hidden="true"><span>Weniger</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`stat-cell level-${level}`} />)}<span>Mehr</span></figcaption>
    </figure>
  )
}

function Bars({ values, labels, fmtValue, ariaLabel }: { values: number[]; labels: string[]; fmtValue: (value: number) => string; ariaLabel: string }) {
  const max = Math.max(1, ...values)
  return (
    <div className="stat-bars" role="img" aria-label={`${ariaLabel}: ${labels.map((label, index) => `${label} ${fmtValue(values[index])}`).join(', ')}`}>
      {values.map((value, index) => (
        <div key={labels[index]} className="stat-bar-col" title={`${labels[index]}: ${fmtValue(value)}`}>
          <span className="stat-bar" style={{ height: `${Math.max(value > 0 ? 4 : 0, (value / max) * 100)}%` }} />
          <small data-i18n-ignore>{labels[index]}</small>
        </div>
      ))}
    </div>
  )
}

const FileList = ({ rows, fmt, value }: { rows: StatsFileRow[]; fmt: Fmt; value: (row: StatsFileRow) => string }) => (
  rows.length
    ? <ol className="stat-files">{rows.map((row) => <li key={row.path}><span title={row.subject} data-i18n-ignore>{row.name.replace(/\.(?:md|markdown)$/iu, '')}</span><small data-i18n-ignore>{value(row)}</small></li>)}</ol>
    : <Empty>Noch nichts vorhanden.</Empty>
)

export function StatisticsPage({ settings, update, syncState }: {
  settings: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  syncState?: SyncPublicState
}) {
  const fmt = useFormat()
  const [stats, setStats] = useState<VaultStats | null>(null)
  const [progress, setProgress] = useState<StatsProgress | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [force, setForce] = useState(false)

  useEffect(() => { recordFeature('view.statistics') }, [])

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    const host = window.fanotes
    if (!host?.getTree || !host.readFile) { setError('Statistiken sind in dieser Umgebung nicht verfügbar.'); return undefined }
    loadVaultStats(host, controller.signal, (next, step) => { if (!controller.signal.aborted) { setStats(next); setProgress(step) } }, { force })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Statistik konnte nicht gelesen werden.') })
    return () => controller.abort()
  }, [reload]) // eslint-disable-line react-hooks/exhaustive-deps

  const working = progress && progress.phase !== 'done'
  const phaseLabel = progress?.phase === 'history' ? 'Verlauf wird gelesen' : progress?.phase === 'stories' ? 'Geschichten werden gelesen' : 'Notizen werden gelesen'

  return (
    <div className="statistics-page" aria-busy={working ? true : undefined}>
      {error && <p className="conflict-notice is-error" role="alert">{error}</p>}
      {working && (
        <div className="stat-progress" role="status" aria-live="polite">
          <span>{phaseLabel}</span>
          <progress max={Math.max(1, progress.total)} value={progress.done} aria-label={phaseLabel} />
        </div>
      )}
      {progress && <div className="stat-refresh"><button type="button" className="secondary-button" aria-disabled={working ? true : undefined} onClick={() => { if (working) return; setForce(true); setReload((value) => value + 1) }}>Neu berechnen</button></div>}

      <div className="stat-tiles">
        {stats ? (
          <>
            <Tile icon={<FileText size={15} />} value={fmt.n(stats.totals.notes)} label="Notizen" />
            <Tile icon={<HardDrive size={15} />} value={fmt.bytes(stats.totals.bytes)} label="Grösse des Vaults" />
            <Tile icon={<PenLine size={15} />} value={fmt.n(stats.writing.wordsTyped + stats.writing.storyWords)} label="Wörter getippt" />
            <Tile icon={<Flame size={15} />} value={fmt.n(stats.activity.streak.current)} label="Tage in Folge" hint={`${fmt.en ? 'best' : 'Rekord'} ${stats.activity.streak.longest}`} />
            <Tile icon={<Timer size={15} />} value={fmt.duration(stats.time.dwellMs)} label="Zeit in Notizen" />
          </>
        ) : [0, 1, 2, 3, 4].map((index) => <div className="stat-tile" key={index}><Skeleton rows={2} /></div>)}
      </div>

      <Card icon={<Flame size={16} />} title="Aktivität" id="settings-stat-activity">
        {stats ? (
          <>
            <Heatmap cells={stats.activity.cells} fmt={fmt} />
            <div className="stat-two">
              <div>
                <h4>Bearbeitet pro Woche</h4>
                <Bars values={stats.activity.weeks.map((week) => week.edited + week.created)} labels={stats.activity.weeks.map((week) => `${Number(week.start.slice(8))}.${Number(week.start.slice(5, 7))}.`)} fmtValue={fmt.n} ariaLabel={fmt.en ? 'Notes touched per week' : 'Bearbeitete Notizen pro Woche'} />
              </div>
              <dl className="stat-facts">
                <div><dt>Aktive Tage</dt><dd>{fmt.n(stats.activity.streak.activeDays)}</dd></div>
                <div><dt>Längste Serie</dt><dd>{fmt.n(stats.activity.streak.longest)}</dd></div>
                <div><dt>Handschrift-Striche</dt><dd>{fmt.n(stats.writing.strokes)}</dd></div>
                <div><dt>Schreibzeit mit Stift</dt><dd>{fmt.duration(stats.writing.penMs)}</dd></div>
                <div><dt>Wörter in Notizen</dt><dd>{fmt.n(stats.writing.wordsInNotes)}</dd></div>
                <div><dt>Wörter in Geschichten</dt><dd>{fmt.n(stats.writing.storyWords)}</dd></div>
              </dl>
            </div>
          </>
        ) : <Skeleton rows={5} />}
      </Card>

      <Card icon={<Layers size={16} />} title="Vault" id="settings-stat-vault">
        {stats ? (
          <>
            <div className="stat-kinds" role="img" aria-label={`${fmt.en ? 'Notes by type' : 'Notizen nach Art'}: ${KIND_LABELS.map((item) => `${item.label} ${stats.kinds[item.kind].count}`).join(', ')}`}>
              {KIND_LABELS.map((item) => {
                const share = stats.totals.files ? (stats.kinds[item.kind].count / stats.totals.files) * 100 : 0
                return share > 0 ? <span key={item.kind} style={{ width: `${share}%`, background: item.color }} /> : null
              })}
            </div>
            <ul className="stat-kind-list">
              {KIND_LABELS.map((item) => (
                <li key={item.kind}><i style={{ background: item.color }} /><span>{item.label}</span><b>{fmt.n(stats.kinds[item.kind].count)}</b><small>{fmt.bytes(stats.kinds[item.kind].bytes)}</small></li>
              ))}
            </ul>
            <h4>Fächer und Ordner</h4>
            {stats.subjects.length ? (
              <ul className="stat-subjects">
                {stats.subjects.slice(0, 12).map((subject) => (
                  <li key={subject.name}>
                    <i style={{ background: subject.color || 'var(--text-muted)' }} aria-hidden="true" />
                    <span data-i18n-ignore>{subject.name === 'Eingang' ? (fmt.en ? 'Inbox' : 'Eingang') : subject.name}</span>
                    <span className="stat-meter" aria-hidden="true"><span style={{ width: `${(subject.count / stats.subjects[0].count) * 100}%`, background: subject.color || 'var(--accent-readable)' }} /></span>
                    <b>{fmt.n(subject.count)}</b>
                    <small>{fmt.bytes(subject.bytes)}</small>
                  </li>
                ))}
              </ul>
            ) : <Empty>Noch keine Ordner.</Empty>}
            <div className="stat-three">
              <div><h4>Grösste Notizen</h4><FileList rows={stats.largest} fmt={fmt} value={(row) => fmt.bytes(row.size)} /></div>
              <div><h4>Zuletzt bearbeitet</h4><FileList rows={stats.recent} fmt={fmt} value={(row) => fmt.dateTime(row.mtime)} /></div>
              <div><h4>Neueste Notizen</h4><FileList rows={stats.newest} fmt={fmt} value={(row) => fmt.date(row.ctime || row.mtime)} /></div>
            </div>
          </>
        ) : <Skeleton rows={6} />}
      </Card>

      <Card icon={<Timer size={16} />} title="Lernzeit" id="settings-stat-time">
        {stats ? (
          stats.time.notesMeasured ? (
            <div className="stat-two">
              <div>
                <h4>Zeit pro Wochentag</h4>
                <Bars values={WEEKDAY_ORDER.map((day) => stats.time.byWeekday[day])} labels={WEEKDAY_ORDER.map((day) => WEEKDAYS[day])} fmtValue={fmt.duration} ariaLabel={fmt.en ? 'Time per weekday' : 'Zeit pro Wochentag'} />
              </div>
              <div>
                <h4>Zeit pro Fach</h4>
                <ul className="stat-subjects">
                  {stats.time.bySubject.map((subject) => (
                    <li key={subject.name}><i style={{ background: subject.color || 'var(--text-muted)' }} aria-hidden="true" /><span data-i18n-ignore>{subject.name}</span><span className="stat-meter" aria-hidden="true"><span style={{ width: `${(subject.dwellMs / stats.time.bySubject[0].dwellMs) * 100}%`, background: subject.color || 'var(--accent-readable)' }} /></span><small>{fmt.duration(subject.dwellMs)}</small></li>
                  ))}
                </ul>
              </div>
            </div>
          ) : <Empty>Die Zeit wird pro Notiz auf diesem Gerät mitgezählt, sobald du Notizen öffnest.</Empty>
        ) : <Skeleton rows={3} />}
      </Card>

      <Card icon={<GraduationCap size={16} />} title="Schule" id="settings-stat-school">
        {stats ? (
          <>
            {stats.school ? (
              <>
                <div className="stat-tiles small">
                  <Tile icon={<BookOpenCheck size={14} />} value={fmt.n(stats.school.done)} label="Hausaufgaben erledigt" />
                  <Tile icon={<BookOpenCheck size={14} />} value={fmt.n(stats.school.open)} label="Hausaufgaben offen" />
                  <Tile icon={<BookOpenCheck size={14} />} value={fmt.n(stats.school.overdue)} label="Überfällig" />
                </div>
                {stats.school.bySubject.length > 0 && (
                  <ul className="stat-subjects">
                    {stats.school.bySubject.slice(0, 10).map((row) => (
                      <li key={row.name} title={`${row.done} / ${row.open} / ${row.overdue}`}>
                        <span data-i18n-ignore>{row.name === 'Ohne Fach' ? (fmt.en ? 'No subject' : 'Ohne Fach') : row.name}</span>
                        <span className="stat-meter stacked" role="img" aria-label={fmt.en ? `${row.done} done, ${row.open} open, ${row.overdue} overdue` : `${row.done} erledigt, ${row.open} offen, ${row.overdue} überfällig`}>
                          {row.done > 0 && <span className="done" style={{ flexGrow: row.done }} />}{row.open - row.overdue > 0 && <span className="open" style={{ flexGrow: row.open - row.overdue }} />}{row.overdue > 0 && <span className="late" style={{ flexGrow: row.overdue }} />}
                        </span>
                        <b>{row.done}/{row.done + row.open}</b>
                      </li>
                    ))}
                  </ul>
                )}
                {stats.school.bySubject.length > 0 && (
                  <p className="stat-meter-key" aria-hidden="true" data-i18n-ignore>
                    <span className="done"><i />{fmt.en ? 'Done' : 'Erledigt'}</span>
                    <span className="open"><i />{fmt.en ? 'Open' : 'Offen'}</span>
                    <span className="late"><i />{fmt.en ? 'Overdue' : 'Überfällig'}</span>
                  </p>
                )}
                <h4>Anstehende Termine und Prüfungen</h4>
                {stats.school.upcoming.length ? (
                  <ol className="stat-files">{stats.school.upcoming.map((item, index) => <li key={index}><span data-i18n-ignore>{item.exam ? '★ ' : ''}{item.title}</span><small data-i18n-ignore>{fmt.date(item.date)}{item.time ? ` · ${item.time}` : ''}</small></li>)}</ol>
                ) : <Empty>Keine anstehenden Termine.</Empty>}
              </>
            ) : <Empty>Noch keine Hausaufgaben angelegt.</Empty>}
            <h4>Karteikarten</h4>
            {stats.cards.total ? (
              <div className="stat-tiles small">
                <Tile icon={<Layers size={14} />} value={fmt.n(stats.cards.total)} label="Karten" />
                <Tile icon={<Layers size={14} />} value={fmt.n(stats.cards.due)} label="Heute fällig" />
                <Tile icon={<Layers size={14} />} value={fmt.n(stats.cards.reviewed)} label="Schon geübt" />
                <Tile icon={<Layers size={14} />} value={stats.cards.retention === null ? '–' : `${Math.round(stats.cards.retention * 100)} %`} label="Behaltensquote" />
              </div>
            ) : <Empty>Noch keine Karteikarten. Sie entstehen aus den Lernfragen einer Notiz.</Empty>}
          </>
        ) : <Skeleton rows={4} />}
      </Card>

      <Card icon={<Cloud size={16} />} title="Sync" id="settings-stat-sync">
        {syncState && syncState.status !== 'unavailable' && syncState.status !== 'signed-out' ? (
          <dl className="stat-facts wide">
            <div><dt>Letzte Synchronisierung</dt><dd data-i18n-ignore>{syncState.lastSyncAt ? fmt.dateTime(syncState.lastSyncAt) : '–'}</dd></div>
            <div><dt>Verfolgte Dateien</dt><dd>{fmt.n(syncState.trackedFiles)}</dd></div>
            <div><dt>Wartet auf Upload</dt><dd>{fmt.n(syncState.pendingLocal)}</dd></div>
            <div><dt>Offene Konflikte</dt><dd>{fmt.n(syncState.openConflicts)}</dd></div>
            <div><dt>Konflikte dieser Sitzung</dt><dd>{fmt.n(syncState.conflicts.length)}</dd></div>
            {syncState.info && <div><dt>Belegt auf dem Server</dt><dd data-i18n-ignore>{fmt.bytes(syncState.info.usage.bytes)} / {fmt.bytes(syncState.info.usage.quotaBytes)}</dd></div>}
            {syncState.info && <div><dt>Geräte</dt><dd data-i18n-ignore>{syncState.info.devices.map((device) => device.name).join(', ') || '–'}</dd></div>}
          </dl>
        ) : <Empty>Sync ist nicht eingerichtet. Melde dich unter Sync an, um hier den Stand zu sehen.</Empty>}
      </Card>

      <DiagnosticsCard settings={settings} update={update} />
    </div>
  )
}

export const StatisticsIcon = BarChart3
