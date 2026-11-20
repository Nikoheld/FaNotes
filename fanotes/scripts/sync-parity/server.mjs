// A local sync server for the harness and benchmarks: the real
// fanotes-site/sync-api.mjs on 127.0.0.1 with a temporary data directory.
// Rate limits would throttle a 2,000-file first sync, so each request gets its
// own client address and the server clock moves one minute per 1,000 requests.
//   node scripts/sync-parity/server.mjs   → prints {"origin": "..."} and runs until SIGTERM/SIGINT
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const startSyncServer = async () => {
  const realNow = Date.now
  let offset = 0
  let handled = 0
  Date.now = () => realNow() + offset
  const dataDirectory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'fanotes-sync-local-'))
  process.env.FANOTES_SYNC_DIR = dataDirectory
  const port = 19_800 + Math.floor(Math.random() * 600)
  const origin = `http://127.0.0.1:${port}`
  process.env.FANOTES_PUBLIC_ORIGIN = origin
  const { handleSyncRequest } = await import('../../../fanotes-site/sync-api.mjs')
  const log = console.log
  console.log = (...items) => { if (typeof items[0] === 'string' && items[0].startsWith('{"time"')) return; log(...items) }
  const server = createServer(async (request, response) => {
    handled += 1
    if (handled % 1000 === 0) offset += 61_000
    request.headers['x-real-ip'] = `10.1.${Math.floor(handled / 250) % 250}.${handled % 250}`
    if (await handleSyncRequest(request, response, new URL(request.url, 'http://localhost'))) return
    response.writeHead(404); response.end()
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { origin, dataDirectory, close: () => { server.close(); rmSync(dataDirectory, { recursive: true, force: true }) } }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const running = await startSyncServer()
  process.stdout.write(`${JSON.stringify({ origin: running.origin })}\n`)
  const stop = () => { running.close(); process.exit(0) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  setInterval(() => undefined, 1 << 30)
}
