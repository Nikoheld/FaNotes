import { dateLabel } from '../lib/i18n'
import { useKanti } from '../state'
import { Card, Empty, SectionLabel } from '../components/ui'

/** School messages and announcements, what changed lately, and the account statement. */
export const Updates = () => {
  const { t, language, data, news } = useKanti()
  const snapshot = data.snapshot
  const messages = [...(snapshot?.messages || [])].sort((left, right) => (right.at || '').localeCompare(left.at || ''))
  return (
    <div className="view view-updates">
      <div className="columns">
        <div className="column column-main">
          <SectionLabel>{t.messages}</SectionLabel>
          {(snapshot?.startMessages || []).map((line, index) => <Card key={`start-${index}`} className="message"><p>{line}</p></Card>)}
          {messages.length ? messages.map((message) => (
            <Card key={message.id} className="message">
              <header><h3>{message.title}</h3><small className="tabular">{message.at ? dateLabel(message.at.slice(0, 10), language) : ''}</small></header>
              <p>{message.body}</p>
            </Card>
          )) : (snapshot?.startMessages || []).length ? null : <Card><Empty icon="updates">{t.noMessages}</Empty></Card>}
        </div>
        <aside className="column column-side">
          <SectionLabel>{t.news}</SectionLabel>
          <Card className="list">
            {news.length ? news.slice(0, 20).map((change) => (
              <div key={`${change.id}-${change.revision}`} className="news-row">
                <span className="grade-title">{change.title}</span>
                <small>{change.body}</small>
                <small className="muted tabular">{change.at ? new Date(change.at).toLocaleString(language === 'de' ? 'de-CH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }) : ''}</small>
              </div>
            )) : <Empty icon="bell">{t.noNews}</Empty>}
          </Card>
          {snapshot?.konto?.length ? (
            <>
              <SectionLabel>{t.statement}</SectionLabel>
              <Card className="table-card">
                <table>
                  <thead><tr><th>{t.date}</th><th>{t.title}</th><th className="number">{t.amount}</th><th className="number">{t.balance}</th></tr></thead>
                  <tbody>{snapshot.konto.map((line, index) => (
                    <tr key={`${line.date}-${index}`}><td className="tabular">{dateLabel(line.date, language)}</td><td>{line.label}</td><td className="number tabular">{line.amount}</td><td className="number tabular">{line.balance}</td></tr>
                  ))}</tbody>
                </table>
              </Card>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
