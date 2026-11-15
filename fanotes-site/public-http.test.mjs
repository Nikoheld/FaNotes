import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FAVICON_TARGET, PUBLIC_LIMIT, clientAddress, createPublicLimiter, isLimitedPublicPath, publicCacheControl } from './public-http.mjs'

test('sitemap and robots can be cached and pages stay fresh', () => {
  assert.equal(publicCacheControl('/sitemap.xml'), 'public, max-age=3600')
  assert.equal(publicCacheControl('/robots.txt'), 'public, max-age=3600')
  assert.equal(publicCacheControl('/'), 'no-cache')
  assert.equal(publicCacheControl('/kantiplus/datenschutz/'), 'no-cache')
  assert.equal(publicCacheControl('/assets/fanotes.svg'), 'public, max-age=2592000, immutable')
})

test('the automatic favicon request is not a JSON 404', () => {
  const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.equal(FAVICON_TARGET, '/assets/fanotes.svg')
  assert.match(server, /pathname === '\/favicon\.ico'/u)
  assert.match(server, /FAVICON_TARGET/u)
})

test('a flood of the public pages is limited and the API is not', () => {
  let clock = 1_000
  const limit = createPublicLimiter({ now: () => clock })
  const hit = (pathname, method = 'GET', ip = '203.0.113.8') => limit({ ip, pathname, method })
  assert.equal(isLimitedPublicPath('/api/v1/sync'), false)
  assert.equal(isLimitedPublicPath('/notes/'), false)
  assert.equal(hit('/api/health'), false)
  assert.equal(hit('/notes/', 'GET'), false)
  assert.equal(hit('/', 'POST'), false)
  assert.equal(hit('/', 'GET', ''), false)
  for (let i = 0; i < PUBLIC_LIMIT; i += 1) assert.equal(hit('/'), false)
  assert.equal(hit('/'), true)
  clock += 10_000
  assert.equal(hit('/'), false)
  assert.equal(clientAddress('203.0.113.8, 10.0.0.1'), '203.0.113.8')
  assert.equal(clientAddress('not an address'), '')
})
