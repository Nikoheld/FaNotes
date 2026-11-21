'use strict'

// Regression checks for the Linux QA platform fixes (QA-001, 008, 014, 032):
//   QA-001  the updater keeps the user's Chromium switches on relaunch (collectRelaunchArgs; the
//           shell-level round trip lives in check-updater.cjs);
//   QA-008  file:// documents get no COEP/CORP (they blocked every Worker; live probe in
//           check-csp-delivery.cjs), served documents keep the full isolation set;
//   QA-014  the hardened AppRun warms the page cache and can be switched off;
//   QA-032  the OCR host lowers the priority of every thread of its renderer, not only the main thread.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { collectRelaunchArgs } = require('../electron/updater.cjs')
const { applySecurityHeaders } = require('../electron/content-security-policy.cjs')
const { lowerProcessPriority } = require('../electron/ocr-host.cjs')

// QA-001
assert.deepEqual(
  collectRelaunchArgs(['/app/fanotes', '--use-gl=angle', '--use-angle=gl', '--force-device-scale-factor=2', '--disable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE', '--ozone-platform=wayland', '--fanotes-updated-from=1.0', '--fanotes-self-test', '--remote-debugging-port=9333', '--inspect=1', '/home/u/a.md', 'https://x.y', '--', '--updated']),
  ['--use-gl=angle', '--use-angle=gl', '--force-device-scale-factor=2', '--disable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE', '--ozone-platform=wayland'],
)
assert.equal(collectRelaunchArgs(Array.from({ length: 200 }, (_, index) => (index ? `--flag${index}` : 'x'))).length, 64, 'bounded')
assert.deepEqual(collectRelaunchArgs(['x', `--${'a'.repeat(2000)}`, '--bad\nflag']), [], 'oversized and multi-line arguments are dropped')

// QA-008
for (const url of ['file:///app/dist/index.html', 'file:///app.asar/dist/index.html']) {
  const headers = applySecurityHeaders({ url })
  assert.equal(headers['Cross-Origin-Embedder-Policy'], undefined, `${url}: no COEP (it blocks Worker scripts on file://)`)
  assert.equal(headers['Cross-Origin-Resource-Policy'], undefined)
}
assert.deepEqual(applySecurityHeaders({ url: 'http://127.0.0.1:5174/' })['Cross-Origin-Embedder-Policy'], ['require-corp'])

// QA-014
const harden = fs.readFileSync(path.join(__dirname, 'harden-appimage.cjs'), 'utf8')
assert.match(harden, /FANOTES_NO_PREWARM/u)
assert.match(harden, /cat "\\\$\{APPDIR\}\/fanotes"/u, 'the AppRun reads the binary in the background')

// QA-032: fake os/fs, then a real process with threads on Linux.
{
  const calls = []
  const fakeOs = { constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } }, setPriority: (id, level) => { calls.push([id, level]); if (id === 999) throw new Error('EPERM') } }
  const fakeFs = { readdirSync: () => ['100', '101', '999', 'x'] }
  assert.equal(lowerProcessPriority(100, { osModule: fakeOs, fsModule: fakeFs, platform: 'linux' }), 2)
  assert.deepEqual(calls, [[100, 10], [101, 10], [999, 10]])
  calls.length = 0
  lowerProcessPriority(100, { osModule: fakeOs, fsModule: fakeFs, platform: 'win32' })
  assert.deepEqual(calls, [[100, 10]], 'only the process on Windows')
  assert.equal(lowerProcessPriority(-1, { osModule: fakeOs }), 0)
}

const finish = () => console.log('Linux QA platform checks: ok')
if (process.platform !== 'linux') {
  finish()
} else {
  const child = spawn(process.execPath, ['-e', "const { Worker } = require('node:worker_threads'); for (let i = 0; i < 3; i += 1) new Worker('setInterval(() => {}, 1000)', { eval: true }); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
  setTimeout(() => {
    try {
      const before = fs.readdirSync(`/proc/${child.pid}/task`).length
      assert.ok(before >= 4, `the probe process has threads (${before})`)
      const lowered = lowerProcessPriority(child.pid)
      const nice = fs.readdirSync(`/proc/${child.pid}/task`).map((id) => Number(fs.readFileSync(`/proc/${child.pid}/task/${id}/stat`, 'utf8').replace(/^.*\) /u, '').split(' ')[16]))
      assert.ok(lowered >= 4, `every thread was set (${lowered})`)
      assert.ok(nice.every((value) => value >= 10), `all threads are at nice >= 10: ${nice.join(',')}`)
      finish()
    } catch (error) {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    } finally {
      child.kill('SIGKILL')
    }
  }, 600)
}
