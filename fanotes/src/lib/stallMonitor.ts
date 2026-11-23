// Stall statistics for the anonymous "Leistungsdaten" batch (only when the user has that switch on).
// A stall is a main-thread task of 500 ms or more. For each one this keeps two numbers: how long it took
// and which kind of background activity was running at that moment (a fixed word from PHASES, or "other").
// Nothing else is recorded: no path, note name, text, stack or timestamp leaves this module.
import { recordStall } from './diagnosticsClient'

export const STALL_PHASES = ['sync', 'save', 'index', 'open', 'other'] as const
export type StallPhase = (typeof STALL_PHASES)[number]

export const STALL_MIN_MS = 500
const MAX_SPANS = 64

type Span = { phase: StallPhase; start: number; end: number }
const spans: Span[] = []
const running = new Map<StallPhase, number>()
let observer: PerformanceObserver | null = null

const remember = (span: Span) => {
  spans.push(span)
  if (spans.length > MAX_SPANS) spans.shift()
}

/** Marks `work` as the activity `phase` for as long as it runs. Returns the same promise. */
export const trackActivity = <T>(phase: StallPhase, work: Promise<T>): Promise<T> => {
  const start = performance.now()
  running.set(phase, (running.get(phase) ?? 0) + 1)
  const done = () => {
    const left = (running.get(phase) ?? 1) - 1
    if (left > 0) running.set(phase, left)
    else running.delete(phase)
    remember({ phase, start, end: performance.now() })
  }
  work.then(done, done)
  return work
}

/** The phase that overlapped the task [start, end] the most (or the one still running), else "other". */
export const phaseOfTask = (start: number, end: number, now = performance.now()): StallPhase => {
  const overlap = new Map<StallPhase, number>()
  for (const span of spans) {
    const length = Math.min(end, span.end) - Math.max(start, span.start)
    if (length > 0) overlap.set(span.phase, (overlap.get(span.phase) ?? 0) + length)
  }
  for (const [phase, since] of running) {
    void since
    const length = Math.min(end, now) - start
    if (length > 0) overlap.set(phase, (overlap.get(phase) ?? 0) + length)
  }
  let best: StallPhase = 'other'
  let most = 0
  for (const [phase, length] of overlap) if (length > most) { best = phase; most = length }
  return best
}

export const startStallMonitor = (enabled: boolean) => {
  if (!enabled) {
    observer?.disconnect()
    observer = null
    return
  }
  if (observer || typeof PerformanceObserver === 'undefined') return
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= STALL_MIN_MS) recordStall(entry.duration, phaseOfTask(entry.startTime, entry.startTime + entry.duration))
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    observer = null
  }
}
