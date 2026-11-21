'use strict'
// Regression guards for the Windows QA shell findings (QA-004, 006, 015, 016, 018, 019).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const main = read('electron/main.cjs')

// QA-019: only the packaged, installed app may own the fanotes:// handler.
assert.match(main, /if \(shouldRegisterProtocolClient\(\)\) \{\s*try \{ app\.setAsDefaultProtocolClient\('fanotes'\)/, 'protocol registration must be gated')
const gate = main.slice(main.indexOf('function shouldRegisterProtocolClient'), main.indexOf('function shouldRegisterProtocolClient') + 700)
for (const needle of ['app.isPackaged', 'PORTABLE_EXECUTABLE_FILE', '--user-data-dir', 'FANOTES_TEST']) assert.ok(gate.includes(needle), `gate misses ${needle}`)
assert.equal((main.match(/setAsDefaultProtocolClient\(/g) ?? []).length, 1, 'only one registration site')

// QA-006: an existing non-empty default folder is never adopted silently.
assert.match(main, /if \(await folderHasEntries\(defaultPath\)\) \{\s*defaultPath = await askExistingDefaultVault\(defaultPath\)/)

// QA-015: no Ctrl+Alt letter shortcuts in writing mode (AltGr on Windows).
for (const file of ['src/writing/ui/Toolbar.tsx', 'src/writing/ui/Inspector.tsx', 'src/writing/ui/WritingMode.tsx']) {
  assert.ok(!/(Strg|Ctrl)\+Alt\+/.test(read(file)), `${file} still advertises Ctrl+Alt`)
}
assert.ok(!/mod && event\.altKey/.test(read('src/writing/ui/WritingMode.tsx')), 'Ctrl+Alt handler must be gone')

// QA-016: the data notice is hidden in toolbar fullscreen.
assert.match(read('src/styles.css'), /\.app-shell\.toolbar-fullscreen \.send-data-notice \{ display: none; \}/)

// QA-018: the standard baseline yields to the event loop while rendering.
assert.match(read('../src/lib/standardRecognition.ts'), /await yieldToEventLoop\(\)/)

// QA-004: missing cmake falls back to the prebuilt runtime.
assert.match(read('scripts/stage-enhanced-math-runtime.cjs'), /spawnSync\('cmake', \['--version'\]/)
console.log('QA shell/Windows checks passed')
