import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { getUiLocale } from '../i18n'
import {
  activateDashboardNote,
  addDashboardCard,
  formatDashboardClock,
  formatDashboardDate,
  formatDashboardLongDate,
  moveDashboardCard,
  parseDashboardLayout,
  removeDashboardCard,
  resizeDashboardCard,
  retargetDashboardCard,
  serializeDashboardLayout,
  type DashboardCard,
  type DashboardCardKind,
  type DashboardLayout,
  type DashboardNote,
  type DashboardSubject,
} from '../lib/dashboardLayout'

const KIND_LABEL: Record<DashboardCardKind, string> = {
  clock: 'Uhr',
  date: 'Datum',
  note: 'Notiz',
  subject: 'Fach',
}

type StartDashboardProps = {
  notes: DashboardNote[]
  subjects: DashboardSubject[]
  time?: Date
  layoutPayload?: unknown
  onOpenNote: (notePath: string) => void
  onLeave: () => void
  onLayoutChange: (payload: string) => void
}

export function StartDashboard({
  notes,
  subjects,
  time,
  layoutPayload,
  onOpenNote,
  onLeave,
  onLayoutChange,
}: StartDashboardProps) {
  const [now, setNow] = useState(() => time ?? new Date())
  const [override, setOverride] = useState<DashboardLayout | null>(null)
  const [seenPayload, setSeenPayload] = useState(layoutPayload)
  if (time && time.getTime() !== now.getTime()) setNow(time)
  if (layoutPayload !== seenPayload) {
    setSeenPayload(layoutPayload)
    setOverride(null)
  }

  useEffect(() => {
    if (time) return undefined
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [time])

  const layout = override ?? parseDashboardLayout(layoutPayload, notes, subjects)
  const clock = formatDashboardClock(now)
  const date = formatDashboardDate(now)
  const longDate = formatDashboardLongDate(now, getUiLocale())
  const boardHeight = Math.max(640, ...layout.cards.map((card) => card.y + card.height + 48), 640)

  const commit = (next: DashboardLayout) => {
    const payload = serializeDashboardLayout(next)
    setSeenPayload(payload)
    setOverride(next)
    onLayoutChange(payload)
  }

  const dragCard = (card: DashboardCard, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const originX = event.clientX
    const originY = event.clientY
    const snapshot = layout
    const move = (pointer: PointerEvent) => {
      commit(moveDashboardCard(snapshot, card.id, card.x + pointer.clientX - originX, card.y + pointer.clientY - originY))
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.setPointerCapture(event.pointerId)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const resizeCard = (card: DashboardCard, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const originX = event.clientX
    const originY = event.clientY
    const snapshot = layout
    const move = (pointer: PointerEvent) => {
      commit(resizeDashboardCard(
        snapshot,
        card.id,
        card.width + pointer.clientX - originX,
        card.height + pointer.clientY - originY,
      ))
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.setPointerCapture(event.pointerId)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  return (
    <main className="dashboard" aria-label="Startfläche">
      <header className="dashboard-top">
        <div className="dashboard-brand">
          <span className="dashboard-mark" aria-hidden="true">F</span>
          <div>
            <h1>Startfläche</h1>
            <p>Ziehe Karten, ändere ihre Größe und wähle Uhr, Datum, Notiz oder Fach.</p>
          </div>
        </div>
        <div className="dashboard-actions">
          <button type="button" className="secondary-button" onClick={() => commit(addDashboardCard(layout, 'note', notes, subjects))}>Karte hinzufügen</button>
          <button type="button" className="primary-button" onClick={onLeave}>Zur letzten Notiz</button>
        </div>
      </header>
      <div className="dashboard-board" style={{ minHeight: boardHeight }}>
        {layout.cards.map((card) => {
          const note = notes.find((entry) => entry.path === card.notePath)
          const subject = subjects.find((entry) => entry.id === card.subjectId)
          const noteTitle = note?.title || ''
          const subjectName = subject?.name || ''
          const accessibleName = card.kind === 'clock'
            ? `Uhr ${clock}`
            : card.kind === 'date'
              ? `Datum ${date}`
              : card.kind === 'note'
                ? `Notiz ${noteTitle}`
                : `Fach ${subjectName}`
          return (
            <article
              key={card.id}
              className="dashboard-card"
              data-kind={card.kind}
              data-card-id={card.id}
              data-x={card.x}
              data-y={card.y}
              data-width={card.width}
              data-height={card.height}
              data-note-path={card.notePath}
              data-subject-id={card.subjectId}
              style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
              aria-label={accessibleName}
            >
              <header className="dashboard-card-bar">
                <button type="button" className="dashboard-card-drag" aria-label="Karte verschieben" onPointerDown={(event) => dragCard(card, event)}>
                  <i aria-hidden="true" />
                  <span>{KIND_LABEL[card.kind]}</span>
                </button>
                <button type="button" className="dashboard-card-remove" aria-label="Karte entfernen" onClick={() => commit(removeDashboardCard(layout, card.id))}>
                  <span aria-hidden="true">×</span>
                </button>
              </header>
              <div className="dashboard-card-body">
                {card.kind === 'clock' && (
                  <div className="dashboard-clock">
                    <p className="dashboard-clock-time">{clock}</p>
                    <small>{date}</small>
                  </div>
                )}
                {card.kind === 'date' && (
                  <div className="dashboard-date">
                    <strong>{now.getDate()}</strong>
                    <p>{longDate}</p>
                    <small className="dashboard-date-value">{date}</small>
                  </div>
                )}
                {card.kind === 'note' && (
                  <div className="dashboard-note">
                    {noteTitle ? <strong data-i18n-ignore>{noteTitle}</strong> : <strong>Noch keine Notiz</strong>}
                    {card.notePath ? <small data-i18n-ignore>{card.notePath}</small> : null}
                    <button type="button" onClick={() => activateDashboardNote(card, onOpenNote)}>Notiz öffnen</button>
                  </div>
                )}
                {card.kind === 'subject' && (
                  <div className="dashboard-subject">
                    <i style={{ background: subject?.color || 'var(--accent)' }} aria-hidden="true" />
                    {subjectName ? <strong data-i18n-ignore>{subjectName}</strong> : <strong>Noch kein Fach</strong>}
                  </div>
                )}
              </div>
              <footer className="dashboard-card-tools">
                <select
                  aria-label="Anzeige ändern"
                  value={card.kind}
                  onChange={(event) => commit(retargetDashboardCard(layout, card.id, {
                    kind: event.target.value as DashboardCardKind,
                    notePath: card.notePath || notes[0]?.path || '',
                    subjectId: card.subjectId || subjects[0]?.id || '',
                  }))}
                >
                  <option value="clock">Uhr</option>
                  <option value="date">Datum</option>
                  <option value="note">Notizkarte</option>
                  <option value="subject">Fachkarte</option>
                </select>
                {card.kind === 'note' && (
                  <select
                    data-i18n-ignore
                    aria-label="Notiz wählen"
                    value={card.notePath}
                    onChange={(event) => commit(retargetDashboardCard(layout, card.id, { kind: 'note', notePath: event.target.value }))}
                  >
                    {notes.map((entry) => <option key={entry.path} value={entry.path}>{entry.title}</option>)}
                  </select>
                )}
                {card.kind === 'subject' && (
                  <select
                    data-i18n-ignore
                    aria-label="Fach wählen"
                    value={card.subjectId}
                    onChange={(event) => commit(retargetDashboardCard(layout, card.id, { kind: 'subject', subjectId: event.target.value }))}
                  >
                    {subjects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </select>
                )}
                <button type="button" className="dashboard-card-resize" aria-label="Kartengröße ändern" onPointerDown={(event) => resizeCard(card, event)} />
              </footer>
            </article>
          )
        })}
      </div>
    </main>
  )
}
