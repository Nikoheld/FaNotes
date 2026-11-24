// The forms of the own-data features, with the app's wording (CompanionForms.kt, GradeBookScreens.kt, PlannerScreens.kt).
import { useState, type FormEvent, type ReactNode } from 'react'
import { useKanti } from '../state'
import { Banner, Button, Dialog, Toggle } from '../components/ui'
import { markLabel } from '../lib/i18n'
import { collectiveValue, type CourseMark } from '../lib/grades'
import { zurichToday } from '@shared/schulnetz-logic'
import { newId, parseGradeDate, type CalendarEvent, type CollectiveGrade, type CollectivePart, type GradeAdjustment, type HomeworkTask, type OwnGrade, type Recurrence } from './files'
import { dayMs, dayText, monthShift, wallMs, wallText } from './calendar'
import { useVault } from './store'
import { prepareTask } from './tasks'

/** "5,5" and "5.5" both read as 5.5; anything else is NaN. */
export const parseNumber = (text: string): number => {
  const clean = text.trim().replace(',', '.')
  return clean === '' ? Number.NaN : Number(clean)
}
const inMarkRange = (value: number) => Number.isFinite(value) && value >= 1 && value <= 6
const positive = (value: number) => Number.isFinite(value) && value > 0
const numberText = (value: number | null | undefined) => (value == null ? '' : String(Math.round(value * 1000) / 1000))

/** A dialog around a form: saving disables the buttons, a failed save keeps the dialog open and says why. */
export const FormDialog = ({ title, onClose, onSave, ready, saveLabel, children, extra }: {
  title: string; onClose: () => void; onSave: () => Promise<boolean>; ready: boolean; saveLabel?: string; children: ReactNode; extra?: ReactNode
}) => {
  const { t } = useKanti()
  const vault = useVault()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    vault.clearWriteError()
    const saved = await onSave()
    setBusy(false)
    if (saved) onClose()
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form vault-form" onSubmit={(event) => void submit(event)}>
        {children}
        {vault.lastWriteError ? <Banner tone="danger" icon="warning">{vault.lastWriteError}</Banner> : null}
        <div className="dialog-actions">
          {extra}
          <Button tone="quiet" onClick={onClose}>{t.cancel}</Button>
          <Button type="submit" disabled={!ready || busy}>{busy ? t.vaultBusy : saveLabel || t.save}</Button>
        </div>
      </form>
    </Dialog>
  )
}

const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="field"><span className="field-label">{label}</span>{children}{hint ? <small className="muted">{hint}</small> : null}</label>
)

// ── Marks ────────────────────────────────────────────────────────────────────

export const OwnGradeDialog = ({ courseId, existing, onClose }: { courseId: string; existing?: OwnGrade | null; onClose: () => void }) => {
  const { t } = useKanti()
  const { actions } = useVault()
  const [title, setTitle] = useState(existing?.title || '')
  const [mark, setMark] = useState(numberText(existing?.mark))
  const [weight, setWeight] = useState(existing ? numberText(existing.weight) : '1')
  const [date, setDate] = useState(existing?.date || zurichToday())
  const markValue = parseNumber(mark)
  const weightValue = parseNumber(weight)
  const iso = parseGradeDate(date)
  return (
    <FormDialog
      title={existing ? t.editYourMark : t.addYourMark}
      onClose={onClose}
      ready={inMarkRange(markValue) && positive(weightValue) && iso !== null}
      onSave={() => actions.saveOwnGrade({ id: existing?.id || newId(), courseId, title: title.trim() || t.ownMark, mark: markValue, weight: weightValue, date: iso as string })}
    >
      <p className="muted small">{t.ownMarkDialogHelp}</p>
      <Field label={t.fieldName}><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></Field>
      <div className="form-row">
        <Field label={t.fieldMark}><input inputMode="decimal" value={mark} onChange={(event) => setMark(event.target.value)} /></Field>
        <Field label={t.fieldWeight}><input inputMode="decimal" value={weight} onChange={(event) => setWeight(event.target.value)} /></Field>
      </div>
      <Field label={t.fieldDate} hint={t.fieldDateHint}><input value={date} onChange={(event) => setDate(event.target.value)} /></Field>
    </FormDialog>
  )
}

interface PartDraft { id: string; title: string; mark: string; weight: string }

