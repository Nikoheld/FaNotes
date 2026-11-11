import { useEffect, useMemo, useState } from 'react'
import { courseSummaries, overallAverage, plusLabel, promotionTotals, wishFor, type CourseMark, type CourseSummary } from '../lib/grades'
import { dateLabel, markLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Banner, Button, Card, Dialog, Empty, Icon, SectionLabel, Tag } from '../components/ui'
import { MarkBadge } from './common'
import { MarkTrend, ScaleBar } from '../components/charts'
import { PASS_MARK } from '../lib/charts'

export const Grades = () => {
  const kanti = useKanti()
  const { t, data, route } = kanti
  const courses = useMemo(() => courseSummaries(data.snapshot?.grades || []), [data.snapshot])
  const totals = promotionTotals(courses)
  const overall = overallAverage(courses)
  const requested = route.params.get('fach') || ''
  const selected = courses.find((course) => course.key === requested) || null
  const hidden = courses.reduce((sum, course) => sum + course.hidden, 0)
  const [revealing, setRevealing] = useState<CourseMark | null>(null)
  const averaged = courses.filter((course) => course.average != null)
  const below = averaged.filter((course) => (course.average as number) < PASS_MARK).length
  const best = averaged.reduce<CourseSummary | null>((top, course) => (top == null || (course.average as number) > (top.average as number) ? course : top), null)

  const open = (course: CourseSummary | null) => kanti.navigate('grades', course ? { fach: course.key } : {}, true)

  useEffect(() => {
    if (!requested && courses.length) open(courses[0])
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (action !== 'up' && action !== 'down') return
      const index = Math.max(0, courses.findIndex((course) => course.key === requested))
      const nextIndex = Math.min(courses.length - 1, Math.max(0, index + (action === 'down' ? 1 : -1)))
      if (courses[nextIndex]) open(courses[nextIndex])
    }
    window.addEventListener('kanti:action', onAction)
    return () => window.removeEventListener('kanti:action', onAction)
  })

  if (!courses.length) return <div className="view"><Card><Empty icon="grades">{t.noGrades}</Empty></Card></div>

  return (
    <div className="view view-grades">
      <div className="metric-row">
        <Card className="metric"><span className="metric-label">{t.pluspunkte}</span><span className={`metric-value tabular ${totals.total >= 0 ? 'positive' : 'negative'}`}>{plusLabel(totals.total)}</span><small className="metric-sub tabular">+{totals.plus} / −{Math.abs(totals.minus)}</small></Card>
        <Card className="metric"><span className="metric-label">{t.overall}</span><span className="metric-value tabular">{markLabel(overall)}</span><small className="metric-sub">{t.subjects(courses.length)}</small></Card>
        <Card className="metric"><span className="metric-label">{t.statBelowFour}</span><span className={`metric-value tabular ${below ? 'negative' : 'positive'}`}>{below}</span><small className="metric-sub">{t.statBelowFourSub(averaged.length)}</small></Card>
        <Card className="metric"><span className="metric-label">{t.statBestSubject}</span><span className="metric-value tabular">{best ? markLabel(best.average) : '–'}</span><small className="metric-sub" title={best?.label}>{best?.label || ''}</small></Card>
        {hidden ? <Card className="metric stat-hidden"><span className="metric-label">{t.hiddenGrade}</span><span className="metric-value tabular"><Icon name="eyeOff" size={26} /> {hidden}</span><small className="metric-sub">{t.hiddenCount(hidden)}</small></Card> : null}
      </div>
      <div className="columns columns-grades">
        <Card className="course-card">
          <div className="course-cols" aria-hidden="true"><span>{t.allSubjects}</span><span>{t.average}</span><span>{t.zeugnis}</span><span>{t.pluspunkte}</span></div>
          <div className="course-list" role="listbox" aria-label={t.grades}>
            {courses.map((course) => (
              <button type="button" role="option" aria-selected={course.key === selected?.key} key={course.key} className={`course-row${course.key === selected?.key ? ' selected' : ''}`} onClick={() => open(course)}>
                <span className="course-main">
                  <span className="course-name">{course.label}{course.hidden ? <Icon name="eyeOff" size={14} /> : null}</span>
                  <ScaleBar value={course.average} />
                </span>
                <span className="course-average tabular">{markLabel(course.average)}</span>
                <MarkBadge mark={course.zeugnis} t={t} />
                <span className={`course-points tabular ${course.pluspunkte >= 0 ? 'positive' : 'negative'}`}>{course.promotion ? plusLabel(course.pluspunkte) : '–'}</span>
              </button>
            ))}
          </div>
        </Card>
        <div className="column column-detail">
          {selected ? <CourseDetail course={selected} onReveal={setRevealing} /> : <Card><Empty>{t.pickCourse}</Empty></Card>}
        </div>
      </div>
      {revealing ? <RevealDialog mark={revealing} onClose={() => setRevealing(null)} /> : null}
      <p className="fine">{t.ownMarksNote}</p>
    </div>
  )
}

