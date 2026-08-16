import {
  AlarmClock,
  BookOpen,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  ClipboardList,
  LoaderCircle,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  classifyHomeworkTask,
  createHomeworkTask,
  HOMEWORK_NOTE_PATH,
  HOMEWORK_NOTE_TITLE,
  parseHomeworkMarkdown,
  serializeHomeworkMarkdown,
  sortHomeworkTasks,
  type HomeworkBucket,
  type HomeworkDocument,
  type HomeworkKind,
  type HomeworkTask,
} from '../lib/homeworkStore'
import { getUiLanguage } from '../i18n'

export type HomeworkBoardProps = {
  subjects: string[]
  onClose: () => void
  onOpenNote?: (path: string) => void | Promise<void>
  onDocumentPersisted?: (document: HomeworkDocument) => void
}

const HOMEWORK_COPY = {
  de: {
    aria: 'Hausaufgaben und Termine',
    eyebrow: 'Schule & Organisation',
    title: 'Hausaufgaben & Termine',
    intro: 'Trage Hausaufgaben und Termine mit Fälligkeit ein. Alles bleibt lokal in deinem Vault unter',
    openNote: 'Als Notiz öffnen',
    close: 'Schließen',
    openStat: 'offen',
    overdueStat: 'überfällig',
    todayStat: 'heute',
    appointmentsStat: 'Termine',
    doneStat: 'erledigt',
    saving: 'Speichert …',
    taskLabel: 'Aufgabe / Termin',
    taskPlaceholder: 'z. B. Mathe S. 42, Nr. 3–5 oder Elternabend',
    kind: 'Art',
    homework: 'Hausaufgabe',
    appointment: 'Termin',
    subject: 'Fach',
    subjectPlaceholder: 'Mathematik',
    date: 'Datum',
    time: 'Uhrzeit',
    priority: 'Priorität',
    normal: 'Normal',
    high: 'Wichtig',
    notes: 'Notizen',
    notesPlaceholder: 'Optional: Seite, Heft, Mitbringsel …',
    add: 'Eintrag hinzufügen',
    views: 'Darstellung',
    list: 'Liste',
    week: 'Woche',
    month: 'Monat',
    filters: 'Filter',
    filterOpen: 'Offen',
    filterHomework: 'Hausaufgaben',
    filterAppointments: 'Termine',
    filterDone: 'Erledigt',
    filterAll: 'Alle',
    previous: 'Vorheriger Zeitraum',
    next: 'Nächster Zeitraum',
    today: 'Heute',
    weekPrefix: 'Woche',
    loading: 'Hausaufgaben werden geladen …',
    emptyTitle: 'Noch keine Einträge',
    emptyBody: 'Lege deine erste Hausaufgabe oder den nächsten Termin oben an.',
    overdue: 'Überfällig',
    upcoming: 'Demnächst',
    undated: 'Ohne Termin',
    done: 'Erledigt',
    noDate: 'Kein Termin',
    markOpen: 'Als offen markieren',
    markDone: 'Als erledigt markieren',
    deleteEntry: 'Eintrag löschen',
    collapse: 'einklappen',
    expand: 'anzeigen',
    saveError: 'Hausaufgaben konnten nicht gespeichert werden.',
    loadError: 'Hausaufgaben konnten nicht geladen werden.',
  },
  en: {
    aria: 'Homework and appointments',
    eyebrow: 'School & organisation',
    title: 'Homework & appointments',
    intro: 'Add homework and appointments with due dates. Everything stays local in your vault under',
    openNote: 'Open as note',
    close: 'Close',
    openStat: 'open',
    overdueStat: 'overdue',
    todayStat: 'today',
    appointmentsStat: 'appointments',
    doneStat: 'done',
    saving: 'Saving…',
    taskLabel: 'Task / appointment',
    taskPlaceholder: 'e.g. Maths p. 42, nos. 3–5 or parents’ evening',
    kind: 'Type',
    homework: 'Homework',
    appointment: 'Appointment',
    subject: 'Subject',
    subjectPlaceholder: 'Mathematics',
    date: 'Date',
    time: 'Time',
    priority: 'Priority',
    normal: 'Normal',
    high: 'Important',
    notes: 'Notes',
    notesPlaceholder: 'Optional: page, notebook, things to bring…',
    add: 'Add entry',
    views: 'View',
    list: 'List',
    week: 'Week',
    month: 'Month',
    filters: 'Filter',
    filterOpen: 'Open',
    filterHomework: 'Homework',
    filterAppointments: 'Appointments',
    filterDone: 'Done',
    filterAll: 'All',
    previous: 'Previous period',
    next: 'Next period',
    today: 'Today',
    weekPrefix: 'Week',
    loading: 'Loading homework…',
    emptyTitle: 'No entries yet',
    emptyBody: 'Add your first homework or next appointment above.',
    overdue: 'Overdue',
    upcoming: 'Upcoming',
    undated: 'No date',
    done: 'Done',
    noDate: 'No date',
    markOpen: 'Mark as open',
    markDone: 'Mark as done',
    deleteEntry: 'Delete entry',
    collapse: 'collapse',
    expand: 'show',
    saveError: 'Homework could not be saved.',
    loadError: 'Homework could not be loaded.',
  },
} as const

