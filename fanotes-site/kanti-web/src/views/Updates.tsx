import { dateLabel } from '../lib/i18n'
import { kontoFooter } from '../lib/konto'
import { useKanti } from '../state'
import { Card, Empty, Icon, SectionLabel } from '../components/ui'

/** Statement amounts come as the school writes them ("-12.50", "50.00"); positive ones get an explicit plus. */
const signed = (amount: string) => {
  const text = (amount || '').trim()
  if (!text) return { text, tone: '' }
  if (/^[-−–]/u.test(text)) return { text, tone: 'negative' }
  if (/^\+/u.test(text)) return { text, tone: 'positive' }
  return /^\d/u.test(text) && !/^0+([.,]0+)?(\s|$)/u.test(text) ? { text: `+${text}`, tone: 'positive' } : { text, tone: '' }
}

/** School messages and announcements, what changed lately, and the account statement. */
export const Updates = () => {
  const { t, language, data, news } = useKanti()
  const snapshot = data.snapshot
  const footer = kontoFooter(snapshot?.konto || [], snapshot?.kontoSaldo)
  const messages = [...(snapshot?.messages || [])].sort((left, right) => (right.at || '').localeCompare(left.at || ''))
  return (
    <div className="view view-updates">
      <div className="updates-grid">
        <div className="column column-main">
          <SectionLabel>{t.messages}</SectionLabel>
          <div className="message-list">
            {(snapshot?.startMessages || []).map((line, index) => <Card key={`start-${index}`} className="message"><p>{line}</p></Card>)}
            {messages.length ? messages.map((message) => (
              <Card key={message.id} className="message">
                <header><h3>{message.title}</h3><small className="message-date tabular">{message.at ? dateLabel(message.at.slice(0, 10), language, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</small></header>
                <p>{message.body}</p>
              </Card>
            )) : (snapshot?.startMessages || []).length ? null : <Card><Empty icon="updates">{t.noMessages}</Empty></Card>}
          </div>
        </div>
        <aside className="column column-side">
          <SectionLabel>{t.news}</SectionLabel>
          <Card className="list news-card">
            {news.length ? news.slice(0, 20).map((change) => (
              <div key={`${change.id}-${change.revision}`} className="news-row">
                <span className="news-dot" aria-hidden="true" />
                <span className="news-main">
                  <span className="grade-title">{change.title}</span>
                  <small>{change.body}</small>
                  <small className="muted tabular">{change.at ? new Date(change.at).toLocaleString(language === 'de' ? 'de-CH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }) : ''}</small>
                </span>
              </div>
            )) : <Empty icon="bell">{t.noNews}</Empty>}
          </Card>
          {snapshot?.konto?.length ? (
            <>
              <SectionLabel>{t.statement}</SectionLabel>
              <Card className="table-card statement">
                <table>
                  <thead><tr><th>{t.date}</th><th>{t.title}</th><th className="number">{t.amount}</th><th className="number">{t.balance}</th></tr></thead>
                  <tbody>{snapshot.konto.map((line, index) => {
                    const amount = signed(line.amount)
                    return (
                      <tr key={`${line.date}-${index}`}>
                        <td className="tabular muted">{dateLabel(line.date, language, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                        <td>{line.label}</td>
                        <td className={`number tabular amount ${amount.tone}`}>{amount.text}</td>
                        <td className="number tabular muted">{line.balance}</td>
                      </tr>
                    )
                  })}</tbody>
                  {footer ? (
                    <tfoot><tr className="konto-total"><th colSpan={3} scope="row"><Icon name="check" size={18} />{footer.kind === 'calculated' ? t.accountBalanceCalculated : t.accountBalance}</th><td className="number tabular">{footer.amount}</td></tr></tfoot>
                  ) : null}
                </table>
              </Card>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
