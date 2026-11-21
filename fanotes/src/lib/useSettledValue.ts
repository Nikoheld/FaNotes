import { startTransition, useEffect, useState } from 'react'

/** Documents above this size get whole-text helpers (tags, outline, backlinks, word count) after typing pauses. */
export const LARGE_NOTE_CHARS = 100_000
export const LARGE_NOTE_SETTLE_MS = 600

/**
 * The value itself while `weight` is small. While it is large (a huge note), the value
 * follows only after `delay` ms without a change and is applied at low priority, so
 * O(document) derived data does not run on every key. A new `key` (another note) is
 * never delayed.
 */
export const useSettledValue = <T,>(value: T, weight: number, key: string, delay = LARGE_NOTE_SETTLE_MS): T => {
  const [settled, setSettled] = useState({ key, value })
  const large = weight >= LARGE_NOTE_CHARS
  useEffect(() => {
    if (settled.key === key && settled.value === value) return undefined
    if (!large || settled.key !== key) {
      setSettled({ key, value })
      return undefined
    }
    const timer = window.setTimeout(() => startTransition(() => setSettled({ key, value })), delay)
    return () => window.clearTimeout(timer)
  }, [delay, key, large, settled, value])
  return settled.key !== key || !large ? value : settled.value
}