export const CollectiveDialog = ({ courseId, existing, onClose }: { courseId: string; existing?: CollectiveGrade | null; onClose: () => void }) => {
  const { t } = useKanti()
  const { actions } = useVault()
  const [title, setTitle] = useState(existing?.title || '')
  const [weight, setWeight] = useState(existing ? numberText(existing.weight) : '1')
  const [date, setDate] = useState(existing?.date || zurichToday())
  const [drafts, setDrafts] = useState<PartDraft[]>(() => (existing?.parts.length
    ? existing.parts.map((part) => ({ id: part.id || newId(), title: part.title, mark: numberText(part.mark), weight: numberText(part.weight) }))
    : [{ id: newId(), title: '', mark: '', weight: '1' }, { id: newId(), title: '', mark: '', weight: '1' }]))
  const parts: CollectivePart[] = drafts.flatMap((draft) => {
    const mark = parseNumber(draft.mark)
    const factor = parseNumber(draft.weight)
    return inMarkRange(mark) && positive(factor) ? [{ id: draft.id, title: draft.title.trim() || t.partialTestName, mark, weight: factor }] : []
  })
  const factor = parseNumber(weight)
  const iso = parseGradeDate(date)
  const value = collectiveValue(parts)
  const change = (index: number, patch: Partial<PartDraft>) => setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)))
  return (
    <FormDialog
      title={existing ? t.editCollectiveGrade : t.collectiveGrade}
      onClose={onClose}
      ready={title.trim() !== '' && parts.length >= 2 && parts.length === drafts.length && positive(factor) && iso !== null}
      onSave={() => actions.saveCollective({ id: existing?.id || newId(), courseId, title: title.trim(), date: iso as string, weight: factor, parts })}
    >
      <p className="muted small">{t.collectiveDialogHelp}</p>
      <Field label={t.fieldName}><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></Field>
      <div className="form-row">
        <Field label={t.fieldDate}><input value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        <Field label={t.weightInSubject}><input inputMode="decimal" value={weight} onChange={(event) => setWeight(event.target.value)} /></Field>
      </div>
      {drafts.map((draft, index) => (
        <fieldset className="part-fieldset" key={draft.id}>
          <legend>{t.partialTest(index + 1)}</legend>
          <Field label={t.fieldName}><input value={draft.title} onChange={(event) => change(index, { title: event.target.value })} /></Field>
          <div className="form-row">
            <Field label={t.mark}><input inputMode="decimal" value={draft.mark} onChange={(event) => change(index, { mark: event.target.value })} /></Field>
            <Field label={t.fieldWeight}><input inputMode="decimal" value={draft.weight} onChange={(event) => change(index, { weight: event.target.value })} /></Field>
          </div>
          {drafts.length > 2 ? <Button tone="quiet" className="button-small" onClick={() => setDrafts((current) => current.filter((_, at) => at !== index))}>{t.removePartialTest}</Button> : null}
        </fieldset>
      ))}
      <Button tone="outline" icon="plus" onClick={() => setDrafts((current) => [...current, { id: newId(), title: '', mark: '', weight: '1' }])}>{t.addPartialTest}</Button>
      {value != null ? <p className="vault-counts">{t.countsAs(markLabel(value))}</p> : <p className="muted small">{t.collectiveNeedsTwo}</p>}
    </FormDialog>
  )
}

export const AdjustDialog = ({ mark, existing, onClose }: { mark: CourseMark; existing?: GradeAdjustment | null; onClose: () => void }) => {
  const { t } = useKanti()
  const { actions } = useVault()
  const [overrideMark, setMark] = useState(numberText(existing?.mark))
  const [overrideWeight, setWeight] = useState(numberText(existing?.weight))
  const [excluded, setExcluded] = useState(existing?.excluded === true)
  const parsedMark = parseNumber(overrideMark)
  const parsedWeight = parseNumber(overrideWeight)
  const markOk = overrideMark.trim() === '' || inMarkRange(parsedMark)
  const weightOk = overrideWeight.trim() === '' || positive(parsedWeight)
  const targetId = mark.targetId || ''
  return (
    <FormDialog
      title={mark.grade.title || t.schoolMark}
      onClose={onClose}
      ready={markOk && weightOk && targetId !== ''}
      onSave={() => actions.saveAdjustment({ targetId, mark: overrideMark.trim() === '' ? null : parsedMark, weight: overrideWeight.trim() === '' ? null : parsedWeight, excluded })}
      extra={existing ? <Button tone="quiet" onClick={() => void actions.restoreAdjustment(targetId).then((saved) => { if (saved) onClose() })}>{t.restoreSchoolMark}</Button> : null}
    >
      <p className="muted small">{t.adjustHelp(markLabel(mark.displayMark, 3), markLabel(mark.displayWeight, 3))}</p>
      <div className="form-row">
        <Field label={t.yourMark}><input inputMode="decimal" placeholder={markLabel(mark.displayMark, 3)} value={overrideMark} onChange={(event) => setMark(event.target.value)} autoFocus /></Field>
        <Field label={t.yourWeight}><input inputMode="decimal" placeholder={markLabel(mark.displayWeight, 3)} value={overrideWeight} onChange={(event) => setWeight(event.target.value)} /></Field>
      </div>
      <Toggle checked={excluded} onChange={setExcluded} label={t.excludeFromAverage} detail={t.excludeFromAverageBody} />
    </FormDialog>
  )
}

