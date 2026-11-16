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
  merging: ['verifying', 'failed'],
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

export function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (s && PHASES.includes(s.phase)) return s
  } catch { /* missing or corrupt: start clean */ }
  return emptyState()
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