const homeworkText = () => HOMEWORK_COPY[getUiLanguage()]

const bucketLabel = (bucket: HomeworkBucket) => {
  const copy = homeworkText()
  return {
    overdue: copy.overdue,
    today: copy.today,
    upcoming: copy.upcoming,
    undated: copy.undated,
    done: copy.done,
  }[bucket]
}

const homeworkLocale = () => (getUiLanguage() === 'en' ? 'en-GB' : 'de-CH')

const startOfMondayWeek = (date: Date) => {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return start
}

const mondayWeekdayLabels = () => {
  const monday = startOfMondayWeek(new Date())
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday)
    day.setDate(monday.getDate() + index)
    return new Intl.DateTimeFormat(homeworkLocale(), { weekday: 'short' })
      .format(day)
      .replace(/\.$/u, '')
  })
}

const dateFormatter = () => new Intl.DateTimeFormat(homeworkLocale(), {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
})

const formatDue = (task: HomeworkTask) => {
  if (!task.dueDate) return homeworkText().noDate
  const label = dateFormatter().format(new Date(`${task.dueDate}T12:00:00`))
  return task.dueTime ? `${label} · ${task.dueTime}` : label
}

export function HomeworkBoard({ subjects, onClose, onOpenNote, onDocumentPersisted }: HomeworkBoardProps) {
  const [document, setDocument] = useState<HomeworkDocument>({ version: 1, tasks: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'open' | 'homework' | 'appointment' | 'done' | 'all'>('open')
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [kind, setKind] = useState<HomeworkKind>('homework')
  const [priority, setPriority] = useState<'normal' | 'high'>('normal')
  const [notes, setNotes] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [plannerView, setPlannerView] = useState<'list' | 'week' | 'month'>('list')
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  })
  const persistQueueRef = useRef(Promise.resolve())
  const persistGenerationRef = useRef(0)

  const persist = useCallback(async (next: HomeworkDocument) => {
    const generation = ++persistGenerationRef.current
    const run = async () => {
      if (generation !== persistGenerationRef.current) return
      setSaving(true)
      setError(null)
      try {
        const markdown = serializeHomeworkMarkdown(next)
        try {
          await window.fanotes.writeFile(HOMEWORK_NOTE_PATH, markdown)
        } catch (writeError) {
          const message = writeError instanceof Error ? writeError.message : ''
          if (!/nicht gefunden|ENOENT|no such file/iu.test(message)) throw writeError
          const created = await window.fanotes.createNote('', HOMEWORK_NOTE_TITLE)
          if (created.relativePath !== HOMEWORK_NOTE_PATH) {
            await window.fanotes.writeFile(created.relativePath, markdown)
          } else {
            await window.fanotes.writeFile(HOMEWORK_NOTE_PATH, markdown)
          }
        }
        if (generation === persistGenerationRef.current) {
          setDocument(next)
          onDocumentPersisted?.(next)
        }
      } catch (persistError) {
        if (generation === persistGenerationRef.current) {
          setError(persistError instanceof Error ? persistError.message : homeworkText().saveError)
        }
      } finally {
        if (generation === persistGenerationRef.current) setSaving(false)
      }
    }
    persistQueueRef.current = persistQueueRef.current.then(run, run)
    await persistQueueRef.current
  }, [onDocumentPersisted])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        try {
          const markdown = await window.fanotes.readFile(HOMEWORK_NOTE_PATH)
          if (!cancelled) setDocument(parseHomeworkMarkdown(markdown))
        } catch {
          if (!cancelled) setDocument({ version: 1, tasks: [] })
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : homeworkText().loadError)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const tasks = useMemo(() => sortHomeworkTasks(document.tasks), [document.tasks])

  const visibleTasks = useMemo(() => tasks.filter((task) => {
    if (filter === 'all') return true
    if (filter === 'open') return !task.done
    if (filter === 'done') return task.done
    if (filter === 'homework') return !task.done && task.kind === 'homework'
    return !task.done && task.kind === 'appointment'
  }), [filter, tasks])

  const buckets = useMemo(() => {
    const groups: Record<HomeworkBucket, HomeworkTask[]> = {
      overdue: [],
      today: [],
      upcoming: [],
      undated: [],
      done: [],
    }
    for (const task of visibleTasks) {
      groups[classifyHomeworkTask(task)].push(task)
    }
    return groups
  }, [visibleTasks])

  const stats = useMemo(() => {
    const open = tasks.filter((task) => !task.done)
    const overdue = open.filter((task) => classifyHomeworkTask(task) === 'overdue').length
    const today = open.filter((task) => classifyHomeworkTask(task) === 'today').length
    const appointments = open.filter((task) => task.kind === 'appointment').length
    return { open: open.length, overdue, today, appointments, done: tasks.length - open.length }
  }, [tasks])

  const subjectOptions = useMemo(() => {
    const set = new Set<string>(subjects.filter(Boolean))
    for (const task of tasks) if (task.subject) set.add(task.subject)
    return [...set].sort((left, right) => left.localeCompare(right, homeworkLocale()))
  }, [subjects, tasks])

  const addTask = async () => {
    const nextTitle = title.trim()
    if (!nextTitle) return
    const task = createHomeworkTask({
      title: nextTitle,
      notes,
      subject,
      dueDate: dueDate || null,
      dueTime: dueTime || null,
      kind,
      priority,
    })
    const next = { version: 1 as const, tasks: [task, ...document.tasks] }
    await persist(next)
    setTitle('')
    setNotes('')
    setDueTime('')
    setPriority('normal')
  }

  const updateTask = async (id: string, patch: Partial<HomeworkTask>) => {
    const next = {
      version: 1 as const,
      tasks: document.tasks.map((task) => (
        task.id === id
          ? { ...task, ...patch, updatedAt: new Date().toISOString() }
          : task
      )),
    }
    await persist(next)
  }

  const removeTask = async (id: string) => {
    const next = { version: 1 as const, tasks: document.tasks.filter((task) => task.id !== id) }
    await persist(next)
  }

  const renderTask = (task: HomeworkTask) => {
    const bucket = classifyHomeworkTask(task)
    return (
      <article
        key={task.id}
        className={`homework-card ${task.done ? 'is-done' : ''} ${bucket === 'overdue' ? 'is-overdue' : ''} ${task.priority === 'high' ? 'is-high' : ''} ${task.kind === 'appointment' ? 'is-appointment' : ''}`}
      >
        <button
          type="button"
          className="homework-check"
          aria-label={task.done ? homeworkText().markOpen : homeworkText().markDone}
          aria-pressed={task.done}
          onClick={() => void updateTask(task.id, { done: !task.done })}
        >
          {task.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
        </button>
        <div className="homework-card-body">
          <header>
            <strong>{task.title}</strong>
            <span className="homework-kind">{task.kind === 'appointment' ? homeworkText().appointment : homeworkText().homework}</span>
          </header>
          <div className="homework-meta">
            {task.subject && <span><BookOpen size={12} />{task.subject}</span>}
            <span className={bucket === 'overdue' ? 'is-overdue' : ''}>
              {task.kind === 'appointment' ? <AlarmClock size={12} /> : <CalendarDays size={12} />}
              {formatDue(task)}
            </span>
            {task.priority === 'high' && <span className="homework-priority">{homeworkText().high}</span>}
          </div>
          {task.notes && <p>{task.notes}</p>}
        </div>
        <button
          type="button"
          className="homework-delete"
          aria-label={homeworkText().deleteEntry}
          onClick={() => void removeTask(task.id)}
        >
          <Trash2 size={15} />
        </button>
      </article>
    )
  }

  const openBuckets: HomeworkBucket[] = ['overdue', 'today', 'upcoming', 'undated']

  const shiftCalendar = (delta: number) => {
    setCalendarCursor((current) => {
      const next = new Date(current)
      if (plannerView === 'week') next.setDate(next.getDate() + delta * 7)
      else next.setMonth(next.getMonth() + delta)
      return next
    })
  }

  const calendarDays = useMemo(() => {
    if (plannerView === 'week') {
      const start = startOfMondayWeek(calendarCursor)
      return Array.from({ length: 7 }, (_, index) => {
        const day = new Date(start)
        day.setDate(start.getDate() + index)
        return day
      })
    }
    const first = startOfMondayWeek(new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1))
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(first)
      day.setDate(first.getDate() + index)
      return day
    })
  }, [calendarCursor, plannerView])

  const tasksByDate = useMemo(() => {
    const map = new Map<string, HomeworkTask[]>()
    for (const task of visibleTasks) {
      if (!task.dueDate) continue
      const list = map.get(task.dueDate) ?? []
      list.push(task)
      map.set(task.dueDate, list)
    }
    return map
  }, [visibleTasks])

  const isoDay = (day: Date) => {
    const month = `${day.getMonth() + 1}`.padStart(2, '0')
    const date = `${day.getDate()}`.padStart(2, '0')
    return `${day.getFullYear()}-${month}-${date}`
  }

  const todayIso = isoDay(new Date())
  const calendarLabel = plannerView === 'week'
    ? `${homeworkText().weekPrefix} ${calendarDays[0] ? dateFormatter().format(calendarDays[0]) : ''} – ${calendarDays[6] ? dateFormatter().format(calendarDays[6]) : ''}`
    : new Intl.DateTimeFormat(homeworkLocale(), { month: 'long', year: 'numeric' }).format(calendarCursor)
  const copy = homeworkText()

  return (
    <section className="homework-board" aria-label={copy.aria} lang={homeworkLocale()} data-i18n-ignore>
      <style>{homeworkStyles}</style>
      <div className="homework-shell">
        <header className="homework-header">
          <div className="homework-heading">
            <span className="homework-eyebrow"><ClipboardList size={14} /> {copy.eyebrow}</span>
            <h1>{copy.title}</h1>
            <p>{copy.intro} <code>{HOMEWORK_NOTE_PATH}</code>.</p>
          </div>
          <div className="homework-header-actions">
            {onOpenNote && (
              <button type="button" className="homework-secondary" onClick={() => void onOpenNote(HOMEWORK_NOTE_PATH)}>
                {copy.openNote}
              </button>
            )}
            <button type="button" className="homework-close" aria-label={copy.close} onClick={onClose}><X size={17} /></button>
          </div>
        </header>

        <div className="homework-stats" aria-live="polite">
          <span className="homework-stat"><strong>{stats.open}</strong> {copy.openStat}</span>
          <span className="homework-stat is-warn"><strong>{stats.overdue}</strong> {copy.overdueStat}</span>
          <span className="homework-stat"><strong>{stats.today}</strong> {copy.todayStat}</span>
          <span className="homework-stat"><strong>{stats.appointments}</strong> {copy.appointmentsStat}</span>
          <span className="homework-stat"><strong>{stats.done}</strong> {copy.doneStat}</span>
          {saving && <span className="homework-stat is-saving"><LoaderCircle className="spin" size={12} /> {copy.saving}</span>}
        </div>

        <form
          className="homework-composer"
          onSubmit={(event) => {
            event.preventDefault()
            void addTask()
          }}
        >
          <div className="homework-composer-row">
            <label className="homework-field is-grow">
              <span>{copy.taskLabel}</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={copy.taskPlaceholder}
                maxLength={240}
                required
              />
            </label>
            <label className="homework-field">
              <span>{copy.kind}</span>
              <select value={kind} onChange={(event) => setKind(event.target.value as HomeworkKind)}>
                <option value="homework">{copy.homework}</option>
                <option value="appointment">{copy.appointment}</option>
              </select>
            </label>
          </div>
          <div className="homework-composer-row">
            <label className="homework-field">
              <span>{copy.subject}</span>
              <input
                list="homework-subjects"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder={copy.subjectPlaceholder}
                maxLength={80}
              />
              <datalist id="homework-subjects">
                {subjectOptions.map((entry) => <option key={entry} value={entry} />)}
              </datalist>
            </label>
            <label className="homework-field">
              <span>{copy.date}</span>
              <input type="date" lang={homeworkLocale()} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            </label>
            <label className="homework-field">
              <span>{copy.time}</span>
              <input type="time" lang={homeworkLocale()} value={dueTime} onChange={(event) => setDueTime(event.target.value)} />
            </label>
            <label className="homework-field">
              <span>{copy.priority}</span>
              <select value={priority} onChange={(event) => setPriority(event.target.value as 'normal' | 'high')}>
                <option value="normal">{copy.normal}</option>
                <option value="high">{copy.high}</option>
              </select>
            </label>
          </div>
          <label className="homework-field">
            <span>{copy.notes}</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={copy.notesPlaceholder}
              rows={2}
              maxLength={4000}
            />
          </label>
          <div className="homework-composer-actions">
            <button type="submit" className="homework-primary" disabled={!title.trim() || saving}>
              <Plus size={15} /> {copy.add}
            </button>
          </div>
        </form>

        <div className="homework-views" role="tablist" aria-label={copy.views}>
          {([
            ['list', copy.list],
            ['week', copy.week],
            ['month', copy.month],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={plannerView === id}
              className={plannerView === id ? 'is-active' : ''}
              onClick={() => setPlannerView(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="homework-filters" role="tablist" aria-label={copy.filters}>
          {([
            ['open', copy.filterOpen],
            ['homework', copy.filterHomework],
            ['appointment', copy.filterAppointments],
            ['done', copy.filterDone],
            ['all', copy.filterAll],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? 'is-active' : ''}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <div className="homework-error" role="alert">{error}</div>}

        {plannerView !== 'list' && (
          <div className={`homework-calendar is-${plannerView}`}>
            <div className="homework-calendar-nav">
              <button type="button" onClick={() => shiftCalendar(-1)} aria-label={copy.previous}>‹</button>
              <strong>{calendarLabel}</strong>
              <button type="button" onClick={() => shiftCalendar(1)} aria-label={copy.next}>›</button>
              <button type="button" className="homework-linkish" onClick={() => setCalendarCursor(new Date())}>{copy.today}</button>
            </div>
            <div className="homework-calendar-weekdays">
              {mondayWeekdayLabels().map((label) => <span key={label}>{label}</span>)}
            </div>
            <div className={`homework-calendar-grid is-${plannerView}`}>
              {calendarDays.map((day) => {
                const key = isoDay(day)
                const items = tasksByDate.get(key) ?? []
                const outside = plannerView === 'month' && day.getMonth() !== calendarCursor.getMonth()
                return (
                  <button
                    key={key}
                    type="button"
                    className={`homework-day ${key === todayIso ? 'is-today' : ''} ${outside ? 'is-outside' : ''}`}
                    onClick={() => setDueDate(key)}
                  >
                    <span>{day.getDate()}</span>
                    <ul>
                      {items.slice(0, plannerView === 'week' ? 8 : 3).map((task) => (
                        <li key={task.id} className={`${task.kind === 'appointment' ? 'is-appointment' : ''} ${task.priority === 'high' ? 'is-high' : ''} ${task.done ? 'is-done' : ''}`}>
                          {task.dueTime ? `${task.dueTime} · ` : ''}{task.title}
                        </li>
                      ))}
                    </ul>
                    {items.length > (plannerView === 'week' ? 8 : 3) && <em>+{items.length - (plannerView === 'week' ? 8 : 3)}</em>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {loading ? (
          <div className="homework-empty"><LoaderCircle className="spin" size={22} /> {copy.loading}</div>
        ) : visibleTasks.length === 0 ? (
          <div className="homework-empty">
            <ClipboardList size={28} />
            <strong>{copy.emptyTitle}</strong>
            <p>{copy.emptyBody}</p>
          </div>
        ) : (
          <div className="homework-lists">
            {openBuckets.map((bucket) => {
              if (filter === 'done') return null
              const items = buckets[bucket]
              if (!items.length) return null
              return (
                <section key={bucket} className="homework-bucket" aria-label={bucketLabel(bucket)}>
                  <h2>{bucketLabel(bucket)} <em>{items.length}</em></h2>
                  <div className="homework-cards">{items.map(renderTask)}</div>
                </section>
              )
            })}
            {(filter === 'done' || filter === 'all' || showDone) && buckets.done.length > 0 && (
              <section className="homework-bucket is-done" aria-label={copy.done}>
                <h2>
                  {copy.done} <em>{buckets.done.length}</em>
                  {filter !== 'done' && (
                    <button type="button" className="homework-linkish" onClick={() => setShowDone((value) => !value)}>
                      {showDone || filter === 'all' ? copy.collapse : copy.expand}
                    </button>
                  )}
                </h2>
                {(filter === 'done' || showDone || filter === 'all') && (
                  <div className="homework-cards">{buckets.done.map(renderTask)}</div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

const homeworkStyles = `
.homework-board{position:absolute;inset:0;overflow:auto;background:radial-gradient(circle at 12% -10%,rgba(var(--accent-rgb),.12),transparent 34%),radial-gradient(circle at 88% 0,rgba(69,201,183,.08),transparent 28%),var(--bg)}
.homework-shell{width:min(1080px,calc(100% - 48px));margin:0 auto;padding:30px 0 56px;animation:homework-enter .34s cubic-bezier(.22,1,.36,1) both}
@keyframes homework-enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.homework-header{display:flex;align-items:flex-start;gap:18px;margin-bottom:16px}
.homework-heading{min-width:0;flex:1}
.homework-eyebrow{display:inline-flex;align-items:center;gap:7px;margin-bottom:8px;color:var(--accent-readable);font-size:10px;font-weight:720;letter-spacing:.08em;text-transform:uppercase}
.homework-heading h1{margin:0;font-size:clamp(24px,3vw,34px);font-weight:720;letter-spacing:-.04em}
.homework-heading p{max-width:560px;margin:8px 0 0;color:var(--text-muted);font-size:12px;line-height:1.6}
.homework-heading code{padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--panel-strong) 80%,transparent);font-size:10px}
.homework-header-actions{display:flex;align-items:center;gap:8px}
.homework-secondary,.homework-close,.homework-primary,.homework-check,.homework-delete,.homework-filters>button,.homework-views>button,.homework-linkish{border:1px solid var(--border);background:color-mix(in srgb,var(--panel-strong) 88%,transparent);color:var(--text-soft);cursor:pointer}
.homework-secondary{height:34px;padding:0 12px;border-radius:9px;font-size:10px;font-weight:650}
.homework-close{width:34px;height:34px;display:grid;place-items:center;border-radius:9px}
.homework-secondary:hover,.homework-close:hover{color:var(--text);border-color:var(--border-strong);background:var(--panel-hover)}
.homework-stats{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
.homework-stat{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:0 10px;border:1px solid var(--border);border-radius:999px;color:var(--text-muted);background:color-mix(in srgb,var(--panel) 70%,transparent);font-size:10px}
.homework-stat strong{color:var(--text);font-weight:700}
.homework-stat.is-warn{color:var(--warning);border-color:color-mix(in srgb,var(--warning) 35%,var(--border))}
.homework-stat.is-saving{color:var(--accent-readable)}
.homework-composer{display:grid;gap:10px;margin-bottom:16px;padding:14px;border:1px solid var(--border-strong);border-radius:16px;background:color-mix(in srgb,var(--panel-strong) 92%,transparent);box-shadow:0 16px 40px rgba(0,0,0,.16)}
.homework-composer-row{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(3,minmax(0,.7fr));gap:8px}
.homework-field{display:flex;min-width:0;flex-direction:column;gap:4px;color:var(--text-muted);font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.homework-field.is-grow{grid-column:1/-1}
.homework-composer-row .homework-field.is-grow{grid-column:auto}
.homework-field input,.homework-field select,.homework-field textarea{width:100%;min-height:34px;padding:7px 9px;border:1px solid var(--border);border-radius:9px;outline:none;color:var(--text);background:var(--bg-elevated);font:650 12px/1.35 var(--ui-font);text-transform:none;letter-spacing:0}
.homework-field textarea{min-height:58px;resize:vertical;font-weight:500}
.homework-field input:focus,.homework-field select:focus,.homework-field textarea:focus{border-color:color-mix(in srgb,var(--accent) 55%,var(--border));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.homework-composer-actions{display:flex;justify-content:flex-end}
.homework-primary{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:0 13px;border-radius:9px;border-color:color-mix(in srgb,var(--accent) 55%,var(--border));color:var(--on-accent);background:var(--accent);font-size:11px;font-weight:700}
.homework-primary:hover:not(:disabled){filter:brightness(1.06)}
.homework-primary:disabled{opacity:.55;cursor:not-allowed}
.homework-views,.homework-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.homework-views>button,.homework-filters>button{min-height:28px;padding:0 11px;border-radius:999px;font-size:10px;font-weight:700}
.homework-views>button.is-active,.homework-filters>button.is-active{color:var(--text);border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:color-mix(in srgb,var(--accent) 16%,transparent)}
.homework-calendar{margin:4px 0 18px;padding:12px;border:1px solid var(--border);border-radius:16px;background:color-mix(in srgb,var(--panel-strong) 82%,transparent)}
.homework-calendar-nav{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.homework-calendar-nav strong{flex:1;text-align:center;font-size:13px}
.homework-calendar-nav>button{width:32px;height:32px;border-radius:9px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer}
.homework-calendar-weekdays{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin-bottom:6px;color:var(--text-muted);font-size:9px;font-weight:720;text-transform:uppercase;letter-spacing:.06em;text-align:center}
.homework-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.homework-day{min-height:86px;display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:7px;border:1px solid var(--border);border-radius:10px;background:color-mix(in srgb,var(--bg) 80%,transparent);color:inherit;text-align:left;cursor:pointer;transition:transform .16s cubic-bezier(.22,1,.36,1),border-color .16s ease,background .16s ease,box-shadow .16s ease}
.homework-day:hover{transform:translateY(-1px);border-color:var(--border-strong);box-shadow:0 8px 18px rgba(0,0,0,.12)}
.homework-calendar.is-week .homework-day{min-height:150px}
.homework-day.is-today{border-color:color-mix(in srgb,var(--accent) 55%,var(--border))}
.homework-day.is-outside{opacity:.45}
.homework-day>span{font-size:11px;font-weight:720}
.homework-day ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}
.homework-day li{overflow:hidden;padding:2px 5px;border-radius:5px;background:color-mix(in srgb,var(--accent) 14%,transparent);font-size:8px;text-overflow:ellipsis;white-space:nowrap}
.homework-day li.is-appointment{background:color-mix(in srgb,#45c9b7 18%,transparent)}
.homework-day li.is-high{background:color-mix(in srgb,#e0677a 18%,transparent)}
.homework-day li.is-done{opacity:.55;text-decoration:line-through}
.homework-day em{color:var(--text-muted);font-size:8px}
.homework-error{margin-bottom:12px;padding:9px 11px;border:1px solid color-mix(in srgb,var(--danger) 35%,var(--border));border-radius:10px;color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,transparent);font-size:11px}
.homework-empty{display:grid;place-items:center;gap:8px;min-height:180px;padding:28px;border:1px dashed var(--border);border-radius:16px;color:var(--text-muted);text-align:center}
.homework-empty strong{color:var(--text);font-size:14px}
.homework-empty p{max-width:360px;margin:0;font-size:12px;line-height:1.55}
.homework-bucket{margin-bottom:16px}
.homework-bucket h2{display:flex;align-items:center;gap:8px;margin:0 0 8px;color:var(--text-soft);font-size:11px;font-weight:750;letter-spacing:.04em;text-transform:uppercase}
.homework-bucket h2 em{min-width:18px;height:18px;display:inline-grid;place-items:center;border-radius:999px;color:var(--text-muted);background:color-mix(in srgb,var(--text) 8%,transparent);font-style:normal;font-size:9px}
.homework-linkish{margin-left:auto;border:0;background:transparent;color:var(--accent-readable);font-size:10px;font-weight:700;text-transform:none;letter-spacing:0;cursor:pointer}
.homework-cards{display:grid;gap:8px}
.homework-card{display:grid;grid-template-columns:34px minmax(0,1fr) 34px;gap:4px;align-items:start;padding:10px;border:1px solid var(--border);border-radius:13px;background:color-mix(in srgb,var(--panel-strong) 90%,transparent)}
.homework-card.is-overdue{border-color:color-mix(in srgb,var(--danger) 40%,var(--border));background:color-mix(in srgb,var(--danger) 6%,var(--panel-strong))}
.homework-card.is-high{box-shadow:inset 3px 0 0 var(--warning)}
.homework-card.is-appointment{box-shadow:inset 3px 0 0 color-mix(in srgb,var(--accent) 75%,#45c9b7)}
.homework-card.is-done{opacity:.72}
.homework-card.is-done strong{text-decoration:line-through;color:var(--text-muted)}
.homework-check,.homework-delete{width:34px;height:34px;display:grid;place-items:center;border-radius:9px;background:transparent}
.homework-check{color:var(--accent-readable)}
.homework-delete{color:var(--text-muted)}
.homework-delete:hover{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}
.homework-card-body{min-width:0;padding-top:4px}
.homework-card-body header{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.homework-card-body strong{min-width:0;flex:1;color:var(--text);font-size:13px;font-weight:700;line-height:1.3}
.homework-kind{flex:0 0 auto;padding:2px 7px;border-radius:999px;color:var(--text-muted);background:color-mix(in srgb,var(--text) 7%,transparent);font-size:8px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
.homework-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;color:var(--text-muted);font-size:10px}
.homework-meta span{display:inline-flex;align-items:center;gap:4px}
.homework-meta .is-overdue{color:var(--danger);font-weight:700}
.homework-priority{color:var(--warning);font-weight:800}
.homework-card-body p{margin:0;color:var(--text-soft);font-size:11px;line-height:1.5;white-space:pre-wrap}
@media(max-width:760px){
  .homework-shell{width:calc(100% - 24px);padding-top:18px}
  .homework-header{flex-direction:column}
  .homework-composer-row{grid-template-columns:1fr 1fr}
}
@media(prefers-reduced-motion:reduce){
  .homework-shell{animation:none}
  .homework-day{transition:none}
}
`

export default HomeworkBoard
