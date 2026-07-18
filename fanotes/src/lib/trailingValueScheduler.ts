export type TimerAdapter = {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}

export type TrailingValueScheduler<T> = {
  push(value: T): void
  flush(): void
  cancel(): void
  pending(): boolean
}

const browserTimers: TimerAdapter = {
  set: (callback, delay) => globalThis.setTimeout(callback, delay),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Coalesces a rapid stream while retaining a synchronous flush path for save/close. */
export const createTrailingValueScheduler = <T>(
  emit: (value: T) => void,
  delay = 90,
  timers: TimerAdapter = browserTimers,
): TrailingValueScheduler<T> => {
  let latest: T
  let hasValue = false
  let timer: unknown = null

  const cancelTimer = () => {
    if (timer === null) return
    timers.clear(timer)
    timer = null
  }

  const flush = () => {
    cancelTimer()
    if (!hasValue) return
    const value = latest
    hasValue = false
    emit(value)
  }

  return {
    push(value) {
      latest = value
      hasValue = true
      cancelTimer()
      timer = timers.set(flush, Math.max(0, delay))
    },
    flush,
    cancel() {
      cancelTimer()
      hasValue = false
    },
    pending: () => hasValue,
  }
}
