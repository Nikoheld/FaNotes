// Pendelstrecken in the browser. The commute endpoints are mocked (no timetable provider in CI);
// the page itself, its sign-in and the CSRF handling are the real ones.
import { expect, test, type Page } from '@playwright/test'
import { appIdentity, COMMUTE_STOPS, commuteBoard } from './seed'

const base = () => `http://127.0.0.1:${Number(process.env.E2E_PORT || 4783)}`
const PROVIDER = { name: 'search.ch', occupancy: 'train-class', formation: false }

/** Mocks /commute, /commute/stops and /commute/board; PUT stores the list like the server does. */
const mockCommute = async (page: Page) => {
  const state = { routes: [] as Record<string, unknown>[], settings: { delayThreshold: 3, hiddenLabels: [] as string[] }, saved: [] as unknown[], tripRequests: [] as string[] }
  await page.route('**/api/v1/kanti-web/connections/*/commute**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname.endsWith('/commute/stops')) {
      const q = (url.searchParams.get('q') || '').toLowerCase()
      return json({ stops: COMMUTE_STOPS.filter((stop) => stop.name.toLowerCase().includes(q)) })
    }
    if (url.pathname.endsWith('/commute/board')) return json({ boards: state.routes.map((entry) => commuteBoard(String(entry.id))), provider: PROVIDER })
    if (url.pathname.endsWith('/commute/trip')) {
      state.tripRequests.push(url.search)
      const board = commuteBoard(String(url.searchParams.get('route')))
      const found = board.trips.find((entry) => entry.id === url.searchParams.get('trip'))
      if (!found) return json({ trip: null, gone: true, updatedAt: board.updatedAt, stale: false })
      const leg = found.legs[0] as Record<string, unknown>
      const stops = [{ name: 'Mittelstadt', stopId: 'e2e-mid', arrival: { planned: found.plannedDeparture, time: found.plannedDeparture, delay: 0 }, departure: null, platform: '2', platformChanged: false, realtime: true, cancelled: false, occupancy: { first: null, second: null } }]
      const trip = { ...found, legs: [{ ...leg, journeyId: 'e2e', stopCount: 1, stops }] }
      return json({ trip, position: { state: 'notStarted', legIndex: 0, point: 0, progress: 0, estimated: false }, updatedAt: board.updatedAt, stale: false, gone: false, sources: { realtime: 'search.ch', platforms: null, formation: null } })
    }
    if (url.pathname.endsWith('/commute/trips')) return json({ trips: [] })
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { routes: Record<string, unknown>[]; settings: typeof state.settings }
      state.saved.push(body)
      state.routes = body.routes
      state.settings = { ...state.settings, ...body.settings }
    }
    return json({ routes: state.routes, settings: state.settings, provider: PROVIDER })
  })
  return state
}

const skipTour = async (page: Page) => {
  const tour = page.getByRole('dialog', { name: /Kanti\+ auf dem grossen Bildschirm/ })
  if (await tour.isVisible().catch(() => false)) await tour.getByRole('button').first().click()
  await expect(tour).toHaveCount(0)
}

const signIn = async (page: Page) => {
  const app = await appIdentity(base())
  await page.goto('/')
  await skipTour(page)
  await page.getByRole('button', { name: 'Code anzeigen' }).first().click()
  const code = (await page.locator('.pairing-code').innerText()).trim()
  await app.call('POST', '/web-pair', { code, connectionId: 'c0', label: 'E2E Schule', provider: 'schulnetz', finish: true })
  await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 15_000 })
}

