import { dateLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Card, Empty, Tag } from '../components/ui'
import { useClock } from './common'

export const Absences = () => {
  const { t, language, data } = useKanti()
  const clock = useClock()
  const absences = [...(data.snapshot?.absences || [])].sort((left, right) => right.dateFrom.localeCompare(left.dateFrom))
  const open = absences.filter((absence) => !absence.excused).length
  return (
    <div className="view view-absences">
      <div className="stat-row">
        <Card className="stat"><span className="stat-label">{t.absences}</span><span className="stat-value tabular">{absences.length}</span></Card>
        <Card className="stat"><span className="stat-label">{t.open}</span><span className={`stat-value tabular${open ? ' negative' : ''}`}>{open}</span></Card>
      </div>
      <Card className="table-card">
        {absences.length ? (
          <table>
            <thead><tr><th>{t.date}</th><th>{t.time}</th><th>{t.subject}</th><th>{t.reason}</th><th>{t.status}</th></tr></thead>
            <tbody>
              {absences.map((absence) => (
                <tr key={absence.id}>
                  <td className="tabular">{dateLabel(absence.dateFrom, language, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}{absence.dateTo && absence.dateTo !== absence.dateFrom ? ` – ${dateLabel(absence.dateTo, language)}` : ''}</td>
                  <td className="tabular">{[absence.hourFrom, absence.hourTo].filter(Boolean).join('–')}</td>
                  <td>{absence.subject}</td>
                  <td>{absence.reason}</td>
                  <td>
                    {absence.excused ? <Tag tone="success">{t.excused}</Tag> : <Tag tone={absence.excuseUntil && absence.excuseUntil >= clock.today ? 'warning' : 'danger'}>{t.open}</Tag>}
                    {!absence.excused && absence.excuseUntil ? <small className="block muted">{t.excuseUntil(dateLabel(absence.excuseUntil, language))}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty icon="absences">{t.noAbsences}</Empty>}
      </Card>
    </div>
  )
}