export const WhatIfDialog = ({ courseId, onClose }: { courseId: string; onClose: () => void }) => {
  const { t } = useKanti()
  const { actions } = useVault()
  const [title, setTitle] = useState('')
  const [mark, setMark] = useState('')
  const [weight, setWeight] = useState('1')
  const markValue = parseNumber(mark)
  const weightValue = parseNumber(weight)
  return (
    <FormDialog title={t.addLocalMark} onClose={onClose} ready={inMarkRange(markValue) && positive(weightValue)} saveLabel={t.add} onSave={() => actions.addHypothetical(courseId, title.trim() || t.localMark, markValue, weightValue)}>
      <p className="muted small">{t.onlyForScenario}</p>
      <Field label={t.labelOptional}><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></Field>
      <div className="form-row">
        <Field label={t.fieldMark}><input inputMode="decimal" value={mark} onChange={(event) => setMark(event.target.value)} /></Field>
        <Field label={t.fieldWeight}><input inputMode="decimal" value={weight} onChange={(event) => setWeight(event.target.value)} /></Field>
      </div>
    </FormDialog>
  )
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export const TaskDialog = ({ task, onClose }: { task?: HomeworkTask | null; onClose: () => void }) => {
  const { t } = useKanti()
  const { actions } = useVault()
  const [title, setTitle] = useState(task?.title || '')
  const [subject, setSubject] = useState(task?.subject || '')
  const [dueDate, setDueDate] = useState(task?.dueDate || '')
  const [dueTime, setDueTime] = useState(task?.dueTime || '')
  const [notes, setNotes] = useState(task?.notes || '')
  const [appointment, setAppointment] = useState(task?.kind === 'appointment')
  const [important, setImportant] = useState(task?.priority === 'high')
  const input = { title, subject, dueDate, dueTime, notes, kind: appointment ? 'appointment' : 'homework', priority: important ? 'high' : 'normal' }
  return (
    <FormDialog title={task ? t.editTask : t.newTask} onClose={onClose} ready={prepareTask(input) !== null} saveLabel={t.saveTask} onSave={() => actions.saveTask(input, task?.id)}>
      <Field label={t.whatNeedsDoing}><input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} autoFocus /></Field>
      <Field label={t.taskSubject}><input value={subject} maxLength={80} onChange={(event) => setSubject(event.target.value)} /></Field>
      <div className="form-row">
        <Field label={t.due}><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
        <Field label={t.dueTime}><input type="time" value={dueTime} onChange={(event) => setDueTime(event.target.value)} /></Field>
      </div>
      <Field label={t.taskNotes}><textarea rows={3} value={notes} maxLength={4000} onChange={(event) => setNotes(event.target.value)} /></Field>
      <Toggle checked={appointment} onChange={setAppointment} label={t.taskKindAppointment} detail={t.taskKind} />
      <Toggle checked={important} onChange={setImportant} label={t.taskImportant} detail={t.taskImportantBody} />
    </FormDialog>
  )
}

// ── Events ───────────────────────────────────────────────────────────────────

const repeatLabel = (recurrence: Recurrence, t: ReturnType<typeof useKanti>['t']) =>
  ({ none: t.repeatNever, daily: t.repeatDaily, weekly: t.repeatWeekly, monthly: t.repeatMonthly, yearly: t.repeatYearly })[recurrence]

