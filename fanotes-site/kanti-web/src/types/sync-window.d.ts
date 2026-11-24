// The shared sync client (fanotes/src/lib/sync/api.ts) looks at the desktop shell's `window.fanotes`.
// The browser app has no such shell; the client is always given its origin explicitly.
export {}
declare global {
  interface Window { fanotes?: { platform?: string } }
}
