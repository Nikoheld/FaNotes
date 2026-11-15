/**
 * Desktop-only (Tauri) step of the Electron profile migration.
 *
 * The Rust host reads the Electron profile's IndexedDB and localStorage from
 * its verified backup and exports them as tagged JSON (`crates/fanotes-host/src/migrate`).
 * This step writes them into the webview's own storage before the app renders,
 * then reads every record back and reports counts to the host, which only marks
 * the migration complete when every record is present and equal.
 *
 * Idempotent: a record or key that already exists is never overwritten. If it
 * is equal it counts as migrated; if it differs the existing (Tauri) value is
 * kept and reported, and the Electron value stays in the backup.
 * Electron and the web app have no `__TAURI_INTERNALS__` and skip this file.
 */

type Tagged = unknown
type Invoke = (command: string, payload: { args: unknown[] }) => Promise<unknown>
type StoreCounts = { expected: number; equal: number; keptExisting: number; failed: number }
type StorePlan = { name: string; keyPath: string | string[] | null; autoIncrement: boolean; indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[]; count: number; file: string }
type DatabasePlan = { name: string; version: number; stores: StorePlan[] }
type Plan = { databases: DatabasePlan[]; localStorage: { count: number; file: string } | null }
type Page = { items: { key?: Tagged; value?: Tagged; name?: Tagged }[]; next: number | null }

const SPECIAL = '\u0000'

const fromBase64 = (text: string) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
const toBase64 = (bytes: Uint8Array) => {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x2000) text += String.fromCharCode(...bytes.subarray(index, index + 0x2000))
  return btoa(text)
}

const VIEWS: Record<string, new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  DataView: DataView as unknown as new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView,
}

const decodeNumber = (value: Tagged): number => {
  if (typeof value === 'number') return value
  const [, text] = (value as Record<string, [string, string]>)[SPECIAL]
  return text === '-0' ? -0 : Number(text)
}

const unescapeKey = (key: string) => key.startsWith(SPECIAL) ? key.slice(1) : key

const decodeProperties = (target: Record<string, unknown>, encoded: Record<string, Tagged>) => {
  for (const [key, value] of Object.entries(encoded)) target[unescapeKey(key)] = decode(value)
  return target
}

/** Tagged JSON → structured-clone value. */
export const decode = (value: Tagged): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== SPECIAL) return decodeProperties({}, value as Record<string, Tagged>)
  const [tag, ...rest] = (value as Record<string, unknown[]>)[SPECIAL]
  switch (tag) {
    case 'undefined': return undefined
    case 'number': return decodeNumber(value)
    case 'utf16': {
      const bytes = fromBase64(rest[0] as string)
      let text = ''
      for (let index = 0; index + 1 < bytes.length; index += 2) text += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8))
      return text
    }
    case 'bigint': return BigInt(rest[0] as string)
    case 'BigInt': return Object(BigInt(rest[0] as string))
    case 'date': return new Date(decodeNumber(rest[0]))
    case 'regexp': return new RegExp(decode(rest[0]) as string, rest[1] as string)
    case 'Number': return new Number(decodeNumber(rest[0]))
    case 'String': return new String(decode(rest[0]) as string)
    case 'Boolean': return new Boolean(rest[0] as boolean)
    case 'map': return new Map((rest[0] as Tagged[][]).map(([key, item]) => [decode(key), decode(item)]))
    case 'set': return new Set((rest[0] as Tagged[]).map(decode))
    case 'ArrayBuffer': return fromBase64(rest[0] as string).buffer
    case 'array': {
      const elements = rest[0] as Tagged[]
      const array: unknown[] = new Array(elements.length)
      elements.forEach((item, index) => {
        const holeKeys = item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : []
        const hole = holeKeys.length === 1 && holeKeys[0] === SPECIAL && (item as Record<string, unknown[]>)[SPECIAL][0] === 'hole'
        if (!hole) array[index] = decode(item)
      })
      return decodeProperties(array as unknown as Record<string, unknown>, rest[1] as Record<string, Tagged>)
    }
    case 'sparse': {
      const array: unknown[] = new Array(rest[0] as number)
      for (const [index, item] of rest[1] as [number, Tagged][]) array[index] = decode(item)
      return decodeProperties(array as unknown as Record<string, unknown>, rest[2] as Record<string, Tagged>)
    }
    default: {
      const View = VIEWS[tag as string]
      if (!View) throw new Error(`Unbekannter Migrationswert ${String(tag)}`)
      return new View(fromBase64(rest[0] as string).buffer, rest[1] as number, tag === 'DataView' ? rest[2] as number : (rest[2] as number) / ((View as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT))
    }
  }
}

