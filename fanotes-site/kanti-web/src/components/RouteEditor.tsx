// Add or edit one commute route in a dialog. Saving sends the whole list (the parent does that).
import { useState } from 'react'
import { emptySchedule, isClock, MAX_TIMES, normalizeRoute, THRESHOLDS, validateRoute, type RouteError } from '../lib/commute'
import type { Strings } from '../lib/i18n'
import type { CommuteRoute, ScheduleMode, Stop } from '../types'
import { StopPicker } from './StopPicker'
import { Banner, Button, Dialog, Icon, Toggle } from './ui'

const MODES: ScheduleMode[] = ['none', 'times', 'firstLesson', 'lastLesson']

export const RouteEditor = ({ initial, isNew, globalThreshold, search, onSave, onClose, t }: {
  initial: CommuteRoute
  isNew: boolean
  globalThreshold: number
  search: (query: string) => Promise<Stop[]>
  onSave: (route: CommuteRoute) => Promise<void>
  onClose: () => void
  t: Strings
}) => {
  const [draft, setDraft] = useState<CommuteRoute>(initial)
  const [tried, setTried] = useState(false)
  const [swapped, setSwapped] = useState(0)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState('')
  const errors = validateRoute(draft)
  const shown = (key: RouteError) => (tried && errors.includes(key) ? t.commuteErrors[key] : '')
  const schedule = draft.schedule
  const setSchedule = (patch: Partial<CommuteRoute['schedule']>) => setDraft({ ...draft, schedule: { ...schedule, ...patch } })

  const submit = async () => {
    setTried(true)
    if (errors.length) return
    setSaving(true)
    setFailure('')
    try {
      await onSave(normalizeRoute(draft))
    } catch (error) {
      setFailure(error instanceof Error && error.message ? `${t.commuteSaveFailed} (${error.message})` : t.commuteSaveFailed)
      setSaving(false)
    }
  }
  const swap = () => { setDraft({ ...draft, from: draft.to, to: draft.from }); setSwapped(swapped + 1) }
  const setTime = (index: number, value: string) => setSchedule({ times: schedule.times.map((time, at) => (at === index ? value : time)) })

  return (
    <Dialog title={isNew ? t.commuteNewRoute : t.commuteEditRoute} onClose={onClose} wide>
      <form className="form route-editor" noValidate onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label className="field">
          <span className="field-label">{t.commuteName}</span>
          <input value={draft.name} maxLength={40} placeholder={t.commuteNamePlaceholder} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          {shown('name') ? <small className="field-error" role="alert">{shown('name')}</small> : null}
        </label>

        <div className="route-stops">
          <StopPicker key={`from${swapped}`} label={t.commuteFrom} value={draft.from.id ? draft.from : null} onChange={(stop) => setDraft({ ...draft, from: stop || { id: '', name: '', type: 'other' } })} search={search} t={t} invalid={Boolean(shown('from') || shown('same'))} error={shown('from') || shown('same')} />
          <button type="button" className="icon-button swap-button" onClick={swap} aria-label={t.commuteSwap} title={t.commuteSwap}><Icon name="swap" /></button>
          <StopPicker key={`to${swapped}`} label={t.commuteTo} value={draft.to.id ? draft.to : null} onChange={(stop) => setDraft({ ...draft, to: stop || { id: '', name: '', type: 'other' } })} search={search} t={t} invalid={Boolean(shown('to'))} error={shown('to')} />
        </div>
        <StopPicker label={t.commuteVia} value={draft.via} onChange={(stop) => setDraft({ ...draft, via: stop })} search={search} t={t} optional />

        <fieldset className="field schedule-field">
          <legend className="field-label">{t.commuteSchedule}</legend>
          <div className="segments schedule-modes" role="radiogroup" aria-label={t.commuteSchedule}>
            {MODES.map((mode) => (
              <button type="button" role="radio" aria-checked={schedule.mode === mode} key={mode} className={schedule.mode === mode ? 'active' : ''} onClick={() => setDraft({ ...draft, schedule: { ...emptySchedule(mode), days: schedule.days.length ? schedule.days : emptySchedule().days, times: mode === 'times' ? (schedule.times.length ? schedule.times : ['07:00']) : [], bufferMinutes: schedule.bufferMinutes } })}>
                {t.scheduleModes[mode]}
              </button>
            ))}
          </div>
          {schedule.mode === 'times' ? (
            <div className="schedule-times">
              <p className="muted small">{t.scheduleTimesHint}</p>
              {schedule.times.map((time, index) => (
                <div className="time-row" key={index}>
                  <input type="time" value={time} aria-label={t.commuteTimeLabel(index + 1)} aria-invalid={!isClock(time) || undefined} onChange={(event) => setTime(index, event.target.value)} />
                  <button type="button" className="icon-button" aria-label={t.commuteRemoveTime} title={t.commuteRemoveTime} onClick={() => setSchedule({ times: schedule.times.filter((_, at) => at !== index) })}><Icon name="close" size={18} /></button>
                </div>
              ))}
              {schedule.times.length < MAX_TIMES ? <Button tone="outline" icon="plus" onClick={() => setSchedule({ times: [...schedule.times, '07:00'] })}>{t.commuteAddTime}</Button> : null}
              {shown('times') ? <small className="field-error" role="alert">{shown('times')}</small> : null}
            </div>
          ) : null}
          {schedule.mode === 'firstLesson' || schedule.mode === 'lastLesson' ? (
            <div className="schedule-buffer">
              <p className="muted small">{schedule.mode === 'firstLesson' ? t.scheduleFirstHint : t.scheduleLastHint}</p>
              <label className="field">
                <span className="field-label">{schedule.mode === 'firstLesson' ? t.commuteBufferFirst : t.commuteBufferLast}</span>
                <span className="inline-number"><input type="number" min={0} max={60} step={1} value={Number.isFinite(schedule.bufferMinutes) ? schedule.bufferMinutes : ''} onChange={(event) => setSchedule({ bufferMinutes: event.target.value === '' ? Number.NaN : Number(event.target.value) })} /> {t.minutesShort}</span>
                {shown('buffer') ? <small className="field-error" role="alert">{shown('buffer')}</small> : null}
              </label>
            </div>
          ) : null}
          {schedule.mode !== 'none' ? (
            <div className="field">
              <span className="field-label">{t.commuteDays}</span>
              <div className="day-chips" role="group" aria-label={t.commuteDays}>
                {t.weekdays.map((name, index) => {
                  const day = index + 1
                  const on = schedule.days.includes(day)
                  return <button type="button" key={day} aria-pressed={on} className={on ? 'on' : ''} title={t.weekdaysLong[index]} onClick={() => setSchedule({ days: on ? schedule.days.filter((value) => value !== day) : [...schedule.days, day].sort((a, b) => a - b) })}>{name}</button>
                })}
              </div>
              {shown('days') ? <small className="field-error" role="alert">{shown('days')}</small> : null}
            </div>
          ) : null}
        </fieldset>

        <label className="field">
          <span className="field-label">{t.commuteThreshold}</span>
          <select value={draft.delayThreshold == null ? '' : String(draft.delayThreshold)} onChange={(event) => setDraft({ ...draft, delayThreshold: event.target.value === '' ? null : Number(event.target.value) })}>
            <option value="">{t.commuteThresholdGlobal(globalThreshold)}</option>
            {THRESHOLDS.map((minutes) => <option key={minutes} value={minutes}>{t.commuteThresholdMin(minutes)}</option>)}
          </select>
        </label>
        <Toggle checked={draft.notify} onChange={(value) => setDraft({ ...draft, notify: value })} label={t.commuteNotify} />

        {failure ? <Banner tone="danger" icon="warning">{failure}</Banner> : null}
        <div className="dialog-actions">
          <Button tone="quiet" onClick={onClose}>{t.cancel}</Button>
          <Button type="submit" disabled={saving}>{t.save}</Button>
        </div>
      </form>
    </Dialog>
  )
}
