// Pendelstrecken in the browser. The commute endpoints are mocked (no timetable provider in CI);
// the page itself, its sign-in and the CSRF handling are the real ones.
import { expect, test, type Page } from '@playwright/test'
import { appIdentity, COMMUTE_STOPS, commuteBoard } from './seed'

const base = () => `http://127.0.0.1:${Number(process.env.E2E_PORT || 4783)}`
const PROVIDER = { name: 'search.ch', occupancy: 'train-class', formation: false }

/** Mocks /commute, /commute/stops and /commute/board; PUT stores the list like the server does. */
const mockCommute = async (page: Page) => {
  const state = { routes: [] as Record<string, unknown>[], settings: { delayThreshold: 3, hiddenLabels: [] as string[] }, saved: [] as unknown[] }
  await page.route('**/api/v1/kanti-web/connections/*/commute**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname.endsWith('/commute/stops')) {
      const q = (url.searchParams.get('q') || '').toLowerCase()
      return json({ stops: COMMUTE_STOPS.filter((stop) => stop.name.toLowerCase().includes(q)) })
    }
    if (url.pathname.endsWith('/commute/board')) return json({ boards: state.routes.map((entry) => commuteBoard(String(entry.id))), provider: PROVIDER })
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
  await page.locator('.alternatives .trip-head').first().click()
  await expect(page.locator('.alternatives .leg').first()).toBeVisible()

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
