import { useEffect, useMemo, useState } from 'react'
import { activeCourses, courseSummaries, overallAverage, plusLabel, promotionTotals, wishFor, type CourseMark, type CourseSummary } from '../lib/grades'
import { courseAlias, overrideColor } from '../vault/school'
import { useVault } from '../vault/store'
import { VaultHint, ConfirmDelete } from '../vault/ui'
import { AdjustDialog, CollectiveDialog, OwnGradeDialog, WhatIfDialog } from '../vault/forms'
import type { CollectiveGrade, OwnGrade } from '../vault/files'
import { dateLabel, markLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Banner, Button, Card, Dialog, Empty, Icon, IconButton, SectionLabel, Tag } from '../components/ui'
import { MarkBadge } from './common'
import { MarkTrend, ScaleBar } from '../components/charts'
import { PASS_MARK } from '../lib/charts'
import { changedTrack, lastVersion, removedTracks, seenLabel } from '../lib/gradeHistory'
import type { GradeTrack } from '../types'

export const Grades = () => {
  const kanti = useKanti()
  const { t, data, route } = kanti
  const vault = useVault()
  const { own } = vault
  const all = useMemo(() => courseSummaries(data.snapshot?.grades || [], { book: own.book }), [data.snapshot, own.book])
  // Archived subjects leave the list, the overall average and the promotion points (as in the app).
  const courses = useMemo(() => activeCourses(all), [all])
  const archived = all.filter((course) => course.archived)
  const totals = promotionTotals(courses)
  const overall = overallAverage(courses)
  const requested = route.params.get('fach') || ''
  const selected = all.find((course) => course.key === requested) || null
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

  if (!all.length) return <div className="view"><VaultHint /><Card><Empty icon="grades">{t.noGrades}</Empty></Card></div>

  return (
    <div className="view view-grades">
      <VaultHint compact />
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
                  <span className="course-name">{colorDot(course.label, own.colors)}{courseAlias(course.label, own.desk.courseAliases)}{course.hidden ? <Icon name="eyeOff" size={14} /> : null}{course.marks.some((mark) => mark.own) ? <Tag tone="accent">{t.own}</Tag> : null}</span>
                  <ScaleBar value={course.average} />
                </span>
                <span className="course-average tabular">{markLabel(course.average)}</span>
                <MarkBadge mark={course.zeugnis} t={t} />
                <span className={`course-points tabular ${course.pluspunkte >= 0 ? 'positive' : 'negative'}`}>{course.promotion ? plusLabel(course.pluspunkte) : '–'}</span>
              </button>
            ))}
          </div>
          {archived.length ? (
            <div className="archived-block">
              <p className="archived-head">{t.archivedSubjects}</p>
              <p className="muted small">{t.archivedNote}</p>
              {archived.map((course) => (
                <button type="button" key={course.key} className={`course-row archived${course.key === selected?.key ? ' selected' : ''}`} onClick={() => open(course)}>
                  <span className="course-main"><span className="course-name">{courseAlias(course.label, own.desk.courseAliases)}</span></span>
                  <span className="course-average tabular">{markLabel(course.average)}</span>
                  <span /><span />
                </button>
              ))}
            </div>
          ) : null}
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

/** The colour dot of a subject the student coloured in the app (colors.json); nothing when none was chosen. */
const colorDot = (label: string, colors: Record<string, string>) => {
  const color = overrideColor(label, colors)
  return color ? <i className="subject-dot" style={{ background: color }} aria-hidden="true" /> : null
}

