import { expect, test, type Page } from '@playwright/test'
import { EVENT_TITLE, OWN_MARK_TITLE, PASSWORD, TASK_TITLE, appIdentity, vaultAccount } from './seed'

const base = () => `http://127.0.0.1:${Number(process.env.E2E_PORT || 4783)}`

const watch = (page: Page) => {
  const problems: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`) })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`)
  })
  return problems
}

const skipTour = async (page: Page) => {
  const tour = page.getByRole('dialog', { name: /Kanti\+ auf dem grossen Bildschirm/ })
  await expect(page.locator('#root .boot, #root .kp-intro')).toHaveCount(0, { timeout: 15_000 })
  if (await tour.isVisible().catch(() => false)) await tour.getByRole('button').first().click()
  await expect(tour).toHaveCount(0)
}

export const signIn = async (page: Page, email: string) => {
  await page.goto('/')
  await skipTour(page)
  await page.locator('input[type=email]').fill(email)
  await page.locator('input[type=password]').fill(PASSWORD)
  await page.locator('form:has(input[type=email]) button[type=submit]').click()
  await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 20_000 })
}

const vaultDatabases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name))

test('own data: the vault opens at sign-in, survives a reload and is wiped at sign-out', async ({ page }) => {
  const problems = watch(page)
  const { email, client } = await vaultAccount(base())
  const syncRequests: string[] = []
  page.on('request', (request) => { if (request.url().includes('/api/v1/sync/')) syncRequests.push(`${request.method()} ${new URL(request.url()).pathname}`) })
  await signIn(page, email)
  // Today: the own task, and the own event in today's list.
  await expect(page.getByText(TASK_TITLE).first()).toBeVisible()
  await expect(page.getByText(EVENT_TITLE).first()).toBeVisible()
  // Grades: the own mark counts and is tagged.
  await page.goto('/noten?fach=ALPHA-1')
  await expect(page.locator('.marks').getByText(OWN_MARK_TITLE)).toBeVisible()
  await expect(page.locator('.marks').getByText('Eigene', { exact: true })).toBeVisible()
  // School mark 5.25 and own mark 6 average to 5.625.
  await expect(page.locator('.course-figures')).toContainText('5.625')
  // The access is kept as non-extractable keys; no password, wrapping key or raw secret is stored.
  expect(await vaultDatabases(page)).toContain('kanti-vault')
  const stored = await page.evaluate(() => new Promise<{ keys: Record<string, boolean>; fields: string[] }>((resolve, reject) => {
    const open = indexedDB.open('kanti-vault', 1)
    open.onsuccess = () => {
      const get = open.result.transaction('access').objectStore('access').get('current')
      get.onsuccess = () => {
        const value = get.result as Record<string, unknown>
        const keys = value.keys as Record<string, CryptoKey>
        resolve({ keys: { data: keys.data.extractable, id: keys.id.extractable, token: (value.tokenKey as CryptoKey).extractable }, fields: Object.keys(value) })
      }
      get.onerror = () => reject(get.error)
    }
  }))
  expect(Object.values(stored.keys)).toEqual([false, false, false])
  expect(stored.fields.sort()).toEqual(['accountId', 'deviceId', 'email', 'expiresAt', 'keys', 'token', 'tokenKey', 'v'])
  // A reload keeps the vault open: the own mark is back without asking for the password again.
  const before = syncRequests.filter((line) => line === 'POST /api/v1/sync/login').length
  await page.reload()
  await skipTour(page)
  await page.goto('/noten?fach=ALPHA-1')
  await expect(page.locator('.marks').getByText(OWN_MARK_TITLE)).toBeVisible()
  await expect(page.getByText('Entsperren')).toHaveCount(0)
  expect(syncRequests.filter((line) => line === 'POST /api/v1/sync/login').length).toBe(before)
  // Sign out: the sync session ends and IndexedDB is wiped.
  await page.goto('/einstellungen')
  await page.getByRole('button', { name: 'In diesem Browser abmelden' }).click()
  await expect(page.locator('input[type=email]')).toBeVisible()
  await expect.poll(() => vaultDatabases(page)).not.toContain('kanti-vault')
  expect(syncRequests).toContain('POST /api/v1/sync/logout')
  expect(problems).toEqual([])
  // The other device can still read the vault (only this browser's session ended).
  expect((await client.list()).length).toBeGreaterThan(3)
})

test('own data: a session paired by code (no password) shows the hint instead', async ({ page }) => {
  const app = await appIdentity(base())
  const offer = await app.call('POST', '/web-pair/offer', {})
  await app.call('POST', '/web-pair', { code: offer.code, connectionId: 'c0', label: 'E2E Schule', provider: 'schulnetz', finish: true })
  await page.goto('/')
  await skipTour(page)
  await page.locator('.claim-form input').fill(offer.code)
  await page.locator('.claim-form button[type=submit]').click()
  await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Mit deinem FaNotes-Konto anmelden, um eigene Noten, Aufgaben und Notizen zu sehen.').first()).toBeVisible()
  await page.goto('/noten')
  await expect(page.getByText('Mit deinem FaNotes-Konto anmelden, um eigene Noten, Aufgaben und Notizen zu sehen.').first()).toBeVisible()
})

