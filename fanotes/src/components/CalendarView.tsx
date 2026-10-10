import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Copy,
  LoaderCircle,
  MapPin,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getUiLanguage } from '../i18n'
import {
  CALENDAR_NOTE_PATH,
  CALENDAR_NOTE_TITLE,
  CALENDAR_VIEWS,
  addDays,
  addMinutes,
  calendarById,
  createCalendar,
  createEvent,
  dateKey,
  deleteEvent,
  duplicateEvent,
  emptyCalendarDocument,
  expandOccurrences,
  healCalendarNames,
  isoWeek,
  layoutDayColumns,
  minutesSinceMidnight,
  moveOccurrence,
  occurrenceOnDay,
  parseCalendarMarkdown,
  parseDateKey,
  parseWall,
  resizeOccurrence,
  sameDay,
  saveOccurrenceEdit,
  searchOccurrences,
  serializeCalendarMarkdown,
  shiftCursor,
  skipOccurrence,
  sliceOnDay,
  snapMinutes,
  startOfDay,
  viewRange,
  wallKey,
  type CalendarDocument,
  type CalendarEvent,
  type CalendarOccurrence,
  type CalendarViewId,
  type RecurrenceFreq,
} from '../lib/calendarModel'

export type CalendarViewProps = {
  reloadToken?: number
  onClose: () => void
  onOpenNote?: (path: string) => void | Promise<unknown>
  onOpenDaily?: (date: Date) => void | Promise<unknown>
}

