// The pieces of the own-data features that several views share: the hint where the vault is not
// open, the unlock form and the task list.
import { useEffect, useState } from 'react'
import { SyncApiError } from '@sync/api'
import type { Entry } from '../lib/agenda'
import type { AgendaEvent } from '../types'
import type { Strings } from '../lib/i18n'
import { useKanti } from '../state'
import { dateLabel } from '../lib/i18n'
import { zurichNow, type Clock } from '../lib/agenda'
import { Banner, Button, Card, Dialog, Empty, Icon, IconButton, SectionLabel, Tag } from '../components/ui'
import { useProvisional } from './planned'
import { useVault } from './store'
import { classifyTask, sortTasks } from './tasks'
import type { HomeworkTask } from './files'
import { EventDialog, TaskDialog } from './forms'
import { hidingRules, plannedFor } from './school'
import { loadCalendarEvent } from './calendarLookup'

/** The Zurich clock, once a minute (the same as the views' `useClock`, kept here so the vault pieces do not import the views). */
const useClock = (): Clock => {
  const [clock, setClock] = useState(() => zurichNow())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(zurichNow()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return clock
}

const savedEmail = () => { try { return window.sessionStorage.getItem('kanti-web:vault-email') || '' } catch { return '' } }

/** "Entsperren": the account is signed in here but the vault key is not (a reload without IndexedDB). */
export const UnlockForm = () => {
  const { t } = useKanti()
  const vault = useVault()
  const [email, setEmail] = useState(savedEmail)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await vault.unlock(email, password)
      setPassword('')
    } catch (failure) {
      setError(failure instanceof SyncApiError && failure.status === 401 ? t.wrongLogin : failure instanceof Error ? failure.message : t.error)
    } finally { setBusy(false) }
  }
  return (
    <form className="form vault-unlock" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="field"><span className="field-label">{t.email}</span><input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="field"><span className="field-label">{t.password}</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error ? <Banner tone="danger" icon="warning">{error}</Banner> : null}
      <Button type="submit" icon="key" disabled={busy || !email || !password}>{busy ? t.vaultUnlocking : t.vaultUnlock}</Button>
    </form>
  )
}

/** What stands where the own data would be, when it is not there: the pairing hint, the unlock form or a notice. */
export const VaultHint = ({ compact = false }: { compact?: boolean }) => {
  const { t } = useKanti()
  const vault = useVault()
  if (vault.mode === 'pair') {
    return compact ? <Banner icon="key">{t.vaultPairHint}</Banner> : (
      <Card className="vault-hint"><div className="vault-hint-row"><Icon name="key" size={22} /><div><strong>{t.vaultPairHint}</strong><p className="muted small">{t.vaultPairHintBody}</p></div></div></Card>
    )
  }
  if (vault.mode === 'locked') {
    return (
      <Card className="vault-hint">
        <div className="vault-hint-row"><Icon name="key" size={22} /><div><strong>{t.vaultLockedTitle}</strong><p className="muted small">{t.vaultLockedBody}</p></div></div>
        <UnlockForm />
      </Card>
    )
  }
  if (vault.mode === 'unavailable') {
    return <Banner tone="warning" icon="warning" action={<Button tone="outline" onClick={() => void vault.reload()}>{t.vaultRetry}</Button>}>{t.vaultUnavailable}</Banner>
  }
  return null
}

/** A yes/no question before something is deleted. */
export const ConfirmDelete = ({ title, body, confirm, onConfirm, onClose }: { title: string; body: string; confirm: string; onConfirm: () => Promise<boolean>; onClose: () => void }) => {
  const { t } = useKanti()
  const vault = useVault()
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title={title} onClose={onClose}>
      <p>{body}</p>
      {vault.lastWriteError ? <Banner tone="danger" icon="warning">{vault.lastWriteError}</Banner> : null}
      <div className="dialog-actions">
        <Button tone="quiet" onClick={onClose}>{t.cancel}</Button>
        <Button tone="danger" disabled={busy} onClick={() => { setBusy(true); vault.clearWriteError(); void onConfirm().then((saved) => { setBusy(false); if (saved) onClose() }) }}>{confirm}</Button>
      </div>
    </Dialog>
  )
}

