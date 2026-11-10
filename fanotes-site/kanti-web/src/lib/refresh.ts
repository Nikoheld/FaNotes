// When the browser refreshes. The server reads Schulnetz on its own schedule (every few minutes on
// school days); the page takes the server's copy when it opens, when the tab becomes visible again
// and on a timer while visible, never more often than the debounce.

/** A refresh is skipped when the last one finished this recently. */
export const REFRESH_DEBOUNCE_MS = 30_000

export const refreshDue = (lastAt: number, now: number, loading: boolean): boolean => {
  if (loading) return false
  if (!lastAt || now < lastAt) return true
  return now - lastAt >= REFRESH_DEBOUNCE_MS
}
