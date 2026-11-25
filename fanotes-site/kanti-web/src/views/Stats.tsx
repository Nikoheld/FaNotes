import { useMemo, type ReactNode } from 'react'
import { dateLabel } from '../lib/i18n'
import { schoolStats } from '../lib/stats'
import { useKanti } from '../state'
import { Card, Empty, SectionLabel } from '../components/ui'
import { useClock } from './common'

const percent = (part: number, whole: number) => (whole ? Math.round((part * 100) / whole) : 0)

const Bar = ({ fraction, tone = 'accent' }: { fraction: number; tone?: 'accent' | 'danger' | 'warning' }) => (
  <span className={`meter tone-${tone === 'accent' ? 'accent' : tone}`} aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} /></span>
)

const Row = ({ title, sub, side, bar, tone }: { title: ReactNode; sub?: ReactNode; side?: ReactNode; bar?: number; tone?: 'accent' | 'danger' | 'warning' }) => (
  <div className="stat-line">
    <div className="stat-line-main">
      <span className="stat-line-title">{title}</span>
      {sub ? <small className="muted stat-line-sub">{sub}</small> : null}
      {bar !== undefined ? <Bar fraction={bar} tone={tone} /> : null}
    </div>
    {side ? <span className="stat-line-side tabular">{side}</span> : null}
  </div>
)

const num = (value: number, language: string) => (Number.isInteger(value) ? String(value) : value.toFixed(1)).replace('.', language === 'de' ? ',' : '.')

