/** Cache and flood control for the public site. API, notes and downloads are not included. */

export const FAVICON_TARGET = '/assets/fanotes.svg'
export const PUBLIC_LIMIT = 800
export const PUBLIC_WINDOW_MS = 10_000

export const publicCacheControl = (pathname) => {
  if (pathname === '/sitemap.xml' || pathname === '/robots.txt') return 'public, max-age=3600'
  if (pathname.startsWith('/assets/') || pathname.includes('/assets/')) return 'public, max-age=2592000, immutable'
  return 'no-cache'
}

/** Marketing documents only. A shared school address must still be able to open the site. */
export const isLimitedPublicPath = (pathname) => pathname === '/'
  || pathname === '/sitemap.xml'
  || pathname === '/robots.txt'
  || pathname === '/favicon.ico'
  || pathname === '/kantiplus'
  || pathname.startsWith('/kantiplus/')

/** First forwarded hop, or nothing. An empty result means do not limit. */
export const clientAddress = (header) => {
  const first = String(header || '').split(',')[0].trim()
  if (!first || first.length > 64) return ''
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(first)) return first
  if (/^[0-9a-f:]+$/iu.test(first) && first.includes(':')) return first
  return ''
}

export const createPublicLimiter = ({ limit = PUBLIC_LIMIT, windowMs = PUBLIC_WINDOW_MS, now = Date.now, maxKeys = 4096 } = {}) => {
  const hits = new Map()
  return ({ ip, pathname, method }) => {
    if (!ip || (method !== 'GET' && method !== 'HEAD') || !isLimitedPublicPath(pathname)) return false
    const at = now()
    let bucket = hits.get(ip)
    if (!bucket || at - bucket.start >= windowMs) {
      if (!bucket && hits.size >= maxKeys) return false
      bucket = { start: at, count: 0 }
      hits.set(ip, bucket)
    }
    bucket.count += 1
    if (hits.size > maxKeys) {
      for (const [key, value] of hits) {
        if (at - value.start >= windowMs) hits.delete(key)
        if (hits.size <= maxKeys) break
      }
    }
    return bucket.count > limit
  }
}
