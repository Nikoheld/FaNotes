'use strict'

// Writes a synthetic FaNotes Electron profile with the real Electron binary.
//
//   xvfb-run -a fanotes/node_modules/electron/dist/electron --password-store=basic \
//     crates/fanotes-host/src/migrate/fixtures/make-electron-profile.cjs --out <dir> \
//     [--backend leveldb|sqlite|default] [--samples 120] [--plain-text-encryption] [--phase reopen]
//
// `--phase reopen` opens an existing profile again and changes a few records, so
// LevelDB turns the first run's log into a table file and the reader sees both.
// `--plain-text-encryption` calls `safeStorage.setUsePlainTextEncryption(true)` so
// the basic_text backend still produces `v10` values (FaNotes itself leaves
// secrets empty and seals the sync login with `local1:` when encryption is off).
//
// Everything in the profile is made up: records, settings and secrets. The page
// is a `file://` page like the packaged app, so IndexedDB and localStorage land
// in the same origin directory FaNotes uses. `<dir>/expected.json` lists every
// record in the tagged JSON form the Rust reader produces, so the Rust test can
// compare record by record.

const { app, BrowserWindow, safeStorage } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const out = path.resolve(argument('--out', path.join(process.cwd(), 'electron-profile-fixture')))
const backend = argument('--backend', 'default')
const sampleCount = Number(argument('--samples', '120'))
const phase = argument('--phase', 'create')
const plainTextEncryption = process.argv.includes('--plain-text-encryption')
const userData = path.join(out, 'profile')
const vault = path.join(out, 'vault')

if (phase === 'create') {
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
}

if (backend === 'leveldb') app.commandLine.appendSwitch('disable-features', 'IdbSqliteBackingStore,IdbSqliteOnDiskRollout')
if (backend === 'sqlite') app.commandLine.appendSwitch('enable-features', 'IdbSqliteBackingStore,IdbSqliteOnDiskRollout')
app.setName('FaNotes')
app.setPath('userData', userData)

const write = (target, bytes, mode = 0o600) => {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.writeFileSync(target, bytes, { mode })
}

// Made-up secrets. None of these is a real credential.
const FIXTURE_SECRETS = {
  openAiApiKey: 'sk-fixture-openai-0000-not-a-real-key',
  anthropicApiKey: 'sk-ant-fixture-1111-not-a-real-key',
  homeworkApiSecret: 'homework-fixture-secret-ä-ß-2222',
  grokBuildRefreshToken: `fixture-refresh-${'r'.repeat(300)}`,
}
const FIXTURE_ACCOUNT = {
  v: 1,
  accountId: 'acct-fixture-0001',
  deviceId: 'device-fixture-0001',
  token: 'token-fixture-not-real-3333',
  expiresAt: '2027-01-01T00:00:00.000Z',
  email: 'fixture-user@example.invalid',
  vaultSecret: Buffer.alloc(32, 7).toString('base64'),
}

const encrypt = (value) => safeStorage.encryptString(value).toString('base64')