const special = (...items: unknown[]) => ({ [SPECIAL]: items })
const wellFormed = (text: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/u.test(text)
const encodeString = (text: string): Tagged => {
  if (wellFormed(text)) return text
  const bytes = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) { const unit = text.charCodeAt(index); bytes[index * 2] = unit & 255; bytes[index * 2 + 1] = unit >> 8 }
  return special('utf16', toBase64(bytes))
}
const encodeNumber = (value: number): Tagged => Number.isNaN(value) ? special('number', 'NaN') : value === Infinity ? special('number', 'Infinity') : value === -Infinity ? special('number', '-Infinity') : Object.is(value, -0) ? special('number', '-0') : value
const isIndex = (name: string) => String(Number(name) >>> 0) === name && Number(name) >>> 0 !== 4294967295
const encodeProperties = (value: object, skipIndices: boolean) => {
  const out: Record<string, Tagged> = {}
  for (const name of Object.keys(value)) {
    if (skipIndices && isIndex(name)) continue
    out[name.startsWith(SPECIAL) ? SPECIAL + name : name] = encode((value as Record<string, unknown>)[name])
  }
  return out
}

/** Structured-clone value → tagged JSON (the same rules as the Rust reader). */
export const encode = (value: unknown): Tagged => {
  if (value === undefined) return special('undefined')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return encodeNumber(value)
  if (typeof value === 'string') return encodeString(value)
  if (typeof value === 'bigint') return special('bigint', value.toString())
  if (value instanceof Date) return special('date', encodeNumber(value.getTime()))
  if (value instanceof RegExp) return special('regexp', encodeString(value.source), value.flags)
  if (value instanceof Number) return special('Number', encodeNumber(value.valueOf()))
  if (value instanceof String) return special('String', encodeString(value.valueOf()))
  if (value instanceof Boolean) return special('Boolean', value.valueOf())
  if (Object.prototype.toString.call(value) === '[object BigInt]') return special('BigInt', (value as { valueOf(): bigint }).valueOf().toString())
  if (value instanceof Map) return special('map', [...value].map(([key, item]) => [encode(key), encode(item)]))
  if (value instanceof Set) return special('set', [...value].map(encode))
  if (value instanceof ArrayBuffer) return special('ArrayBuffer', toBase64(new Uint8Array(value)))
  if (ArrayBuffer.isView(value)) return special(Object.prototype.toString.call(value).slice(8, -1), toBase64(new Uint8Array(value.buffer as ArrayBuffer)), value.byteOffset, value.byteLength)
  if (Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.length === value.length && keys.every((name, index) => name === String(index))) return value.map(encode)
    const present = keys.filter(isIndex).length
    if ((value.length - present) * 2 > value.length) {
      return special('sparse', value.length, keys.filter((name) => String(Number(name) >>> 0) === name).map((name) => [Number(name), encode(value[Number(name)])]), encodeProperties(value, true))
    }
    const elements = Array.from({ length: value.length }, (_, index) => Object.prototype.hasOwnProperty.call(value, index) ? encode(value[index]) : special('hole'))
    return special('array', elements, encodeProperties(value, true))
  }
  return encodeProperties(value as object, false)
}

const decodeKey = (value: Tagged): IDBValidKey => {
  if (Array.isArray(value)) return value.map(decodeKey)
  const decoded = decode(value)
  return decoded as IDBValidKey
}

const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result)
  value.onerror = () => reject(value.error)
})

const openDatabase = (name: string, version: number | undefined, upgrade?: (database: IDBDatabase, transaction: IDBTransaction | null) => void) => new Promise<IDBDatabase>((resolve, reject) => {
  const opening = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
  opening.onupgradeneeded = () => upgrade?.(opening.result, opening.transaction)
  opening.onsuccess = () => resolve(opening.result)
  opening.onerror = () => reject(opening.error)
  opening.onblocked = () => reject(new Error('Die Handschrift-Datenbank ist blockiert.'))
})