export const Stats = () => {
  const { t, language, data } = useKanti()
  const clock = useClock()
  const snapshot = data.snapshot
  // The snapshot can hold many weeks: compute once per snapshot, not per render.
  const stats = useMemo(() => (snapshot ? schoolStats(snapshot) : null), [snapshot])
  if (!stats) return <div className="view view-stats"><Card><Empty icon="info">{t.statsCoverageNone}</Empty></Card></div>
  const day = (iso: string, short = true) => dateLabel(iso, language, short ? { day: 'numeric', month: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' })
  const cancellations = stats.cancellations
  const totals = cancellations.totals
  const grading = stats.grading
  const peakExam = Math.max(1, ...stats.examLoad.weeks.map((week) => week.count))
  const peakAbsence = Math.max(1, ...stats.absences.map((item) => item.count))
  void clock
  return (
    <div className="view view-stats">
      <p className="muted stats-coverage">
        {cancellations.coverage.weeks ? t.statsCoverage(cancellations.coverage.weeks, day(cancellations.coverage.firstDay), day(cancellations.coverage.lastDay)) : t.statsCoverageNone}
        <br />{t.statsNote}
      </p>

      <SectionLabel>{t.statsCancellations}</SectionLabel>
      {totals.total === 0 ? <Card><Empty icon="info">{t.statsCancelledNone}</Empty></Card> : (
        <div className="stats-grid">
          <Card>
            <Row title={t.statsCancelledSummary(totals.cancelled, totals.total, percent(totals.cancelled, totals.total))} sub={t.statsCancelledExtra(totals.substituted, totals.moved, totals.changed)} bar={totals.rate} tone="danger" />
          </Card>
          <Card className="stat-list">
            {cancellations.courses.map((course) => (
              <Row key={course.key} title={course.title || course.key}
                sub={[course.teacher, t.statsCourseCounts(course.cancelled, course.total), course.substituted ? t.statsSubstituted(course.substituted) : ''].filter(Boolean).join(' · ')}
                side={`${percent(course.cancelled, course.total)}%`} bar={course.rate} tone="danger" />
            ))}
          </Card>
          <Card className="stat-list">
            <h3 className="stat-heading">{t.statsByWeekday}</h3>
            {cancellations.weekdays.map((item) => (
              <Row key={item.weekday} title={dateLabel(`2024-01-0${item.weekday}`, language, { weekday: 'long' })} side={`${item.cancelled}/${item.total}`} bar={item.total ? item.cancelled / item.total : 0} tone="danger" />
            ))}
            {cancellations.clocks.length ? <h3 className="stat-heading">{t.statsByTime}</h3> : null}
            {cancellations.clocks.map((item) => <Row key={item.clock} title={item.clock} side={`${item.cancelled}/${item.total}`} bar={item.total ? item.cancelled / item.total : 0} tone="danger" />)}
          </Card>
          {cancellations.recent.length ? (
            <Card className="stat-list">
              <h3 className="stat-heading">{t.statsLatestCancelled}</h3>
              {cancellations.recent.map((item, index) => <Row key={`${item.day}-${item.clock}-${index}`} title={item.title} side={`${day(item.day, false)} ${item.clock}`.trim()} />)}
            </Card>
          ) : null}
        </div>
      )}

      <SectionLabel>{t.statsGrading}</SectionLabel>
      {grading.median === null || grading.mean === null ? <Card><Empty icon="info">{t.statsGradingNone}</Empty></Card> : (
        <div className="stats-grid">
          <Card>
            <div className="stat-big">{t.statsMedian(num(grading.median, language), grading.median === 1)}</div>
            <small className="muted">{t.statsGradingOverall(num(grading.mean, language), grading.count)}</small>
          </Card>
          <Card className="stat-list">
            {grading.courses.map((course) => (
              <Row key={course.key} title={course.title || course.key}
                sub={[course.teacher, t.statsCourseDelay(num(course.median, language), num(course.mean, language), course.fastest, course.slowest, course.count)].filter(Boolean).join(' · ')}
                side={num(course.median, language)} />
            ))}
          </Card>
          {grading.recent.length ? (
            <Card className="stat-list">
              <h3 className="stat-heading">{t.statsLatestGraded}</h3>
              {grading.recent.map((item, index) => <Row key={`${item.title}-${index}`} title={item.title} sub={[item.course, t.statsGradedRow(day(item.testDay), item.delay)].filter(Boolean).join(' · ')} side={String(item.delay)} />)}
            </Card>
          ) : null}
        </div>
      )}

      <SectionLabel>{t.statsWaiting}</SectionLabel>
      {stats.waiting.length === 0 ? <Card><Empty icon="check">{t.statsWaitingNone}</Empty></Card> : (
        <Card className="stat-list">
          <p className="muted small">{t.statsWaitingHelp}</p>
          {stats.waiting.map((item, index) => <Row key={`${item.examDay}-${item.title}-${index}`} title={item.title} sub={[item.course, day(item.examDay, false)].filter(Boolean).join(' · ')} side={t.statsDaysWaiting(item.daysWaiting)} />)}
        </Card>
      )}

      <SectionLabel>{t.statsChanged}</SectionLabel>
      {stats.gradeChanges.count === 0 ? <Card><Empty icon="check">{t.statsChangedNone}</Empty></Card> : (
        <Card className="stat-list">
          <p className="muted small">{t.statsChangedHelp}</p>
          {stats.gradeChanges.items.map((item, index) => <Row key={`${item.title}-${index}`} title={item.title} sub={[item.course, t.statsChangedRow(day(item.firstSeenDay), item.versions)].filter(Boolean).join(' · ')} />)}
        </Card>
      )}

      <SectionLabel>{t.statsExamLoad}</SectionLabel>
      {stats.examLoad.weeks.length === 0 ? <Card><Empty icon="info">{t.statsExamNone}</Empty></Card> : (
        <Card className="stat-list">
          <Row title={t.statsExamBusiest(day(stats.examLoad.busiestMonday), stats.examLoad.busiestCount)} sub={t.statsExamNext(stats.examLoad.next28)} />
          {stats.examLoad.weeks.map((week) => <Row key={week.monday} title={t.statsExamWeek(day(week.monday))} side={String(week.count)} bar={week.count / peakExam} />)}
        </Card>
      )}

      <SectionLabel>{t.absences}</SectionLabel>
      {stats.absences.length === 0 ? <Card><Empty icon="check">{t.statsAbsenceNone}</Empty></Card> : (
        <Card className="stat-list">
          {stats.absences.map((item) => <Row key={item.subject || '-'} title={item.subject || t.statsNoSubject} sub={t.statsAbsenceRow(item.count, item.excused)} side={String(item.count)} bar={item.count / peakAbsence} />)}
        </Card>
      )}
    </div>
  )
}
