import { useMemo, useState } from 'react'
import { allEntries, weekMonday, type Entry } from '../lib/agenda'
import { dateLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Card, Dialog, Empty, SectionLabel, Toggle } from '../components/ui'
import { EntryDetails, EntryRow, useClock } from './common'

const groupByWeek = (entries: Entry[]) => {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    const monday = weekMonday(entry.day)
    groups.set(monday, [...(groups.get(monday) || []), entry])
  }
  return [...groups.entries()]
}

/** Exams and school events next to each other, grouped by week. */
export const Agenda = () => {
  const { t, language, data, prefs } = useKanti()
  const clock = useClock()
  const [past, setPast] = useState(false)
  const [selected, setSelected] = useState<Entry | null>(null)
  const entries = useMemo(() => allEntries(data.snapshot, prefs.groupChoices), [data.snapshot, prefs.groupChoices])
  const shown = (kind: Entry['kind']) => {
    const list = entries.filter((entry) => entry.kind === kind && (past ? entry.day < clock.today : entry.day >= clock.today))
    return past ? list.reverse() : list
  }
  const column = (kind: Entry['kind'], title: string, empty: string) => {
    const list = shown(kind)
    return (
      <div className="column">
        <SectionLabel>{title} <small>{list.length}</small></SectionLabel>
        {list.length ? groupByWeek(list).map(([monday, items]) => (
          <Card className="list" key={monday}>
            <p className="list-head">{t.weekOf(dateLabel(monday, language, { day: 'numeric', month: 'long' }))}</p>
            {items.map((entry) => <EntryRow key={entry.key} entry={entry} t={t} language={language} today={clock.today} showDay onOpen={() => setSelected(entry)} />)}
          </Card>
        )) : <Card><Empty icon="agenda">{empty}</Empty></Card>}
      </div>
    )
  }
  return (
    <div className="view view-agenda">
      <div className="toolbar"><div className="toolbar-group"><Toggle checked={past} onChange={setPast} label={t.showPast} /></div></div>
      <div className="columns columns-even">
        {column('exam', t.exams, t.noExams)}
        {column('appointment', t.appointments, t.noAppointments)}
      </div>
      {selected ? <Dialog title={selected.title} onClose={() => setSelected(null)}><EntryDetails entry={selected} t={t} language={language} /></Dialog> : null}
    </div>
  )
}
