'use strict'

// Content-Security-Policy delivery of the desktop app (electron/content-security-policy.cjs).
//
// Static part (plain Node): the policy keeps its security-relevant shape, main.cjs installs it from
// the shared module and nothing else, the page has no inline script (the policy blocks it), and the
// only iframes of the renderer are ones the policy allows.
//
// Live part (needs the Electron binary, and on Linux a display or xvfb-run): the real policy code is
// installed on a session and synthetic pages are loaded the way the app, a dev server or a custom
// scheme would serve them. On every path an inline script and eval must be blocked, a `data:` frame
// must be refused by frame-src, and a sandboxed `srcdoc` frame (how OneNote pages are shown) must load
// without a violation. Without the policy the same pages run their script (control), so a passing run
// means the policy is really in force. The Electron docs claim a header cannot reach file:// documents;
// this check is what keeps the opposite (verified on Electron 43) true after an upgrade.
//
// FANOTES_CHECK_CSP_REQUIRE_ELECTRON=1 turns a missing Electron/display into a failure instead of a skip.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { applySecurityHeaders, buildContentSecurityPolicy } = require('../electron/content-security-policy.cjs')

const root = path.resolve(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const directives = (policy) => new Map(policy.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
  const [name, ...sources] = entry.split(/\s+/u)
  return [name, sources]
}))

// ── static: the shape of the policy ──────────────────────────────────────────────────────────────
{
  const production = directives(buildContentSecurityPolicy())
  assert.deepEqual(production.get('default-src'), ["'self'"])
  assert.deepEqual(production.get('script-src'), ["'self'", 'blob:', "'wasm-unsafe-eval'"], 'no inline script, no eval')
  for (const [name, sources] of production) {
    assert.ok(!sources.includes("'unsafe-eval'"), `${name}: no unsafe-eval`)
    assert.ok(!sources.some((source) => source === '*' || source === 'http:' || source === 'https:' || source === 'ws:' || source === 'wss:'), `${name}: no scheme or host wildcard`)
  }
  assert.ok(!production.get('script-src').includes("'unsafe-inline'"))
  assert.deepEqual(production.get('frame-src'), ["'self'"], 'frames: the app itself only (OneNote pages use srcdoc, which frame-src does not cover)')
  assert.deepEqual(production.get('object-src'), ["'none'"])
  assert.deepEqual(production.get('base-uri'), ["'self'"])
  assert.deepEqual(production.get('form-action'), ["'none'"])
  assert.deepEqual(production.get('frame-ancestors'), ["'none'"])
  assert.deepEqual(production.get('connect-src'), ["'self'", 'fanotes-model:', 'https://fanotes.fasrv.ch'], 'the packaged app talks to its model scheme and the FaNotes site only')
  const development = directives(buildContentSecurityPolicy({ devServer: true }))
  assert.ok(development.get('connect-src').includes('ws://localhost:*') && development.get('connect-src').includes('http://127.0.0.1:*'), 'the dev server keeps its websocket and local APIs')
  assert.deepEqual(directives(buildContentSecurityPolicy({ glyphenWerkFrame: true })).get('frame-ancestors'), ["'self'"])
  for (const name of ['script-src', 'frame-src', 'object-src']) assert.deepEqual(development.get(name), production.get(name), `${name} is the same in development`)

  const headers = applySecurityHeaders({ url: 'file:///app/dist/index.html', responseHeaders: { 'Content-Type': ['text/html'], 'X-Other': ['1'] } })
  assert.deepEqual(headers['Content-Security-Policy'], [buildContentSecurityPolicy()])
  // file:// documents have an opaque origin and can never be cross-origin isolated; COEP/CORP there only
  // block the module workers (spelling, pdf.js), so they get COOP alone. Served documents get all three.
  assert.deepEqual([headers['Cross-Origin-Opener-Policy'], headers['Cross-Origin-Embedder-Policy'], headers['Cross-Origin-Resource-Policy']], [['same-origin'], undefined, undefined])
  const served = applySecurityHeaders({ url: 'http://127.0.0.1:5174/index.html' })
  assert.deepEqual([served['Cross-Origin-Opener-Policy'], served['Cross-Origin-Embedder-Policy'], served['Cross-Origin-Resource-Policy']], [['same-origin'], ['require-corp'], ['same-origin']])
  assert.deepEqual(headers['X-Other'], ['1'], 'other headers pass through')
  assert.deepEqual(applySecurityHeaders({ url: 'file:///app/dist/glyphenwerk/index.html' })['Content-Security-Policy'], [buildContentSecurityPolicy({ glyphenWerkFrame: true })])
  assert.ok(applySecurityHeaders({ url: 'fanotes-model://local/x' })['Content-Security-Policy'][0].includes("frame-ancestors 'none'"))
}

