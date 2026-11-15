// One JSON line per service event. Callers pass a route without a query string.
// Keys that could carry a credential, and any nested value, are dropped.

import { randomBytes } from 'node:crypto'

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/u
const SECRET_KEY = /authorization|cookie|token|password|email|set-cookie|secret|credential/iu

/** A caller-supplied id when it is a short token. Otherwise a new 16 hex character id. */
export const requestIdFrom = (header) => {
  const value = String(header ?? '').trim()
  return REQUEST_ID.test(value) ? value : randomBytes(8).toString('hex')
}

/** Origin and path only, so a stop name or a time in the query is not logged. */
export const routeOf = (url) => {
  try {
    const parsed = new URL(String(url))
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

const plain = (value) => value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

export const createServiceLog = (service, write = (line) => console.log(line), clock = () => new Date()) => {
  const emit = (level, fields) => {
    const row = { time: clock().toISOString(), service, level }
    for (const [key, value] of Object.entries(fields || {})) {
      if (SECRET_KEY.test(key) || !plain(value)) continue
      row[key] = value
    }
    write(JSON.stringify(row))
  }
  return {
    requestId: requestIdFrom,
    info: (fields) => emit('info', fields),
    warn: (fields) => emit('warn', fields),
  }
}
