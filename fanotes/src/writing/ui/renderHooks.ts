import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * An object of callbacks whose identity never changes but which always call the latest version
 * of each function. The set of keys must stay the same between renders.
 */
export function useStableActions<T extends Record<string, (...args: never[]) => unknown>>(actions: T): T {
  const latest = useRef(actions)
  latest.current = actions
  return useMemo(() => {
    const stable: Record<string, unknown> = {}
    for (const key of Object.keys(actions)) stable[key] = (...args: unknown[]) => (latest.current[key] as (...inner: unknown[]) => unknown)(...args)
    return stable as T
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/**
 * Follows `value`, but while it keeps changing quickly (typing) it only catches up once it
 * has been quiet for `quietMs` (or after `maxMs` at the latest). An isolated change is
 * taken over immediately, so discrete actions (undo, rename, replace) are not delayed.
 */
export function useBurstThrottled<T>(value: T, quietMs = 300, maxMs = 1200): T {
  const [shown, setShown] = useState(value)
  const last = useRef({ changedAt: 0, shownAt: 0 })
  useEffect(() => {
    if (Object.is(value, shown)) return undefined
    const now = performance.now()
    const idle = now - last.current.changedAt >= quietMs
    last.current.changedAt = now
    if (idle || now - last.current.shownAt >= maxMs) {
      last.current.shownAt = now
      setShown(value)
      return undefined
    }
    const timer = window.setTimeout(() => { last.current.shownAt = performance.now(); setShown(value) }, quietMs)
    return () => window.clearTimeout(timer)
  }, [value, shown, quietMs, maxMs])
  return shown
}

/** Returns the previous object while the new one is shallow-equal to it. */
export function useShallowStable<T extends object>(value: T): T {
  const previous = useRef(value)
  const keys = Object.keys(value) as Array<keyof T>
  const same = keys.length === Object.keys(previous.current).length && keys.every((key) => Object.is(value[key], previous.current[key]))
  if (!same) previous.current = value
  return previous.current
}
