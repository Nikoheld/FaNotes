'use strict'
// Helpers for the vault tree scan in the main process.
//
// 1. createTreeScanCache: the watcher walks the vault in the background and the
//    renderer may reuse that walk once. A walk that started before one of our own
//    mutations (create/rename/move/trash/import ...) can miss the change, so every
//    scan remembers the structure generation it started in and is only reusable
//    while that generation is still current.
// 2. mergeTreeEntries: a folder that exists in several linked locations is one
//    logical folder; its children from all locations are merged.

function createTreeScanCache({ now = Date.now, maxAgeMs = 5000 } = {}) {
  let generation = 0
  let scan = null
  return {
    generation: () => generation,
    /** Call before AND after every own mutation of the vault structure. */
    bump() {
      generation += 1
      scan = null
      return generation
    },
    /** Call when a walk starts; pass the token to finish(). */
    begin: () => generation,
    finish(token, root, entries) {
      scan = { root, entries, at: now(), generation: token, reusable: false }
    },
    /** The watcher announced a change: its latest walk may now answer one getTree. */
    markReusable(root) {
      if (scan?.root === root) scan.reusable = true
    },
    /** Returns the reusable walk (once) or null. Always consumes the stored walk. */
    take(root, { fromWatcher = false } = {}) {
      const current = scan
      scan = null
      if (!fromWatcher || !current?.reusable || current.root !== root) return null
      if (current.generation !== generation) return null
      if (now() - current.at >= maxAgeMs) return null
      return current.entries
    },
  }
}

function mergeTreeEntries(target, extra) {
  const byName = new Map(target.map((entry) => [entry.name, entry]))
  for (const entry of extra) {
    const existing = byName.get(entry.name)
    if (!existing) {
      target.push(entry)
      byName.set(entry.name, entry)
    } else if (existing.kind === 'folder' && entry.kind === 'folder') {
      existing.children = mergeTreeEntries(existing.children ?? [], entry.children ?? [])
    }
  }
  return target
}

module.exports = { createTreeScanCache, mergeTreeEntries }
