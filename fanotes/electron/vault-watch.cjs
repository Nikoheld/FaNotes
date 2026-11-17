'use strict'
// Detects files that appear, change or vanish in the vault (or a linked folder
// location) without FaNotes doing it. fs.watch is only a hint; a periodic and
// on-focus rescan compares cheap signatures, so it also works where recursive
// watching is missing or unreliable (Linux, network drives).

/** Names the tree never shows or that are FaNotes internals / temp files. */
function isIgnoredWatchPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return true
  const parts = relativePath.split(/[\\/]+/).filter(Boolean)
  if (!parts.length) return true
  for (const part of parts) {
    if (part.startsWith('.')) return true // .fanotes/, hidden files, atomic-write temp files
  }
  const leaf = parts[parts.length - 1].toLowerCase()
  if (leaf.endsWith('.tmp') || leaf.endsWith('~') || leaf.endsWith('.part') || leaf.endsWith('.crdownload')) return true
  if (leaf.includes('.sync-conflict-') || leaf.includes('.conflict-spool')) return true
  return false
}

/** Flatten a tree to Map(path -> signature). Folders only carry their kind. */
function flattenTree(entries, out = new Map()) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.relativePath !== 'string') continue
    if (entry.kind === 'folder') {
      out.set(entry.relativePath, 'd')
      flattenTree(entry.children, out)
    } else {
      out.set(entry.relativePath, `f:${entry.modifiedAt || ''}:${entry.size ?? ''}`)
    }
  }
  return out
}

/** Compare two signature maps. */
function diffSignatures(previous, next) {
  const added = []
  const removed = []
  const changed = []
  for (const [key, value] of next) {
    if (!previous.has(key)) added.push(key)
    else if (previous.get(key) !== value) changed.push(key)
  }
  for (const key of previous.keys()) if (!next.has(key)) removed.push(key)
  return { added, removed, changed }
}

function isEmptyDiff(diff) {
  return !diff.added.length && !diff.removed.length && !diff.changed.length
}

/**
 * createVaultWatcher({ getRoots, scan, onChange, watch, setIntervalFn, ... })
 * scan() resolves the current tree; getRoots() the absolute directories to hint-watch.
 */
function createVaultWatcher(options) {
  const {
    getRoots, scan, onChange, watch,
    debounceMs = 1200, intervalMs = 20000, healthyIntervalMs = 120000,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  } = options
  let signature = null
  let timer = null
  let interval = null
  let running = false
  let again = false
  let stopped = false
  let watchers = []
  let watchedKey = ''
  let healthy = false
  let active = true
  let armedMs = 0

  // 20 s only while fs.watch is missing or failing; healthy watchers are only a hint, so back off.
  const wantedInterval = () => (healthy ? Math.max(healthyIntervalMs, intervalMs) : intervalMs)
  const armInterval = () => {
    if (stopped || !active) return
    const wanted = wantedInterval()
    if (interval && armedMs === wanted) return
    if (interval) clearIntervalFn(interval)
    armedMs = wanted
    interval = setIntervalFn(() => { void rescan() }, wanted)
    interval?.unref?.()
  }

  const closeWatchers = () => {
    for (const watcher of watchers) { try { watcher.close() } catch { /* already closed */ } }
    watchers = []
    watchedKey = ''
    healthy = false
  }

  const syncWatchers = () => {
    if (!watch) return
    let roots = []
    try { roots = [...new Set(getRoots())] } catch { roots = [] }
    const key = roots.join('\n')
    if (key === watchedKey) return
    closeWatchers()
    watchedKey = key
    let failed = false
    for (const root of roots) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
          if (name && isIgnoredWatchPath(String(name))) return
          schedule()
        })
        watcher.on?.('error', () => {
          // The periodic rescan still covers this root, at the fast rate again.
          healthy = false
          armInterval()
        })
        watchers.push(watcher)
      } catch { failed = true /* unsupported or missing: rely on the rescan */ }
    }
    healthy = !failed && watchers.length > 0
  }

  async function rescan() {
    if (stopped) return null
    if (running) { again = true; return null }
    running = true
    try {
      syncWatchers()
      armInterval()
      const next = flattenTree(await scan())
      if (signature === null) { signature = next; return null }
      const diff = diffSignatures(signature, next)
      signature = next
      if (isEmptyDiff(diff)) return null
      onChange(diff)
      return diff
    } catch {
      return null
    } finally {
      running = false
      if (again && !stopped) { again = false; schedule() }
    }
  }

  function schedule() {
    if (stopped) return
    if (timer) clearTimeoutFn(timer)
    timer = setTimeoutFn(() => { timer = null; void rescan() }, debounceMs)
    timer?.unref?.()
  }

  return {
    start() {
      stopped = false
      void rescan()
      armInterval()
    },
    /** False while every window is hidden or minimized: no periodic rescans. True: rescan now. */
    setActive(value) {
      if (stopped || active === Boolean(value)) return
      active = Boolean(value)
      if (!active) {
        if (interval) clearIntervalFn(interval)
        interval = null
        armedMs = 0
        return
      }
      armInterval()
      schedule()
    },
    currentIntervalMs: () => (interval ? armedMs : 0),
    /** Window focus or another cue: look soon. */
    nudge: schedule,
    rescan,
    stop() {
      stopped = true
      if (timer) clearTimeoutFn(timer)
      if (interval) clearIntervalFn(interval)
      timer = interval = null
      armedMs = 0
      closeWatchers()
    },
  }
}

module.exports = { isIgnoredWatchPath, flattenTree, diffSignatures, isEmptyDiff, createVaultWatcher }
