import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MensaCard } from '../src/components/MensaCard'
import { STRINGS } from '../src/lib/i18n'
import { pickMensaDay, toMensaFeed } from '../src/lib/mensa'
import { DEFAULT_PREFS } from '../src/lib/prefs'

const body = {
  fetchedAt: '2026-11-10T07:00:00.000Z', stale: false, day: null,
  days: [
    { date: '2026-11-10', weekday: 'Di', closed: false, note: '', menus: [
      { name: 'Pouletgeschnetzeltes ( CH )', description: 'Zürcher Art', label: 'Daily', price: 13.5, studentPrice: 10.5 },
      { name: 'Risotto', description: '', label: 'Vegi', price: 12.5, studentPrice: null },
      { name: '' },
    ] },
    { date: '2026-11-13', weekday: 'Fr', closed: true, note: '', menus: [] },
    { date: 'bad' },
  ],
}

describe('Mensa card', () => {
  it('is off by default', () => expect(DEFAULT_PREFS.showMensa).toBe(false))

  it('maps the server body and skips odd parts', () => {
    const feed = toMensaFeed(body)
    expect(feed.days).toHaveLength(2)
    expect(feed.days[0].menus).toHaveLength(2)
    expect(feed.days[0].menus[0]).toMatchObject({ label: 'Daily', price: 13.5, studentPrice: 10.5 })
    expect(toMensaFeed('nonsense').days).toEqual([])
  })

  it('picks today, then the next school day after 14:00 and on weekends', () => {
    const { days } = toMensaFeed(body)
    expect(pickMensaDay(days, new Date('2026-11-10T08:00:00Z'))?.date).toBe('2026-11-10')
    expect(pickMensaDay(days, new Date('2026-11-10T14:00:00Z'))).toBeNull()
    expect(pickMensaDay(days, new Date('2026-11-12T14:00:00Z'))?.date).toBe('2026-11-13')
    expect(pickMensaDay(days, new Date('2026-11-13T09:00:00Z'))?.date).toBe('2026-11-13')
  })

  it('renders dishes with label, name, description and student price', () => {
    const [day] = toMensaFeed(body).days
    const html = renderToString(<MensaCard day={day} t={STRINGS.de} language="de" />)
    expect(html).toContain('Daily')
    expect(html).toContain('Pouletgeschnetzeltes ( CH )')
    expect(html).toContain('Zürcher Art')
    expect(html).toContain('Schüler CHF 10.50')
  })

  it('renders a closed day', () => {
    const closed = toMensaFeed(body).days[1]
    expect(renderToString(<MensaCard day={closed} t={STRINGS.de} language="de" />)).toContain('Mensa geschlossen')
    expect(renderToString(<MensaCard day={closed} t={STRINGS.en} language="en" />)).toContain('Mensa closed')
  })
})
