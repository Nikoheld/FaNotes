import { dateLabel, type Language, type Strings } from '../lib/i18n'
import { mensaPrice, type MensaDay } from '../lib/mensa'
import { SectionLabel } from './ui'

/** Compact Mensa card: weekday and date, each dish with label chip, name, short description and student price. */
export const MensaCard = ({ day, t, language }: { day: MensaDay; t: Strings; language: Language }) => (
  <>
    <SectionLabel>{t.mensa}</SectionLabel>
    <section className="card mensa-card" aria-label={t.mensa}>
      <p className="mensa-day">{dateLabel(day.date, language, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      {day.closed ? <p className="muted mensa-closed">{day.note || t.mensaClosed}</p> : null}
      {day.menus.map((menu, index) => (
        <div className="mensa-menu" key={`${menu.name}:${index}`}>
          <div className="mensa-main">
            <span className="mensa-title">{menu.label ? <span className="tag">{menu.label}</span> : null}<span>{menu.name}</span></span>
            {menu.description ? <small className="muted">{menu.description}</small> : null}
          </div>
          {menu.studentPrice != null ? <span className="tabular mensa-price">{t.mensaStudentPrice(mensaPrice(menu.studentPrice))}</span> : null}
        </div>
      ))}
    </section>
  </>
)
