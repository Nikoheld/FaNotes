// Local full stack for the end-to-end tests: the built web app (dist/) plus the real sync API,
// Schulnetz runtime and Kanti+ web API on ONE origin, with temp data dirs and no network.
// Builds nothing: run `npm run build` first. Port: E2E_PORT (default 4783).
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const port = Number(process.env.E2E_PORT || 4783)
const dist = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const site = fileURLToPath(new URL('../../', import.meta.url))

const root = await mkdtemp(join(tmpdir(), 'kanti-web-e2e-'))
process.env.FANOTES_SYNC_DIR = join(root, 'sync')

const { handleSyncRequest } = await import(`${site}sync-api.mjs`)
const { createSchulnetzRuntime } = await import(`${site}schulnetz-api.mjs`)
const { createKantiWebApi, createKantiWebAppRoutes, createKantiWebStore } = await import(`${site}kanti-web-api.mjs`)

const store = createKantiWebStore({ root })
const schulnetz = createSchulnetzRuntime({
  root,
  key: randomBytes(32),
  autostart: false,
  log: () => {},
  fetch: async () => { throw new Error('no network in e2e') },
  fcmSend: async () => ({ status: 200 }),
  web: createKantiWebAppRoutes(store, {}),
})
// The browser reaches the server as http://127.0.0.1:<port>; the API checks Host and Origin.
const web = createKantiWebApi({ store, access: schulnetz.webAccess, hosts: ['127.0.0.1'], origins: [`http://127.0.0.1:${port}`], log: () => {} })

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
}

const serveStatic = async (url, response) => {
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/u, '')
  let file = join(dist, relative)
  if (!file.startsWith(dist)) { response.writeHead(403).end(); return }
  const info = await stat(file).catch(() => null)
  // Single-page app: unknown paths without an extension fall back to index.html.
  if (!info?.isFile()) {
    if (extname(relative)) { response.writeHead(404).end('not found'); return }
    file = join(dist, 'index.html')
  }
  const body = await readFile(file)
  response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  response.end(body)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      if (await handleSyncRequest(request, response, url)) return
      if (await schulnetz.handle(request, response, url)) return
      if (await web.handle(request, response, url)) return
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"fallthrough"}')
      return
    }
    await serveStatic(url, response)
  } catch (error) {
    response.writeHead(500).end(String(error?.message || error))
  }
})

const stop = async () => {
  server.close()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
server.listen(port, '127.0.0.1', () => console.log(`kanti-web e2e server on http://127.0.0.1:${port}`))
