// Crash-safe state file and the request state machine.
import fs from 'node:fs'
import path from 'node:path'

export const PHASES = ['idle', 'claimed', 'preparing', 'running', 'pr_open', 'waiting', 'merging', 'verifying', 'done', 'failed']

const ALLOWED = {
  idle: ['claimed'],
  claimed: ['preparing', 'failed'],
  preparing: ['running', 'failed'],
  running: ['running', 'pr_open', 'failed'],
  pr_open: ['waiting', 'running', 'failed'],
  waiting: ['running', 'merging', 'failed'],
  merging: ['verifying', 'running', 'failed'],
  verifying: ['done', 'failed'],
  done: ['idle'],
  failed: ['idle'],
}

export function canTransition(from, to) {
  return (ALLOWED[from] || []).includes(to)
}

export function transition(state, to, patch = {}) {
  if (!canTransition(state.phase, to)) throw new Error(`illegal transition ${state.phase} -> ${to}`)
  return { ...state, ...patch, phase: to }
}

export const emptyState = () => ({ phase: 'idle' })

// The state file holds {jobs: {<requestId>: jobState}}. Requests parked in pr_open/waiting
// keep being served while the next request is claimed, so several jobs can exist at once.
export function loadJobs(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    const jobs = {}
    for (const [id, j] of Object.entries(s?.jobs || {})) if (j && PHASES.includes(j.phase)) jobs[id] = j
    return jobs
  } catch { return {} /* missing or corrupt: start clean */ }
}

export function saveJobs(file, jobs) {
  const state = { jobs }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