/** The open tasks of the Today page (Hausaufgaben.md): add, edit, complete, delete, and copy school assignments in. */
export const TasksCard = () => {
  const { t, language } = useKanti()
  const vault = useVault()
  const clock = useClock()
  const [editing, setEditing] = useState<HomeworkTask | 'new' | null>(null)
  const [deleting, setDeleting] = useState<HomeworkTask | null>(null)
  if (vault.mode === 'pair' || vault.mode === 'locked' || vault.mode === 'unavailable') return <VaultHint />
  if (vault.mode !== 'ready') return null
  const writable = vault.own.tasksReadable && vault.actions.writable
  const open = sortTasks(vault.own.tasks.filter((task) => !task.done))
  const finished = sortTasks(vault.own.tasks.filter((task) => task.done)).slice(0, 5)
  return (
    <>
      <SectionLabel action={writable ? <button type="button" className="link" onClick={() => setEditing('new')}>{t.newTask} <Icon name="plus" size={16} /></button> : undefined}>{t.tasks}</SectionLabel>
      <Card className="list vault-tasks">
        {!vault.own.tasksReadable ? <Banner tone="warning" icon="warning">{t.taskUnreadable}</Banner> : null}
        {open.length ? open.slice(0, 8).map((task) => {
          const bucket = classifyTask(task, clock.today)
          return (
            <div key={task.id} className={`task-row${task.priority === 'high' ? ' important' : ''}`}>
              <button type="button" className="task-check" role="checkbox" aria-checked="false" aria-label={`${t.taskDone}: ${task.title}`} disabled={!writable} onClick={() => void vault.actions.setTaskDone(task.id, true)} />
              <button type="button" className="task-main" onClick={() => writable && setEditing(task)}>
                <span className="task-title">{task.title}</span>
                <small className="muted">{[task.subject, task.dueDate ? `${dateLabel(task.dueDate, language)}${task.dueTime ? ` · ${task.dueTime}` : ''}` : t.noDueDate].filter(Boolean).join(' · ')}</small>
              </button>
              {bucket === 'overdue' ? <Tag tone="danger">{t.taskOverdue}</Tag> : null}
              {writable ? <IconButton icon="delete" label={t.deleteTask} onClick={() => setDeleting(task)} /> : null}
            </div>
          )
        }) : <Empty icon="check">{t.taskNothingLeft}</Empty>}
        {finished.length ? (
          <details className="task-finished">
            <summary>{t.taskFinished} ({vault.own.tasks.filter((task) => task.done).length})</summary>
            {finished.map((task) => (
              <div key={task.id} className="task-row done">
                <button type="button" className="task-check checked" role="checkbox" aria-checked="true" aria-label={`${t.taskReopen}: ${task.title}`} disabled={!writable} onClick={() => void vault.actions.setTaskDone(task.id, false)} />
                <span className="task-main"><span className="task-title">{task.title}</span></span>
              </div>
            ))}
          </details>
        ) : null}
        {vault.lastWriteError ? <Banner tone="danger" icon="warning">{vault.lastWriteError}</Banner> : null}
      </Card>
      {editing ? <TaskDialog task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <ConfirmDelete title={t.deleteTaskTitle} body={t.deleteTaskBody} confirm={t.deleteTask} onConfirm={() => vault.actions.deleteTask(deleting.id)} onClose={() => setDeleting(null)} /> : null}
    </>
  )
}

/** The school assignment's "copy into my tasks" action; only there while the vault is open. */
export const HomeworkCopy = ({ item, t }: { item: { title: string; courseName: string; day: string; description: string }; t: Strings }) => {
  const vault = useVault()
  const [note, setNote] = useState('')
  if (vault.mode !== 'ready' || !vault.actions.writable || !vault.own.tasksReadable) return null
  return (
    <div className="entry-actions">
      <Button tone="outline" icon="plus" onClick={() => void vault.actions.addSchoolHomework({ title: item.title, courseName: item.courseName, dueDate: item.day, description: item.description }).then((result) => setNote(result === 'added' ? t.addedToTasks : result === 'exists' ? t.alreadyInTasks : ''))}>{t.addToMyTasks}</Button>
      {note ? <span className="muted small" role="status">{note}</span> : null}
    </div>
  )
}

/**
 * What can be done with one entry beyond reading it: hide or plan an absence for a lesson, copy an exam into the
 * own calendar, edit or delete an own task or event. Shown inside the details of an entry.
 */
