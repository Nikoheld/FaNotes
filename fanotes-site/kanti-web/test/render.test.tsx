// Every view renders with the demo data, without a browser.
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { App } from '../src/App'
import { KantiProvider } from '../src/state'
import { createApi } from '../src/lib/api'
import { Absences } from '../src/views/Absences'
import { Today } from '../src/views/Today'

const noServer = createApi(async () => new Response('{"signedIn":false}', { status: 200 }))

describe('views', () => {
  it('render the sign-in page server-side without throwing', () => {
    const html = renderToString(<KantiProvider api={noServer}><App /></KantiProvider>)
    expect(html).toContain('logo')
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
