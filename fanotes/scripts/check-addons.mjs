import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'vite'

// The add-on system: manifest and index parsing, the registry fallback, block
// normalisation, the permission table versus the worker SDK, and the host
// runtime driven through a fake worker (permissions, argument checks, quotas,
// storage, events, crash accounting) – everything that must hold so that a
// broken or hostile add-on can only ever break itself.

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

try {
  const manifest = await server.ssrLoadModule('/src/lib/addons/manifest.ts')
  const registry = await server.ssrLoadModule('/src/lib/addons/registry.ts')
  const blocks = await server.ssrLoadModule('/src/lib/addons/blocks.ts')
  const protocol = await server.ssrLoadModule('/src/lib/addons/protocol.ts')
  const bootstrap = await server.ssrLoadModule('/src/lib/addons/workerBootstrap.ts')
  const storagePort = await server.ssrLoadModule('/src/lib/addons/storagePort.ts')
  const appBridge = await server.ssrLoadModule('/src/lib/addons/appBridge.ts')
  const browserApi = await server.ssrLoadModule('/src/lib/addons/browserAddonsApi.ts')

  // ── Manifest ──────────────────────────────────────────────────────────────
  const good = manifest.parseAddonManifest({
    id: 'wort-zaehler', name: 'Wortzähler', version: '1.2.0', description: 'Zählt.', author: { name: 'Fabio', url: 'https://github.com/fabio' },
    permissions: ['commands', 'ui', 'network'], networkHosts: ['api.example.com', '*.example.org'], categories: ['writing', 'nope'], keywords: ['a', 'a', 'b'], icon: 'icon.svg',
  }, { expectedId: 'wort-zaehler' })
  assert.deepEqual(good.errors, [])
  assert.deepEqual(good.manifest.categories, ['writing'])
  assert.deepEqual(good.manifest.keywords, ['a', 'b'])
  assert.equal(good.manifest.api, 1)
  assert.ok(good.warnings.some((w) => w.includes('nope')))

  const bad = manifest.parseAddonManifest({ id: 'Bad_ID', version: 'x', permissions: ['root'], api: 2, networkHosts: ['not a host'], main: 'index.js', homepage: 'http://x' }, { expectedId: 'other' })
  for (const needle of ['"id"', 'Ordnernamen', '"name"', '"version"', '"description"', '"author"', '"api"', 'root', 'ungültigen Host', '"main"', 'homepage']) {
    assert.ok(bad.errors.some((e) => e.includes(needle)), `manifest error for ${needle}: ${bad.errors.join(' | ')}`)
  }
  assert.ok(manifest.parseAddonManifest({ id: 'a-b', name: 'n', version: '1', description: 'd', author: 'x', permissions: ['network'] }).errors.some((e) => e.includes('networkHosts')))
  assert.ok(manifest.parseAddonManifest(null).errors.length > 0)
  assert.ok(manifest.parseAddonManifest('nope').errors.length > 0)

  assert.equal(manifest.compareAddonVersions('1.10.0', '1.9.0'), 1)
  assert.equal(manifest.compareAddonVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(manifest.compareAddonVersions('2', '2.0.0'), 0)
  assert.equal(manifest.appSatisfiesMinVersion('2026.9.21', '2026.9.20'), true)
  assert.equal(manifest.appSatisfiesMinVersion('2026.9.19', '2026.9.20'), false)
  assert.equal(manifest.appSatisfiesMinVersion(undefined, '2026.9.20'), true)
  assert.equal(manifest.hostMatchesPattern('api.example.com', 'api.example.com'), true)
  assert.equal(manifest.hostMatchesPattern('a.b.example.org', '*.example.org'), true)
  assert.equal(manifest.hostMatchesPattern('example.org', '*.example.org'), false)
  assert.equal(manifest.hostMatchesPattern('evil-example.org', '*.example.org'), false)
  for (const permission of manifest.ADDON_PERMISSIONS) assert.ok(manifest.ADDON_PERMISSION_LABELS[permission]?.title, `label for ${permission}`)

  // ── Registry / source ─────────────────────────────────────────────────────
  const source = registry.parseAddonSource('Nikoheld/FaNotes-Addons#main')
  assert.equal(source.kind, 'github')
  assert.equal(source.indexUrl, 'https://raw.githubusercontent.com/Nikoheld/FaNotes-Addons/main/index.json')
  assert.equal(registry.parseAddonSource('  ').indexUrl, registry.parseAddonSource(registry.DEFAULT_ADDON_SOURCE).indexUrl)
  assert.equal(registry.parseAddonSource('owner/repo#dev').branch, 'dev')
  const urlSource = registry.parseAddonSource('https://raw.githubusercontent.com/o/r/b/')
  assert.equal(urlSource.kind, 'url')
  assert.equal(urlSource.indexUrl, 'https://raw.githubusercontent.com/o/r/b/index.json')
  assert.equal(urlSource.repoUrl, 'https://github.com/o/r/tree/b')
  assert.equal(registry.isAllowedAddonFetchUrl('https://raw.githubusercontent.com/x/y/main/index.json'), true)
  assert.equal(registry.isAllowedAddonFetchUrl('https://evil.example/index.json'), false)
  assert.equal(registry.isAllowedAddonFetchUrl('http://raw.githubusercontent.com/x'), false)
  assert.equal(registry.isAllowedAddonFetchUrl('https://user:pw@raw.githubusercontent.com/x'), false)

  const indexJson = {
    schema: 1,
    addons: [
      { id: 'b-addon', name: 'Beta', version: '1.0.0', description: 'd', author: 'x', path: 'addons/b-addon', files: { 'main.js': { size: 10, sha256: 'ab'.repeat(32) } }, updatedAt: '2026-09-08T00:00:00Z' },
      { id: 'a-addon', name: 'Alpha', version: '2.0.0', description: 'd', author: 'x', icon: 'icon.svg', path: '../escape', files: { 'main.js': { size: 1, sha256: 'not-hex' } } },
      { id: 'a-addon', name: 'Dup', version: '1', description: 'd', author: 'x' },
      { id: 'BROKEN', name: 'x', version: '1', description: 'd', author: 'x' },
    ],
  }
  const parsed = registry.parseAddonIndex(indexJson, source)
  assert.equal(parsed.origin, 'index')
  assert.deepEqual(parsed.entries.map((e) => e.manifest.id), ['a-addon', 'b-addon'], 'sorted by name, duplicates and broken dropped')
  assert.equal(parsed.entries[0].path, 'addons/a-addon', 'path traversal falls back to addons/<id>')
  assert.equal(parsed.entries[0].files['main.js'].sha256, undefined, 'invalid sha ignored')
  assert.equal(parsed.entries[0].iconUrl, 'https://raw.githubusercontent.com/Nikoheld/FaNotes-Addons/main/addons/a-addon/icon.svg')
  assert.equal(parsed.entries[1].mainUrl, 'https://raw.githubusercontent.com/Nikoheld/FaNotes-Addons/main/addons/b-addon/main.js')
  assert.equal(parsed.entries[1].updatedAt, '2026-09-08T00:00:00Z')
  assert.ok(parsed.problems.some((p) => p.includes('doppelter')))
  assert.ok(registry.parseAddonIndex({ schema: 99, addons: [] }, source).problems[0].includes('Schema'))

  // Fallback: index missing → contents API listing → manifests.
  const requested = []
  const fakeFetch = async (url) => {
    requested.push(url)
    if (url.endsWith('/index.json')) throw new Error('404')
    if (url.startsWith('https://api.github.com/repos/Nikoheld/FaNotes-Addons/contents/addons')) {
      return JSON.stringify([{ type: 'dir', name: 'hello' }, { type: 'dir', name: 'broken' }, { type: 'file', name: 'README.md' }])
    }
    if (url.endsWith('/addons/hello/manifest.json')) return JSON.stringify({ id: 'hello', name: 'Hello', version: '1.0.0', description: 'd', author: 'x' })
    if (url.endsWith('/addons/broken/manifest.json')) return '{ not json'
    throw new Error(`unexpected ${url}`)
  }
  const listed = await registry.fetchAddonIndex(source, fakeFetch)
  assert.equal(listed.origin, 'listing')
  assert.deepEqual(listed.entries.map((e) => e.manifest.id), ['hello'])
  assert.ok(listed.problems.some((p) => p.startsWith('broken:')))
  assert.ok(requested.every((url) => registry.isAllowedAddonFetchUrl(url)), 'every registry request stays on GitHub hosts')

  const hits = registry.searchAddonEntries(parsed.entries, 'alpha', null)
  assert.deepEqual(hits.map((e) => e.manifest.id), ['a-addon'])
  assert.equal(registry.searchAddonEntries(parsed.entries, '', 'writing').length, 0)

  // ── Blocks ────────────────────────────────────────────────────────────────
  const tree = blocks.normaliseAddonBlocks([
    { type: 'heading', text: 'x'.repeat(500), level: 7 },
    { type: 'button', id: 'bad id!', label: 'Go', primary: 'yes', onclick: 'alert(1)' },
    { type: 'input', id: 'q', rows: 999, multiline: true },
    { type: 'select', id: 's', options: ['a', { value: 'b', label: 'B' }, 5, null] },
    { type: 'list', id: 'l', items: [{ id: 'n1', title: 'one', badge: 'x'.repeat(50) }, 'plain', 7] },
    { type: 'progress', value: 7 },
    { type: 'script', src: 'evil.js' },
    { type: 'row', children: [{ type: 'row', children: [{ type: 'row', children: [{ type: 'row', children: [{ type: 'row', children: [{ type: 'text', text: 'deep' }] }] }] }] }] },
    'garbage',
  ])
  assert.equal(tree[0].level, 2)
  assert.equal(tree[0].text.length, 200)
  assert.match(tree[1].id, /^button-\d+$/)
  assert.equal(tree[1].primary, false)
  assert.equal(Object.hasOwn(tree[1], 'onclick'), false)
  assert.equal(tree[2].rows, 20)
  assert.deepEqual(tree[3].options, [{ value: 'a', label: 'a' }, { value: 'b', label: 'B' }, { value: '5', label: '5' }, { value: '', label: '' }])
  assert.equal(tree[4].items[0].badge.length, 24)
  assert.equal(tree[4].items[1].title, 'plain')
  assert.equal(tree[5].value, 1)
  assert.equal(tree.some((b) => b.type === 'script'), false)
  const depth = (b) => (b.type === 'row' ? 1 + Math.max(0, ...b.children.map(depth)) : 0)
  assert.ok(depth(tree[6]) <= blocks.ADDON_BLOCK_LIMITS.maxDepth)
  assert.equal(tree.length, 7)
  const flood = blocks.normaliseAddonBlocks(Array.from({ length: 1000 }, () => ({ type: 'divider' })))
  assert.equal(flood.length, blocks.ADDON_BLOCK_LIMITS.maxBlocks)
  assert.deepEqual(blocks.normaliseAddonBlocks(undefined), [])
  assert.equal(blocks.normaliseAddonBlocks({ type: 'text', text: 'one' }).length, 1)

  // ── Protocol ↔ worker SDK ─────────────────────────────────────────────────
  const sdk = bootstrap.ADDON_WORKER_BOOTSTRAP
  const sdkMethods = new Set()
  for (const match of sdk.matchAll(/api\('([a-z]+)', \[([^\]]+)\]\)/gu)) {
    for (const name of match[2].matchAll(/'([A-Za-z]+)'/gu)) sdkMethods.add(`${match[1]}.${name[1]}`)
  }
  for (const match of sdk.matchAll(/call\('([a-z]+(?:\.[A-Za-z]+)+)'/gu)) sdkMethods.add(match[1])
  const table = Object.keys(protocol.ADDON_METHOD_PERMISSIONS)
  for (const method of sdkMethods) assert.ok(table.includes(method), `worker SDK calls "${method}" which the host table does not know`)
  for (const method of table) {
    if (method === 'app.info' || method === 'app.log') continue
    assert.ok(sdkMethods.has(method), `host method "${method}" is not exposed by the worker SDK`)
  }
  for (const [method, permission] of Object.entries(protocol.ADDON_METHOD_PERMISSIONS)) {
    if (permission !== null) assert.ok(manifest.ADDON_PERMISSIONS.includes(permission), `${method} needs unknown permission ${permission}`)
  }
  assert.ok(!sdk.includes('${'), 'the bootstrap is String.raw and must not contain template placeholders')
  assert.ok(sdk.includes("self.addEventListener('error'") && sdk.includes("'unhandledrejection'"), 'worker reports uncaught errors instead of dying silently')
  assert.ok(sdk.includes("message.t === 'ping'"), 'worker answers pings')
  const err = protocol.serializeAddonError(Object.assign(new Error('boom'), { code: 'E_X' }))
  assert.deepEqual([err.name, err.message, err.code], ['Error', 'boom', 'E_X'])
  assert.equal(protocol.serializeAddonError('str').message, 'str')
  assert.equal(protocol.isAddonEventName('note:opened'), true)
  assert.equal(protocol.isAddonEventName('app:idle'), false, 'only events App.tsx actually emits are subscribable')
  const app = src('src/App.tsx')
  for (const event of protocol.ADDON_EVENTS) assert.ok(app.includes(`addonRuntime.emit('${event}'`), `App.tsx emits ${event}`)

  // ── Storage port / browser API / bridge helpers ───────────────────────────
  const record = storagePort.parseInstalledAddonRecord({ id: 'x-y', manifest: { id: 'x-y', name: 'X', version: '1', description: 'd', author: 'a' }, enabled: true, installedAt: 'now', updatedAt: 'now', source: 's', path: 'addons/x-y', mainSha256: 'f'.repeat(64), origin: 'store' })
  assert.equal(record?.id, 'x-y')
  assert.equal(storagePort.parseInstalledAddonRecord({ id: 'x-y', manifest: { id: 'other' } }), null)
  assert.equal(storagePort.parseInstalledAddonRecord('nope'), null)
  const fetchText = storagePort.createAddonFetchText({ fetchText: async (url) => `ok:${url}` })
  assert.equal(await fetchText('https://raw.githubusercontent.com/a/b/c/d'), 'ok:https://raw.githubusercontent.com/a/b/c/d')
  await assert.rejects(fetchText('https://evil.example/x'), /nicht erlaubt/u)
  assert.equal(browserApi.rewriteAddonUrlForProxy('https://raw.githubusercontent.com/a/b/main/index.json', 'https://fasrv.example/notes/'), 'https://fasrv.example/notes/addons-registry/a/b/main/index.json')
  assert.equal(browserApi.rewriteAddonUrlForProxy('https://api.github.com/repos/a/b/contents/addons?ref=main', 'https://fasrv.example/notes/'), 'https://fasrv.example/notes/addons-api/repos/a/b/contents/addons?ref=main')

  const view = appBridge.safeSettingsView({ theme: 'dark', uiLanguage: 'de', openAiKey: 'sk-secret', remoteSupportToken: 'x', vaultPath: '/home/me', editorFontSize: 14, nested: { a: 1 } })
  assert.deepEqual(view, { uiLanguage: 'de', theme: 'dark', editorFontSize: 14 })
  const notes = appBridge.flattenNoteTree([
    { name: 'Mathe', relativePath: 'Mathe', kind: 'folder', children: [{ name: 'A.md', relativePath: 'Mathe/A.md', kind: 'file', extension: 'md', modifiedAt: 't', size: 3 }, { name: 'x.png', relativePath: 'Mathe/x.png', kind: 'file' }] },
    { name: 'B.pdf', relativePath: 'B.pdf', kind: 'file' },
  ])
  assert.deepEqual(notes.map((n) => [n.path, n.title, n.folder]), [['Mathe/A.md', 'A', 'Mathe'], ['B.pdf', 'B', '']])

  // ── Runtime through a fake worker ─────────────────────────────────────────
  // Node has no Web Worker / blob URLs; stub just enough for the runtime to spawn
  // "workers" whose messages we script by hand.
  const workers = []
  class FakeWorker {
    constructor(url, options) {
      this.url = url
      this.name = options?.name
      this.listeners = new Map()
      this.sent = []
      this.onHostMessage = null
      workers.push(this)
    }
    addEventListener(type, fn) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)).add(fn) }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
    emit(type, data) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ data, message: data?.message, preventDefault() {} }) }
    postMessage(message) {
      this.sent.push(message)
      if (message.t === 'init') queueMicrotask(() => this.emit('message', { t: 'ready', exports: [] }))
      else if (message.t === 'invoke') queueMicrotask(() => this.emit('message', { t: 'result', id: message.id, ok: true, value: message.kind === 'activate' ? { commands: [], listeners: [] } : true }))
      else if (message.t === 'ping') queueMicrotask(() => this.emit('message', { t: 'pong', id: message.id }))
      if (this.onHostMessage) this.onHostMessage(message)
    }
    terminate() { this.terminated = true }
  }
  globalThis.Worker = FakeWorker
  globalThis.window = { setTimeout, clearTimeout }
  if (!URL.createObjectURL) {
    URL.createObjectURL = () => `blob:fake/${Math.random()}`
    URL.revokeObjectURL = () => {}
  }
  if (typeof globalThis.structuredClone !== 'function') globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v))

  const runtimeModule = await server.ssrLoadModule('/src/lib/addons/runtime.ts')
  const runtime = new runtimeModule.AddonRuntime()

  const files = new Map()
  const data = new Map()
  const records = new Map()
  const port = {
    list: async () => [...records.values()],
    save: async (r) => { records.set(r.id, r) },
    remove: async (id) => { records.delete(id); files.delete(id); data.delete(id) },
    readFile: async (id, name) => files.get(id)?.[name] ?? null,
    writeFiles: async (id, next) => { files.set(id, { ...(files.get(id) ?? {}), ...next }) },
    readData: async (id) => data.get(id) ?? null,
    writeData: async (id, value) => { data.set(id, value) },
  }
  const toasts = []
  const written = []
  const bridge = {
    appVersion: '2026.9.21', platform: 'linux', language: 'de', web: false,
    notes: {
      list: async () => [{ path: 'A.md', title: 'A', folder: '', modifiedAt: null, size: 1 }],
      tree: async () => [],
      read: async (path) => (path === 'A.md' ? 'hello' : ''),
      exists: async (path) => path === 'A.md',
      write: async (path, content) => { written.push([path, content]) },
      create: async () => 'New.md',
      open: async () => {},
      search: async () => [],
      active: () => ({ path: 'A.md', title: 'A', kind: 'markdown' }),
    },
    vault: { createFolder: async () => 'F', rename: async () => 'R', move: async () => 'M', trash: async () => {} },
    editor: { getText: () => 'text', getSelection: () => null, insert: () => true, replaceSelection: () => true, setText: () => true, format: () => true },
    ink: { read: async () => null },
    stats: { read: async () => ({}) },
    settings: { read: () => ({ theme: 'dark' }) },
    clipboard: { writeText: async () => {} },
    net: { fetch: async (url) => ({ status: 200, statusText: 'OK', headers: {}, body: `body:${url}`, url }) },
    ui: { toast: (m, k) => toasts.push([m, k]), confirm: async () => true, prompt: async () => 'typed', openExternal: async () => {} },
    commands: { execute: async () => true, list: () => [{ id: 'save', label: 'Speichern', group: 'Dateien' }] },
  }
  runtime.attach(bridge, port)

  const install = async (id, permissions, extra = {}) => {
    const m = manifest.parseAddonManifest({ id, name: id.toUpperCase(), version: '1.0.0', description: 'd', author: 'a', permissions, ...extra }).manifest
    await runtime.installLocal({ manifest: JSON.stringify(m), main: 'export {}' })
  }
  await runtime.start()
  await install('reader', ['notes:read', 'ui', 'storage', 'commands'])
  await install('writer', ['notes:write', 'network'], { networkHosts: ['api.example.com'] })
  assert.equal(runtime.getState().statuses.reader.state, 'running')
  assert.equal(runtime.getState().statuses.writer.state, 'running')
  const readerWorker = workers.find((w) => w.name === 'fanotes-addon:reader')
  const writerWorker = workers.find((w) => w.name === 'fanotes-addon:writer')
  assert.ok(readerWorker && writerWorker)
  assert.equal(readerWorker.sent[0].t, 'init')
  assert.deepEqual(readerWorker.sent[0].addon.permissions, ['notes:read', 'ui', 'storage', 'commands'])

  let seq = 1000
  const awaiting = new Map()
  const call = (worker, method, ...args) => new Promise((resolve) => {
    const id = ++seq
    awaiting.set(id, resolve)
    if (!worker.onHostMessage) {
      worker.onHostMessage = (message) => {
        if (message.t !== 'reply') return
        const done = awaiting.get(message.id)
        if (done) { awaiting.delete(message.id); done(message) }
      }
    }
    worker.emit('message', { t: 'call', id, method, args })
  })
  const ok = async (worker, method, ...args) => {
    const reply = await call(worker, method, ...args)
    assert.equal(reply.ok, true, `${method}: ${reply.error?.message}`)
    return reply.value
  }
  const fails = async (worker, code, method, ...args) => {
    const reply = await call(worker, method, ...args)
    assert.equal(reply.ok, false, `${method} should fail with ${code}`)
    assert.equal(reply.error.code, code, `${method}: ${reply.error.message}`)
  }

  assert.equal((await ok(readerWorker, 'app.info')).addon.id, 'reader')
  assert.deepEqual(await ok(readerWorker, 'notes.list'), [{ path: 'A.md', title: 'A', folder: '', modifiedAt: null, size: 1 }])
  assert.equal(await ok(readerWorker, 'notes.read', 'A.md'), 'hello')
  await fails(readerWorker, 'E_PERMISSION', 'notes.write', 'A.md', 'x')
  await fails(readerWorker, 'E_PERMISSION', 'net.fetch', 'https://api.example.com/x')
  await fails(readerWorker, 'E_PERMISSION', 'editor.getText')
  await fails(readerWorker, 'E_UNKNOWN_METHOD', 'notes.delete', 'A.md')
  await fails(readerWorker, 'E_UNKNOWN_METHOD', '__proto__.polluted')
  await fails(readerWorker, 'E_ARGS', 'notes.read', '../secret.md')
  await fails(readerWorker, 'E_ARGS', 'notes.read', '')
  await fails(readerWorker, 'E_ARGS', 'notes.read', 42)
  await fails(readerWorker, 'E_TOO_LARGE', 'notes.search', 'x'.repeat(501))

  await fails(writerWorker, 'E_PERMISSION', 'notes.read', 'A.md')
  await ok(writerWorker, 'notes.write', 'A.md', 'new text')
  assert.deepEqual(written.at(-1), ['A.md', 'new text'])
  await fails(writerWorker, 'E_TOO_LARGE', 'notes.write', 'A.md', 'x'.repeat(protocol.ADDON_LIMITS.maxNoteBytes + 1))
  await fails(writerWorker, 'E_NETWORK', 'net.fetch', 'http://api.example.com/x')
  await fails(writerWorker, 'E_NETWORK', 'net.fetch', 'https://evil.example.com/x')
  await fails(writerWorker, 'E_ARGS', 'net.fetch', 'not a url')
  const response = await ok(writerWorker, 'net.fetch', 'https://api.example.com/x', { method: 'post', headers: { Cookie: 'steal', 'X-Token': 'ok', Authorization: 'no' } })
  assert.equal(response.body, 'body:https://api.example.com/x')

  // Panels, status items and commands are quota-limited per add-on.
  for (let i = 0; i < protocol.ADDON_LIMITS.maxPanelsPerAddon; i += 1) await ok(readerWorker, 'ui.panel.show', { id: `p${i}`, title: 'P', blocks: [{ type: 'text', text: 'hi' }] })
  await fails(readerWorker, 'E_LIMIT', 'ui.panel.show', { id: 'one-too-many', title: 'P', blocks: [] })
  await ok(readerWorker, 'ui.panel.show', { id: 'p0', title: 'Renamed', blocks: undefined })
  assert.equal(runtime.getState().panels.find((p) => p.id === 'p0').title, 'Renamed')
  assert.equal(runtime.getState().panels.find((p) => p.id === 'p0').blocks[0].text, 'hi', 'blocks kept when only the title changes')
  await ok(readerWorker, 'ui.panel.update', 'p1', [{ type: 'button', id: 'go', label: 'Go' }])
  await fails(readerWorker, 'E_NO_PANEL', 'ui.panel.update', 'missing', [])
  await ok(readerWorker, 'ui.panel.close', 'p1')
  assert.equal(runtime.getState().panels.filter((p) => p.addonId === 'reader').length, protocol.ADDON_LIMITS.maxPanelsPerAddon - 1)
  await fails(writerWorker, 'E_PERMISSION', 'ui.panel.show', { id: 'x', title: 'x', blocks: [] })

  for (let i = 0; i < protocol.ADDON_LIMITS.maxStatusItemsPerAddon; i += 1) await ok(readerWorker, 'ui.status.set', { id: `s${i}`, text: `S${i}` })
  await fails(readerWorker, 'E_LIMIT', 'ui.status.set', { id: 'more', text: 'x' })
  await ok(readerWorker, 'ui.status.set', { id: 's0', text: '   ' })
  assert.equal(runtime.getState().statusItems.filter((s) => s.addonId === 'reader').length, protocol.ADDON_LIMITS.maxStatusItemsPerAddon - 1, 'empty text removes the item')
  await fails(readerWorker, 'E_TOO_LARGE', 'ui.status.set', { id: 's9', text: 'x'.repeat(61) })

  await ok(readerWorker, 'commands.register', { id: 'hello', title: 'Hallo' })
  await fails(readerWorker, 'E_ARGS', 'commands.register', { id: 'bad id', title: 'x' })
  assert.ok(runtime.getState().commands.some((c) => c.addonId === 'reader' && c.id === 'hello'))
  const listed2 = await ok(readerWorker, 'commands.list')
  assert.ok(listed2.some((c) => c.id === 'save') && listed2.some((c) => c.id === 'hello' && c.group === 'Add-on: READER'))
  await ok(readerWorker, 'ui.toast', 'hi there', 'success')
  assert.deepEqual(toasts.at(-1), ['READER: hi there', 'success'], 'toasts carry the add-on name')

  // Events: subscribing checks the permission the payload needs.
  await ok(readerWorker, 'events.subscribe', 'note:opened')
  await ok(readerWorker, 'events.subscribe', 'note:changed')
  await fails(readerWorker, 'E_PERMISSION', 'events.subscribe', 'ink:stroke')
  await fails(readerWorker, 'E_ARGS', 'events.subscribe', 'app:idle')
  await fails(writerWorker, 'E_PERMISSION', 'events.subscribe', 'note:changed')
  assert.equal(runtime.hasSubscribers('note:opened'), true)
  assert.equal(runtime.hasSubscribers('ink:stroke'), false)
  const before = readerWorker.sent.length
  runtime.emit('note:opened', { path: 'A.md', title: 'A', kind: 'markdown' })
  runtime.emit('ink:stroke', { path: 'A.md' })
  const events = readerWorker.sent.slice(before).filter((m) => m.t === 'invoke' && m.kind === 'event')
  assert.deepEqual(events.map((m) => m.payload.name), ['note:opened'], 'only subscribed events reach the worker')
  assert.equal(writerWorker.sent.filter((m) => m.t === 'invoke' && m.kind === 'event').length, 0)

  // Storage: isolated per add-on, bounded.
  await ok(readerWorker, 'storage.set', 'k', { n: 1 })
  assert.deepEqual(await ok(readerWorker, 'storage.get', 'k'), { n: 1 })
  assert.equal(await ok(readerWorker, 'storage.get', 'missing'), null)
  await fails(readerWorker, 'E_TOO_LARGE', 'storage.set', 'big', 'x'.repeat(protocol.ADDON_LIMITS.maxStorageBytes))
  assert.deepEqual(await ok(readerWorker, 'storage.keys'), ['k'])
  await fails(writerWorker, 'E_PERMISSION', 'storage.get', 'k')
  assert.equal(JSON.parse(data.get('reader')).k.n, 1)
  assert.equal(data.has('writer'), false)

  // Rate limit: the burst above the per-second budget is rejected, not the app.
  const burst = await Promise.all(Array.from({ length: protocol.ADDON_LIMITS.maxCallsPerSecond + 40 }, () => call(readerWorker, 'app.info')))
  assert.ok(burst.some((r) => r.ok === false && r.error.code === 'E_RATE'), 'burst hits E_RATE')
  assert.equal(runtime.getState().statuses.reader.state, 'running', 'a single burst does not kill the add-on')

  // Errors: eight in a minute stop and disable the add-on; the other add-on is untouched.
  for (let i = 0; i < protocol.ADDON_LIMITS.maxErrorsBeforeDisable; i += 1) writerWorker.emit('message', { t: 'error', error: { name: 'TypeError', message: `boom ${i}` } })
  assert.equal(runtime.getState().statuses.writer.state, 'crashed')
  assert.match(runtime.getState().statuses.writer.error, /Fehler innerhalb einer Minute/u)
  assert.equal(writerWorker.terminated, true)
  assert.equal(runtime.getState().installed.find((r) => r.id === 'writer').enabled, false)
  assert.equal(runtime.getState().statuses.reader.state, 'running')
  assert.equal(runtime.getState().panels.filter((p) => p.addonId === 'reader').length > 0, true)
  assert.ok(runtime.getState().statuses.writer.logs.some((l) => l.text.includes('boom 7')))

  // Restart clears the counters and brings a fresh worker.
  await runtime.setEnabled('writer', true)
  assert.equal(runtime.getState().statuses.writer.state, 'running')
  assert.equal(runtime.getState().statuses.writer.errorCount, 0)
  assert.notEqual(workers.find((w) => w.name === 'fanotes-addon:writer' && !w.terminated), undefined)

  // Deactivation removes every contribution and the pending calls reject.
  await runtime.deactivate('reader')
  assert.equal(runtime.getState().statuses.reader.state, 'stopped')
  assert.equal(runtime.getState().panels.filter((p) => p.addonId === 'reader').length, 0)
  assert.equal(runtime.getState().commands.filter((c) => c.addonId === 'reader').length, 0)
  assert.equal(runtime.getState().statusItems.filter((s) => s.addonId === 'reader').length, 0)
  assert.equal(runtime.hasSubscribers('note:opened'), false)

  // Tampered main.js does not start.
  const tampered = manifest.parseAddonManifest({ id: 'tamper', name: 'T', version: '1', description: 'd', author: 'a' }).manifest
  records.set('tamper', { id: 'tamper', manifest: tampered, enabled: true, installedAt: 'x', updatedAt: 'x', source: 's', path: 'addons/tamper', mainSha256: '0'.repeat(64), origin: 'store' })
  files.set('tamper', { 'main.js': 'export {}' })
  const runtime2 = new runtimeModule.AddonRuntime()
  runtime2.attach(bridge, port)
  await runtime2.start()
  assert.equal(runtime2.getState().statuses.tamper.state, 'crashed')
  assert.match(runtime2.getState().statuses.tamper.error, /verändert/u)
  assert.equal(runtime2.getState().statuses.reader.state, 'running', 'deactivate() only stops the session; the record stays enabled and starts again with a fresh runtime')

  // minAppVersion gate.
  await runtime2.uninstall('tamper')
  assert.equal(records.has('tamper'), false)
  const future = manifest.parseAddonManifest({ id: 'future', name: 'F', version: '1', description: 'd', author: 'a', minAppVersion: '2099.1.1' }).manifest
  await runtime2.installLocal({ manifest: JSON.stringify(future), main: 'export {}' })
  assert.equal(runtime2.getState().statuses.future.state, 'incompatible')

  // Install from the registry verifies the checksum before writing anything.
  const mainCode = 'export const x = 1'
  const digest = await registry.sha256Hex(mainCode)
  const entry = registry.parseAddonIndex({ schema: 1, addons: [{ id: 'store-addon', name: 'S', version: '1.0.0', description: 'd', author: 'a', files: { 'main.js': { size: mainCode.length, sha256: digest } } }] }, source).entries[0]
  const storeFetch = async (url) => {
    if (url.endsWith('/main.js')) return mainCode
    if (url.endsWith('/manifest.json')) return JSON.stringify({ id: 'store-addon', name: 'S', version: '1.0.0', description: 'd', author: 'a', permissions: ['ui'] })
    if (url.endsWith('/README.md')) return '# S'
    throw new Error('404')
  }
  const installed = await runtime2.install(entry, storeFetch)
  assert.equal(installed.mainSha256, digest)
  assert.deepEqual(installed.manifest.permissions, ['ui'], 'permissions come from the re-parsed manifest, not the index')
  assert.equal(files.get('store-addon')['README.md'], '# S')
  assert.equal(runtime2.getState().statuses['store-addon'].state, 'running')
  const badEntry = registry.parseAddonIndex({ schema: 1, addons: [{ id: 'evil', name: 'E', version: '1', description: 'd', author: 'a', files: { 'main.js': { size: 1, sha256: 'a'.repeat(64) } } }] }, source).entries[0]
  await assert.rejects(runtime2.install(badEntry, storeFetch), /Prüfsumme/u)
  assert.equal(files.has('evil'), false)
  const updates = runtime2.updatesFor(registry.parseAddonIndex({ schema: 1, addons: [{ id: 'store-addon', name: 'S', version: '1.1.0', description: 'd', author: 'a' }] }, source))
  assert.deepEqual(updates.map((u) => u.entry.manifest.version), ['1.1.0'])

  // Tear down: running add-ons keep a heartbeat timer alive, which would otherwise pin the process.
  await runtime.stopAll()
  await runtime2.stopAll()
  assert.equal(workers.filter((w) => !w.terminated).length, 0, 'every worker terminated')

  // ── App / Electron / web wiring ───────────────────────────────────────────
  assert.match(app, /addonRuntime\.attach\(createAppAddonBridge\(/u)
  assert.match(app, /id: 'addon-store'/u)
  assert.match(app, /<SafeBoundary name="Add-on-Dock"/u)
  assert.match(app, /<SafeBoundary name="Add-on-Store"/u)
  assert.match(app, /className="addon-status-item"/u)
  assert.match(app, /addonsAutoUpdate/u)
  const electron = src('electron/addons.cjs')
  assert.match(electron, /ALLOWED_HOSTS = new Set\(\['raw\.githubusercontent\.com', 'api\.github\.com', 'github\.com', 'objects\.githubusercontent\.com'\]\)/u)
  assert.match(electron, /isPrivateHost/u)
  assert.match(electron, /cookie|authorization/iu)
  const main = src('electron/main.cjs')
  assert.match(main, /registerAddonIpc\(/u)
  assert.match(main, /addonSource: \{ type: 'string', max: 400 \}/u)
  assert.match(main, /addonsAutoUpdate: \{ type: 'boolean' \}/u)
  const preload = src('electron/preload.cjs')
  for (const channel of ['addonsFetch', 'addonsList', 'addonsSave', 'addonsRemove', 'addonsReadFile', 'addonsWriteFiles', 'addonsReadData', 'addonsWriteData', 'addonsNetFetch']) {
    assert.ok(preload.includes(channel), `preload exposes ${channel}`)
  }
  const nginx = src('../fanotes-site/deploy/fanotes-fasrv.conf')
  assert.match(nginx, /location \^~ \/notes\/addons-registry\//u)
  assert.match(nginx, /location \^~ \/notes\/addons-api\//u)
  const vite = src('vite.config.ts')
  assert.match(vite, /'\/addons-registry'/u)
  assert.match(vite, /'\/addons-api'/u)
  const defaults = src('src/defaults.ts')
  assert.match(defaults, /addonSource: 'Nikoheld\/FaNotes-Addons#main'/u)
  const settingsModal = src('src/components/SettingsModal.tsx')
  assert.match(settingsModal, /id: 'addons'/u)

  // ── Registry repository twin (when checked out next to this repo) ─────────
  const twinPath = new URL('../../fanotes-addons/scripts/lib/manifest.mjs', import.meta.url)
  if (existsSync(twinPath)) {
    const twin = await import(twinPath.href)
    const fixtures = [
      { id: 'a-b', name: 'n', version: '1.2', description: 'd', author: 'x', permissions: ['ui', 'zzz'], networkHosts: ['ok.example'], categories: ['fun'] },
      { id: 'Bad', version: 'x' },
      { id: 'net', name: 'n', version: '1', description: 'd', author: { name: 'a', url: 'ftp://x' }, permissions: ['network'] },
      null,
    ]
    for (const fixture of fixtures) {
      assert.deepEqual(twin.parseAddonManifest(fixture, { expectedId: 'a-b' }), manifest.parseAddonManifest(fixture, { expectedId: 'a-b' }), `registry manifest twin agrees for ${JSON.stringify(fixture)}`)
    }
    assert.deepEqual([...twin.ADDON_PERMISSIONS], [...manifest.ADDON_PERMISSIONS])
    assert.deepEqual([...twin.ADDON_CATEGORIES], [...manifest.ADDON_CATEGORIES])
    console.log('registry twin: in sync')
  }

  console.log('check-addons ok')
} finally {
  await server.close()
}
