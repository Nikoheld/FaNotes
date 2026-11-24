// What the page needs from a vault: read, change (with the conflict rule), list. The encrypted client
// implements it; the demo and the unit tests use the in-memory one.
import type { Mutation, VaultEntry, VaultRead } from './client'

export interface VaultBackend {
  read(path: string): Promise<VaultRead>
  update(path: string, mutate: Mutation): Promise<{ revision: number; bytes: Uint8Array } | null>
  create(path: string, bytes: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
  list(): Promise<VaultEntry[]>
  /** Brings the list of existing files up to date before a batch of reads (the encrypted client). */
  sync?(): Promise<void>
}

/** A vault in memory. `beforeWrite` lets a test change the file between the read and the write of an update. */
export class MemoryBackend implements VaultBackend {
  readonly files = new Map<string, { bytes: Uint8Array; revision: number; mtimeMs: number }>()
  beforeWrite: ((path: string) => void) | null = null
  writes = 0

  constructor(initial: Record<string, string | Uint8Array> = {}) {
    for (const [path, value] of Object.entries(initial)) this.put(path, typeof value === 'string' ? new TextEncoder().encode(value) : value)
  }

  put(path: string, bytes: Uint8Array) {
    const previous = this.files.get(path)
    this.files.set(path, { bytes, revision: (previous?.revision ?? 0) + 1, mtimeMs: Date.now() })
  }

  async read(path: string): Promise<VaultRead> {
    const file = this.files.get(path)
    return file ? { bytes: file.bytes, revision: file.revision, mtimeMs: file.mtimeMs } : { bytes: null, revision: 0, mtimeMs: 0 }
  }

  async update(path: string, mutate: Mutation) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const current = await this.read(path)
      const next = await mutate(current.bytes)
      if (next === null) return null
      this.beforeWrite?.(path)
      const now = this.files.get(path)
      if ((now?.revision ?? 0) !== current.revision) {
        if (attempt === 3) throw new Error('conflict')
        continue
      }
      this.put(path, next)
      this.writes += 1
      return { revision: this.files.get(path)!.revision, bytes: next }
    }
    throw new Error('conflict')
  }

  async create(path: string, bytes: Uint8Array) {
    if (this.files.has(path)) throw new Error('exists')
    this.put(path, bytes)
  }

  async remove(path: string) { this.files.delete(path) }

  async list(): Promise<VaultEntry[]> {
    return [...this.files.entries()].map(([path, file]) => ({ id: path, path, revision: file.revision, size: file.bytes.byteLength, mtimeMs: file.mtimeMs })).sort((a, b) => a.path.localeCompare(b.path))
  }
}