function writeMainProcessFiles(report) {
  fs.mkdirSync(vault, { recursive: true, mode: 0o700 })
  write(path.join(vault, 'Welcome.md'), '# Fixture vault\n')
  const settings = {
    uiLanguage: 'en',
    theme: 'dark',
    accent: '#aa3366',
    editorFontSize: 18,
    lineHeight: 1.6,
    spellcheck: false,
    syncDeviceName: 'Fixture laptop',
    syncExcludedFolders: 'Private',
    recognitionMode: 'math',
    customCss: '.fixture { color: red; }',
  }
  for (const key of ['lmStudioApiToken', 'ollamaApiToken', 'openAiApiKey', 'geminiApiKey', 'anthropicApiKey', 'grokApiKey', 'grokBuildAccessToken', 'grokBuildRefreshToken', 'openCodePassword', 'homeworkApiSecret']) {
    const value = FIXTURE_SECRETS[key]
    settings[key] = value && report.encryptionAvailable ? `fanotes-secret-v1:${encrypt(value)}` : ''
  }
  // A value the Electron keyring cannot open any more (garbage after the prefix).
  settings.geminiApiKey = `fanotes-secret-v1:${Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 9)]).toString('base64')}`
  write(path.join(userData, 'config.json'), JSON.stringify({ version: 2, vaultPath: vault, settings, resourceLimits: { heapMb: 4096 } }, null, 2))

  const vaultId = crypto.createHash('sha256').update(path.resolve(vault)).digest('hex').slice(0, 32)
  const state = {
    version: 1,
    accountId: FIXTURE_ACCOUNT.accountId,
    cursor: 42,
    lastSyncAt: '2026-11-01T10:00:00.000Z',
    files: {
      'Welcome.md': { id: 'file-fixture-1', revision: 3, sha256: 'a'.repeat(64), size: 16, mtimeMs: 1761991200000 },
      '.fanotes/folder-colors.json': { id: 'file-fixture-2', revision: 1, sha256: 'b'.repeat(64), size: 2, mtimeMs: 1761991200000, blank: true },
    },
    conflicts: [],
  }
  write(path.join(userData, 'sync', `state-${vaultId}.json`), JSON.stringify(state))
  const account = JSON.stringify(FIXTURE_ACCOUNT)
  if (report.encryptionAvailable) {
    write(path.join(userData, 'sync', 'account.secret'), `safe1:${encrypt(account)}`)
  } else {
    // sync.cjs `sealLocal`: AES-256-GCM with a random key next to the file.
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(account, 'utf8'), cipher.final()])
    write(path.join(userData, 'sync', 'account.key'), key)
    write(path.join(userData, 'sync', 'account.secret'), `local1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`)
  }

  write(path.join(userData, 'addons', 'addons.json'), JSON.stringify([{ id: 'fixture-addon', version: '1.0.0', enabled: true, files: ['main.js'] }]))
  write(path.join(userData, 'addons', 'fixture-addon', 'main.js'), 'export default () => "fixture add-on"\n')
  write(path.join(userData, 'addons', 'fixture-addon', 'data.json'), JSON.stringify({ counter: 7, note: 'Grüße' }))
  write(path.join(userData, 'folder-locations.json'), JSON.stringify({ version: 1, vaults: {} }))
  write(path.join(userData, 'ink-recognition', 'personal-model.json'), JSON.stringify({ version: 1, fittedOn: 12, errorBefore: 9.5, errorAfter: 6.25 }))
  write(path.join(userData, 'ink-recognition', 'personal-model.onnx'), Buffer.concat([Buffer.from([0x08, 0x07]), Buffer.alloc(4096, 3)]))
  write(path.join(userData, 'personal-handwriting-v2', 'f'.repeat(64), 'aggregate.json'), JSON.stringify({ population: [] }))
  // Re-downloadable or rebuildable: the backup leaves these out.
  write(path.join(userData, 'models', 'qwen-vision', 'qwen3-vl-2b-int4-npu', 'model.bin'), Buffer.alloc(65536, 1))
  write(path.join(userData, 'models', 'enhanced-math', 'posformer.gguf'), Buffer.alloc(65536, 2))
  write(path.join(userData, 'tree-cache-v1', `${'c'.repeat(64)}.json`), '{}')
  write(path.join(userData, 'updates', 'pending.json'), '{}')
  write(path.join(userData, 'tool-cache', 'onenote', 'x.bin'), Buffer.alloc(128, 5))
  return { vaultId }
}

// Runs in the `file://` page. Seeded so the records are the same on every run.
const PAGE_HELPERS = String.raw`
  let seed = 20261115
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits
  const stroke = (points, base) => ({
    baseWidth: 3.5,
    pressureEnabled: true,
    color: '#1d1d1f',
    points: Array.from({ length: points }, (_, index) => ({
      x: round(base + index / points + random() * 0.01, 6),
      y: round(0.3 + random() * 0.4, 6),
      t: 1761991200000 + index * 8,
      pressure: round(0.2 + random() * 0.8, 4),
      tiltX: Math.round(random() * 60 - 30),
      tiltY: Math.round(random() * 60 - 30),
      pointerType: 'pen',
    })),
  })
  const base64 = (length) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let text = ''
    for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(random() * 64)]
    return text
  }
  const labels = [
    { id: 'digit_1', char: '1', name: 'Eins', latex: '1', category: 'digits' },
    { id: 'lower_a', char: 'a', name: 'a', latex: 'a', category: 'lowercase' },
    { id: 'german_sz', char: 'ß', name: 'Eszett', latex: '\\ss', category: 'german' },
    { id: 'custom_ae', char: 'ä', name: 'a-Umlaut', latex: '\\ddot{a}', category: 'custom' },
    { id: 'operator_sum', char: '∑', name: 'Summe', latex: '\\sum', category: 'math' },
    { id: 'custom_clef', char: '𝄞', name: 'Notenschlüssel', latex: '\\clef', category: 'custom' },
  ]
  const sample = (index, points = 24, strokes = 3) => {
    const label = labels[index % labels.length]
    const list = Array.from({ length: strokes }, (_, strokeIndex) => stroke(points, strokeIndex * 0.2))
    return {
      id: 'sample-' + String(index).padStart(4, '0'),
      labelId: label.id,
      label: label.char,
      labelName: label.name,
      latex: label.latex,
      category: label.category,
      writerId: 'person-fixture',
      sessionId: 'session-fixture-' + (index % 3),
      createdAt: new Date(Date.UTC(2026, 9, 1 + (index % 28), 8, index % 60)).toISOString(),
      imageData: 'data:image/png;base64,' + base64(600 + (index % 7) * 50),
      imageWidth: 64,
      imageHeight: 64,
      sourceCanvas: { width: 640, height: 360, devicePixelRatio: 1.25 },
      bbox: [round(random(), 4), round(random(), 4), 0.25, 0.5],
      strokes: list,
      strokeCount: list.length,
      pointCount: list.reduce((sum, item) => sum + item.points.length, 0),
      schemaVersion: 1,
    }
  }
  const request = (value) => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
  const open = (name, version, upgrade) => new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, version)
    opening.onupgradeneeded = () => upgrade(opening.result)
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  const run = (database, stores, action) => new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, 'readwrite')
    action(transaction)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
`