test('commute: add a route in the editor, see the board and a cancellation with its alternative', async ({ page }) => {
  const state = await mockCommute(page)
  await signIn(page)

  // The empty Today card invites to add a route and opens the editor.
  await expect(page.getByText('Dein Schulweg, live').first()).toBeVisible()
  await page.getByRole('button', { name: 'Strecke hinzufügen' }).first().click()
  const editor = page.getByRole('dialog', { name: 'Neue Strecke' })
  await expect(editor).toBeVisible()

  // Saving without stops shows the validation messages.
  await editor.getByRole('button', { name: 'Speichern' }).click()
  await expect(editor.getByText('Wähle die Starthaltestelle aus der Liste.')).toBeVisible()

  await editor.getByLabel('Name (optional)').fill('E2E Schule')
  const from = editor.getByRole('combobox', { name: 'Von' })
  await from.fill('Test')
  await expect(editor.getByRole('option', { name: /Testdorf Bahnhof/ })).toBeVisible()
  await from.press('ArrowDown')
  await from.press('Enter')
  const to = editor.getByRole('combobox', { name: 'Nach' })
  await to.fill('Schulst')
  await editor.getByRole('option', { name: /Schulstadt Bahnhof/ }).click()
  await editor.getByRole('button', { name: 'Speichern' }).click()
  await expect(editor).toHaveCount(0)

  // The board: the first trip is cancelled, the alternative is offered and marked as less crowded.
  await expect(page).toHaveURL(/\/pendeln/)
  await expect(page.getByRole('heading', { name: 'E2E Schule', exact: true })).toBeVisible()
  await expect(page.getByText('Diese Verbindung fällt aus').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Alternativen' })).toBeVisible()
  await expect(page.getByText('Weniger voll').first()).toBeVisible()
  await expect(page.getByText(/Auslastungsprognose pro Zug und Klasse/)).toBeVisible()
  // A trip card opens the connection detail, loaded from the server's trip endpoint with route, trip and planned departure.
  await page.locator('.alternatives .trip-head').first().click()
  const detail = page.getByRole('dialog', { name: 'Verbindungsdetail' })
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/verbindung=e2e-alt/)
  await expect(detail.locator('.dt-leg').first()).toBeVisible()
  await expect(detail.getByText('Mittelstadt')).toHaveCount(0)
  await detail.getByRole('button', { name: '1 Zwischenhalt' }).click()
  await expect(detail.getByText('Mittelstadt')).toBeVisible()
  await expect(detail.getByText('Noch nicht abgefahren')).toBeVisible()
  expect(state.tripRequests).toHaveLength(1)
  expect(state.tripRequests[0]).toMatch(/route=[0-9a-f]{12}&trip=e2e-alt&at=/u)
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)

  // The saved list carries 12 hex characters of id and the full route.
  expect(state.saved).toHaveLength(1)
  const saved = (state.saved[0] as { routes: { id: string; from: { id: string }; to: { id: string } }[] }).routes[0]
  expect(saved.id).toMatch(/^[0-9a-f]{12}$/u)
  expect([saved.from.id, saved.to.id]).toEqual(['e2e-testdorf', 'e2e-schulstadt'])

  // Today shows the card for the route.
  await page.goto('/')
  await expect(page.locator('.commute-card').getByText('E2E Schule')).toBeVisible()
  await expect(page.locator('.commute-card')).toContainText('Diese Verbindung fällt aus')
})

// ---- Demo mode: fixed connection, the secondary list and two via stops (nothing leaves the browser) ----

