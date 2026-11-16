// Client for the worker endpoints of the FaNotes server (see docs/work-requests-design.md).
// Assumed shapes (documented in README): claim -> {request|null}; messages -> {status, approved, cancelled, messages[]}.
export function createApi({ origin, token, fetchImpl = fetch, timeoutMs = 20_000 }) {
  async function call(method, pathname, body) {
    const res = await fetchImpl(origin + '/api/v1/requests' + pathname, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 204) return null
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${pathname} -> HTTP ${res.status}`)
    return text ? JSON.parse(text) : null
  }
  const enc = encodeURIComponent
  return {
    async claim() {
      const r = await call('POST', '/worker/claim', {})
      return r && (r.request || (r.id ? r : null))
    },
    event: (id, ev) => call('POST', `/worker/requests/${enc(id)}/events`, ev),
    status: (id, payload) => call('POST', `/worker/requests/${enc(id)}/status`, payload),
    async control(id) { return parseControl(await call('GET', `/worker/requests/${enc(id)}/messages`)) },
  }
}

// Normalises the messages endpoint into {approved, cancelled, terminal, messages}.
export function parseControl(r) {
  const status = r?.status || r?.request?.status || ''
  const messages = Array.isArray(r?.messages) ? r.messages : []
  return {
    status,
    approved: r?.approved === true || status === 'approved',
    cancelled: r?.cancelled === true || r?.cancelRequested === true || status === 'cancelled' || status === 'canceled',
    rejected: status === 'rejected',
    messages: messages
      .filter((m) => m && (m.from === undefined || m.from === 'owner' || m.from === 'user'))
      .map((m, i) => ({ id: String(m.id ?? `${m.at ?? ''}:${i}`), text: String(m.text ?? m.body ?? '') }))
      .filter((m) => m.text),
  }
}
