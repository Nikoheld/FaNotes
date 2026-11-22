'use strict'

// Regression guard for the desktop startup critical path (PR "Desktop: faster startup").
// Source-level on purpose: the measured behaviour lives in scripts/measure-startup.mjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
const entry = fs.readFileSync(path.join(root, 'src', 'main.tsx'), 'utf8')

// 1. The window is mapped once the document is parsed, not after the first "non-empty" frame
//    (a hidden window only got that frame about a second later and ran no requestAnimationFrame).
assert.match(main, /mainWindow\.webContents\.once\('dom-ready', revealWindow\)/u, 'the window must be revealed at dom-ready')
assert.match(main, /mainWindow\.once\('ready-to-show', revealWindow\)/u, 'ready-to-show stays as the fallback reveal')
assert.match(main, /show:\s*false/u, 'the window is still created hidden so the reveal is explicit')

// 2. Node's compile cache is enabled before the bulk of main-process modules load.
const cacheAt = main.indexOf('enableCompileCache')
const firstLocalRequire = main.indexOf("require('./folder-locations.cjs')")
assert.ok(cacheAt > 0 && firstLocalRequire > cacheAt, 'enableCompileCache must run before the local modules are required')
assert.match(main, /catch \{[^}]*cache/u, 'a failing compile cache must not stop the start')

// 3. Tree scan: one shared collator, and the per-directory lstat calls start together.
const compare = /function compareEntries\(left, right\) \{[\s\S]*?\n\}/u.exec(main)?.[0] ?? ''
assert.ok(compare.includes('TREE_NAME_COLLATOR.compare'), 'compareEntries must use the shared Intl.Collator')
assert.ok(!compare.includes('localeCompare'), 'compareEntries must not build a collator per comparison')
const scan = /async function readTreeDirectory[\s\S]*?\nasync function readFastTreeDirectory/u.exec(main)?.[0] ?? ''
assert.ok(scan.includes('statJobs'), 'readTreeDirectory must start the lstat calls of a directory together')
assert.ok(!/info = await withTreeIoSlot\(\(\) => fsp\.lstat/u.test(scan), 'readTreeDirectory must not await one lstat per entry')

// 4. The local MCP host is only loaded when its HTTP transport is switched on.
assert.match(main, /currentSettings\.mcpEnabled === true && currentSettings\.mcpHttpEnabled === true\) return localMcpHost\(\)\.apply/u)

// 5. The renderer starts the editor chunk as soon as the config names the note, not after the first render.
assert.match(entry, /desktopBootstrap\?\.then\(/u)
assert.match(entry, /import\('\.\/components\/MarkdownEditor'\)/u)
assert.match(entry, /pdf\|story/u, 'PDFs and stories must not pull the Markdown editor')
assert.match(entry, /onboardingRequired/u, 'the first-run setup must not pull the Markdown editor')

console.log('Startup critical path: early reveal, compile cache, tree scan, lazy MCP host and early editor chunk are in place.')