const openDemo = async (page: Page, path = '/pendeln') => {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}demo`)
  await skipTour(page)
  await expect(page.locator('.view-commute')).toBeVisible()
}

test('commute demo: the pinned connection is the focus and the others hide behind an expander', async ({ page }) => {
  await openDemo(page, '/pendeln?strecke=d3m0c9d0e1f2')
  await expect(page.getByRole('heading', { name: 'Fester Zug', exact: true })).toBeVisible()
  const pinned = page.locator('.trip-pinned')
  await expect(pinned).toHaveCount(1)
  await expect(pinned).toContainText('Feste Verbindung')
  await expect(pinned).toContainText('+2 Min.')
  await expect(pinned).toContainText('IR16')

  // Other connections are collapsed until asked for.
  const toggle = page.getByRole('button', { name: 'Andere Verbindungen anzeigen' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.others-body')).toHaveCount(0)
  await expect(page.locator('.board-body .trip')).toHaveCount(1)
  await toggle.click()
  await expect(page.getByRole('button', { name: 'Andere Verbindungen ausblenden' })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.others-body .trip')).toHaveCount(2)
  await expect(page.locator('.others-body').getByRole('button', { name: 'Frühere Verbindungen' })).toBeVisible()

  // Plain routes keep their list.
  await page.getByRole('tab', { name: 'Schule' }).click()
  await expect(page.locator('.board-body .trip').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Andere Verbindungen anzeigen' })).toHaveCount(0)

  // Today: the card shows the fixed connection of the relevant route.
  await page.getByRole('tab', { name: 'Fester Zug' }).click()
  await expect(page.locator('.trip-pinned')).toHaveCount(1)
})

test('commute demo: a route with two via stops', async ({ page }) => {
  await openDemo(page, '/pendeln?strecke=d3m0a9b8c7d6')
  await expect(page.getByRole('heading', { name: 'Seeweg', exact: true })).toBeVisible()
  await expect(page.locator('.board-stops')).toContainText('über Mittelwil, Testdorf, Bahnhof')
  await page.getByRole('button', { name: /Bearbeiten: Seeweg/ }).click()
  const editor = page.getByRole('dialog', { name: 'Strecke bearbeiten' })
  await expect(editor.getByRole('combobox', { name: 'Über (optional)' })).toHaveValue('Mittelwil')
  await expect(editor.getByRole('combobox', { name: 'Über, 2. Halt (optional)' })).toHaveValue('Testdorf, Bahnhof')
  await expect(editor.getByRole('button', { name: 'Via hinzufügen' })).toHaveCount(0)
})

test('commute demo: choose a fixed connection in the editor, per day and per weekday', async ({ page }) => {
  await openDemo(page)
  await page.getByRole('button', { name: 'Strecke hinzufügen' }).first().click()
  const editor = page.getByRole('dialog', { name: 'Neue Strecke' })
  await editor.getByLabel('Name (optional)').fill('Mein Weg')

  // Without start and destination the picker stays disabled.
  await editor.getByRole('radio', { name: 'Jeden Tag dieselbe' }).click()
  await expect(editor.getByText(/Wähle zuerst Start und Ziel/)).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Verbindung wählen' })).toBeDisabled()

  await editor.getByRole('combobox', { name: 'Von' }).fill('Testdorf, B')
  await editor.getByRole('option', { name: /Testdorf, Bahnhof/ }).click()
  await editor.getByRole('combobox', { name: 'Nach' }).fill('Schulstadt, K')
  await editor.getByRole('option', { name: /Schulstadt, Kantonsschule/ }).click()

  // Two via stops: the second field comes with "Via hinzufügen".
  await expect(editor.getByRole('button', { name: 'Via hinzufügen' })).toHaveCount(0)
  await editor.getByRole('combobox', { name: 'Über (optional)' }).fill('Mittel')
  await editor.getByRole('option', { name: /Mittelwil/ }).click()
  await editor.getByRole('button', { name: 'Via hinzufügen' }).click()
  await editor.getByRole('combobox', { name: 'Über, 2. Halt (optional)' }).fill('Seeblick')
  await editor.getByRole('option', { name: /Seeblick/ }).click()
  await expect(editor.getByRole('button', { name: 'Via hinzufügen' })).toHaveCount(0)

  // The picker lists connections; a later page extends the list.
  await expect(editor.getByRole('button', { name: 'Verbindung wählen' })).toBeEnabled()
  await editor.getByRole('button', { name: 'Verbindung wählen' }).click()
  const picker = editor.locator('.pin-picker')
  await expect(picker.locator('.pick-trip')).toHaveCount(8)
  await picker.getByRole('button', { name: 'Später' }).click()
  await expect(picker.locator('.pick-trip')).toHaveCount(16)
  await picker.locator('.pick-trip').nth(1).click()
  await expect(picker).toHaveCount(0)
  const summary = editor.locator('.pin-summary')
  await expect(summary).toContainText('S29 ab Testdorf, Bahnhof')
  await expect(summary).toContainText('1 Umstieg')
  await expect(editor.getByText('Gilt: Mo–Fr')).toBeVisible()

  // Changing the route removes the pin with a note.
  await editor.getByRole('combobox', { name: 'Nach' }).fill('Schulstadt')
  await expect(editor.getByText(/feste Verbindung wurde entfernt/)).toBeVisible()
  await expect(editor.locator('.pin-summary')).toHaveCount(0)
  await editor.getByRole('option', { name: /^Schulstadt Bahnhof$/ }).click()

  // Per weekday: Wednesday gets its own connection.
  await editor.getByRole('radio', { name: 'Pro Wochentag' }).click()
  await editor.getByRole('button', { name: 'Verbindung wählen: Mittwoch' }).click()
  await expect(editor.locator('.pin-picker .pick-trip')).toHaveCount(8)
  await editor.locator('.pin-picker .pick-trip').first().click()
  await expect(editor.locator('.pin-summary')).toHaveCount(1)
  await expect(editor.getByRole('button', { name: 'Entfernen: Mittwoch' })).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Verbindung wählen: Dienstag' })).toBeVisible()

  await editor.getByRole('button', { name: 'Speichern' }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Mein Weg', exact: true })).toBeVisible()
  await expect(page.locator('.route-row.active')).toContainText('Feste Verbindung')
})

test('commute demo: change the fixed connection of the pinned route', async ({ page }) => {
  await openDemo(page, '/pendeln?strecke=d3m0c9d0e1f2')
  await page.getByRole('button', { name: /Bearbeiten: Fester Zug/ }).click()
  const editor = page.getByRole('dialog', { name: 'Strecke bearbeiten' })
  await expect(editor.getByRole('radio', { name: 'Jeden Tag dieselbe' })).toHaveAttribute('aria-checked', 'true')
  const before = await editor.locator('.pin-summary').innerText()
  await editor.getByRole('button', { name: 'Ändern' }).click()
  await editor.locator('.pin-picker .pick-trip').nth(3).click()
  await expect(editor.locator('.pin-summary')).not.toHaveText(before)
  await editor.getByRole('button', { name: 'Entfernen' }).click()
  await expect(editor.locator('.pin-summary')).toHaveCount(0)
  await editor.getByRole('radio', { name: /Keine – nächste/ }).click()
  await editor.getByRole('button', { name: 'Speichern' }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.locator('.trip-pinned')).toHaveCount(0)
})

// ---- Connection detail in demo mode: legs, the stops behind "Zwischenhalte", delays, the vehicle, Escape and the back button ----

test('commute demo: the connection detail opens from a trip, shows legs, stops, a delay and where the train is', async ({ page }) => {
  await openDemo(page, '/pendeln?strecke=d3m0a9b8c7d6')
  await page.locator('.trip-head').first().click()
  const detail = page.getByRole('dialog', { name: 'Verbindungsdetail' })
  await expect(detail).toBeVisible()
  await expect(page).toHaveURL(/strecke=d3m0a9b8c7d6&verbindung=.+&ab=/)
  // The lake trip is under way: the ferry is between two stops, the status line says so.
  await expect(detail.getByRole('status').filter({ hasText: 'Zwischen Rebberg und Fischerhaus' })).toBeVisible()
  await expect(detail.locator('.rail-vehicle')).toHaveCount(1)
  // Three legs; the change to the IR is tight.
  await expect(detail.locator('.dt-leg')).toHaveCount(3)
  await expect(detail.getByText('Anschluss gefährdet')).toBeVisible()
  // Collapsed by default; the button reveals the stops (one without real time, one cancelled).
  await expect(detail.getByText('Neumatt')).toHaveCount(0)
  await detail.getByRole('button', { name: '4 Zwischenhalte' }).click()
  await expect(detail.getByText('Neumatt')).toBeVisible()
  await expect(detail.getByText('ohne Echtzeit')).toBeVisible()
  await expect(detail.getByText('Halt fällt aus')).toBeVisible()
  await expect(detail.getByText('Wagenreihung: keine Daten')).toBeVisible()
  await expect(detail.getByText('Echtzeit: search.ch · Gleise: transport.opendata.ch')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(page).not.toHaveURL(/verbindung=/)
})

test('commute demo: a delayed trip shows the delay badge and that it has not left yet; the back button closes the detail', async ({ page }) => {
  await openDemo(page, '/pendeln?strecke=d3m0a1b2c3d4')
  await page.locator('.trip-head').first().click()
  const detail = page.getByRole('dialog', { name: 'Verbindungsdetail' })
  await expect(detail.getByRole('status').filter({ hasText: 'Noch nicht abgefahren' })).toBeVisible()
  await expect(detail.locator('.delay-badge').first()).toHaveText('+4 Min.')
  await expect(detail.locator('.platform-changed').first()).toBeVisible()
  await page.goBack()
  await expect(detail).toHaveCount(0)
  await expect(page.locator('.view-commute')).toBeVisible()
})

test('commute demo: the detail is linkable and the Today card opens the connection it shows', async ({ page }) => {
  await openDemo(page, '/pendeln?strecke=d3m0c9d0e1f2')
  await page.locator('.trip-pinned .trip-head').click()
  await expect(page).toHaveURL(/verbindung=/)
  const link = page.url()
  await page.keyboard.press('Escape')
  await page.goto(`${link}&demo`)
  await expect(page.getByRole('dialog', { name: 'Verbindungsdetail' })).toBeVisible()
  await expect(page.getByRole('dialog').getByText('IR16')).toBeVisible()

  await page.goto('/?demo')
  await skipTour(page)
  await page.locator('.commute-card').click()
  await expect(page.getByRole('dialog', { name: 'Verbindungsdetail' })).toBeVisible()
  await expect(page).toHaveURL(/\/pendeln\?strecke=.+&verbindung=/)
})
