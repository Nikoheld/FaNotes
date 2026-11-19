/**
 * Startup marks read by `scripts/bench-desktop`. Inert: one `performance.mark`
 * per name and page load, no listeners, no state, nothing sent anywhere.
 */
export const markOnce = (name: string) => {
  try {
    if (!performance.getEntriesByName(name, 'mark').length) performance.mark(name)
  } catch {
    // No User Timing API: nothing to mark.
  }
}