/** New or edited own event. `occurrence` is the day of a series' occurrence being edited (the app's "eventId@day" key). */
export const EventDialog = ({ event, occurrence, day, onClose }: { event?: CalendarEvent | null; occurrence?: string; day?: string; onClose: () => void }) => {
  const { t } = useKanti()
  const { actions, own } = useVault()
  const start0 = event ? (occurrence && event.start.slice(0, 10) !== occurrence ? shiftTo(event, occurrence).start : event.start) : `${day || zurichToday()}T09:00`
  const end0 = event ? (occurrence && event.start.slice(0, 10) !== occurrence ? shiftTo(event, occurrence).end : event.end) : `${day || zurichToday()}T10:00`
  const [title, setTitle] = useState(event?.title || '')
  const [allDay, setAllDay] = useState(event?.allDay ?? false)
  const [start, setStart] = useState(allDay ? start0.slice(0, 10) : start0.slice(0, 16))
  const [end, setEnd] = useState(allDay ? end0.slice(0, 10) : end0.slice(0, 16))
  const [calendarId, setCalendarId] = useState(event?.calendarId || own.calendar.calendars[0]?.id || 'personal')
  const [location, setLocation] = useState(event?.location || '')
  const [notes, setNotes] = useState(event?.notes || '')
  const [recurrence, setRecurrence] = useState<Recurrence>(event?.recurrence || 'none')
  const [until, setUntil] = useState(event?.recurrenceUntil || '')
  const toggleAllDay = (value: boolean) => {
    setAllDay(value)
    setStart((current) => (value ? current.slice(0, 10) : `${current.slice(0, 10)}T09:00`))
    setEnd((current) => (value ? current.slice(0, 10) : `${current.slice(0, 10)}T10:00`))
  }
  const startMs = allDay ? dayMs(start) : wallMs(start)
  const endMs = allDay ? dayMs(end) : wallMs(end)
  const endOk = startMs !== null && endMs !== null && (allDay ? endMs >= startMs : endMs > startMs)
  const detached = Boolean(event && occurrence && recurrence !== 'none' && event.start.slice(0, 10) !== occurrence)
  const next: CalendarEvent = {
    id: event?.id || newId(), calendarId, title, start, end, allDay, location, notes, notePath: event?.notePath || '', recurrence, recurrenceUntil: until || null, exceptionDates: event?.exceptionDates || [],
  }
  return (
    <FormDialog
      title={event ? t.editEvent : t.newEvent}
      onClose={onClose}
      ready={title.trim() !== '' && endOk}
      saveLabel={t.saveEvent}
      onSave={() => actions.saveEvent(next, event ? `${event.id}@${occurrence || event.start.slice(0, 10)}` : null)}
    >
      <Field label={t.eventTitle}><input value={title} maxLength={240} onChange={(event_) => setTitle(event_.target.value)} autoFocus /></Field>
      <Toggle checked={allDay} onChange={toggleAllDay} label={t.allDayEvent} />
      <div className="form-row">
        <Field label={t.starts}><input type={allDay ? 'date' : 'datetime-local'} value={start} onChange={(event_) => setStart(event_.target.value)} /></Field>
        <Field label={t.ends}><input type={allDay ? 'date' : 'datetime-local'} value={end} onChange={(event_) => setEnd(event_.target.value)} /></Field>
      </div>
      {!endOk && startMs !== null ? <p className="field-error">{t.endAfterStart}</p> : null}
      <div className="form-row">
        <Field label={t.calendar}>
          <select value={calendarId} onChange={(event_) => setCalendarId(event_.target.value)}>
            {own.calendar.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </select>
        </Field>
        <Field label={t.location}><input value={location} maxLength={160} onChange={(event_) => setLocation(event_.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label={t.repeat}>
          <select value={recurrence} onChange={(event_) => setRecurrence(event_.target.value as Recurrence)}>
            {(['none', 'daily', 'weekly', 'monthly', 'yearly'] as Recurrence[]).map((value) => <option key={value} value={value}>{repeatLabel(value, t)}</option>)}
          </select>
        </Field>
        {recurrence !== 'none' ? <Field label={t.repeatUntil}><input type="date" value={until} onChange={(event_) => setUntil(event_.target.value)} /></Field> : null}
      </div>
      {event && recurrence !== 'none' && !detached ? <p className="muted small">{t.repeatNote(repeatLabel(recurrence, t))}</p> : null}
      {detached ? <p className="muted small">{t.repeatDetach}</p> : null}
      <Field label={t.taskNotes}><textarea rows={3} value={notes} maxLength={4000} onChange={(event_) => setNotes(event_.target.value)} /></Field>
    </FormDialog>
  )
}

/** The start and end of the series' event moved onto one of its later days (what the editor shows for that day). */
const shiftTo = (event: CalendarEvent, day: string): { start: string; end: string } => {
  const first = dayMs(event.start.slice(0, 10))
  const target = dayMs(day)
  if (first === null || target === null) return { start: event.start, end: event.end }
  const delta = target - first
  const move = (value: string) => (event.allDay || !value.includes('T') ? dayText((dayMs(value.slice(0, 10)) ?? 0) + delta) : wallText((wallMs(value) ?? 0) + delta))
  return { start: move(event.start), end: move(event.end) }
}

export { monthShift }
