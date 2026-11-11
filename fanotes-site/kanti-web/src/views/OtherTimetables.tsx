import { useEffect, useMemo, useState } from 'react'
import { weekDays, weekMonday } from '../lib/agenda'
import { dateLabel } from '../lib/i18n'
import { classGridEntries, roomGridEntries, type ClassFootnote, type ClassWeek, type RoomWeek, type TimetableSummary } from '../lib/timetables'
import { useKanti } from '../state'
import { Banner, Button, Card, Empty } from '../components/ui'
import { DetailsPanel, WeekGrid, type GridEntry } from '../components/WeekGrid'
import { useClock } from './common'

type Segment = 'classes' | 'rooms'

/** The generic week of a class or room in the same grid as the own timetable, with a details panel. */
const OtherWeek = ({ entries, footnotes = [], empty }: { entries: GridEntry[]; footnotes?: ClassFootnote[]; empty: string }) => {
  const { t } = useKanti()
  const clock = useClock()
  const [selectedKey, setSelectedKey] = useState('')
  const monday = weekMonday(clock.today)
  const days = weekDays(monday)
  const selected = entries.find((entry) => entry.key === selectedKey) || null
  return (
    <>
      <div className="columns columns-timetable">
        <WeekGrid
          days={days}
          today={clock.today}
          entries={entries}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          emptyLabel={<Empty icon="info">{empty}</Empty>}
        />
        <DetailsPanel entry={selected} />
      </div>
      {footnotes.length ? (
        <Card className="footnotes">
          <h3>{t.footnotesTitle}</h3>
          <ul className="footnote-list">
            {footnotes.map((note, index) => (
              <li key={index}><strong className="fn-nr tabular">{note.nr}</strong><span>{[note.subject, note.teacher, note.room].filter(Boolean).join(' · ')}{note.classes.length ? <small className="muted"> {note.classes.join(', ')}{note.classesTruncated ? ' …' : ''}</small> : null}</span></li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  )
}

/** The school's timetable for other classes and for rooms, as week grids like the own timetable. */
export const OtherTimetables = ({ summary }: { summary: TimetableSummary }) => {
  const kanti = useKanti()
  const { t, api, active, language } = kanti
  const classes = summary.classes || []
  const rooms = summary.rooms || []
  const [segment, setSegment] = useState<Segment>(classes.length ? 'classes' : 'rooms')
  const [code, setCode] = useState(classes[0]?.code || '')
  const [room, setRoom] = useState(rooms[0] || '')
  const [week, setWeek] = useState<RoomWeek | null>(null)
  const [classWeek, setClassWeek] = useState<ClassWeek | null>(null)
  const monday = weekMonday(useClock().today)
  const [failed, setFailed] = useState(false)
  const connectionId = active?.id || ''

  useEffect(() => {
    if (segment !== 'rooms' || !room || !connectionId) return undefined
    let live = true
    setFailed(false)
    api.timetableRoom(connectionId, room).then((value) => { if (live) setWeek(value) }).catch(() => { if (live) { setWeek(null); setFailed(true) } })
    return () => { live = false }
  }, [api, connectionId, room, segment])

  useEffect(() => {
    if (segment !== 'classes' || !code || !connectionId) return undefined
    let live = true
    setFailed(false)
    api.timetableClass(connectionId, code).then((value) => { if (live) setClassWeek(value) }).catch(() => { if (live) { setClassWeek(null); setFailed(true) } })
    return () => { live = false }
  }, [api, connectionId, code, segment])

  const classEntries = useMemo(() => (classWeek && classWeek.class === code ? classGridEntries(classWeek, monday) : []), [classWeek, code, monday])
  const roomEntries = useMemo(() => (week && week.room === room ? roomGridEntries(week, monday) : []), [week, room, monday])
  const teacher = classes.find((item) => item.code === code)?.teacher || ''
  return (
    <div className="view view-other-timetables">
      <div className="toolbar tt-toolbar">
        <div className="toolbar-group">
          <Button tone="outline" icon="left" onClick={() => kanti.navigate('timetable')}>{t.backToTimetable}</Button>
          <h2 className="week-title">{t.otherTimetables}</h2>
        </div>
        <div className="segments" role="tablist" aria-label={t.otherTimetables}>
          {(['classes', 'rooms'] as const).map((item) => (
            <button type="button" role="tab" aria-selected={segment === item} key={item} className={segment === item ? 'active' : ''} onClick={() => setSegment(item)}>
              {item === 'classes' ? t.classesTab : t.roomsTab}
            </button>
          ))}
        </div>
      </div>
      <Card className="tt-picker">
        <div className="tt-picker-row">
          {segment === 'classes' ? (
            <>
              <label className="select tt-picker-select">
                <span className="tt-picker-label">{t.pickClass}</span>
                <select value={code} onChange={(event) => setCode(event.target.value)}>
                  {classes.map((item) => <option key={item.code} value={item.code}>{item.code}</option>)}
                </select>
              </label>
              {teacher ? <span className="tt-picker-teacher">{t.classTeacher}: <strong>{teacher}</strong></span> : null}
            </>
          ) : (
            <label className="select tt-picker-select">
              <span className="tt-picker-label">{t.pickRoom}</span>
              <select value={room} onChange={(event) => setRoom(event.target.value)}>
                {rooms.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          )}
          {summary.uploadedAt ? <p className="muted small tt-picker-source">{t.timetableSource(summary.semester || '', dateLabel(summary.uploadedAt.slice(0, 10), language))}</p> : null}
        </div>
        {failed ? <Banner tone="warning" icon="warning">{t.timetableLoadFailed}</Banner> : null}
      </Card>
      {failed ? null : segment === 'classes'
        ? (classWeek && classWeek.class === code ? <OtherWeek key={`c:${code}`} entries={classEntries} footnotes={classWeek.footnotes} empty={t.weekFree} /> : <div className="loading"><span className="spinner" /></div>)
        : (week && week.room === room ? <OtherWeek key={`r:${room}`} entries={roomEntries} empty={t.roomEmpty} /> : <div className="loading"><span className="spinner" /></div>)}
    </div>
  )
}