const createMissing = (database: IDBDatabase, transaction: IDBTransaction | null, stores: StorePlan[]) => {
  for (const store of stores) {
    const target = database.objectStoreNames.contains(store.name)
      ? transaction?.objectStore(store.name)
      : database.createObjectStore(store.name, { keyPath: store.keyPath ?? undefined, autoIncrement: store.autoIncrement })
    if (!target) continue
    for (const index of store.indexes) {
      if (!target.indexNames.contains(index.name)) target.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry })
    }
  }
}

const openForPlan = async (plan: DatabasePlan) => {
  const exists = (await indexedDB.databases()).some((info) => info.name === plan.name)
  if (!exists) {
    return openDatabase(plan.name, Math.max(1, plan.version), (database, transaction) => createMissing(database, transaction, plan.stores))
  }
  const current = await openDatabase(plan.name, undefined)
  const missing = plan.stores.some((store) => !current.objectStoreNames.contains(store.name))
  const version = current.version
  current.close()
  if (!missing && version >= plan.version) return openDatabase(plan.name, undefined)
  const next = Math.max(version + (missing ? 1 : 0), plan.version)
  return openDatabase(plan.name, next, (database, transaction) => createMissing(database, transaction, plan.stores))
}

const same = (stored: unknown, expected: Tagged) => JSON.stringify(encode(stored)) === JSON.stringify(expected)

const importStore = async (invoke: Invoke, database: IDBDatabase, store: StorePlan): Promise<StoreCounts> => {
  const counts: StoreCounts = { expected: store.count, equal: 0, keptExisting: 0, failed: 0 }
  let start: number | null = 0
  const seen: { key: IDBValidKey; value: Tagged }[] = []
  while (start !== null) {
    const page = await invoke('fanotes-native:migration-page', { args: [store.file, start] }) as Page
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(store.name, 'readwrite')
      const target = transaction.objectStore(store.name)
      for (const item of page.items) {
        const key = decodeKey(item.key)
        seen.push({ key, value: item.value })
        const lookup = target.get(key)
        lookup.onsuccess = () => {
          if (lookup.result !== undefined) return
          const value = decode(item.value)
          if (store.keyPath === null) target.add(value, key)
          else target.add(value)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    start = page.next
  }
  // Read back every record and compare it with the export.
  const transaction = database.transaction(store.name, 'readonly')
  const target = transaction.objectStore(store.name)
  for (const { key, value } of seen) {
    const stored = await request(target.get(key))
    if (stored === undefined) counts.failed += 1
    else if (same(stored, value)) counts.equal += 1
    else counts.keptExisting += 1
  }
  return counts
}

const importLocalStorage = async (invoke: Invoke, file: string, expected: number): Promise<StoreCounts> => {
  const counts: StoreCounts = { expected, equal: 0, keptExisting: 0, failed: 0 }
  let start: number | null = 0
  while (start !== null) {
    const page = await invoke('fanotes-native:migration-page', { args: [file, start] }) as Page
    for (const item of page.items) {
      const name = decode(item.name) as string
      const value = decode(item.value) as string
      if (localStorage.getItem(name) === null) localStorage.setItem(name, value)
      const stored = localStorage.getItem(name)
      if (stored === null) counts.failed += 1
      else if (stored === value) counts.equal += 1
      else counts.keptExisting += 1
    }
    start = page.next
  }
  return counts
}

/** Runs before the app renders. Never throws: a failure stays pending and is retried on the next start. */
export const runDesktopMigration = async () => {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__
  if (!internals?.invoke) return
  const invoke = internals.invoke.bind(internals)
  try {
    const plan = await invoke('fanotes-native:migration-plan', { args: [] }) as Plan | null
    if (!plan) return
    const stores: Record<string, StoreCounts> = {}
    for (const databasePlan of plan.databases) {
      const database = await openForPlan(databasePlan)
      try {
        for (const store of databasePlan.stores) stores[`${databasePlan.name}/${store.name}`] = await importStore(invoke, database, store)
      } finally {
        database.close()
      }
    }
    const local = plan.localStorage ? await importLocalStorage(invoke, plan.localStorage.file, plan.localStorage.count) : undefined
    await invoke('fanotes-native:migration-done', { args: [{ stores, localStorage: local }] })
  } catch (error) {
    console.warn('FaNotes: Die Übernahme der Electron-Browserdaten wird beim nächsten Start fortgesetzt.', error)
  }
}
