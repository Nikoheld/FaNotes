#!/usr/bin/env node
// Spike S1: what does Chromium (Electron or the Tauri 3 + CEF shell) render with
// under this display? Starts the app, asks the browser target for
// `SystemInfo.getInfo` (GPU devices, feature status, driver bug workarounds) and
// prints the summary. Run inside run-in-container.sh (Xvfb), optionally with --gpu.
//
//   node gpu-probe.mjs --host electron|cef --app <binary> [--chromium-args "..."]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => (value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : [])))
const extra = (args['chromium-args'] || '').split(/\s+/u).filter(Boolean)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-probe-'))
const port = 22_000 + Math.floor(Math.random() * 10_000)
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'c'), XDG_DATA_HOME: path.join(home, 'd'), XDG_CACHE_HOME: path.join(home, 'k') }
let argv
if (args.host === 'electron') argv = [args.app, `--remote-debugging-port=${port}`, '--no-sandbox', '--ozone-platform=x11', ...extra]
else {
  Object.assign(env, { FANOTES_CEF_REMOTE_DEBUGGING_PORT: String(port), FANOTES_CEF_NO_SANDBOX: '1' })
  if (extra.length) env.FANOTES_CEF_ARGS = extra.join(' ')
  argv = [args.app]
}
const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk })
let version = null
for (let tries = 0; tries < 400 && !version; tries += 1) {
  try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { await wait(50) }
}
await wait(4_000)
const socket = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
const info = await new Promise((resolve) => {
  socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)))
  socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }))
})
const gpu = info.result?.gpu || {}
const summary = {
  host: args.host,
  chromiumArgs: extra,
  browser: version.Browser,
  devices: (gpu.devices || []).map((device) => `${device.vendorString || device.vendorId} ${device.deviceString || device.deviceId} ${device.driverVersion || ''}`.trim()),
  featureStatus: gpu.featureStatus,
  gl: Object.fromEntries((gpu.auxAttributes && Object.entries(gpu.auxAttributes).filter(([key]) => /gl(Renderer|Vendor|Implementation)|angle|vulkan|software|displayType/iu.test(key))) || []),
  stderrGpu: [...new Set(stderr.split('\n').filter((line) => /gpu|egl|angle|vulkan|gl_|swiftshader/iu.test(line)).map((line) => line.replace(/^\[[^\]]*\]/u, '').slice(0, 200)))].slice(0, 8),
  error: info.error?.message,
}
console.log(JSON.stringify(summary, null, 1))
socket.close()
child.kill('SIGKILL')
process.exit(0)