export const EntryActions = ({ entry, t, onDone }: { entry: Omit<Entry, 'event'> & { event?: AgendaEvent }; t: Strings; onDone?: () => void }) => {
  const vault = useVault()
  const [editing, setEditing] = useState<'task' | 'event' | null>(null)
  const [deleting, setDeleting] = useState<'task' | 'event' | 'series' | null>(null)
  const [note, setNote] = useState('')
  if (vault.mode !== 'ready' || !vault.actions.writable) return null
  const { actions, own } = vault
  const done = (saved: boolean) => { if (saved) onDone?.(); return saved }
  const event = entry.event
  if (entry.own?.type === 'task') {
    const task = own.tasks.find((item) => item.id === entry.own?.id)
    if (!task) return null
    return (
      <div className="entry-actions">
        <Button tone="outline" icon="edit" onClick={() => setEditing('task')}>{t.edit}</Button>
        <Button tone="outline" icon="check" onClick={() => void actions.setTaskDone(task.id, true).then(done)}>{t.taskDone}</Button>
        <Button tone="quiet" icon="delete" onClick={() => setDeleting('task')}>{t.deleteTask}</Button>
        {editing ? <TaskDialog task={task} onClose={() => { setEditing(null); onDone?.() }} /> : null}
        {deleting ? <ConfirmDelete title={t.deleteTaskTitle} body={t.deleteTaskBody} confirm={t.deleteTask} onConfirm={() => actions.deleteTask(task.id).then(done)} onClose={() => setDeleting(null)} /> : null}
      </div>
    )
  }
  if (entry.own?.type === 'event') {
    const stored = loadCalendarEvent(own, entry.own.id)
    if (!stored) return null
    const day = entry.own.occurrence || stored.start.slice(0, 10)
    const recurring = stored.recurrence !== 'none'
    return (
      <div className="entry-actions">
        <Button tone="outline" icon="edit" onClick={() => setEditing('event')}>{t.edit}</Button>
        <Button tone="quiet" icon="delete" onClick={() => setDeleting('event')}>{recurring ? t.deleteOne : t.delete}</Button>
        {recurring ? <Button tone="quiet" icon="delete" onClick={() => setDeleting('series')}>{t.deleteSeries}</Button> : null}
        {editing ? <EventDialog event={stored} occurrence={day} onClose={() => { setEditing(null); onDone?.() }} /> : null}
        {deleting ? <ConfirmDelete title={t.deleteEventTitle} body={t.deleteEventBody} confirm={deleting === 'series' ? t.deleteSeries : t.delete} onConfirm={() => (deleting === 'series' ? actions.deleteEvent(stored.id) : actions.skipOccurrence(stored.id, day)).then(done)} onClose={() => setDeleting(null)} /> : null}
      </div>
    )
  }
  if (entry.kind === 'lesson' && event && actions.schoolWritable) {
    const planned = plannedFor(event, own.planned)
    return (
      <div className="entry-actions">
        <Button tone="quiet" icon="close" onClick={() => void actions.hideLesson(event, 'once').then(done)}>{t.hideLesson}</Button>
        <Button tone="quiet" icon="close" onClick={() => void actions.hideLesson(event, 'series').then(done)}>{t.hideWeeklyLesson}</Button>
        <Button tone="outline" icon="absences" onClick={() => void (planned ? actions.unplanAbsence(planned.id) : actions.planAbsence(event))}>{planned ? t.plannedAbsenceRemove : t.plannedAbsenceMark}</Button>
        {planned ? <Tag tone="warning">{t.plannedAbsenceTag}</Tag> : null}
        {hidingRules(event, own.hidden).length ? <Tag>{t.hiddenLessons}</Tag> : null}
        <p className="muted small">{t.plannedAbsenceHint}</p>
      </div>
    )
  }
  if (entry.kind === 'exam' && event) {
    return (
      <div className="entry-actions">
        <Button tone="outline" icon="agenda" onClick={() => void actions.addExam({ id: event.id, title: entry.title, start: event.start.slice(0, 16), end: event.end.slice(0, 16), room: entry.room, comment: entry.comment }).then((result) => setNote(result === 'added' ? t.addedToCalendar : result === 'exists' ? t.alreadyInCalendar : ''))}>{t.addToMyCalendar}</Button>
        {note ? <span className="muted small" role="status">{note}</span> : null}
      </div>
    )
  }
  return null
}

