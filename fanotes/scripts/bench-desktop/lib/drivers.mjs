// Page control for both hosts. Both drivers expose the same tiny interface
//   evaluate(expression) → JSON value (the expression may return a promise)
//   close()
// Electron: Chrome DevTools Protocol over --remote-debugging-port.
// Tauri:    W3C WebDriver against WebKitWebDriver attached to the running app
//           (--target: the app's WebKit remote inspector, WEBKIT_INSPECTOR_SERVER).
// Only page control goes through the drivers. Input is X11 (XTest) for both, and
// every timestamp is taken in the page or from CLOCK_MONOTONIC.
import { spawn } from 'node:child_process'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const connectCdp = async (port, { timeoutMs = 60_000, alive = () => true } = {}) => {
  const deadline = Date.now() + timeoutMs
  let socket = null
  while (Date.now() < deadline && !socket) {
    if (!alive()) throw new Error('Electron exited before its renderer opened')
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((candidate) => candidate.type === 'page' && !candidate.url.startsWith('devtools'))
      if (page?.webSocketDebuggerUrl) {
        const candidate = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          candidate.addEventListener('open', resolve, { once: true })
          candidate.addEventListener('error', reject, { once: true })
        })
        socket = candidate
      }
    } catch {
      // The debugging endpoint is not up yet.
    }
    if (!socket) await wait(25)
  }
  if (!socket) throw new Error('Electron did not open a debugging endpoint in time')
  let sequence = 0
  const pending = new Map()
  const listeners = new Set()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) { for (const listener of listeners) listener(message); return }
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return {
    kind: 'cdp',
    send,
    onMessage: (listener) => listeners.add(listener),
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(`page: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
      return result.result?.value
    },
    close: () => socket.close(),
  }
}

export const connectWebDriver = async ({ inspectorPort, timeoutMs = 60_000, alive = () => true }) => {
  const port = 14_000 + Math.floor(Math.random() * 1_000)
  const driver = spawn('WebKitWebDriver', [`--port=${port}`, `--target=127.0.0.1:${inspectorPort}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  let driverLog = ''
  driver.stderr.on('data', (chunk) => { driverLog = (driverLog + chunk).slice(-4000) })
  const base = `http://127.0.0.1:${port}`
  const request = async (method, path, body, timeoutMs = 180_000) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`webdriver ${method} ${path}: ${json.value?.error} ${json.value?.message ?? ''}`.trim())
    return json.value
  }
  const deadline = Date.now() + timeoutMs
  let session = null
  let lastError = null
  while (Date.now() < deadline && !session) {
    if (!alive()) throw new Error('the Tauri app exited before WebDriver attached')
    try {
      const value = await request('POST', '/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': {} } } }, 15_000)
      session = value.sessionId
    } catch (error) {
      lastError = error
      await wait(50)
    }
  }
  if (!session) {
    driver.kill('SIGKILL')
    throw new Error(`WebKitWebDriver did not attach: ${lastError?.message} ${driverLog.slice(-400)}`)
  }
  // Scrolling a long document runs longer than the 30 s default script timeout.
  await request('POST', `/session/${session}/timeouts`, { script: 900_000 })
  // Pick the main window (the app may open none other at start, but be explicit).
  try {
    const handles = await request('GET', `/session/${session}/window/handles`)
    for (const handle of handles) {
      await request('POST', `/session/${session}/window`, { handle })
      const url = await request('GET', `/session/${session}/url`)
      if (!String(url).includes('subject-book')) break
    }
  } catch {
    // A single window: nothing to choose.
  }
  return {
    kind: 'webdriver',
    async evaluate(expression) {
      const script = `const done = arguments[arguments.length - 1]; Promise.resolve().then(() => (${expression})).then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error && error.stack || error) }))`
      const result = await request('POST', `/session/${session}/execute/async`, { script, args: [] })
      if (!result?.ok) throw new Error(`page: ${result?.error}`)
      return result.value
    },
    async close() {
      // Detach without deleting the session: deleting would close the app before the harness does.
      driver.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => driver.once('exit', resolve)), wait(1000)])
      if (driver.exitCode === null) driver.kill('SIGKILL')
    },
  }
}

/** XTest input (fanotes-xinject); answers carry CLOCK_MONOTONIC nanoseconds. */
export const startXInput = () => {
  const child = spawn('fanotes-xinject', [], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buffer = ''
  const waiting = []
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      waiting.shift()?.(line)
    }
  })
  const command = (line) => new Promise((resolve, reject) => {
    waiting.push((answer) => (answer.startsWith('ok') ? resolve(answer.split(' ').slice(1)) : reject(new Error(`xinject ${line}: ${answer}`))))
    child.stdin.write(`${line}\n`)
  })
  return {
    command,
    window: async (pid) => { const [id, x, y, width, height] = (await command(`window ${pid}`)).map(Number); return { id, x, y, width, height } },
    place: (pid, x, y, width, height) => command(`place ${pid} ${x} ${y} ${width} ${height}`),
    focus: (pid) => command(`focus ${pid}`),
    move: (x, y) => command(`move ${Math.round(x)} ${Math.round(y)}`),
    click: (button = 1) => command(`click ${button}`),
    key: async (keysym, ...modifiers) => BigInt((await command(`key ${keysym} ${modifiers.join(' ')}`.trim()))[0]),
    close: () => child.stdin.end(),
  }
}