test('own data: marks, tasks, events, hidden lessons and planned absences are edited and land encrypted in the vault', async ({ page }) => {
  const problems = watch(page)
  const { email, client } = await vaultAccount(base())
  await signIn(page, email)
  const stored = async (path: string) => { await client.sync(); return new TextDecoder().decode((await client.read(path)).bytes ?? new Uint8Array()) }

  // An own mark: added with the app's form, counted at once, and in grade-book.json for the app to read.
  await page.goto('/noten?fach=ALPHA-1')
  await page.getByRole('button', { name: 'Deine Note hinzufügen' }).click()
  await page.getByLabel('Name', { exact: true }).fill('E2E Note Lambda')
  await page.getByLabel('Note · 1 bis 6').fill('4,5')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.locator('.marks').getByText('E2E Note Lambda')).toBeVisible()
  // 5.25 (school) + 6 (own) + 4.5 (own) over three equal weights.
  await expect(page.locator('.course-figures')).toContainText('5.25')
  expect(await stored('.fanotes/schulnetz/grade-book.json')).toContain('"title":"E2E Note Lambda","mark":4.5,"weight":1.0')

  // The school's own mark can be adjusted without touching the original; restoring brings it back.
  await page.getByRole('button', { name: 'Schulnote anpassen' }).click()
  await page.getByLabel('Deine Note', { exact: true }).fill('3')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.locator('.marks')).toContainText('Angepasst · Schule 5.25 · Gewicht 1')
  await page.locator('.marks').getByRole('button', { name: 'Wiederherstellen' }).click()
  await expect(page.locator('.marks')).not.toContainText('Angepasst')

  // A what-if mark shows the projected average on the subject page and is kept in hypothetical.json.
  await page.getByRole('button', { name: 'Was wäre wenn?', exact: true }).click()
  await page.getByLabel('Note · 1 bis 6').fill('6')
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.getByText('Voraussichtlicher Schnitt')).toBeVisible()
  expect(await stored('.fanotes/schulnetz/hypothetical.json')).toContain('"mark":6.0')

  // A task: created, shown on Today, completed.
  await page.goto('/')
  await page.getByRole('button', { name: /Neue Aufgabe/ }).click()
  await page.getByLabel('Was ist zu tun?').fill('E2E Aufgabe My')
  await page.getByRole('button', { name: 'Aufgabe speichern' }).click()
  await expect(page.locator('.vault-tasks').getByText('E2E Aufgabe My')).toBeVisible()
  expect(await stored('Hausaufgaben.md')).toContain('"title":"E2E Aufgabe My"')
  await page.getByRole('checkbox', { name: /Erledigen: E2E Aufgabe My/ }).click()
  await expect(page.locator('.vault-tasks').getByText('E2E Aufgabe My').first()).toBeHidden()
  expect(await stored('Hausaufgaben.md')).toMatch(/"title":"E2E Aufgabe My".*"done":true/u)

  // An own event with a weekly repeat shows up in the agenda.
  await page.goto('/termine')
  await page.getByRole('button', { name: 'Neuer Termin' }).click()
  await page.getByLabel('Titel des Termins').fill('E2E Termin Ny')
  await page.getByLabel('Wiederholen').selectOption('weekly')
  await page.getByRole('button', { name: 'Termin speichern' }).click()
  await expect(page.getByText('E2E Termin Ny').first()).toBeVisible()
  expect(await stored('Kalender.md')).toContain('"title":"E2E Termin Ny"')
  expect(await stored('Kalender.md')).toContain('"recurrence":"weekly"')

  // A lesson hidden and a planned absence.
  await page.goto('/stundenplan')
  const lessons = page.locator('.block', { hasText: 'Testfach Alpha' })
  await expect(lessons.first()).toBeVisible()
  const before = await lessons.count()
  await lessons.first().click()
  await page.getByRole('button', { name: 'Als geplante Absenz markieren' }).click()
  await expect(page.getByRole('button', { name: 'Geplante Absenz entfernen' })).toBeVisible()
  await page.getByRole('button', { name: 'Diese Lektion ausblenden', exact: true }).click()
  await expect(lessons).toHaveCount(before - 1)
  expect(await stored('.fanotes/schulnetz/hidden-lessons.json')).toContain('"mode":"once"')
  expect(await stored('.fanotes/schulnetz/planned-absences.json')).toContain('"subject":"Testfach Alpha"')
  await page.goto('/absenzen')
  await expect(page.locator('.vault-planned')).toContainText('Testfach Alpha')
  // Settings list the hidden lesson and bring it back.
  await page.goto('/einstellungen')
  await expect(page.locator('.vault-settings')).toContainText('Testfach Alpha')
  await page.locator('.vault-settings').getByRole('button', { name: 'Wieder einblenden' }).click()
  await expect(page.locator('.vault-settings')).toContainText('Keine ausgeblendeten Lektionen')

  // Another device changes the mark file; the next change from the page keeps that change.
  await client.update('.fanotes/schulnetz/grade-book.json', (current) => new TextEncoder().encode(new TextDecoder().decode(current!).replace('"archived":[]', '"archived":["fremd"]')))
  await page.goto('/noten?fach=ALPHA-1')
  await page.getByRole('button', { name: 'Deine Note hinzufügen' }).click()
  await page.getByLabel('Name', { exact: true }).fill('E2E Note Xi')
  await page.getByLabel('Note · 1 bis 6').fill('5')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.locator('.marks').getByText('E2E Note Xi')).toBeVisible()
  const book = await stored('.fanotes/schulnetz/grade-book.json')
  expect(book).toContain('"archived":["fremd"]')
  expect(book).toContain('E2E Note Xi')
  expect(book).toContain('E2E Note Lambda')
  expect(problems).toEqual([])
})