const PAGE_REOPEN = String.raw`
  const handwriting = await open('fanotes-handwriting', 1, () => { throw new Error('the profile has no handwriting database') })
  await run(handwriting, ['samples', 'labels'], (transaction) => {
    const replaced = sample(11)
    replaced.labelName = 'nach dem Neustart'
    transaction.objectStore('samples').put(replaced)
    transaction.objectStore('samples').delete('sample-0012')
    transaction.objectStore('samples').put(sample(SAMPLE_COUNT + 50))
    transaction.objectStore('labels').put({ id: 'custom_reopen', char: 'Ж', name: 'Zhe', latex: 'Ж', category: 'custom' })
  })
  handwriting.close()
  localStorage.setItem('fanotes-after-reopen', 'yes')
  return 'ok'
`

const PAGE_CREATE = String.raw`
  // fanotes-handwriting, exactly the schema of handwritingDb.ts.
  const handwriting = await open('fanotes-handwriting', 1, (database) => {
    const samples = database.createObjectStore('samples', { keyPath: 'id' })
    samples.createIndex('labelId', 'labelId', { unique: false })
    samples.createIndex('createdAt', 'createdAt', { unique: false })
    const layouts = database.createObjectStore('layoutExamples', { keyPath: 'id' })
    layouts.createIndex('anchorLabelId', 'anchorLabelId', { unique: false })
    layouts.createIndex('createdAt', 'createdAt', { unique: false })
    database.createObjectStore('labels', { keyPath: 'id' })
  })
  await run(handwriting, ['labels'], (transaction) => labels.forEach((label) => transaction.objectStore('labels').put(label)))
  for (let batch = 0; batch * 50 < SAMPLE_COUNT; batch += 1) {
    await run(handwriting, ['samples'], (transaction) => {
      for (let index = batch * 50; index < Math.min(SAMPLE_COUNT, batch * 50 + 50); index += 1) transaction.objectStore('samples').put(sample(index))
    })
  }
  // Large records: Chromium wraps values above its threshold (compression, external blob file).
  await run(handwriting, ['samples'], (transaction) => {
    transaction.objectStore('samples').put(sample(900, 1800, 4))
    transaction.objectStore('samples').put(sample(901, 700, 3))
  })
  // Later writes win and deletes stay deleted.
  await run(handwriting, ['samples'], (transaction) => {
    const replaced = sample(5)
    replaced.labelName = 'überschrieben'
    transaction.objectStore('samples').put(replaced)
    transaction.objectStore('samples').delete('sample-0007')
  })
  await run(handwriting, ['layoutExamples'], (transaction) => {
    for (let index = 0; index < 40; index += 1) {
      transaction.objectStore('layoutExamples').put({
        id: 'layout-' + index,
        anchorLabelId: labels[index % labels.length].id,
        childLabelId: labels[(index + 1) % labels.length].id,
        role: ['superscript', 'subscript', 'above', 'below'][index % 4],
        relativeCenterX: round(random() * 2 - 1, 6),
        relativeCenterY: round(random() * 2 - 1, 6),
        relativeWidth: round(random(), 6),
        relativeHeight: round(random(), 6),
        createdAt: new Date(Date.UTC(2026, 8, 1 + (index % 28))).toISOString(),
      })
    }
  })
  handwriting.close()

  // fanotes-ink-personal, exactly the schema of inkPersonalStore.ts.
  const ink = await open('fanotes-ink-personal', 1, (database) => {
    database.createObjectStore('lines', { keyPath: 'id' }).createIndex('createdAt', 'createdAt', { unique: false })
    database.createObjectStore('meta', { keyPath: 'key' })
  })
  await run(ink, ['lines', 'meta'], (transaction) => {
    for (let index = 0; index < 25; index += 1) {
      transaction.objectStore('lines').put({
        id: 'ink-line-' + index,
        text: index % 2 ? 'Grüße aus der Schule ' + index : 'The quick brown fox ' + index,
        language: index % 2 ? 'de' : 'en',
        strokes: [stroke(40, 0), stroke(30, 0.5)],
        sourceWidth: 900,
        sourceHeight: 1273,
        referenceHeight: index % 5 ? 36 : 0,
        origin: ['correction', 'confirmed', 'prompt', 'import'][index % 4],
        createdAt: new Date(Date.UTC(2026, 10, 1, 9, index)).toISOString(),
      })
    }
    transaction.objectStore('meta').put({
      key: 'profile',
      modelVersion: 'fanotes-ink-2026.10',
      enabled: true,
      style: { slant: -0.125, width: 1.5, spacing: 0.75 },
      vocabulary: { de: ['Größe', 'Übung', 'Maß'], en: ['quick', 'fox'] },
      fittedOn: 25,
      fittedAt: '2026-11-02T12:00:00.000Z',
      errorBefore: 12.5,
      errorAfter: null,
    })
  })
  ink.close()

  // GlyphenWerk, the same-origin iframe (src/lib/db.ts).
  const glyphen = await open('glyphenwerk-db', 1, (database) => {
    const store = database.createObjectStore('samples', { keyPath: 'id' })
    store.createIndex('labelId', 'labelId', { unique: false })
    store.createIndex('createdAt', 'createdAt', { unique: false })
  })
  await run(glyphen, ['samples'], (transaction) => {
    for (let index = 0; index < 8; index += 1) transaction.objectStore('samples').put({ ...sample(500 + index), id: 'gw-' + index })
  })
  glyphen.close()

  // Every structured-clone shape the V8 reader has to keep apart.
  const types = await open('fanotes-fixture-types', 3, (database) => {
    database.createObjectStore('values', { keyPath: 'id' })
    const outOfLine = database.createObjectStore('outOfLine', { autoIncrement: true })
    outOfLine.createIndex('tag', 'tag', { unique: true, multiEntry: false })
    database.createObjectStore('keys')
  })
  const shared = { shared: true }
  const sparse = []
  sparse[3] = 'three'
  sparse[100] = 'hundred'
  const holes = [1, , 3]
  const extra = [1, 2]
  extra.note = 'extra'
  const values = [
    { id: 'primitives', undefinedValue: undefined, nullValue: null, yes: true, no: false, zero: 0, negativeZero: -0, smi: 1073741823, negativeSmi: -1073741824, big: 2 ** 53, fraction: 0.1, nan: NaN, inf: Infinity, ninf: -Infinity, tiny: 5e-324 },
    { id: 'strings', empty: '', latin1: 'café ÿ', twoByte: 'Ωμέγα', astral: '𝄞😀', lone: 'a\ud800b', nul: 'a\u0000b', marker: '\u0000t' },
    { id: 'containers', date: new Date(Date.UTC(2026, 10, 15, 12, 30)), invalidDate: new Date(NaN), map: new Map([['a', 1], [2, 'b']]), set: new Set(['x', 3]), sparse, holes, extra, nested: { a: [{ b: [{ c: 'deep' }] }] }, integerKeys: { 2: 'two', 1: 'one', '-1': 'minus', '1.5': 'one and a half' }, sharedA: shared, sharedB: shared },
    { id: 'binary', u8: new Uint8Array([0, 1, 2, 255]), f32: new Float32Array([1.5, -2.25]), f64: new Float64Array([Math.PI]), buffer: new Uint8Array([9, 8, 7]).buffer, view: new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2) },
    { id: 'boxed', bigint: 12345678901234567890n, negativeBigint: -42n, number: new Number(3.5), string: new String('boxed'), yes: new Boolean(true), no: new Boolean(false), regexp: /fa+notes/giu },
  ]
  await run(types, ['values', 'outOfLine', 'keys'], (transaction) => {
    for (const value of values) transaction.objectStore('values').put(value)
    transaction.objectStore('outOfLine').put({ tag: 'first', text: 'auto 1' })
    transaction.objectStore('outOfLine').put({ tag: 'second', text: 'auto 2' })
    transaction.objectStore('outOfLine').put({ tag: 'explicit', text: 'explicit key' }, 50)
    transaction.objectStore('keys').put('number key', 7.25)
    transaction.objectStore('keys').put('date key', new Date(Date.UTC(2026, 0, 1)))
    transaction.objectStore('keys').put('array key', ['a', 1])
    transaction.objectStore('keys').put('binary key', new Uint8Array([1, 2, 3]))
    transaction.objectStore('keys').put('string key', 'zß😀')
  })
  types.close()

  // localStorage of the same origin (FaNotes keys plus GlyphenWerk keys).
  localStorage.setItem('fanotes.uiLanguage', 'en')
  localStorage.setItem('fanotes.spelling.personal.v1', JSON.stringify(['Größenordnung', 'FaNotes', 'Ω-Schaltung']))
  localStorage.setItem('fanotes.paperView.v1', JSON.stringify({ 'Notes/Math.md': { zoom: 1.5, x: 120, y: 480 } }))
  localStorage.setItem('fanotes.drafting.v1', JSON.stringify({ grid: true, snap: 5 }))
  localStorage.setItem('fanotes-glyphenwerk-sample-ids.v1', JSON.stringify(['gw-0', 'gw-1']))
  localStorage.setItem('glyphenwerk-writer-id', 'person-fixture')
  localStorage.setItem('glyphenwerk-custom-labels', JSON.stringify([{ id: 'custom_clef', char: '𝄞' }]))
  localStorage.setItem('fanotes.workspace.v1:fixture', 'x'.repeat(20000))
  localStorage.setItem('fanotes-deleted-later', 'gone')
  localStorage.removeItem('fanotes-deleted-later')
  localStorage.setItem('fanotes-overwritten', 'first')
  localStorage.setItem('fanotes-overwritten', 'second')
  return 'ok'
`

