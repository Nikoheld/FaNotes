// Every view renders with the demo data, without a browser.
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { App } from '../src/App'
import { KantiProvider } from '../src/state'
import { createApi } from '../src/lib/api'
import { Absences } from '../src/views/Absences'
import { Today } from '../src/views/Today'
import { EntryDetails, EntryRow, EntryTags } from '../src/views/common'
import { allEntries } from '../src/lib/agenda'
import { demoSnapshot } from '../src/lib/demo'
import { STRINGS } from '../src/lib/i18n'

const noServer = createApi(async () => new Response('{"signedIn":false}', { status: 200 }))

describe('views', () => {
  it('render the sign-in page server-side without throwing', () => {
    const html = renderToString(<KantiProvider api={noServer}><App /></KantiProvider>)
    expect(html).toContain('logo')
  })

  it('renders the cancelled and the changed demo lesson in the timetable, row tags and details', () => {
    const entries = allEntries(demoSnapshot('2026-11-10'))
    const [cancelled] = entries.filter((entry) => entry.cancelled)
    const [changed] = entries.filter((entry) => entry.marker === 'changed')
    for (const language of ['de', 'en'] as const) {
      const t = STRINGS[language]
      const row = renderToString(<EntryRow entry={cancelled} t={t} language={language} today="2026-11-10" />)
      expect(row).toContain('entry-row kind-lesson cancelled')
      expect(row).toContain(t.cancelled)
      const rowChanged = renderToString(<EntryRow entry={changed} t={t} language={language} today="2026-11-10" />)
      expect(rowChanged).toContain(t.markChanged)
      const details = renderToString(<EntryDetails entry={changed} t={t} language={language} />)
      expect(details).toContain(t.substituteBy('Lehrperson Z'))
      expect(renderToString(<EntryDetails entry={cancelled} t={t} language={language} />)).toContain('class="struck"')
    }
    expect(STRINGS.de.substituteBy('X')).toBe('Vertretung: X')
    expect(STRINGS.en.markAdded).toBe('Extra lesson')
    expect(renderToString(<EntryTags entry={{ ...changed, marker: 'moved', substitution: false }} t={STRINGS.de} />)).toContain('Verschoben')
  })

  it('shows open reports with their estimate and the combined quota', () => {
    const html = renderToString(<KantiProvider api={noServer} demo><Absences /></KantiProvider>)
    // Booked 5, an open double lesson estimated 2 + 1 = 3, so 22 of 30 remain.
    expect(html).toMatch(/Geschätzt · offen|Estimated · open/u)
    expect(html).toMatch(/≈ 3 (Punkte|points)/u)
    expect(html).toMatch(/Lektionen am Stück: 2 \+ 1 = 3 Punkte|lessons in a row: 2 \+ 1 = 3 points/u)
    expect(html).toMatch(/22<small class="stat-of">\/ (<!-- -->)?30<\/small>/u)
    const today = renderToString(<KantiProvider api={noServer} demo><Today /></KantiProvider>)
    expect(today).toMatch(/noch 22 von 30|22 of 30 left/u)
  })
})
