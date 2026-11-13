import { expect, test, type Page } from '@playwright/test'
import { ABSENCE_REASON, CANCELLED_SUBJECT, CHANGED_SUBJECT, SUBSTITUTE, EXAM_TOPIC, GRADE_TITLE, MESSAGE_TITLE, PASSWORD, SUBJECT, appIdentity, fanotesAccount } from './seed'

const base = () => `http://127.0.0.1:${Number(process.env.E2E_PORT || 4783)}`

/** Collects failed API responses and console errors for the whole test. */
const watch = (page: Page) => {
  const problems: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`) })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`)
  })
  return problems
}

/** The first-run tour covers the page until it is skipped (once per browser profile). */
const skipTour = async (page: Page) => {
  const tour = page.getByRole('dialog', { name: /Kanti\+ auf dem grossen Bildschirm/ })
  if (await tour.isVisible().catch(() => false)) await tour.getByRole('button').first().click()
  await expect(tour).toHaveCount(0)
}

const sections: { path: string; heading: string; text: string }[] = [
  { path: '/', heading: 'Heute', text: '' },
  { path: '/stundenplan', heading: 'Stundenplan', text: SUBJECT },
  { path: '/noten', heading: 'Noten', text: GRADE_TITLE },
  { path: '/termine', heading: 'Prüfungen & Termine', text: EXAM_TOPIC },
  { path: '/absenzen', heading: 'Absenzen', text: ABSENCE_REASON },
  { path: '/mitteilungen', heading: 'Mitteilungen', text: MESSAGE_TITLE },
  { path: '/einstellungen', heading: 'Einstellungen', text: '' },
]

const visitEverything = async (page: Page, problems: string[]) => {
  for (const section of sections) {
    await test.step(section.heading, async () => {
      await page.goto(section.path)
      await skipTour(page)
      await expect(page.getByRole('heading', { name: section.heading, exact: true }).first()).toBeVisible()
      if (section.text) await expect(page.getByText(section.text).first()).toBeVisible()
      // Let the view finish loading before looking for banners.
      await page.waitForLoadState('networkidle')
      await expect(page.locator('.banner-danger')).toHaveCount(0)
      await expect(page.getByText('Nicht alles konnte gelesen werden')).toHaveCount(0)
      await expect(page.getByText('Laden fehlgeschlagen')).toHaveCount(0)
    })
  }
  await test.step('marked lessons', async () => {
    await page.goto('/')
    await skipTour(page)
    // A cancelled lesson stays in today's list, struck through and tagged; a changed one names its substitute.
    const cancelled = page.locator('.entry-row.cancelled', { hasText: CANCELLED_SUBJECT })
    await expect(cancelled).toBeVisible()
    await expect(cancelled.getByText('Fällt aus')).toBeVisible()
    const changed = page.locator('.entry-row', { hasText: CHANGED_SUBJECT })
    await expect(changed.getByText('Geändert')).toBeVisible()
    await changed.click()
    // The details dialog names the substitute. (Before noon the same lesson is also the "next" card, so look in the dialog.)
    await expect(page.getByRole('dialog').getByText(`Vertretung: ${SUBSTITUTE}`)).toBeVisible()
  })
  expect(problems).toEqual([])
}

test('pairing: the browser shows a code, the app approves it', async ({ page }) => {
  const problems = watch(page)
  const app = await appIdentity(base())
  await page.goto('/')
  await skipTour(page)
  await page.getByRole('button', { name: 'Code anzeigen' }).first().click()
  const codeText = (await page.locator('.pairing-code').innerText()).trim()
  expect(codeText).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u)
  await app.call('POST', '/web-pair', { code: codeText, connectionId: 'c0', label: 'E2E Schule', provider: 'schulnetz', finish: true })
  await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await visitEverything(page, problems)
})

test('pairing: the app shows a code, the browser takes it', async ({ page }) => {
  const problems = watch(page)
  const app = await appIdentity(base())
  const offer = await app.call('POST', '/web-pair/offer', {})
  await app.call('POST', '/web-pair', { code: offer.code, connectionId: 'c0', label: 'E2E Schule', provider: 'schulnetz', finish: true })
  await page.goto('/')
  await skipTour(page)
  await page.locator('.claim-form input').fill(offer.code)
  await page.locator('.claim-form button[type=submit]').click()
  await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await visitEverything(page, problems)
})

test('FaNotes account sign-in', async ({ page }) => {
  const problems = watch(page)
  const { email } = await fanotesAccount(base())
  await page.goto('/')
  await skipTour(page)
  await page.locator('input[type=email]').fill(email)
  await page.locator('input[type=password]').fill(PASSWORD)
  await page.locator('form:has(input[type=email]) button[type=submit]').click()
  await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await visitEverything(page, problems)
})

test.describe('static pages and the SPA shell', () => {
  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false })
    test('/about/ shows the landing text and the FAQ in plain HTML', async ({ page }) => {
      await page.goto('/about/')
      await expect(page.getByRole('heading', { level: 1, name: /Kanti\+/ })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Ist Kanti+ offiziell?' })).toBeVisible()
      await expect(page.getByText('noch nicht im Play Store').first()).toBeVisible()
      // No horizontal scroll at phone width is covered by the mobile project; here the page must at least render the screenshots.
      await expect(page.locator('img[src$="heute.webp"]')).toHaveCount(1)
    })
    test('/ ships a crawlable intro before the app loads', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { level: 1, name: 'Kanti+' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Was ist Kanti+?' })).toHaveAttribute('href', '/about/')
    })
  })

  test('/about/ does not scroll sideways', async ({ page }) => {
    await page.goto('/about/')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('the intro is replaced by the app after load', async ({ page }) => {
    await page.goto('/?demo')
    await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.kp-intro')).toHaveCount(0)
    await expect(page.getByText('Die Seite wird geladen')).toHaveCount(0)
  })

  test('the sign-in screen links to the landing page', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.signin a[href="/about/"]')).toBeVisible()
  })
})