// ── static: wiring ───────────────────────────────────────────────────────────────────────────────
{
  const main = read('electron/main.cjs')
  assert.match(main, /require\('\.\/content-security-policy\.cjs'\)/u)
  assert.match(main, /installSecurityHeaders\(currentSession,/u, 'installSecurityPolicy installs the shared policy on the default session')
  assert.doesNotMatch(main, /['"]Content-Security-Policy['"]/u, 'no second, hand-written policy in main.cjs')
  assert.match(main, /installSecurityPolicy\(\)\s*registerIpcHandlers\(\)\s*await createWindow\(\)/u, 'the policy is installed before the first window is created')
  assert.equal([...main.matchAll(/new BrowserWindow\(/gu)].length, 2, 'two windows exist; both use the default session')
  assert.doesNotMatch(main, /partition\s*:/u, 'a window with its own partition would escape the default-session headers')
  const html = read('index.html')
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>/giu)].filter((match) => !/\bsrc=/iu.test(match[0])).map((match) => match[0]), [], 'index.html has no inline script, the policy would block it')
  assert.ok(JSON.parse(read('package.json')).build.files.includes('electron/**/*'), 'every module in electron/ ships with the app')
  // Every iframe of the renderer: the GlyphenWerk page from the app itself, worksheets through srcdoc.
  const frames = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (/\.tsx$/u.test(entry.name)) for (const match of fs.readFileSync(target, 'utf8').matchAll(/<iframe\s[\s\S]*?\/>/gu)) frames.push({ file: entry.name, tag: match[0] })
    }
  }
  walk(path.join(root, 'src'))
  assert.deepEqual(frames.map((frame) => frame.file).sort(), ['GlyphenWerkWorkspace.tsx', 'WorksheetLayer.tsx'], 'a new iframe needs a look at frame-src first')
  for (const { file, tag } of frames) {
    assert.doesNotMatch(tag, /\bsrc=\{(?:`|')?(?:data|blob):/u, `${file}: a data: or blob: frame source is refused by frame-src 'self'`)
    if (file === 'WorksheetLayer.tsx') {
      assert.match(tag, /sandbox=""/u, 'worksheet pages stay in a frame without any permission')
      assert.match(tag, /\bsrcDoc=\{/u, 'the OneNote page is shown through srcDoc, which frame-src does not cover')
      assert.doesNotMatch(tag, /\bsrc=/u, 'no src on the worksheet frame')
    }
    else assert.match(tag, /src=\{`\.\/glyphenwerk\//u, 'GlyphenWerk is loaded from the app itself')
  }
}

// ── live ─────────────────────────────────────────────────────────────────────────────────────────
const requireElectron = process.env.FANOTES_CHECK_CSP_REQUIRE_ELECTRON === '1'
const skip = (reason) => {
  if (requireElectron) throw new Error(`CSP delivery check cannot run: ${reason}`)
  console.log(`CSP delivery: static checks passed; live load-path check skipped (${reason}).`)
}

const PAGES = {
  'probe.js': [
    'window.__violations = []',
    "document.addEventListener('securitypolicyviolation', (event) => window.__violations.push(event.effectiveDirective))",
    'try { eval("1"); window.__evalBlocked = false } catch { window.__evalBlocked = true }',
    // QA-008: the spelling and pdf.js workers are module workers; the isolation headers must not stop them.
    "window.__workerState = 'pending'",
    'try {',
    "  const worker = new Worker('./probe-worker.js', { type: 'module' })",
    "  worker.onmessage = () => { window.__workerState = 'ok'; worker.terminate() }",
    "  worker.onerror = () => { window.__workerState = 'error' }",
    "} catch { window.__workerState = 'throw' }",
  ].join('\n'),
  'probe-worker.js': "self.postMessage('ready')",
  'inline.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="./probe.js"></script></head><body><script>window.__inlineRan = true</script><p>inline</p></body></html>',
  'frame-data.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="./probe.js"></script></head><body><iframe sandbox="" src="data:text/html;base64,PHA+ZGF0YTwvcD4="></iframe></body></html>',
  'frame-srcdoc.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="./probe.js"></script></head><body><iframe sandbox="" referrerpolicy="no-referrer" srcdoc="&lt;!doctype html&gt;&lt;p&gt;worksheet&lt;/p&gt;&lt;script&gt;parent.__pwned=true&lt;/script&gt;"></iframe></body></html>',
}

const expectations = (result) => {
  const { label, page } = result
  const violated = (directive) => (result.violations ?? []).includes(directive)
  assert.equal(result.failure, '', `${label}: the page loaded`)
  if (label === 'control-without-policy') {
    assert.equal(result.inlineRan, true, `${label}: without a policy the inline script runs`)
    assert.equal(result.evalBlocked, false, `${label}: without a policy eval works`)
    assert.deepEqual(result.violations, [], `${label}: nothing is reported`)
    return
  }
  if (page === 'inline.html' && label !== 'custom-scheme:inline.html') assert.equal(result.workerState, 'ok', `${label}: a module worker starts (the isolation headers must not block it)`)
  assert.equal(result.evalBlocked, true, `${label}: eval is blocked`)
  assert.ok(violated('script-src'), `${label}: the eval attempt was reported`)
  if (page === 'inline.html') {
    assert.equal(result.inlineRan, false, `${label}: the inline script did not run`)
    assert.ok(violated('script-src-elem'), `${label}: the inline script was reported`)
  }
  if (page === 'frame-data.html') assert.ok(violated('frame-src'), `${label}: a data: frame is refused by frame-src`)
  if (page === 'frame-srcdoc.html') {
    assert.ok(!violated('frame-src'), `${label}: a srcdoc frame is not a frame-src violation`)
    assert.ok(result.frames.includes('about:srcdoc'), `${label}: the srcdoc frame exists`)
    assert.equal(result.pwned, false, `${label}: the script inside the sandboxed frame did not run`)
  }
}

void (async () => {
  let electronPath
  try { electronPath = require('electron') } catch { electronPath = null }
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) return skip('the Electron binary is not installed')
  const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
  const xvfb = needsDisplay ? spawnSync('xvfb-run', ['--help'], { encoding: 'utf8' }) : null
  if (needsDisplay && (!xvfb || xvfb.error)) return skip('no display and no xvfb-run')

  const probeDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-csp-'))
  try {
    const pages = path.join(probeDir, 'pages')
    fs.mkdirSync(pages, { recursive: true })
    for (const [name, content] of Object.entries(PAGES)) fs.writeFileSync(path.join(pages, name), content)
    let withAsar = false
    try {
      await require('@electron/asar').createPackage(pages, path.join(probeDir, 'pages.asar'))
      withAsar = true
    } catch (error) {
      if (requireElectron) throw error
      console.log(`CSP delivery: asar scenario skipped (${error?.message ?? error})`)
    }
    const args = [path.join(__dirname, 'csp-delivery-probe.cjs')]
    if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage')
    const [command, commandArgs] = needsDisplay ? ['xvfb-run', ['-a', electronPath, ...args]] : [electronPath, args]
    const env = { ...process.env, CSP_PROBE_DIR: probeDir, CSP_MODULE: path.join(root, 'electron', 'content-security-policy.cjs') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: 180_000, env })
    const line = (child.stdout ?? '').split('\n').find((entry) => entry.startsWith('CSP_PROBE_RESULT '))
    assert.ok(line, `the Electron probe reported nothing (exit ${child.status}, ${String(child.stderr ?? '').slice(-400)})`)
    const results = JSON.parse(line.slice('CSP_PROBE_RESULT '.length)).map((result) => ({ ...result, page: result.label.split(':')[1] }))
    const labels = results.map((result) => result.label.split(':')[0])
    for (const required of ['control-without-policy', 'file', 'dev-server', 'http', 'custom-scheme', ...(withAsar ? ['asar'] : [])]) {
      assert.ok(labels.includes(required), `the ${required} load path was probed`)
    }
    for (const result of results) expectations(result)
    console.log(`CSP delivery: ${results.length} probes passed (${[...new Set(labels)].join(', ')}).`)
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
