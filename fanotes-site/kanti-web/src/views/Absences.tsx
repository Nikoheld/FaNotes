import { useMemo } from 'react'
import { absenceTally, eventDate, type AbsenceEstimate } from '@shared/schulnetz-logic'
import { dateLabel, pointsLabel, type Strings } from '../lib/i18n'
import { useKanti } from '../state'
import { Card, Empty, Tag } from '../components/ui'
import { useClock } from './common'
import type { SchoolAbsence } from '../types'

/** Schulnetz pages give Swiss dates (03.11.2026), REST and the demo ISO dates. */
const isoDay = (raw: string) => eventDate(raw || '') || raw || ''

export const estimateRule = (estimate: AbsenceEstimate, t: Strings) => {
  switch (estimate.rule) {
    case 'exam': return estimate.points < 10 ? t.ruleExamCapped : t.ruleExam
    case 'instrument': return t.ruleInstrument
    case 'special': return estimate.points >= 9 ? t.ruleSpecialFull : t.ruleSpecialHalf
    case 'fallback': return t.ruleFallback(estimate.lessons, estimate.points)
    case 'booked': return t.ruleBooked
    default: return estimate.lessons === 1 ? t.ruleLesson(estimate.points) : t.ruleLessons(estimate.lessons, estimate.points)
  }
}

/** Open (no points yet): an open report, or a row of an older layout that is not excused. */
const isOpen = (absence: SchoolAbsence) => Boolean(absence.pending) || (absence.points == null && !absence.excused)

export const Absences = () => {
  const { t, language, data } = useKanti()
  const clock = useClock()
  const snapshot = data.snapshot
  const tally = useMemo(() => absenceTally(snapshot), [snapshot])
  const absences = [...(snapshot?.absences || [])].sort((left, right) => isoDay(right.dateFrom).localeCompare(isoDay(left.dateFrom)) || left.hourFrom.localeCompare(right.hourFrom))
  const open = absences.filter(isOpen).length
  const withPoints = tally.quota != null || absences.some((absence) => absence.pending || absence.points != null)
  const points = (value: number) => pointsLabel(value, language)
  return (
    <div className="view view-absences">
      <div className="stat-row">
        {tally.quota != null && tally.remaining != null ? (
          <Card className="stat" title={t.absenceExplain}>
            <span className="stat-label">{t.absencePoints} · {t.pointsRemaining}</span>
            <span className={`stat-value tabular${tally.remaining < 0 ? ' negative' : tally.estimated > 0 ? ' warning-text' : ''}`}>{points(tally.remaining)}<small className="stat-of">/ {points(tally.quota)}</small></span>
          </Card>
        ) : null}
        {withPoints ? (
          <>
            <Card className="stat"><span className="stat-label">{t.pointsBooked}</span><span className="stat-value tabular">{points(tally.booked)}</span></Card>
            <Card className="stat" title={t.absenceExplain}>
              <span className="stat-label">{t.pointsEstimated}</span>
              <span className={`stat-value tabular${tally.estimated > 0 ? ' warning-text' : ''}`}>{tally.estimated > 0 ? `≈ ${tally.estimated}` : '0'}</span>
            </Card>
          </>
        ) : (
          <>
            <Card className="stat"><span className="stat-label">{t.absences}</span><span className="stat-value tabular">{absences.length}</span></Card>
            <Card className="stat"><span className="stat-label">{t.open}</span><span className={`stat-value tabular${open ? ' negative' : ''}`}>{open}</span></Card>
          </>
        )}
      </div>
      {withPoints ? (
        <p className="absence-explain">
          {tally.openReports ? <strong>{t.openReports(tally.openReports)} · {t.estimateValue(tally.estimated)}. </strong> : null}
          {t.absenceExplain}
        </p>
      ) : null}
      <Card className="table-card">
        {absences.length ? (
          <table>
            <thead><tr><th>{t.date}</th><th>{t.time}</th><th>{t.subject}</th><th>{t.reason}</th><th>{t.status}</th>{withPoints ? <th className="numeric">{t.pointsColumn}</th> : null}</tr></thead>
            <tbody>
              {absences.map((absence) => {
                const estimate = tally.estimates[absence.id]
                const until = isoDay(absence.excuseUntil || '')
                return (
                  <tr key={absence.id} className={absence.pending ? 'absence-open' : undefined}>
                    <td className="tabular">{dateLabel(isoDay(absence.dateFrom), language, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}{absence.dateTo && isoDay(absence.dateTo) !== isoDay(absence.dateFrom) ? ` – ${dateLabel(isoDay(absence.dateTo), language)}` : ''}</td>
                    <td className="tabular">{[absence.hourFrom, absence.hourTo].filter(Boolean).join('–')}</td>
                    <td>{absence.subject}</td>
                    <td>{absence.reason}</td>
                    <td>
                      {absence.pending ? <span title={estimate ? estimateRule(estimate, t) : t.absenceExplain}><Tag tone="warning">{t.estimatedOpen}</Tag></span>
                        : absence.points != null ? <Tag tone="accent">{t.bookedTag}</Tag>
                          : absence.excused ? <Tag tone="success">{t.excused}</Tag>
                            : <Tag tone={until && until >= clock.today ? 'warning' : 'danger'}>{t.open}</Tag>}
                      {!absence.excused && until ? <small className="absence-note">{t.excuseUntil(dateLabel(until, language))}</small> : null}
                    </td>
                    {withPoints ? (
                      <td className="numeric">
                        {absence.pending && estimate && estimate.rule !== 'booked' ? (
                          <span className="absence-estimate" title={`${estimateRule(estimate, t)}. ${t.absenceExplain}`}>{t.estimateValue(estimate.points)}</span>
                        ) : absence.points != null ? <span className="tabular">{t.pointsValue(points(absence.points))}</span> : null}
                        {absence.pending && estimate ? <small className="absence-note">{estimateRule(estimate, t)}</small> : null}
                        {absence.pending && estimate && estimate.reports > 1 ? <small className="absence-note">{t.sameBlock(estimate.reports - 1)}</small> : null}
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : <Empty icon="absences">{t.noAbsences}</Empty>}
      </Card>
    </div>
  )
}
