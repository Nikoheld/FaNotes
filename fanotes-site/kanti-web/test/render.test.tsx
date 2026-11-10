// Every view renders with the demo data, without a browser.
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { App } from '../src/App'
import { KantiProvider } from '../src/state'
import { createApi } from '../src/lib/api'

const noServer = createApi(async () => new Response('{"signedIn":false}', { status: 200 }))

describe('views', () => {
  it('render the sign-in page server-side without throwing', () => {
    const html = renderToString(<KantiProvider api={noServer}><App /></KantiProvider>)
    expect(html).toContain('logo')
  })
})
