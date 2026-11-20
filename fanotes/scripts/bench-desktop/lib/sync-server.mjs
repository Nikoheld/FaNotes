// A LOCAL sync server for the benchmark: the real server module
// (fanotes-site/sync-api.mjs) on a bare http server bound to 127.0.0.1, with a
// throw-away data directory. It never talks to the production server.
//
//   node lib/sync-server.mjs --port <port> --data <dir> [--account-limit <requests/min>]
//
// --account-limit replaces the server's per-account request limit (1,200 per
// minute) in memory at import time (a module load hook; the file on disk is not
// changed). Over loopback a 2,000-file first sync sends ~2,000 requests in a few
// seconds and would otherwise stop at the limit; see RUST_DESKTOP_BENCHMARKS.md.
import { createServer } from 'node:http'
import { register } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => (value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : [])))
const port = Number(args.port)
const data = path.resolve(args.data)
const accountLimit = Number(args['account-limit']) || 0
const here = path.dirname(new URL(import.meta.url).pathname)
const serverModule = path.resolve(here, '..', '..', '..', '..', 'fanotes-site', 'sync-api.mjs')

process.env.FANOTES_SYNC_DIR = data
process.env.FANOTES_PUBLIC_ORIGIN = `http://127.0.0.1:${port}`

if (accountLimit > 0) {
  const hook = `
    const target = ${JSON.stringify(pathToFileURL(serverModule).href)}
    const stock = 'rateLimit(\`sync:account:\${auth.account.id}\`, 1200, 60 * 1000)'
    export async function load(url, context, next) {
      const result = await next(url, context)
      if (url !== target) return result
      const source = String(result.source)
      if (!source.includes(stock)) throw new Error('sync-api.mjs changed: the per-account limit line was not found')
      return { ...result, source: source.replace(stock, 'rateLimit(\`sync:account:\${auth.account.id}\`, ${accountLimit}, 60 * 1000)') }
    }`
  register(`data:text/javascript,${encodeURIComponent(hook)}`)
}

const { handleSyncRequest } = await import(pathToFileURL(serverModule).href)
// The server logs one JSON line per request; the benchmark counts them instead.
let requests = 0
console.log = () => { requests += 1 }
const server = createServer(async (request, response) => {
  if (request.url === '/__bench/requests') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ requests, cpu: process.cpuUsage() }))
    return
  }
  const url = new URL(request.url, 'http://localhost')
  if (await handleSyncRequest(request, response, url)) return
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`ready ${port}\n`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