const CourseDetail = ({ course, onReveal }: { course: CourseSummary; onReveal: (mark: CourseMark) => void }) => {
  const { t, language } = useKanti()
  const [target, setTarget] = useState(4.5)
  const [weight, setWeight] = useState(1)
  const wish = wishFor(course, target, weight)
  const wishTone = wish.alreadyMet ? 'success' : wish.achievable && wish.needed != null ? 'accent' : 'danger'
  return (
    <>
      <Card className="course-head">
        <div className="course-title">
          <h2>{course.label}</h2>
          <p className="muted">{course.sport ? t.sportNotCounted : `${t.weight} ${markLabel(course.weight)}`}</p>
        </div>
        <div className="course-figures">
          <span><small>{t.average}</small><strong className="tabular">{markLabel(course.average, 3)}</strong></span>
          <span><small>{t.zeugnis}</small><MarkBadge mark={course.zeugnis} t={t} large /></span>
          <span><small>{t.pluspunkte}</small><strong className={`tabular ${course.pluspunkte >= 0 ? 'positive' : 'negative'}`}>{course.promotion ? plusLabel(course.pluspunkte) : '–'}</strong></span>
        </div>
      </Card>
      {course.marks.some((mark) => mark.counted && !mark.hidden) ? (
        <Card className="trend-card">
          <SectionLabel>{t.gradeTrend}</SectionLabel>
          <MarkTrend marks={course.marks} label={course.label} t={t} language={language} />
        </Card>
      ) : null}
      <Card className="marks">
        <table>
          <thead><tr><th>{t.date}</th><th>{t.title}</th><th className="number">{t.weight}</th><th className="number">{t.mark}</th></tr></thead>
          <tbody>
            {course.marks.map((mark) => (
              <tr key={mark.grade.id} className={mark.hidden ? 'hidden-row' : ''}>
                <td className="tabular muted">{dateLabel(mark.grade.date, language, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                <td><span className="mark-title">{mark.grade.title}</span>{mark.mark == null && !mark.hidden ? <> <Tag>{t.pending}</Tag></> : null}{mark.grade.comment ? <small className="block muted">{mark.grade.comment}</small> : null}</td>
                <td className="number tabular muted">{markLabel(mark.weight)}</td>
                <td className="number">{mark.hidden ? <Button tone="outline" icon="eye" onClick={() => onReveal(mark)}>{t.reveal}</Button> : <MarkBadge mark={mark.mark} t={t} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {!course.sport ? (
        <Card className="wish">
          <SectionLabel>{t.wish}</SectionLabel>
          <div className="wish-inputs">
            <label>{t.wishTarget}<input type="number" min={1} max={6} step={0.25} value={target} onChange={(event) => setTarget(Number(event.target.value))} /></label>
            <label>{t.wishWeight}<input type="number" min={0.25} max={4} step={0.25} value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></label>
          </div>
          <p className={`wish-result wish-${wishTone}`}><Icon name={wishTone === 'danger' ? 'warning' : 'check'} size={20} /><span>{wish.alreadyMet ? t.wishMet : wish.achievable && wish.needed != null ? t.wishNeeded(markLabel(wish.neededHalf ?? wish.needed)) : t.wishImpossible}</span></p>
        </Card>
      ) : null}
    </>
  )
}

/** Guess first (as in the app's guessing game), then reveal; the mark comes from the server only now. */
const RevealDialog = ({ mark, onClose }: { mark: CourseMark; onClose: () => void }) => {
  const kanti = useKanti()
  const { t } = kanti
  const [guess, setGuess] = useState(4.5)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<number | null>(null)
  const id = mark.grade.targetId || ''
  const shown = kanti.data.snapshot?.grades.find((grade) => grade.targetId === id && !grade.hidden)
  useEffect(() => { if (busy && shown?.mark != null) { setResult(shown.mark); setBusy(false) } }, [busy, shown])
  return (
    <Dialog title={mark.grade.title || t.hiddenGrade} onClose={onClose}>
      {result == null ? (
        <div className="reveal">
          <p>{t.guess}</p>
          <div className="guess-row">
            <input type="range" min={1} max={6} step={0.25} value={guess} onChange={(event) => setGuess(Number(event.target.value))} aria-label={t.guess} />
            <strong className="tabular guess-value">{markLabel(guess)}</strong>
          </div>
          <Button icon="eye" disabled={busy || !id} onClick={async () => { setBusy(true); try { await kanti.reveal([id]) } catch { setBusy(false) } }}>{t.reveal}</Button>
        </div>
      ) : (
        <div className="reveal reveal-done">
          <MarkBadge mark={result} t={t} large />
          <p>{t.guessResult(markLabel(guess), markLabel(result))}</p>
          <Button onClick={onClose}>{t.done}</Button>
        </div>
      )}
      {kanti.demo ? <Banner>{t.demoActive}</Banner> : null}
    </Dialog>
  )
}
