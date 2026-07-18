import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'dist')
const runtimeModule = 'ort-wasm-simd-threaded.mjs'

// ONNX Runtime resolves its ESM glue relative to the generated runtime chunk
// (dist/assets) in the full app, but relative to the document root in the
// standalone recognition harness. Ship the same verified 20 KiB module at
// both locations; the Web PWA keeps both copies out of its startup precache.
await fs.copyFile(
  path.join(output, runtimeModule),
  path.join(output, 'assets', runtimeModule),
)

const walk = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(absolute) : [path.relative(output, absolute).split(path.sep).join('/')]
  }))
  return nested.flat()
}

const files = (await walk(output)).filter((file) => file !== 'sw.js').sort()
const fingerprint = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16)
// The neural OCR runtime is intentionally fetched only when handwriting is
// converted. Pre-caching it would add more than 30 MB to the first page load.
const lazyRecognitionFiles = files.filter((file) => (
  file.startsWith('ocr/')
  || file.includes('trocrWorker-')
  || file.includes('neuralTextRecognition-')
  || /(?:^|\/)ort-wasm[^/]*\.(?:wasm|mjs)$/u.test(file)
  || file === runtimeModule
  || file === `assets/${runtimeModule}`
))
const precache = ['./', ...files.filter((file) => !lazyRecognitionFiles.includes(file)).map((file) => `./${file}`)]
const source = `const CACHE = 'fanotes-web-${fingerprint}'
const PRECACHE = ${JSON.stringify(precache)}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('fanotes-web-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/')) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone()
      void caches.open(CACHE).then((cache) => cache.put('./index.html', copy))
      return response
    }).catch(() => caches.match('./index.html')))
    return
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      void caches.open(CACHE).then((cache) => cache.put(request, copy))
    }
    return response
  })))
})
`

await fs.writeFile(path.join(output, 'sw.js'), source, 'utf8')

// Production builds can run below a deliberately restrictive umask. That is
// desirable for private app data, but a copied Web-PWA must remain readable by
// the unprivileged web-service account. Normalize only the inert build output;
// no user data or credentials live below dist.
const makePubliclyReadable = async (directory) => {
  await fs.chmod(directory, 0o755)
  const entries = await fs.readdir(directory, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await makePubliclyReadable(absolute)
      return
    }
    if (entry.isFile()) await fs.chmod(absolute, 0o644)
  }))
}

await makePubliclyReadable(output)
console.log(`FaNotes Web-PWA: ${precache.length} Startressourcen · ${lazyRecognitionFiles.length} Erkennungsressourcen erst bei Bedarf · Cache ${fingerprint}`)
