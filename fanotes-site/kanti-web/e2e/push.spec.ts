import { createECDH, randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { appIdentity } from './seed'

const base = () => `http://127.0.0.1:${Number(process.env.E2E_PORT || 4783)}`

const skipTour = async (page: Page) => {
  const tour = page.getByRole('dialog', { name: /Kanti\+ auf dem grossen Bildschirm/ })
  await expect(page.locator('#root .boot, #root .kp-intro')).toHaveCount(0, { timeout: 15_000 })
  if (await tour.isVisible().catch(() => false)) await tour.getByRole('button').first().click()
  await expect(tour).toHaveCount(0)
}

test('the service worker registers at the root scope and the manifest is served', async ({ page }) => {
  await page.goto('/?demo')
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toBe(`${base()}/`)
  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest.name).toBe('Kanti+')
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', '/manifest.webmanifest')
})

test('the demo offers no push subscription', async ({ page }) => {
  await page.goto('/einstellungen?demo')
  await skipTour(page)
  await expect(page.getByRole('heading', { name: 'Einstellungen', exact: true }).first()).toBeVisible()
  await expect(page.getByText('Benachrichtigungen auch bei geschlossenem Tab')).toHaveCount(0)
})

test('settings toggle subscribes with a mocked push manager and unsubscribes again', async ({ page }) => {
  // Headless Chromium has no push service: the browser side is mocked, the server side is the real API.
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const fake = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-synthetic', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  await page.addInitScript((subscription) => {
    // The mock survives a reload like the real browser state does.
    const make = () => ({ ...subscription, toJSON: () => subscription, unsubscribe: async () => { current = null; sessionStorage.removeItem('mock-sub'); return true } })
    let current: unknown = sessionStorage.getItem('mock-sub') ? make() : null
    const registration = {
      scope: `${location.origin}/`,
      pushManager: {
        getSubscription: async () => current,
        subscribe: async () => {
          current = make()
          sessionStorage.setItem('mock-sub', '1')
          return current
        },
      },
    }
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', { value: async () => registration })
    Object.defineProperty(navigator.serviceWorker, 'register', { value: async () => registration })
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: async () => registration })
    Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true })
    let permission = sessionStorage.getItem('mock-perm') || 'default'
    Object.defineProperty(Notification, 'permission', { get: () => permission })
    Notification.requestPermission = async () => { permission = 'granted'; sessionStorage.setItem('mock-perm', 'granted'); return 'granted' }
  }, fake)

  const app = await appIdentity(base())
  const offer = await app.call('POST', '/web-pair/offer', {})
  await app.call('POST', '/web-pair', { code: offer.code, connectionId: 'c0', label: 'E2E Schule', provider: 'schulnetz', finish: true })
  await page.goto('/')
  await skipTour(page)
  await page.locator('.claim-form input').fill(offer.code)
  await page.locator('.claim-form button[type=submit]').click()
  await expect(page.getByRole('heading', { name: 'Heute', exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await page.goto('/einstellungen')
  const toggle = page.getByRole('switch', { name: /Benachrichtigungen auch bei geschlossenem Tab/ })
  await expect(toggle).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await page.locator('.toggle-row', { hasText: 'Benachrichtigungen auch bei geschlossenem Tab' }).click()
  await expect(toggle).toBeChecked()
  const status = async () => (await page.evaluate(async () => (await fetch('/api/v1/kanti-web/push/status', { credentials: 'same-origin' })).json())) as { subscribed: boolean; host: string }
  expect(await status()).toMatchObject({ subscribed: true, host: 'fcm.googleapis.com' })
  // The page keeps it after a reload.
  await page.reload()
  await expect(page.getByRole('switch', { name: /Benachrichtigungen auch bei geschlossenem Tab/ })).toBeChecked()
  await page.locator('.toggle-row', { hasText: 'Benachrichtigungen auch bei geschlossenem Tab' }).click()
  await expect(page.getByRole('switch', { name: /Benachrichtigungen auch bei geschlossenem Tab/ })).not.toBeChecked()
  expect(await status()).toMatchObject({ subscribed: false })
})