const pageScript = (body) => `(async () => {\nconst SAMPLE_COUNT = ${sampleCount}\n${PAGE_HELPERS}\n${body}\n})()`

// Same tagged JSON as the Rust reader (`migrate::v8`) and the renderer step.
const ENCODER_SCRIPT = String.raw`
(async () => {
  const SPECIAL = '\u0000'
  const base64 = (bytes) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text) }
  const wellFormed = (text) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/u.test(text)
  const string = (text) => {
    if (wellFormed(text)) return text
    const bytes = new Uint8Array(text.length * 2)
    for (let index = 0; index < text.length; index += 1) { const unit = text.charCodeAt(index); bytes[index * 2] = unit & 255; bytes[index * 2 + 1] = unit >> 8 }
    return { [SPECIAL]: ['utf16', base64(bytes)] }
  }
  const key = (text) => text.startsWith(SPECIAL) ? SPECIAL + text : text
  const number = (value) => Number.isNaN(value) ? { [SPECIAL]: ['number', 'NaN'] } : value === Infinity ? { [SPECIAL]: ['number', 'Infinity'] } : value === -Infinity ? { [SPECIAL]: ['number', '-Infinity'] } : Object.is(value, -0) ? { [SPECIAL]: ['number', '-0'] } : value
  const properties = (value, skipIndices) => {
    const out = {}
    for (const name of Object.keys(value)) {
      if (skipIndices && String(Number(name) >>> 0) === name && Number(name) >>> 0 !== 4294967295) continue
      const encodedKey = key(name)
      const entry = string(encodedKey)
      if (typeof entry !== 'string') throw new Error('unpaired surrogate in a property name')
      out[encodedKey] = encode(value[name])
    }
    return out
  }
  const viewName = (value) => Object.prototype.toString.call(value).slice(8, -1)
  const encode = (value) => {
    if (value === undefined) return { [SPECIAL]: ['undefined'] }
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return number(value)
    if (typeof value === 'string') return string(value)
    if (typeof value === 'bigint') return { [SPECIAL]: ['bigint', value.toString()] }
    if (value instanceof Date) return { [SPECIAL]: ['date', number(value.getTime())] }
    if (value instanceof RegExp) return { [SPECIAL]: ['regexp', value.source, value.flags] }
    if (value instanceof Number) return { [SPECIAL]: ['Number', number(value.valueOf())] }
    if (value instanceof String) return { [SPECIAL]: ['String', string(value.valueOf())] }
    if (value instanceof Boolean) return { [SPECIAL]: ['Boolean', value.valueOf()] }
    if (value instanceof Map) return { [SPECIAL]: ['map', [...value].map(([k, v]) => [encode(k), encode(v)])] }
    if (value instanceof Set) return { [SPECIAL]: ['set', [...value].map(encode)] }
    if (value instanceof ArrayBuffer) return { [SPECIAL]: ['ArrayBuffer', base64(new Uint8Array(value))] }
    if (ArrayBuffer.isView(value)) {
      return { [SPECIAL]: [viewName(value), base64(new Uint8Array(value.buffer)), value.byteOffset, value.byteLength] }
    }
    if (Array.isArray(value)) {
      const dense = Object.keys(value).length === value.length && Object.keys(value).every((name, index) => name === String(index))
      if (dense) return value.map(encode)
      const elements = []
      for (let index = 0; index < value.length; index += 1) elements.push(Object.prototype.hasOwnProperty.call(value, index) ? encode(value[index]) : { [SPECIAL]: ['hole'] })
      if (elements.filter((item) => item && item[SPECIAL]?.[0] === 'hole').length * 2 > value.length) {
        const entries = Object.keys(value).filter((name) => String(Number(name) >>> 0) === name).map((name) => [Number(name), encode(value[Number(name)])])
        return { [SPECIAL]: ['sparse', value.length, entries, properties(value, true)] }
      }
      return { [SPECIAL]: ['array', elements, properties(value, true)] }
    }
    return properties(value, false)
  }
  const keyValue = (value) => {
    if (typeof value === 'number') return number(value)
    if (typeof value === 'string') return string(value)
    if (value instanceof Date) return { [SPECIAL]: ['date', number(value.getTime())] }
    if (Array.isArray(value)) return value.map(keyValue)
    if (value instanceof ArrayBuffer) return { [SPECIAL]: ['ArrayBuffer', base64(new Uint8Array(value))] }
    if (ArrayBuffer.isView(value)) return { [SPECIAL]: ['ArrayBuffer', base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))] }
    throw new Error('not a key')
  }
  const request = (value) => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) })
  const databases = []
  for (const info of (await indexedDB.databases()).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const database = await new Promise((resolve, reject) => { const opening = indexedDB.open(info.name); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error) })
    const stores = []
    for (const name of [...database.objectStoreNames]) {
      const transaction = database.transaction(name, 'readonly')
      const store = transaction.objectStore(name)
      const keys = await request(store.getAllKeys())
      const records = await request(store.getAll())
      stores.push({
        name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((indexName) => { const index = store.index(indexName); return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry } }),
        records: records.map((value, index) => ({ key: keyValue(keys[index]), value: encode(value) })),
      })
    }
    databases.push({ name: database.name, version: database.version, stores })
    database.close()
  }
  const storage = {}
  for (let index = 0; index < localStorage.length; index += 1) { const name = localStorage.key(index); storage[name] = localStorage.getItem(name) }
  return JSON.stringify({ indexedDB: databases, localStorage: Object.fromEntries(Object.entries(storage).sort(([a], [b]) => a < b ? -1 : 1)) })
})()
`

