import { dateLabel, type Language, type Strings } from '../lib/i18n'
import { mensaPrice, type MensaDay, type MensaMenu } from '../lib/mensa'
import { Icon, SectionLabel } from './ui'

/** One dish: label chip, name, short description and the student price. Shared by the Today card and the week view. */
export const MensaDish = ({ menu, t }: { menu: MensaMenu; t: Strings }) => (
  <div className="mensa-menu">
    <div className="mensa-main">
      <span className="mensa-title">{menu.label ? <span className="tag">{menu.label}</span> : null}<span>{menu.name}</span></span>
      {menu.description ? <small className="muted">{menu.description}</small> : null}
    </div>
    {menu.studentPrice != null ? <span className="tabular mensa-price">{t.mensaStudentPrice(mensaPrice(menu.studentPrice))}</span> : null}
  </div>
)

/** Compact Mensa card: weekday and date, each dish with label chip, name, short description and student price. `onWeek` adds the link to the week view. */
export const MensaCard = ({ day, t, language, onWeek }: { day: MensaDay; t: Strings; language: Language; onWeek?: () => void }) => (
  <>
    <SectionLabel action={onWeek ? <button type="button" className="link" onClick={onWeek}>{t.mensaWeek} <Icon name="right" size={16} /></button> : undefined}>{t.mensa}</SectionLabel>
    <section className="card mensa-card" aria-label={t.mensa}>
      <p className="mensa-day">{dateLabel(day.date, language, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      {day.closed ? <p className="muted mensa-closed">{day.note || t.mensaClosed}</p> : null}
      {day.menus.map((menu, index) => <MensaDish key={`${menu.name}:${index}`} menu={menu} t={t} />)}
    </section>
  </>
)
