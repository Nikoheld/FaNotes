// Injected into the app page by the harness (the same code for Electron and
// Tauri). Defines window.__fanotesBench. All times are performance.now() of the
// page; the harness maps them to CLOCK_MONOTONIC with a ping offset.
(() => {
  if (window.__fanotesBench) return
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  // A task right after the frame's rendering step: the frame with the change is produced.
  const afterFrame = (callback) => requestAnimationFrame(() => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => callback(performance.now())
    channel.port2.postMessage(0)
  })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const scrollerOf = (element) => {
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (/(auto|scroll|overlay)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight + 10) return node
    }
    return document.scrollingElement
  }

  // The visible match (a hidden editor of another tab can come first), preferring the one with focus.
  const pick = (selector) => {
    const all = [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length && element.getBoundingClientRect().width > 0)
    return all.find((element) => element.contains(document.activeElement)) || all.at(-1) || null
  }
  const typing = { samples: [], pending: [], mutations: 0, observer: null, listener: null }

  window.__fanotesBench = {
    now: () => performance.now(),
    marks: () => ({
      timeOrigin: performance.timeOrigin,
      tree: performance.getEntriesByName('fanotes:tree-rendered', 'mark')[0]?.startTime ?? null,
      note: performance.getEntriesByName('fanotes:note-open', 'mark')[0]?.startTime ?? null,
      ready: Boolean(document.querySelector('.file-tree__entry-button') && document.querySelector('.markdown-editor .cm-content')),
      userAgent: navigator.userAgent,
    }),

    /** Opens a vault path through the file tree, expanding its folders. */
    async open(path, readySelector, timeoutMs = 60_000) {
      const button = (target) => [...document.querySelectorAll('.file-tree__entry-button')].find((candidate) => candidate.dataset.path === target)
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        const folder = parts.slice(0, index).join('/')
        if (button(parts.slice(0, index + 1).join('/'))) continue
        button(folder)?.click()
        for (let tries = 0; tries < 50 && !button(parts.slice(0, index + 1).join('/')); tries += 1) await sleep(20)
      }
      const target = button(path)
      if (!target) throw new Error(`not in the tree: ${path}`)
      const started = performance.now()
      target.click()
      while (performance.now() - started < timeoutMs) {
        if (readySelector()) return performance.now() - started
        await sleep(20)
      }
      throw new Error(`did not open in time: ${path}`)
    },

    rect(selector) {
      const element = pick(selector)
      if (!element) return null
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, screenX: window.screenX, screenY: window.screenY, innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio }
    },

    async idleFrames(count = 120) {
      const times = []
      for (let index = 0; index < count; index += 1) times.push(await frame())
      return times.slice(1).map((time, index) => time - times[index])
    },

    /** Starts recording key → frame latency for edits inside `rootSelector`. */
    typingStart(rootSelector) {
      const root = pick(rootSelector)
      if (!root) throw new Error(`no ${rootSelector}`)
      typing.samples = []
      typing.pending = []
      typing.mutations = 0
      typing.observer?.disconnect()
      typing.observer = new MutationObserver((records) => { typing.mutations += records.length })
      typing.observer.observe(root, { subtree: true, childList: true, characterData: true })
      if (typing.listener) window.removeEventListener('keydown', typing.listener, true)
      typing.listener = (event) => {
        if (!event.isTrusted || event.key === 'Control' || event.key === 'Shift') return
        const entry = { key: event.key, eventTime: event.timeStamp, handlerTime: performance.now(), mutationsAtKey: typing.mutations, frames: 0 }
        const check = () => {
          entry.frames += 1
          if (typing.mutations > entry.mutationsAtKey || entry.frames >= 30) {
            const channel = new MessageChannel()
            channel.port1.onmessage = () => {
              const painted = performance.now()
              typing.samples.push({ key: entry.key, eventTime: entry.eventTime, handlerTime: entry.handlerTime, painted, frames: entry.frames, changed: typing.mutations > entry.mutationsAtKey })
            }
            channel.port2.postMessage(0)
          } else {
            requestAnimationFrame(check)
          }
        }
        requestAnimationFrame(check)
      }
      window.addEventListener('keydown', typing.listener, true)
      return true
    },
    typingStop() {
      typing.observer?.disconnect()
      if (typing.listener) window.removeEventListener('keydown', typing.listener, true)
      typing.listener = null
      return typing.samples
    },
    typingCount: () => typing.samples.length,
    textLength: (selector) => pick(selector)?.textContent.length ?? null,

    /**
     * Scrolls the scroll container of `seedSelector` from top to bottom, moving
     * on every frame by max(minStep, scrollable / targetFrames) pixels, and
     * returns the frame intervals (rAF to rAF).
     */
    async scroll(seedSelector, { targetFrames = 600, minStep = 40 } = {}) {
      const seed = pick(seedSelector)
      if (!seed) throw new Error(`no ${seedSelector}`)
      const scroller = scrollerOf(seed)
      scroller.scrollTop = 0
      for (let index = 0; index < 30; index += 1) await frame()
      const times = []
      const started = performance.now()
      let position = 0
      let guard = 0
      while (guard < targetFrames * 4) {
        guard += 1
        const bottom = scroller.scrollHeight - scroller.clientHeight
        const step = Math.max(minStep, bottom / targetFrames)
        position = Math.min(bottom, position + step)
        scroller.scrollTop = position
        times.push(await frame())
        if (position >= bottom - 1 && scroller.scrollTop >= bottom - 2) break
      }
      return {
        intervals: times.slice(1).map((time, index) => time - times[index]),
        durationMs: performance.now() - started,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scroller: `${scroller.tagName.toLowerCase()}.${[...scroller.classList].join('.')}`,
      }
    },

    afterFrame: () => new Promise((resolve) => afterFrame(resolve)),
  }
  return true
})()
