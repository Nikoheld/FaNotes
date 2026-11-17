// Client for the worker endpoints of the FaNotes server (fanotes-site/work-requests-api.mjs).
//   POST /api/v1/worker/claim                      -> {request|null, busy}
//   POST /api/v1/worker/requests/:id/events        {text, percent}
//   POST /api/v1/worker/requests/:id/status        {status, prNumber?, prUrl?, ci?: pending|success|failure, reason?}
//   POST /api/v1/worker/requests/:id/merged        {prNumber, prUrl?}  (operator: PR merged by hand)
//   GET  /api/v1/worker/requests/:id/messages?after=<seq> -> {messages:[{seq,at,text}], status, approved, cancelled, lastSeq}
//   GET  /api/v1/worker/requests/:id/attachments/(screenshot|logs) -> bytes
export function createApi({ origin, token, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const enc = encodeURIComponent
  async function raw(method, pathname, body) {
    const res = await fetchImpl(origin + '/api/v1/worker' + pathname, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: '*/*' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw Object.assign(new Error(`${method} ${pathname.replace(/r[0-9a-f]{16}/g, ':id')} -> HTTP ${res.status}`), { status: res.status })
    return res
  }
  const json = async (method, pathname, body) => {
    const res = await raw(method, pathname, body)
    const text = res.status === 204 ? '' : await res.text()
    return text ? JSON.parse(text) : null
  }
  return {
    // Returns {request, busy}. The server already moved the request to `picked`.
    async claim() {
      const r = (await json('POST', '/claim', {})) || {}
      return { request: r.request || null, busy: !!r.busy }
    },
    event: (id, ev) => json('POST', `/requests/${enc(id)}/events`, ev),
    status: (id, payload) => json('POST', `/requests/${enc(id)}/status`, payload),
    markMerged: (id, payload) => json('POST', `/requests/${enc(id)}/merged`, payload),
    async control(id, after = 0) { return parseControl(await json('GET', `/requests/${enc(id)}/messages?after=${after}`)) },
    async attachment(id, name) {
      const res = await raw('GET', `/requests/${enc(id)}/attachments/${name}`)
      return Buffer.from(await res.arrayBuffer())
    },
  }
}

// Normalises the messages endpoint into {status, approved, cancelled, rejected, lastSeq, messages}.
export function parseControl(r) {
  const status = r?.status || ''
  const messages = Array.isArray(r?.messages) ? r.messages : []
  return {
    status,
    approved: r?.approved === true,
    // The owner's cancel moves the request to `rejected` and sets `cancelled`.
    cancelled: r?.cancelled === true || status === 'rejected',
    lastSeq: Number(r?.lastSeq) || 0,
    messages: messages
      .map((m, i) => ({ id: String(m.seq ?? m.id ?? `${m.at ?? ''}:${i}`), text: String(m.text ?? '') }))
      .filter((m) => m.text),
  }
}
