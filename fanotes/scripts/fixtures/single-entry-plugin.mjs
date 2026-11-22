// The browser harness checks build one small entry with vite's `build.lib`, but the app's vite.config.ts lists its own
// HTML entries (index.html, ocr-host.html) in `build.rollupOptions.input`, and that wins over `lib.entry`. The result was
// a `harness.js` that was really the OCR host script, so the harness page never rendered and the checks timed out.
// This plugin pins the rollup input to the harness entry.
export const singleEntryPlugin = (entry) => ({
  name: 'fanotes-single-harness-entry',
  options(options) {
    return { ...options, input: entry }
  },
})
