#!/usr/bin/env node
// Spike S1 pen probe: does a real pen reach the page as `pointerType: 'pen'` with
// pressure and tilt? Runs as root inside fanotes-bench-pen:1 (see pen-probe.sh):
//   1. fanotes-pen-uinput creates a virtual tablet (/dev/uinput),
//   2. a real Xorg (dummy video, evdev input) picks it up as an XI2 tablet device,
//   3. the app (Electron or the Tauri 3 + CEF shell) starts on that display,
//   4. the page records pointer events (CDP only installs the listener and reads it),
//   5. the tablet draws strokes over the window.
//
//   node pen-probe.mjs --host electron|cef --app <binary> [--out results/pen-<host>.json]
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { connectCdp } from './lib/drivers.mjs'

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => (value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : [])))
const host = args.host
const app = args.app
const outFile = args.out
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SCREEN = { width: 1440, height: 900 }
const children = []
const stopAll = () => { for (const child of children.reverse()) { try { child.kill('SIGKILL') } catch { /* gone */ } } }
process.on('exit', stopAll)

// 1. The virtual tablet.
const pen = spawn('fanotes-pen-uinput', [], { stdio: ['pipe', 'pipe', 'inherit'] })
children.push(pen)
const penLines = readline.createInterface({ input: pen.stdout })
const penAnswers = []
penLines.on('line', (line) => penAnswers.push(line))
const nextPenLine = async () => { while (!penAnswers.length) await wait(10); return penAnswers.shift() }
const ready = await nextPenLine()
const sysname = ready.split(' ')[1]
const eventName = fs.readdirSync(`/sys/devices/virtual/input/${sysname}`).find((name) => name.startsWith('event'))
const [major, minor] = fs.readFileSync(`/sys/devices/virtual/input/${sysname}/${eventName}/dev`, 'utf8').trim().split(':')
fs.mkdirSync('/dev/input', { recursive: true })
const devNode = `/dev/input/${eventName}`
if (!fs.existsSync(devNode)) execFileSync('mknod', [devNode, 'c', major, minor])

// 2. Xorg with only that device (no udev in the container).
const conf = path.join(os.tmpdir(), 'xorg-pen.conf')
fs.writeFileSync(conf, `
Section "ServerFlags"
  Option "AutoAddDevices" "false"
  Option "AutoEnableDevices" "false"
  Option "AllowEmptyInput" "true"
EndSection
Section "Device"
  Identifier "dummy"
  Driver "dummy"
  VideoRam 256000
EndSection
Section "Monitor"
  Identifier "monitor"
  HorizSync 5.0 - 1000.0
  VertRefresh 5.0 - 200.0
  Modeline "1440x900" 106.50 1440 1528 1672 1904 900 903 909 934 -hsync +vsync
EndSection
Section "Screen"
  Identifier "screen"
  Device "dummy"
  Monitor "monitor"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "1440x900"
  EndSubSection
EndSection
Section "InputDevice"
  Identifier "pen"
  Driver "evdev"
  Option "Device" "${devNode}"
EndSection
Section "ServerLayout"
  Identifier "layout"
  Screen "screen"
  InputDevice "pen"
EndSection
`)
const xorg = spawn('Xorg', [':0', '-config', conf, '-noreset', '-nolisten', 'tcp', '-logfile', path.join(os.tmpdir(), 'xorg-pen.log')], { stdio: 'ignore' })
children.push(xorg)
for (let tries = 0; tries < 100 && !fs.existsSync('/tmp/.X11-unix/X0'); tries += 1) await wait(100)
process.env.DISPLAY = ':0'
await wait(500)

// 3. The app, with a throw-away profile.
const home = fs.mkdtempSync(path.join(os.tmpdir(), `pen-${host}-`))
const port = 21_000 + Math.floor(Math.random() * 10_000)
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), NO_AT_BRIDGE: '1' }
let argv
if (host === 'electron') argv = [app, `--remote-debugging-port=${port}`, '--no-sandbox', '--ozone-platform=x11']
else {
  env.FANOTES_CEF_REMOTE_DEBUGGING_PORT = String(port)
  env.FANOTES_CEF_NO_SANDBOX = '1'
  argv = [app]
}
const child = spawn(argv[0], argv.slice(1), { env, stdio: 'ignore' })
children.push(child)
const driver = await connectCdp(port, { alive: () => child.exitCode === null })
await wait(4_000)

// 4. Record pointer events in the page.
await driver.evaluate(`(() => {
  window.__penProbe = []
  const keep = (event) => window.__penProbe.push({ type: event.type, pointerType: event.pointerType, pressure: Math.round(event.pressure * 1000) / 1000, tiltX: event.tiltX, tiltY: event.tiltY, buttons: event.buttons, coalesced: event.getCoalescedEvents ? event.getCoalescedEvents().length : null, x: Math.round(event.screenX), y: Math.round(event.screenY) })
  for (const type of ['pointerover', 'pointerdown', 'pointermove', 'pointerup', 'pointerout']) window.addEventListener(type, keep, { capture: true, passive: true })
  return true
})()`)
const windowRect = await driver.evaluate('({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight, inner: [window.innerWidth, window.innerHeight] })')

// 5. Strokes over the middle of the window, in device units (0..32767 → screen).
const unit = (value, size) => Math.round((value / size) * 32767)
const cx = windowRect.x + windowRect.width / 2
const cy = windowRect.y + windowRect.height / 2
for (const [pressure, tilt] of [[3000, 20], [1200, -30]]) {
  pen.stdin.write(`stroke ${unit(cx - 200, SCREEN.width)} ${unit(cy, SCREEN.height)} ${unit(cx + 200, SCREEN.width)} ${unit(cy + 60, SCREEN.height)} 40 ${pressure} ${tilt}\n`)
  await nextPenLine()
  await wait(300)
}
await wait(500)
const events = await driver.evaluate('window.__penProbe')
const summarize = (list) => {
  const byKind = {}
  for (const event of list) {
    const key = `${event.type}/${event.pointerType}`
    const entry = (byKind[key] ||= { count: 0, pressures: new Set(), tilts: new Set() })
    entry.count += 1
    entry.pressures.add(event.pressure)
    entry.tilts.add(`${event.tiltX},${event.tiltY}`)
  }
  return Object.fromEntries(Object.entries(byKind).map(([key, value]) => [key, { count: value.count, distinctPressures: value.pressures.size, pressureRange: [Math.min(...value.pressures), Math.max(...value.pressures)], tilts: [...value.tilts].slice(0, 4) }]))
}
const userAgent = await driver.evaluate('navigator.userAgent')
const xorgLog = (() => { try { return fs.readFileSync(path.join(os.tmpdir(), 'xorg-pen.log'), 'utf8').split('\n').filter((line) => /pen|event|tablet|failed|udev/iu.test(line)).slice(-25) } catch { return [] } })()
const xinputList = (() => { try { return execFileSync('xinput', ['list', '--long'], { encoding: 'utf8' }) } catch (error) { return String(error) } })()
const result = { host, app, userAgent, xorgLog, windowRect, xinputPenDevice: xinputList.split('\n').filter((line) => /pen|Abs|Valuator|Pressure|Tilt|Class/iu.test(line)).slice(0, 40), events: events.length, summary: summarize(events), sample: events.filter((event) => event.type === 'pointermove').slice(5, 9) }
console.log(JSON.stringify(result, null, 1))
if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`)
driver.close()
pen.stdin.write('quit\n')
await wait(300)
stopAll()
process.exit(0)