const HOUR_PX = 48
const SNAP = 15
const COPY = {
  de: {
    aria: 'Kalender',
    title: 'Kalender',
    close: 'Schließen',
    today: 'Heute',
    previous: 'Vorheriger Zeitraum',
    next: 'Nächster Zeitraum',
    search: 'Termine suchen',
    newEvent: 'Neuer Termin',
    calendars: 'Kalender',
    newCalendar: 'Neuer Kalender',
    addCalendar: 'Kalender hinzufügen',
    hide: 'Ausblenden',
    show: 'Einblenden',
    rename: 'Umbenennen',
    removeCalendar: 'Kalender entfernen',
    allDay: 'Ganztägig',
    week: 'KW',
    views: { day: 'Tag', three: '3 Tage', week: 'Woche', month: 'Monat', agenda: 'Agenda' } as Record<CalendarViewId, string>,
    empty: 'Keine Termine in diesem Zeitraum.',
    more: 'weitere',
    untitled: 'Neuer Termin',
    save: 'Speichern',
    cancel: 'Abbrechen',
    duplicate: 'Duplizieren',
    deleteOne: 'Nur diesen löschen',
    deleteSeries: 'Serie löschen',
    location: 'Ort',
    notes: 'Notizen',
    note: 'Notizpfad',
    openNote: 'Notiz öffnen',
    daily: 'Tagesnotiz',
    repeat: 'Wiederholen',
    until: 'Bis',
    start: 'Beginn',
    end: 'Ende',
    calendar: 'Kalender',
    saving: 'Speichert …',
    saved: 'Gespeichert',
    openFile: 'Als Notiz öffnen',
    repeats: { none: 'Nie', daily: 'Täglich', weekly: 'Wöchentlich', monthly: 'Monatlich', yearly: 'Jährlich' } as Record<RecurrenceFreq, string>,
    weekdays: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
  },
  en: {
    aria: 'Calendar',
    title: 'Calendar',
    close: 'Close',
    today: 'Today',
    previous: 'Previous range',
    next: 'Next range',
    search: 'Search events',
    newEvent: 'New event',
    calendars: 'Calendars',
    newCalendar: 'New calendar',
    addCalendar: 'Add calendar',
    hide: 'Hide',
    show: 'Show',
    rename: 'Rename',
    removeCalendar: 'Remove calendar',
    allDay: 'All day',
    week: 'W',
    views: { day: 'Day', three: '3 days', week: 'Week', month: 'Month', agenda: 'Agenda' } as Record<CalendarViewId, string>,
    empty: 'No events in this range.',
    more: 'more',
    untitled: 'New event',
    save: 'Save',
    cancel: 'Cancel',
    duplicate: 'Duplicate',
    deleteOne: 'Delete this one',
    deleteSeries: 'Delete series',
    location: 'Location',
    notes: 'Notes',
    note: 'Note path',
    openNote: 'Open note',
    daily: 'Daily note',
    repeat: 'Repeat',
    until: 'Until',
    start: 'Start',
    end: 'End',
    calendar: 'Calendar',
    saving: 'Saving …',
    saved: 'Saved',
    openFile: 'Open as note',
    repeats: { none: 'Never', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' } as Record<RecurrenceFreq, string>,
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
}

type Copy = (typeof COPY)['de']
type EditorState = { key: string | null, event: CalendarEvent }

const text = (): Copy => (getUiLanguage() === 'en' ? COPY.en : COPY.de)

const locale = () => (getUiLanguage() === 'en' ? 'en' : 'de')

const timeLabel = (date: Date) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date)

const dayLabel = (date: Date, style: 'short' | 'long' = 'short') => (
  new Intl.DateTimeFormat(locale(), { weekday: style === 'long' ? 'long' : 'short', day: 'numeric', month: style === 'long' ? 'long' : 'short' }).format(date)
)

const monthLabel = (date: Date) => new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(date)

const minutesFromPointer = (column: HTMLElement, clientY: number) => {
  const rect = column.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
  const minutes = Math.round((ratio * 24 * 60) / SNAP) * SNAP
  return Math.min(24 * 60 - SNAP, Math.max(0, minutes))
}

const atMinutes = (day: Date, minutes: number) => addMinutes(startOfDay(day), minutes)

export function CalendarView({ reloadToken = 0, onClose, onOpenNote, onOpenDaily }: CalendarViewProps) {
  const copy = text()
  const [document, setDocument] = useState<CalendarDocument>(emptyCalendarDocument)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<CalendarViewId>('week')
  const [cursor, setCursor] = useState(() => startOfDay(new Date()))
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [calendarName, setCalendarName] = useState('')
  const [now, setNow] = useState(() => new Date())
  const persistQueue = useRef(Promise.resolve())
  const persistGeneration = useRef(0)
  const committedDocument = useRef<CalendarDocument>(emptyCalendarDocument())
  const scrollerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    kind: 'create' | 'move' | 'resize'
    pointerId: number
    key?: string
    day: Date
    origin: number
    start: Date
    end: Date
    moved: boolean
  } | null>(null)
  const suppressClick = useRef(false)
  const [draftSpan, setDraftSpan] = useState<{ day: Date, start: Date, end: Date } | null>(null)

  const persist = useCallback(async (next: CalendarDocument) => {
    const healed = healCalendarNames(next, committedDocument.current)
    const generation = ++persistGeneration.current
    const run = async () => {
      if (generation !== persistGeneration.current) return
      setSaving(true)
      setError(null)
      try {
        const markdown = serializeCalendarMarkdown(healed)
        try {
          await window.fanotes.writeFile(CALENDAR_NOTE_PATH, markdown)
        } catch (writeError) {
          const message = writeError instanceof Error ? writeError.message : ''
          if (!/nicht gefunden|ENOENT|no such file/iu.test(message)) throw writeError
          const created = await window.fanotes.createNote('', CALENDAR_NOTE_TITLE)
          await window.fanotes.writeFile(created.relativePath === CALENDAR_NOTE_PATH ? CALENDAR_NOTE_PATH : created.relativePath, markdown)
        }
        if (generation === persistGeneration.current) {
          committedDocument.current = healed
          setDocument(healed)
        }
      } catch (persistError) {
        if (generation === persistGeneration.current) {
          setError(persistError instanceof Error ? persistError.message : 'Kalender konnte nicht gespeichert werden.')
        }
      } finally {
        if (generation === persistGeneration.current) setSaving(false)
      }
    }
    persistQueue.current = persistQueue.current.then(run, run)
    await persistQueue.current
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const markdown = await window.fanotes.readFile(CALENDAR_NOTE_PATH)
        if (!cancelled) {
          const loaded = parseCalendarMarkdown(markdown)
          committedDocument.current = loaded
          setDocument(loaded)
        }
      } catch {
        if (!cancelled) {
          const empty = emptyCalendarDocument()
          committedDocument.current = empty
          setDocument(empty)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [reloadToken])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const node = scrollerRef.current
    if (!node || view === 'month' || view === 'agenda') return
    node.scrollTop = 7 * HOUR_PX
  }, [view])

  const range = useMemo(() => viewRange(view, cursor), [cursor, view])
  const occurrences = useMemo(() => (
    searchOccurrences(expandOccurrences(document, range.start, addDays(range.end, view === 'agenda' ? 14 : 0)), query, document.calendars)
  ), [document, query, range.end, range.start, view])
  const openComposer = useCallback((start: Date, end: Date, allDay = false) => {
    const calendarId = document.calendars.find((calendar) => calendar.visible)?.id ?? document.calendars[0]?.id
    if (!calendarId) return
    const event = createEvent({ calendarId, title: copy.untitled, start, end, allDay })
    setEditor({ key: null, event })
  }, [copy.untitled, document.calendars])

  const openOccurrence = (occurrence: CalendarOccurrence) => {
    const event = occurrence.event.allDay
      ? { ...occurrence.event, start: dateKey(occurrence.start), end: dateKey(addDays(startOfDay(occurrence.end), -1)) }
      : { ...occurrence.event, start: wallKey(occurrence.start), end: wallKey(occurrence.end) }
    setEditor({ key: occurrence.key, event })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'Escape' && editor) {
        event.stopPropagation()
        setEditor(null)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 't') { event.preventDefault(); setCursor(startOfDay(new Date())) }
      else if (key === 'n') { event.preventDefault(); const start = snapMinutes(new Date()); openComposer(start, addMinutes(start, 60)) }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); setCursor((current) => shiftCursor(view, current, -1)) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); setCursor((current) => shiftCursor(view, current, 1)) }
      else if (key === '1') setView('day')
      else if (key === '2') setView('three')
      else if (key === '3') setView('week')
      else if (key === '4') setView('month')
      else if (key === '5') setView('agenda')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, openComposer, view])

  const columnAt = (clientX: number, clientY: number) => {
    const nodes = window.document.elementsFromPoint(clientX, clientY)
    const column = nodes.find((node) => node instanceof HTMLElement && node.classList.contains('cal-day-col'))
    if (!(column instanceof HTMLElement)) return null
    const day = parseDateKey(column.dataset.day ?? '')
    return day ? { column, day } : null
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const hit = columnAt(event.clientX, event.clientY)
      const column = hit?.column ?? null
      const day = hit?.day ?? drag.day
      if (!column) return
      const minutes = minutesFromPointer(column, event.clientY)
      if (drag.kind === 'create') {
        if (Math.abs(minutes - drag.origin) >= SNAP) drag.moved = true
        const startMin = Math.min(drag.origin, minutes)
        const endMin = Math.max(drag.origin + SNAP, Math.min(24 * 60, minutes + SNAP))
        drag.day = day
        drag.start = atMinutes(day, startMin)
        drag.end = atMinutes(day, endMin)
        setDraftSpan({ day, start: drag.start, end: drag.end })
        return
      }
      if (drag.kind === 'move') {
        if (Math.abs(minutes - drag.origin) < SNAP && sameDay(day, drag.day)) return
        drag.moved = true
        const duration = drag.end.getTime() - drag.start.getTime()
        drag.day = day
        drag.start = atMinutes(day, minutes)
        drag.end = new Date(drag.start.getTime() + duration)
        setDraftSpan({ day, start: drag.start, end: drag.end })
        return
      }
      const endMin = Math.max(minutesSinceMidnight(drag.start) + SNAP, minutes)
      if (endMin !== minutesSinceMidnight(drag.end)) drag.moved = true
      drag.end = atMinutes(drag.day, endMin)
      setDraftSpan({ day: drag.day, start: drag.start, end: drag.end })
    }
    const up = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      setDraftSpan(null)
      if (drag.moved) suppressClick.current = true
      if (drag.kind === 'create') {
        const end = drag.end.getTime() <= drag.start.getTime() ? addMinutes(drag.start, 30) : drag.end
        openComposer(drag.start, end)
        return
      }
      if (!drag.moved || !drag.key) return
      if (drag.kind === 'move') void persist(moveOccurrence(document, drag.key, drag.start))
      if (drag.kind === 'resize') void persist(resizeOccurrence(document, drag.key, drag.end))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [document, openComposer, persist])

  const onGridPointerDown = (day: Date, event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.cal-event, .cal-resize')) return
    const startMin = minutesFromPointer(event.currentTarget, event.clientY)
    const start = atMinutes(day, startMin)
    dragRef.current = { kind: 'create', pointerId: event.pointerId, day, origin: startMin, start, end: addMinutes(start, 30), moved: false }
    setDraftSpan({ day, start, end: addMinutes(start, 30) })
  }

  const onEventPointerDown = (occurrence: CalendarOccurrence, day: Date, event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    dragRef.current = {
      kind: 'move',
      pointerId: event.pointerId,
      key: occurrence.key,
      day,
      origin: minutesSinceMidnight(occurrence.start),
      start: occurrence.start,
      end: occurrence.end,
      moved: false,
    }
  }

  const onResizePointerDown = (occurrence: CalendarOccurrence, day: Date, event: React.PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation()
    const slice = sliceOnDay(occurrence, day) ?? occurrence
    dragRef.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      key: occurrence.key,
      day,
      origin: minutesSinceMidnight(slice.end),
      start: occurrence.start,
      end: occurrence.end,
      moved: false,
    }
  }

  const saveEditor = () => {
    if (!editor) return
    const title = editor.event.title.trim() || copy.untitled
    void persist(saveOccurrenceEdit(document, editor.key, { ...editor.event, title }))
    setEditor(null)
  }

  const patchEditor = (patch: Partial<CalendarEvent>) => {
    setEditor((current) => current ? { ...current, event: { ...current.event, ...patch } } : current)
  }

  const heading = view === 'month'
    ? monthLabel(cursor)
    : view === 'day'
      ? dayLabel(cursor, 'long')
      : `${dayLabel(range.days[0])} – ${dayLabel(range.days[range.days.length - 1])}`

  const miniDays = useMemo(() => viewRange('month', cursor).days, [cursor])

  return (
    <section className="cal" aria-label={copy.aria}>
      <aside className="cal-side">
        <div className="cal-side-head">
          <strong>{copy.title}</strong>
          <button type="button" className="cal-icon" aria-label={copy.close} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="cal-mini" aria-label={monthLabel(cursor)}>
          <div className="cal-mini-nav">
            <button type="button" aria-label={copy.previous} onClick={() => setCursor((current) => shiftCursor('month', current, -1))}><ChevronLeft size={14} /></button>
            <span>{monthLabel(cursor)}</span>
            <button type="button" aria-label={copy.next} onClick={() => setCursor((current) => shiftCursor('month', current, 1))}><ChevronRight size={14} /></button>
          </div>
          <div className="cal-mini-week">{copy.weekdays.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="cal-mini-grid">
            {miniDays.map((day) => {
              const count = occurrences.filter((item) => occurrenceOnDay(item, day)).length
              return (
                <button
                  key={dateKey(day)}
                  type="button"
                  className={`${day.getMonth() === cursor.getMonth() ? '' : 'is-out'} ${sameDay(day, cursor) ? 'is-selected' : ''} ${sameDay(day, now) ? 'is-today' : ''}`}
                  onClick={() => setCursor(startOfDay(day))}
                >
                  {day.getDate()}
                  {count > 0 && <i />}
                </button>
              )
            })}
          </div>
        </div>
        <div className="cal-list">
          <span className="cal-kicker">{copy.calendars}</span>
          {document.calendars.map((calendar) => (
            <label key={calendar.id} className="cal-row">
              <input
                type="checkbox"
                checked={calendar.visible}
                aria-label={calendar.visible ? copy.hide : copy.show}
                onChange={() => void persist({
                  ...document,
                  calendars: document.calendars.map((item) => item.id === calendar.id ? { ...item, visible: !item.visible } : item),
                })}
              />
              <i style={{ background: calendar.color }} />
              <input
                aria-label={copy.rename}
                value={calendar.name}
                onChange={(event) => setDocument({
                  ...document,
                  calendars: document.calendars.map((item) => item.id === calendar.id ? { ...item, name: event.target.value } : item),
                })}
                onBlur={(event) => {
                  const name = event.target.value.trim()
                  if (!name) {
                    const restored = committedDocument.current.calendars.find((item) => item.id === calendar.id)?.name ?? ''
                    if (!restored) return
                    setDocument({
                      ...document,
                      calendars: document.calendars.map((item) => item.id === calendar.id ? { ...item, name: restored } : item),
                    })
                    return
                  }
                  void persist({
                    ...document,
                    calendars: document.calendars.map((item) => item.id === calendar.id ? { ...item, name } : item),
                  })
                }}
              />
              {document.calendars.length > 1 && (
                <button
                  type="button"
                  className="cal-icon"
                  aria-label={copy.removeCalendar}
                  onClick={() => void persist({
                    ...document,
                    calendars: document.calendars.filter((item) => item.id !== calendar.id),
                    events: document.events.filter((item) => item.calendarId !== calendar.id),
                  })}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </label>
          ))}
          <form onSubmit={(event) => { event.preventDefault(); if (!calendarName.trim()) return; void persist(createCalendar(document, calendarName)); setCalendarName('') }}>
            <input value={calendarName} onChange={(event) => setCalendarName(event.target.value)} placeholder={copy.newCalendar} aria-label={copy.newCalendar} />
            <button type="submit" className="cal-icon" aria-label={copy.addCalendar}><Plus size={14} /></button>
          </form>
        </div>
        <button type="button" className="cal-file" onClick={() => onOpenNote?.(CALENDAR_NOTE_PATH)}>{copy.openFile}</button>
      </aside>
      <div className="cal-main">
        <header className="cal-toolbar">
          <button type="button" className="cal-today" onClick={() => setCursor(startOfDay(new Date()))}>{copy.today}</button>
          <button type="button" className="cal-icon" aria-label={copy.previous} onClick={() => setCursor((current) => shiftCursor(view, current, -1))}><ChevronLeft size={16} /></button>
          <button type="button" className="cal-icon" aria-label={copy.next} onClick={() => setCursor((current) => shiftCursor(view, current, 1))}><ChevronRight size={16} /></button>
          <h2>{heading}{view === 'week' && <small>{copy.week} {isoWeek(range.days[0])}</small>}</h2>
          <label className="cal-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} aria-label={copy.search} />
          </label>
          <div className="cal-views" role="tablist" aria-label={copy.title}>
            {CALENDAR_VIEWS.map((id) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? 'is-active' : ''} onClick={() => setView(id)}>{copy.views[id]}</button>
            ))}
          </div>
          <button type="button" className="cal-primary" onClick={() => { const start = snapMinutes(new Date()); openComposer(start, addMinutes(start, 60)) }}><Plus size={14} />{copy.newEvent}</button>
        </header>
        {error && <p className="cal-error" role="alert">{error}</p>}
        {loading ? (
          <div className="cal-loading"><LoaderCircle className="spin" size={18} /></div>
        ) : view === 'month' ? (
          <MonthGrid copy={copy} cursor={cursor} days={range.days} now={now} occurrences={occurrences} calendars={document.calendars} onOpen={openOccurrence} onSelectDay={(day) => { setCursor(day); setView('day') }} />
        ) : view === 'agenda' ? (
          <Agenda copy={copy} days={range.days} occurrences={occurrences} calendars={document.calendars} onOpen={openOccurrence} onDaily={onOpenDaily} />
        ) : (
          <div className="cal-grid">
            <div className="cal-dayheads" style={{ gridTemplateColumns: `56px repeat(${range.days.length}, minmax(0, 1fr))` }}>
              <span />
              {range.days.map((day) => (
                <button key={dateKey(day)} type="button" className={sameDay(day, now) ? 'is-today' : ''} onClick={() => { setCursor(day); void onOpenDaily?.(day) }}>
                  <small>{copy.weekdays[(day.getDay() + 6) % 7]}</small>
                  <b>{day.getDate()}</b>
                </button>
              ))}
            </div>
            <div className="cal-allday" style={{ gridTemplateColumns: `56px repeat(${range.days.length}, minmax(0, 1fr))` }}>
              <span>{copy.allDay}</span>
              {range.days.map((day) => (
                <div key={dateKey(day)}>
                  {occurrences.filter((item) => item.event.allDay && occurrenceOnDay(item, day)).map((item) => {
                    const calendar = calendarById(document, item.event.calendarId)
                    return (
                      <button key={item.key} type="button" className="cal-chip" style={chipStyle(calendar?.color)} onClick={() => openOccurrence(item)}>{item.event.title}</button>
                    )
                  })}
                  <button type="button" className="cal-allday-add" aria-label={copy.newEvent} onClick={() => openComposer(day, addDays(day, 1), true)}><Plus size={12} /></button>
                </div>
              ))}
            </div>
            <div className="cal-scroll" ref={scrollerRef}>
              <div className="cal-hours" style={{ gridTemplateColumns: `56px repeat(${range.days.length}, minmax(0, 1fr))` }}>
                <div className="cal-hour-labels">
                  {Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * HOUR_PX }}>{padTime(hour)}</span>)}
                </div>
                {range.days.map((day) => {
                  const slices = layoutDayColumns(occurrences
                    .filter((item) => !item.event.allDay && occurrenceOnDay(item, day))
                    .map((item) => sliceOnDay(item, day))
                    .filter((item): item is CalendarOccurrence => Boolean(item)))
                  const showNow = sameDay(day, now)
                  return (
                    <div
                      key={dateKey(day)}
                      className="cal-day-col"
                      data-day={dateKey(day)}
                      onPointerDown={(event) => onGridPointerDown(day, event)}
                    >
                      {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="cal-hour-line" style={{ top: hour * HOUR_PX }} />)}
                      {showNow && <div className="cal-now" style={{ top: (minutesSinceMidnight(now) / 60) * HOUR_PX }} />}
                      {draftSpan && sameDay(draftSpan.day, day) && (
                        <div className="cal-draft" style={blockStyle(draftSpan.start, draftSpan.end)} />
                      )}
                      {slices.map((slice) => {
                        const calendar = calendarById(document, slice.event.calendarId)
                        return (
                          <button
                            key={slice.key}
                            type="button"
                            className="cal-event"
                            style={{ ...blockStyle(slice.start, slice.end), background: tint(calendar?.color ?? '#7f6df2'), borderColor: calendar?.color, left: `calc(${(slice.column / slice.columns) * 100}% + 2px)`, width: `calc(${100 / slice.columns}% - 4px)` }}
                            onPointerDown={(event) => onEventPointerDown(slice, day, event)}
                            onClick={() => { if (suppressClick.current) { suppressClick.current = false; return } openOccurrence(slice) }}
                          >
                            <b>{slice.event.title}</b>
                            <small>{timeLabel(slice.start)}</small>
                            <span className="cal-resize" onPointerDown={(event) => onResizePointerDown(slice, day, event)} />
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
        {!loading && occurrences.length === 0 && view !== 'month' && <p className="cal-empty">{copy.empty}</p>}
        <p className="cal-status">{saving ? copy.saving : copy.saved}</p>
      </div>
      {editor && (
        <Editor
          copy={copy}
          state={editor}
          calendars={document.calendars}
          onChange={patchEditor}
          onClose={() => setEditor(null)}
          onSave={saveEditor}
          onDuplicate={() => { if (editor.key) { void persist(duplicateEvent(document, editor.event.id)); setEditor(null) } }}
          onDeleteOne={() => { if (editor.key) void persist(skipOccurrence(document, editor.key)); else setEditor(null); setEditor(null) }}
          onDeleteSeries={() => { void persist(deleteEvent(document, editor.event.id)); setEditor(null) }}
          onOpenNote={editor.event.notePath ? () => onOpenNote?.(editor.event.notePath) : undefined}
        />
      )}
    </section>
  )
}

const padTime = (hour: number) => `${String(hour).padStart(2, '0')}:00`

const blockStyle = (start: Date, end: Date): React.CSSProperties => {
  const top = (minutesSinceMidnight(start) / 60) * HOUR_PX
  const height = Math.max(18, ((end.getTime() - start.getTime()) / 3_600_000) * HOUR_PX)
  return { top, height }
}

const inkOn = (hex: string) => {
  const raw = hex.replace('#', '')
  const value = raw.length === 3 ? raw.split('').map((part) => `${part}${part}`).join('') : raw.slice(0, 6)
  const num = Number.parseInt(value, 16)
  if (!Number.isFinite(num) || value.length < 6) return '#ffffff'
  const channels = [16, 8, 0].map((shift) => {
    const channel = ((num >> shift) & 255) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return luminance > 0.42 ? '#191919' : '#ffffff'
}

const chipStyle = (hex?: string): CSSProperties => {
  const background = hex && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? hex : '#2a6f97'
  return { background, color: inkOn(background) }
}

const tint = (hex: string) => {
  const value = hex.replace('#', '')
  const num = Number.parseInt(value, 16)
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, .22)`
}

function MonthGrid({
  copy, cursor, days, now, occurrences, calendars, onOpen, onSelectDay,
}: {
  copy: Copy
  cursor: Date
  days: Date[]
  now: Date
  occurrences: CalendarOccurrence[]
  calendars: CalendarDocument['calendars']
  onOpen: (occurrence: CalendarOccurrence) => void
  onSelectDay: (day: Date) => void
}) {
  return (
    <div className="cal-month">
      <div className="cal-month-week">{copy.weekdays.map((day) => <span key={day}>{day}</span>)}</div>
      <div className="cal-month-grid">
        {days.map((day) => {
          const items = occurrences.filter((item) => occurrenceOnDay(item, day))
          return (
            <div key={dateKey(day)} className={`cal-month-cell ${day.getMonth() === cursor.getMonth() ? '' : 'is-out'} ${sameDay(day, now) ? 'is-today' : ''}`}>
              <button type="button" onClick={() => onSelectDay(startOfDay(day))}>{day.getDate()}</button>
              {items.slice(0, 3).map((item) => {
                const calendar = calendarById({ version: 1, calendars, events: [] }, item.event.calendarId)
                return <button key={item.key} type="button" className="cal-chip" style={chipStyle(calendar?.color)} onClick={() => onOpen(item)}>{item.event.allDay ? item.event.title : `${timeLabel(item.start)} ${item.event.title}`}</button>
              })}
              {items.length > 3 && <em>+{items.length - 3} {copy.more}</em>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Agenda({
  copy, days, occurrences, calendars, onOpen, onDaily,
}: {
  copy: Copy
  days: Date[]
  occurrences: CalendarOccurrence[]
  calendars: CalendarDocument['calendars']
  onOpen: (occurrence: CalendarOccurrence) => void
  onDaily?: (date: Date) => void | Promise<unknown>
}) {
  const groups = days
    .map((day) => ({ day, items: occurrences.filter((item) => occurrenceOnDay(item, day) && dateKey(item.start) === dateKey(day)) }))
    .filter((group) => group.items.length)
  if (!groups.length) return null
  return (
    <div className="cal-agenda">
      {groups.map((group) => (
        <section key={dateKey(group.day)}>
          <header>
            <b>{dayLabel(group.day, 'long')}</b>
            <button type="button" onClick={() => void onDaily?.(group.day)}>{copy.daily}</button>
          </header>
          {group.items.map((item) => {
            const calendar = calendarById({ version: 1, calendars, events: [] }, item.event.calendarId)
            return (
              <button key={item.key} type="button" className="cal-agenda-item" onClick={() => onOpen(item)}>
                <i style={{ background: calendar?.color }} />
                <span>{item.event.allDay ? copy.allDay : `${timeLabel(item.start)} – ${timeLabel(item.end)}`}</span>
                <strong>{item.event.title}</strong>
                {item.event.location && <em><MapPin size={12} />{item.event.location}</em>}
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
}

function Editor({
  copy, state, calendars, onChange, onClose, onSave, onDuplicate, onDeleteOne, onDeleteSeries, onOpenNote,
}: {
  copy: Copy
  state: EditorState
  calendars: CalendarDocument['calendars']
  onChange: (patch: Partial<CalendarEvent>) => void
  onClose: () => void
  onSave: () => void
  onDuplicate: () => void
  onDeleteOne: () => void
  onDeleteSeries: () => void
  onOpenNote?: () => void
}) {
  const event = state.event
  const startDate = event.start.slice(0, 10)
  const endDate = event.end.slice(0, 10)
  const startTime = event.allDay ? '09:00' : event.start.slice(11, 16)
  const endTime = event.allDay ? '10:00' : event.end.slice(11, 16)
  const setWhen = (allDay: boolean, startDay: string, endDay: string, from: string, to: string) => {
    if (allDay) {
      const start = parseDateKey(startDay) ?? new Date()
      const end = parseDateKey(endDay) ?? start
      onChange({ allDay: true, start: dateKey(start), end: dateKey(end < start ? start : end) })
      return
    }
    const start = parseWall(`${startDay}T${from}`) ?? new Date()
    const end = parseWall(`${endDay}T${to}`) ?? addMinutes(start, 30)
    onChange({
      allDay: false,
      start: wallKey(start),
      end: wallKey(end.getTime() <= start.getTime() ? addMinutes(start, 30) : end),
    })
  }
  return (
    <div className="cal-editor-backdrop" onPointerDown={onClose}>
      <form className="cal-editor" onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSave() }}>
        <input className="cal-editor-title" value={event.title} onChange={(input) => onChange({ title: input.target.value })} aria-label={copy.newEvent} autoFocus />
        <label>{copy.calendar}
          <select value={event.calendarId} onChange={(input) => onChange({ calendarId: input.target.value })}>
            {calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </select>
        </label>
        <label className="cal-check"><input type="checkbox" checked={event.allDay} onChange={(input) => setWhen(input.target.checked, startDate, endDate, startTime, endTime)} />{copy.allDay}</label>
        <div className="cal-when">
          <label>{copy.start}<input type="date" value={startDate} onChange={(input) => setWhen(event.allDay, input.target.value, endDate, startTime, endTime)} /></label>
          {!event.allDay && <input aria-label={copy.start} type="time" value={startTime} onChange={(input) => setWhen(false, startDate, endDate, input.target.value, endTime)} />}
          <label>{copy.end}<input type="date" value={endDate} onChange={(input) => setWhen(event.allDay, startDate, input.target.value, startTime, endTime)} /></label>
          {!event.allDay && <input aria-label={copy.end} type="time" value={endTime} onChange={(input) => setWhen(false, startDate, endDate, startTime, input.target.value)} />}
        </div>
        <label>{copy.repeat}
          <select value={event.recurrence} onChange={(input) => onChange({ recurrence: input.target.value as RecurrenceFreq })}>
            {(Object.keys(copy.repeats) as RecurrenceFreq[]).map((id) => <option key={id} value={id}>{copy.repeats[id]}</option>)}
          </select>
        </label>
        {event.recurrence !== 'none' && (
          <label>{copy.until}<input type="date" value={event.recurrenceUntil ?? ''} onChange={(input) => onChange({ recurrenceUntil: input.target.value || null })} /></label>
        )}
        <label>{copy.location}<input value={event.location} onChange={(input) => onChange({ location: input.target.value })} /></label>
        <label>{copy.notes}<textarea value={event.notes} onChange={(input) => onChange({ notes: input.target.value })} rows={3} /></label>
        <label>{copy.note}<input value={event.notePath} onChange={(input) => onChange({ notePath: input.target.value })} placeholder="Schule/Mathe.md" /></label>
        <div className="cal-editor-actions">
          {state.key && <button type="button" onClick={onDuplicate}><Copy size={13} />{copy.duplicate}</button>}
          {onOpenNote && <button type="button" onClick={onOpenNote}><CalendarDays size={13} />{copy.openNote}</button>}
          {state.key && <button type="button" className="is-danger" onClick={onDeleteOne}><Trash2 size={13} />{copy.deleteOne}</button>}
          {state.key && event.recurrence !== 'none' && <button type="button" className="is-danger" onClick={onDeleteSeries}>{copy.deleteSeries}</button>}
          <span />
          <button type="button" onClick={onClose}>{copy.cancel}</button>
          <button type="submit" className="cal-primary">{copy.save}</button>
        </div>
      </form>
    </div>
  )
}
