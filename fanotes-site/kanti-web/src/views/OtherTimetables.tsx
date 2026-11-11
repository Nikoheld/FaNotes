import { useEffect, useMemo, useState } from 'react'
import { dateLabel } from '../lib/i18n'
import { cellEntries, cellLabel, roomStarts, type RoomWeek, type TimetableSummary } from '../lib/timetables'
import { useKanti } from '../state'
import { Banner, Button, Card, Empty } from '../components/ui'

type Segment = 'classes' | 'rooms'

const RoomTable = ({ week }: { week: RoomWeek }) => {
  const { t } = useKanti()
  const starts = useMemo(() => roomStarts(week.entries), [week])
  if (!starts.length) return <Empty icon="info">{t.roomEmpty}</Empty>
  return (
    <div className="room-week-scroll">
      <table className="room-week">
        <thead>
          <tr><th scope="col">{t.time}</th>{[0, 1, 2, 3, 4].map((day) => <th scope="col" key={day}>{t.weekdays[day]}</th>)}</tr>
        </thead>
        <tbody>
          {starts.map((start) => (
            <tr key={start}>
              <th scope="row" className="tabular">{start}</th>
              {[1, 2, 3, 4, 5].map((day) => (
                <td key={day}>
                  {cellLabel(cellEntries(week.entries, day, start)).map((item) => (
                    <div key={item.text + item.classes} className="room-cell"><strong>{item.text}</strong><small className="muted">{item.classes}</small></div>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The school's timetable for other classes (as a picture of the PDF page) and for rooms (as a week table). */
export const OtherTimetables = ({ summary }: { summary: TimetableSummary }) => {
  const kanti = useKanti()
  const { t, api, active, language } = kanti
  const classes = summary.classes || []
  const rooms = summary.rooms || []
  const [segment, setSegment] = useState<Segment>(classes.length ? 'classes' : 'rooms')
  const [code, setCode] = useState(classes[0]?.code || '')
  const [room, setRoom] = useState(rooms[0] || '')
  const [week, setWeek] = useState<RoomWeek | null>(null)
  const [failed, setFailed] = useState(false)
  const connectionId = active?.id || ''

  useEffect(() => {
    if (segment !== 'rooms' || !room || !connectionId) return undefined
    let live = true
    setFailed(false)
    api.timetableRoom(connectionId, room).then((value) => { if (live) setWeek(value) }).catch(() => { if (live) { setWeek(null); setFailed(true) } })
    return () => { live = false }
  }, [api, connectionId, room, segment])

  const teacher = classes.find((item) => item.code === code)?.teacher || ''
  return (
    <div className="view view-other-timetables">
      <div className="toolbar">
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
      <Card>
        {segment === 'classes' ? (
          <>
            <div className="toolbar-group">
              <label className="select">
                <span className="sr-only">{t.pickClass}</span>
                <select value={code} onChange={(event) => setCode(event.target.value)}>
                  {classes.map((item) => <option key={item.code} value={item.code}>{item.code}</option>)}
                </select>
              </label>
              {teacher ? <span className="muted">{t.classTeacher}: {teacher}</span> : null}
            </div>
            {code && connectionId ? <img className="class-timetable-image" src={api.timetableClassImage(connectionId, code)} alt={t.timetableImageAlt(code)} /> : null}
          </>
        ) : (
          <>
            <div className="toolbar-group">
              <label className="select">
                <span className="sr-only">{t.pickRoom}</span>
                <select value={room} onChange={(event) => setRoom(event.target.value)}>
                  {rooms.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
            </div>
            {failed ? <Banner tone="warning" icon="warning">{t.timetableLoadFailed}</Banner> : week && week.room === room ? <RoomTable week={week} /> : <div className="loading"><span className="spinner" /></div>}
          </>
        )}
        {summary.uploadedAt ? <p className="muted small">{t.timetableSource(summary.semester || '', dateLabel(summary.uploadedAt.slice(0, 10), language))}</p> : null}
      </Card>
    </div>
  )
}
