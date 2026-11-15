/** Remember a release listing so /api/health does not wait on a cold file share every time. */
export const createReleaseCache = (load, ttlMs, now = Date.now) => {
  const snapshots = new Map()
  const pending = new Map()
  const refresh = (channel) => {
    if (pending.has(channel)) return pending.get(channel)
    const job = Promise.resolve().then(() => load(channel)).then((value) => {
      snapshots.set(channel, { at: now(), value })
      return value
    }).finally(() => { pending.delete(channel) })
    pending.set(channel, job)
    return job
  }
  return {
    get(channel = 'stable') {
      const snapshot = snapshots.get(channel)
      const fresh = snapshot && now() - snapshot.at < ttlMs
      if (fresh) return Promise.resolve(snapshot.value)
      const job = refresh(channel)
      if (!snapshot) return job
      // A later request observes the refresh. This one keeps the previous listing.
      job.catch(() => {})
      return Promise.resolve(snapshot.value)
    },
  }
}