const CourseDetail = ({ course: schoolCourse, onReveal }: { course: CourseSummary; onReveal: (mark: CourseMark) => void }) => {
  const { t, language, data } = useKanti()
  const vault = useVault()
  const { own, actions } = vault
  const editable = actions.schoolWritable
  type Dialog = { type: 'own'; existing: OwnGrade | null } | { type: 'collective'; existing: CollectiveGrade | null } | { type: 'adjust'; mark: CourseMark } | { type: 'whatif' } | { type: 'archive' } | { type: 'history'; track: GradeTrack }
  const [dialog, setDialog] = useState<Dialog | null>(null)
  // With what-if marks the subject page shows the scenario (the app's course page does the same).
  const course = useMemo(() => (own.hypothetical.some((extra) => extra.courseId === schoolCourse.key)
    ? courseSummaries(data.snapshot?.grades || [], { book: own.book, hypothetical: own.hypothetical }).find((item) => item.key === schoolCourse.key) || schoolCourse
    : schoolCourse), [schoolCourse, own.book, own.hypothetical, data.snapshot])
  const scenario = course !== schoolCourse
  const decimals = own.desk.gradeDecimals
  const [target, setTarget] = useState(4.5)
  const [weight, setWeight] = useState(1)
  const wish = wishFor(course, target, weight)
  const wishTone = wish.alreadyMet ? 'success' : wish.achievable && wish.needed != null ? 'accent' : 'danger'
  const history = data.snapshot?.gradeHistory
  const removed = removedTracks(history, schoolCourse.key)
  const rowTools = (mark: CourseMark) => {
    if (mark.hypothetical) return <IconButton icon="close" label={t.removeLocalMark(mark.grade.title)} onClick={() => void actions.removeHypothetical(mark.sourceId || '')} />
    if (mark.collective) {
      const stored = own.book.collective.find((item) => item.id === mark.sourceId) || null
      return <><IconButton icon="edit" label={t.editCollectiveGrade} onClick={() => setDialog({ type: 'collective', existing: stored })} /><IconButton icon="delete" label={t.deleteCollective(mark.grade.title)} onClick={() => void actions.deleteCollective(mark.sourceId || '')} /></>
    }
    if (mark.own) {
      const stored = own.book.own.find((item) => item.id === mark.sourceId) || null
      return <><IconButton icon="edit" label={t.editYourMark} onClick={() => setDialog({ type: 'own', existing: stored })} /><IconButton icon="delete" label={t.deleteOwnMark(mark.grade.title)} onClick={() => void actions.deleteOwnGrade(mark.sourceId || '')} /></>
    }
    if (mark.hidden || mark.mark == null || !mark.targetId) return null
    return <><IconButton icon="edit" label={t.adjustSchoolMark} onClick={() => setDialog({ type: 'adjust', mark })} />{mark.adjusted || mark.excluded ? <Button tone="quiet" className="button-small" onClick={() => void actions.restoreAdjustment(mark.targetId || '')}>{t.restore}</Button> : null}</>
  }
  return (
    <>
      <Card className="course-head">
        <div className="course-title">
          <h2>{colorDot(course.label, own.colors)}{courseAlias(course.label, own.desk.courseAliases)}</h2>
          <p className="muted">{course.archived ? t.archivedNote : course.sport ? t.sportNotCounted : `${t.weight} ${markLabel(course.weight)}`}</p>
        </div>
        {editable ? (
          <div className="course-tools">
            {schoolCourse.archived
              ? <Button tone="outline" icon="check" onClick={() => void actions.restoreCourse(course.key)}>{t.restoreSubject}</Button>
              : <Button tone="quiet" onClick={() => setDialog({ type: 'archive' })}>{t.archiveSubject}</Button>}
          </div>
        ) : null}
        <div className="course-figures">
          <span><small>{scenario ? t.projectedAverage : t.average}</small><strong className="tabular">{markLabel(course.average, scenario ? decimals : 3)}</strong></span>
          <span><small>{t.zeugnis}</small><MarkBadge mark={course.zeugnis} t={t} large /></span>
          <span><small>{t.pluspunkte}</small><strong className={`tabular ${course.pluspunkte >= 0 ? 'positive' : 'negative'}`}>{course.promotion ? plusLabel(course.pluspunkte) : '–'}</strong></span>
        </div>
      </Card>
      {course.marks.some((mark) => mark.counted && !mark.hidden) ? (
        <Card className="trend-card">
          <SectionLabel>{t.gradeTrend}</SectionLabel>
          <MarkTrend marks={course.marks.filter((mark) => !mark.hypothetical)} label={course.label} t={t} language={language} />
        </Card>
      ) : null}
      <Card className="marks">
        {editable ? (
          <div className="marks-tools">
            <Button tone="outline" icon="plus" onClick={() => setDialog({ type: 'own', existing: null })}>{t.addYourMark}</Button>
            <Button tone="outline" icon="plus" onClick={() => setDialog({ type: 'collective', existing: null })}>{t.collectiveGrade}</Button>
            <Button tone="outline" icon="plus" onClick={() => setDialog({ type: 'whatif' })}>{t.whatIf}</Button>
          </div>
        ) : null}
        <table>
          <thead><tr><th>{t.date}</th><th>{t.title}</th><th className="number">{t.weight}</th><th className="number">{t.mark}</th>{editable ? <th /> : null}</tr></thead>
          <tbody>
            {course.marks.map((mark) => (
              <tr key={`${mark.own ? 'own:' : ''}${mark.grade.id}`} className={mark.hidden ? 'hidden-row' : mark.excluded ? 'excluded-row' : ''}>
                <td className="tabular muted">{dateLabel(mark.grade.date, language, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                <td>
                  <span className="mark-title">{mark.grade.title}</span>
                  {mark.own ? <> <Tag tone={mark.hypothetical ? 'warning' : 'accent'}>{mark.hypothetical ? t.whatIf : t.own}</Tag></> : null}
                  {mark.mark == null && !mark.hidden ? <> <Tag>{t.pending}</Tag></> : null}
                  {!mark.own ? <HistoryMarker track={changedTrack(history, mark.grade)} onOpen={(track) => setDialog({ type: 'history', track })} /> : null}
                  {mark.excluded ? <small className="block muted">{t.excludedSchool(markLabel(mark.displayMark), markLabel(mark.displayWeight))}</small> : mark.adjusted ? <small className="block muted">{t.adjustedSchool(markLabel(mark.displayMark), markLabel(mark.displayWeight))}</small> : null}
                  {mark.grade.comment ? <small className="block muted">{mark.grade.comment}</small> : null}
                </td>
                <td className="number tabular muted">{markLabel(mark.weight)}</td>
                <td className="number">{mark.hidden ? <Button tone="outline" icon="eye" onClick={() => onReveal(mark)}>{t.reveal}</Button> : <MarkBadge mark={mark.excluded ? mark.displayMark : mark.mark} t={t} />}</td>
                {editable ? <td className="row-tools">{rowTools(mark)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {removed.length ? (
        <Card className="removed-grades">
          <details>
            <summary>{t.removedGrades} <Tag>{removed.length}</Tag></summary>
            <p className="muted small">{t.removedNote}</p>
            <table>
              <thead><tr><th>{t.date}</th><th>{t.title}</th><th className="number">{t.weight}</th><th className="number">{t.mark}</th></tr></thead>
              <tbody>
                {removed.map((track) => {
                  const last = lastVersion(track)
                  return (
                    <tr key={track.id}>
                      <td className="tabular muted">{dateLabel(last.date, language, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td>
                        <span className="mark-title">{last.title}</span>
                        <small className="block muted">{t.removedOn} {seenLabel(track.removedAt || '', language)}</small>
                        <HistoryMarker track={track.versions.length > 1 ? track : null} onOpen={(item) => setDialog({ type: 'history', track: item })} />
                      </td>
                      <td className="number tabular muted">{markLabel(last.weight)}</td>
                      <td className="number">{track.hidden ? <Tag>{t.hiddenGrade}</Tag> : <MarkBadge mark={last.mark} t={t} />}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </details>
        </Card>
      ) : null}
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
      {dialog?.type === 'history' ? <HistoryDialog track={dialog.track} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === 'own' ? <OwnGradeDialog courseId={course.key} existing={dialog.existing} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === 'collective' ? <CollectiveDialog courseId={course.key} existing={dialog.existing} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === 'whatif' ? <WhatIfDialog courseId={course.key} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === 'adjust' ? <AdjustDialog mark={dialog.mark} existing={own.book.adjustments.find((item) => item.targetId === dialog.mark.targetId) || null} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === 'archive' ? <ConfirmDelete title={t.archiveTitle} body={t.archiveBody} confirm={t.archive} onConfirm={() => actions.archiveCourse(course.key)} onClose={() => setDialog(null)} /> : null}
    </>
  )
}

/** The "Verlauf" marker of a grade that changed: opens the list of its versions. */
const HistoryMarker = ({ track, onOpen }: { track: GradeTrack | null; onOpen: (track: GradeTrack) => void }) => {
  const { t } = useKanti()
  if (!track) return null
  const title = lastVersion(track).title
  return (
    <button type="button" className="history-marker" aria-label={t.gradeHistoryOf(title)} title={t.gradeHistoryOf(title)} onClick={() => onOpen(track)}>
      <Icon name="history" size={14} />{t.gradeHistory}
    </button>
  )
}

/** Every version the server saw, newest first, with the time it first saw it. */
const HistoryDialog = ({ track, onClose }: { track: GradeTrack; onClose: () => void }) => {
  const { t, language } = useKanti()
  const versions = [...track.versions].reverse()
  return (
    <Dialog title={t.gradeHistoryOf(lastVersion(track).title)} onClose={onClose}>
      <ol className="history-list">
        {versions.map((version, index) => (
          <li key={`${version.seenAt}-${index}`}>
            <span className="history-mark">{track.hidden ? <Tag>{t.hiddenVersion}</Tag> : <MarkBadge mark={version.mark} t={t} />}</span>
            <span className="history-detail">
              <strong>{version.title}</strong>
              <small className="block muted">{t.weight} {markLabel(version.weight)} · {dateLabel(version.date, language, { day: 'numeric', month: 'short', year: 'numeric' })}</small>
              <small className="block muted">{t.seenOn} {seenLabel(version.seenAt, language)}{index === 0 && !track.removedAt ? ` · ${t.gradeCurrent}` : ''}</small>
            </span>
          </li>
        ))}
      </ol>
      {track.removedAt ? <p className="muted small">{t.removedOn} {seenLabel(track.removedAt, language)}</p> : null}
      <Button onClick={onClose}>{t.done}</Button>
    </Dialog>
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