app.whenReady().then(async () => {
  if (plainTextEncryption && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true)
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    backend,
    sampleCount,
    phases: [phase],
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    storageBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
  }
  if (phase === 'create') Object.assign(report, writeMainProcessFiles(report))
  else {
    const previous = JSON.parse(fs.readFileSync(path.join(out, 'expected.json'), 'utf8')).report
    Object.assign(report, { ...previous, phases: [...previous.phases, phase] })
  }
  const page = path.join(out, 'page', 'index.html')
  write(page, '<!doctype html><meta charset="utf-8"><title>fixture</title><p>fixture</p>')
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await window.loadFile(page)
  await window.webContents.executeJavaScript(pageScript(phase === 'create' ? PAGE_CREATE : PAGE_REOPEN))
  const expected = JSON.parse(await window.webContents.executeJavaScript(ENCODER_SCRIPT))
  report.secrets = Object.keys(FIXTURE_SECRETS).sort()
  write(path.join(out, 'expected.json'), JSON.stringify({ report, ...expected, secrets: FIXTURE_SECRETS, syncAccount: FIXTURE_ACCOUNT })))
  // Flush DOM storage and IndexedDB to disk before quitting.
  await window.webContents.session.flushStorageData()
  window.destroy()
  setTimeout(() => app.quit(), 1500)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