/** The planned absences with their state, above the absence table. */
export const PlannedAbsences = () => {
  const { t, language } = useKanti()
  const vault = useVault()
  const clock = useClock()
  const provisional = useProvisional(clock.today)
  if (vault.mode !== 'ready' || !provisional.items.length) return null
  return (
    <Card className="vault-planned">
      <SectionLabel>{t.plannedAbsences}</SectionLabel>
      <ul className="planned-list">
        {provisional.items.map(({ absence, state }) => (
          <li key={absence.id}>
            <span className="tabular">{dateLabel(absence.date, language, { weekday: 'short', day: 'numeric', month: 'short' })} · {absence.start}–{absence.end}</span>
            <span>{absence.subject}</span>
            <Tag tone={state === 'upcoming' ? 'warning' : state === 'matched' ? 'success' : 'neutral'}>{state === 'upcoming' ? t.plannedUpcoming : state === 'matched' ? t.plannedMatched : t.plannedNotEntered}</Tag>
            {vault.actions.schoolWritable ? <IconButton icon="delete" label={t.plannedAbsenceRemove} onClick={() => void vault.actions.unplanAbsence(absence.id)} /> : null}
          </li>
        ))}
      </ul>
      {provisional.plannedPoints > 0 ? <p className="muted small">{t.plannedPoints(String(provisional.plannedPoints))}</p> : null}
      <p className="muted small">{t.plannedAbsenceHint}</p>
    </Card>
  )
}

const WEEKDAYS_DE = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const WEEKDAYS_EN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Settings: whether the vault is open, which of the app's connection slots belongs to the shown connection, hidden lessons. */
export const VaultSettings = () => {
  const { t, language, connections, active } = useKanti()
  const vault = useVault()
  if (vault.mode === 'off') return null
  const index = active ? connections.findIndex((connection) => connection.id === active.id) : 0
  const weekdays = language === 'de' ? WEEKDAYS_DE : WEEKDAYS_EN
  return (
    <div className="vault-settings">
      <h3>{t.vaultSettingsTitle}</h3>
      <p className="muted small">{t.vaultSettingsBody}</p>
      {vault.mode === 'ready' ? <p className="settings-note"><Icon name="check" size={16} />{t.vaultOpen}{vault.persistent ? ` · ${t.vaultStaysSignedIn}` : ''}</p> : <VaultHint compact />}
      {vault.mode === 'ready' && !vault.persistent && !vault.backendDemo ? <Banner tone="warning" icon="info">{t.vaultMemoryOnly}</Banner> : null}
      {vault.mode === 'ready' && (index > 0 || vault.slots.length > 0) ? (
        <label className="field">
          <span className="field-label">{t.vaultSlotLabel}</span>
          <select value={vault.slot === null ? '' : vault.slot === '' ? 'first' : vault.slot} onChange={(event) => vault.setSlot(event.target.value === '' ? null : event.target.value === 'first' ? '' : event.target.value)}>
            <option value="">{t.vaultSlotNone}</option>
            <option value="first">{t.vaultSlotFirst}</option>
            {vault.slots.map((slot, at) => <option key={slot} value={slot}>{t.vaultSlotOther(at + 1)}</option>)}
          </select>
          <small className="muted">{t.vaultSlotNote}</small>
        </label>
      ) : null}
      {vault.mode === 'ready' && vault.actions.schoolWritable ? (
        <>
          <h4>{t.hiddenLessons}</h4>
          <p className="muted small">{t.hiddenLessonsBody}</p>
          {vault.own.hidden.length ? vault.own.hidden.map((rule) => (
            <div className="task-row" key={rule.id}>
              <span className="task-main"><span className="task-title">{rule.subject}</span><small className="muted">{rule.mode === 'once' ? t.hiddenOnce(dateLabel(rule.date, language)) : t.hiddenSeries(weekdays[rule.weekday] || '', rule.start)}</small></span>
              <Button tone="outline" className="button-small" onClick={() => void vault.actions.showLesson(rule.id)}>{t.showAgain}</Button>
            </div>
          )) : <p className="muted small">{t.noHiddenLessons}</p>}
        </>
      ) : null}
      {vault.lastWriteError ? <Banner tone="danger" icon="warning">{vault.lastWriteError}</Banner> : null}
    </div>
  )
}
