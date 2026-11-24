// Web Push in the browser: the key decoding, the service worker's push and click handling (run in a
// fake worker scope) and the install manifest. Synthetic notices only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { keyBytes } from '../src/lib/webpush'

const read = (file: string) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8')

type Handler = (event: Record<string, unknown>) => void
const loadWorker = (windows: { url: string; focus: () => Promise<void>; postMessage: (message: unknown) => void }[] = []) => {
  const handlers: Record<string, Handler> = {}
  const shown: { title: string; options: { body: string; tag: string; data: { path: string; connection: string } } }[] = []
  const opened: string[] = []
  const scope = {
    location: { origin: 'https://schulnetz.fasrv.ch' },
    addEventListener: (name: string, handler: Handler) => { handlers[name] = handler },
    skipWaiting: () => {},
    registration: { showNotification: async (title: string, options: never) => { shown.push({ title, options }) } },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url) } },
  }
  new Function('self', read('sw.js'))(scope)
  const push = async (payload: unknown) => {
    const waits: Promise<unknown>[] = []
    handlers.push({ data: payload === undefined ? null : { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) })
    await Promise.all(waits)
  }
  const click = async (data: unknown) => {
    const waits: Promise<unknown>[] = []
    handlers.notificationclick({ notification: { close: () => {}, data }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) })
    await Promise.all(waits)
  }
  return { shown, opened, push, click }
}

describe('service worker', () => {
  it('shows each notice with the page tag and the connection label', async () => {
    const worker = loadWorker()
    await worker.push({ v: 1, c: 'abcdef012345', l: 'Schule', n: [{ i: 'grade:1', t: 'Neue Note', b: 'Mathematik · Test', p: '/noten' }, { i: 'e1', t: 'Ausfall', b: 'Physik', p: '/stundenplan' }] })
    expect(worker.shown.map((item) => item.title)).toEqual(['Schule · Neue Note', 'Schule · Ausfall'])
    expect(worker.shown[0].options.tag).toBe('kanti:grade:1')
    expect(worker.shown[0].options.data).toEqual({ path: '/noten', connection: 'abcdef012345' })
  })

  it('always shows something, and never opens a path outside the app', async () => {
    const worker = loadWorker()
    await worker.push(undefined)
    await worker.push({ n: [{ i: 'x', t: 'T', b: 'B', p: 'https://evil.example/' }] })
    expect(worker.shown).toHaveLength(2)
    expect(worker.shown[1].options.data.path).toBe('/')
  })

  it('a click focuses an open window and tells it where to go, else opens the view', async () => {
    const messages: unknown[] = []
    const open = loadWorker([{ url: 'https://schulnetz.fasrv.ch/noten', focus: async () => {}, postMessage: (message) => messages.push(message) }])
    await open.click({ path: '/noten', connection: 'abcdef012345' })
    expect(messages).toEqual([{ type: 'kanti-open', path: '/noten', connection: 'abcdef012345' }])
    const closed = loadWorker()
    await closed.click({ path: '/noten', connection: 'abcdef012345' })
    expect(closed.opened).toEqual(['/noten?connection=abcdef012345'])
  })
})

describe('install manifest and key', () => {
  it('names Kanti+ and uses the existing icons from the same origin', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'))
    expect(manifest.name).toBe('Kanti+')
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual(['/kanti-icon-512.png', '/kanti-icon.svg'])
    expect(readFileSync(new URL('../index.html', import.meta.url), 'utf8')).toContain('rel="manifest" href="/manifest.webmanifest"')
  })

  it('decodes the base64url application server key', () => {
    const bytes = keyBytes('BAEC_w')
    expect([...bytes]).toEqual([4, 1, 2, 255])
  })
})
