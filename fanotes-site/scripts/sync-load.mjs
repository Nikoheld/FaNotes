// Local load of the sync handler. The server is a child process with its own
// temporary directory, so the figures are not mixed with the client. Never
// points at production data.
//
//   node fanotes-site/scripts/sync-load.mjs
//   SYNC_LOAD_NOTES=2000 SYNC_LOAD_ATTACHMENTS=4 SYNC_LOAD_ATTACHMENT_MIB=8 node fanotes-site/scripts/sync-load.mjs
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'

const notes = Number(process.env.SYNC_LOAD_NOTES || 400)
const attachments = Number(process.env.SYNC_LOAD_ATTACHMENTS || 3)
const attachmentBytes = Number(process.env.SYNC_LOAD_ATTACHMENT_MIB || 4) * 1024 * 1024
const concurrency = Number(process.env.SYNC_LOAD_CONCURRENCY || 3)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const b64 = (size) => randomBytes(size).toString('base64')

if (process.env.SYNC_LOAD_LISTEN === '1') {
  const directory = process.env.FANOTES_SYNC_DIR
  const { handleSyncRequest } = await import('../sync-api.mjs')
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (await handleSyncRequest(request, response, url)) return
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.stdout.write(`port ${server.address().port}\n`)
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGTERM', shutdown)
  process.stdin.on('end', shutdown)
  process.stdin.resume()
} else {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-load-'))
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, SYNC_LOAD_LISTEN: '1', FANOTES_SYNC_DIR: dataDirectory, FANOTES_PUBLIC_ORIGIN: 'http://127.0.0.1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const port = await new Promise((resolve, reject) => {
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const match = /port (\d+)/u.exec(buffered)
      if (match) resolve(Number(match[1]))
    })
    child.once('exit', (code) => reject(new Error(`sync server exited ${code} before it listened`)))
  })
  let rssPeakKb = 0
  const sampleRss = () => {
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, 'utf8')
      const match = /^VmRSS:\s+(\d+)/mu.exec(status)
      if (match) rssPeakKb = Math.max(rssPeakKb, Number(match[1]))
    } catch {
      // The child has already exited.
    }
  }
  const sampler = setInterval(sampleRss, 20)

  const call = (method, path, { token, accountId, headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const started = performance.now()
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}`, 'X-FaNotes-Account': accountId } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks),
        ms: performance.now() - started,
      }))
    })
    req.on('error', reject)
    if (body) req.end(body)
    else req.end()
  })

  const jsonCall = async (method, path, payload, token, accountId) => {
    const body = Buffer.from(JSON.stringify(payload ?? {}))
    const response = await call(method, path, {
      token,
      accountId,
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    })
    const json = JSON.parse(response.body.toString('utf8'))
    return { status: response.status, json, ms: response.ms }
  }

  const percentile = (samples, ratio) => {
    if (!samples.length) return 0
    const sorted = [...samples].sort((left, right) => left - right)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
    return Math.round(sorted[index] * 100) / 100
  }
  const summary = (samples) => ({ n: samples.length, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), maxMs: percentile(samples, 1) })

  try {
    const authKey = b64(32)
    const registered = await jsonCall('POST', '/api/v1/sync/register', {
      email: 'load@example.com',
      authKey,
      kdf: { algorithm: 'pbkdf2-sha256', iterations: 300000, salt: b64(16) },
      vaultKeyWrap: { iv: b64(12), data: b64(32) },
      device: { name: 'Load', platform: 'linux' },
    })
    if (registered.status !== 201) throw new Error(`register ${registered.status} ${JSON.stringify(registered.json)}`)
    const accountId = registered.json.accountId
    const tokens = [registered.json.token]
    for (let index = 1; index < concurrency; index += 1) {
      const loggedIn = await jsonCall('POST', '/api/v1/sync/login', {
        email: 'load@example.com',
        authKey,
        device: { name: `Load ${index}`, platform: 'android' },
      })
      if (loggedIn.status !== 200) throw new Error(`login ${loggedIn.status} ${JSON.stringify(loggedIn.json)}`)
      tokens.push(loggedIn.json.token)
    }
    const meta = b64(32)
    const putFile = async (token, id, bytes, base) => {
      const response = await call('PUT', `/api/v1/sync/files/${id}`, {
        token,
        accountId,
        body: bytes,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          'If-Match': String(base),
          'X-FaNotes-Meta': meta,
          'X-FaNotes-Sha256': sha256(bytes),
          'X-FaNotes-Blank': '0',
        },
      })
      if (response.status !== 200) throw new Error(`put ${response.status} ${response.body.toString('utf8').slice(0, 200)}`)
      return { ms: response.ms, revision: JSON.parse(response.body.toString('utf8')).revision }
    }

    sampleRss()
    const rssBeforeKb = rssPeakKb
    const started = performance.now()
    const smallSamples = []
    const ids = []
    const noteBody = Buffer.alloc(4096, 7)
    for (let index = 0; index < notes; index += 1) {
      const id = randomBytes(32).toString('hex')
      const stored = await putFile(tokens[index % tokens.length], id, noteBody, 0)
      smallSamples.push(stored.ms)
      ids.push(id)
    }

    const largeSamples = []
    const largeIds = []
    const attachment = Buffer.alloc(attachmentBytes, 9)
    for (let offset = 0; offset < attachments; offset += concurrency) {
      const batch = []
      for (let index = offset; index < Math.min(attachments, offset + concurrency); index += 1) batch.push(index)
      const stored = await Promise.all(batch.map(async (index) => {
        const id = randomBytes(32).toString('hex')
        const result = await putFile(tokens[index % tokens.length], id, attachment, 0)
        return { id, ...result }
      }))
      for (const result of stored) {
        largeSamples.push(result.ms)
        largeIds.push(result.id)
      }
    }

    const changeSamples = []
    for (let index = 0; index < 8; index += 1) {
      const since = index === 0 ? 0 : Math.floor(notes / 2)
      const response = await call('GET', `/api/v1/sync/changes?since=${since}`, { token: tokens[index % tokens.length], accountId })
      if (response.status !== 200) throw new Error(`changes ${response.status} ${response.body.toString('utf8').slice(0, 200)}`)
      changeSamples.push(response.ms)
    }

    const readSamples = []
    for (const id of [...ids.slice(0, 20), ...largeIds]) {
      const response = await call('GET', `/api/v1/sync/files/${id}`, { token: tokens[readSamples.length % tokens.length], accountId })
      if (response.status !== 200) throw new Error(`get ${response.status}`)
      readSamples.push(response.ms)
    }

    const probe = []
    if (ids.length) {
      const reads = Array.from({ length: Math.min(concurrency, ids.length) }, (_, index) => (
        call('GET', `/api/v1/sync/files/${ids[index]}`, { token: tokens[index], accountId })
      ))
      const results = await Promise.all(reads)
      for (const response of results) {
        if (response.status !== 200) throw new Error(`probe ${response.status}`)
        probe.push(response.ms)
      }
    }

    clearInterval(sampler)
    sampleRss()
    const report = {
      notes,
      attachments,
      attachmentBytes,
      concurrency,
      putSmall: summary(smallSamples),
      putLarge: summary(largeSamples),
      getChanges: summary(changeSamples),
      getFile: summary(readSamples),
      getFileConcurrent: summary(probe),
      rssBeforeMb: Math.round(rssBeforeKb / 1024),
      rssPeakMb: Math.round(rssPeakKb / 1024),
      durationMs: Math.round(performance.now() - started),
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    clearInterval(sampler)
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    rmSync(dataDirectory, { recursive: true, force: true })
  }
}
