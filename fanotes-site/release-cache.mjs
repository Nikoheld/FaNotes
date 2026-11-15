/** Remember a release listing so /api/health does not wait on a cold file share every time. */
export const createReleaseCache = (load, ttlMs, now = Date.now) => {
  const snapshots = new Map()
  const pending = new Map()
  const quiet = new Set()
  const refresh = (channel) => {
    if (pending.has(channel)) return pending.get(channel)
    const job = Promise.resolve().then(() => load(channel)).then((value) => {
      snapshots.set(channel, { at: now(), value })
      quiet.delete(channel)
      return value
    }).finally(() => { pending.delete(channel) })
    pending.set(channel, job)
    return job
  }
  return {
    get(channel = 'stable', waitMs = Infinity) {
      const snapshot = snapshots.get(channel)
      const fresh = snapshot && now() - snapshot.at < ttlMs
      if (fresh) return Promise.resolve(snapshot.value)
      if (!snapshot && Number.isFinite(waitMs) && quiet.has(channel) && pending.has(channel)) return Promise.resolve(null)
      const job = refresh(channel)
      if (!snapshot && Number.isFinite(waitMs)) {
        let timer
        const limited = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs) })
        const settled = job.then((value) => value, () => null)
        return Promise.race([settled, limited]).finally(() => clearTimeout(timer)).then((value) => {
          if (value == null && !snapshots.has(channel)) quiet.add(channel)
          return value
        })
      }
      if (!snapshot) return job
      // A later request observes the refresh. This one keeps the previous listing.
      job.catch(() => {})
      return Promise.resolve(snapshot.value)
    },
  }
}
