import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

// A canvas that behaves like the real one where it matters here: assigning a
// size clears the bitmap and resets the context state, save/restore nest.
const makeCanvas = (width, height, { content = 'blank', context = true, lost = false, reset = true } = {}) => {
  const size = { width, height }
  const stack = []
  const canvas = {
    content,
    log: [],
    contextOpen: context,
    failDraw: false,
    state: { globalAlpha: 1, globalCompositeOperation: 'source-over' },
    get width() { return size.width },
    set width(value) { size.width = value; this.cleared(`width=${value}`) },
    get height() { return size.height },
    set height(value) { size.height = value; this.cleared(`height=${value}`) },
    cleared(entry) {
      this.content = 'blank'
      this.state = { globalAlpha: 1, globalCompositeOperation: 'source-over' }
      stack.length = 0
      this.log.push(entry)
    },
    getContext() {
      if (!this.contextOpen) return null
      const self = this
      const ctx = {
        save() { stack.push({ ...self.state }); self.log.push('save') },
        restore() { self.state = stack.pop() ?? self.state; self.log.push('restore') },
        setTransform() { self.log.push('setTransform') },
        drawImage(image) {
          self.log.push('drawImage')
          if (self.failDraw) throw new Error('drawImage failed')
          self.content = image.content
        },
        get globalAlpha() { return self.state.globalAlpha },
        set globalAlpha(value) { self.state.globalAlpha = value },
        get globalCompositeOperation() { return self.state.globalCompositeOperation },
        set globalCompositeOperation(value) { self.state.globalCompositeOperation = value },
        isContextLost: () => lost,
      }
      if (reset) ctx.reset = () => { self.cleared('reset') }
      return ctx
    },
  }
  return canvas
}

try {
  const { mayWipeLiveInk, mayWipeLiveInkAfterRedraw, mayCommitStrokeToBitmap } = await server.ssrLoadModule('/src/lib/liveInkHandoff.ts')
  const repaint = await server.ssrLoadModule('/src/lib/inkRepaintJob.ts')
  const {
    INK_BUFFER_IDLE_MS,
    createInkBufferHolder,
    inkBufferAction,
    inkBufferMaySwap,
    inkContextUsable,
    inkJobAfterSlice,
    inkJobGate,
    keepsInkPaintJob,
    prepareInkBuffer,
    stepInkRepaint,
    swapInkBuffer,
  } = repaint
  assert.equal(mayWipeLiveInk({ committedHasStroke: true, committedPaintRunning: false }), true)
  assert.equal(mayWipeLiveInk({ committedHasStroke: false, committedPaintRunning: false }), false, 'no frame without the stroke')
  assert.equal(mayWipeLiveInk({ committedHasStroke: true, committedPaintRunning: true }), false, 'a refilling heavy page keeps the live stroke')

  // Frame model: the stroke must be visible in the live or the committed layer on every frame.
  const frames = (wipeAtPenUp) => {
    let live = true
    let committed = false
    const seen = []
    if (wipeAtPenUp) live = false
    seen.push(live || committed) // frame after pen-up
    committed = true // microtask redraw paints the committed bitmap
    live = false
    seen.push(live || committed)
    return seen
  }
  assert.deepEqual(frames(false), [true, true])
  assert.deepEqual(frames(true), [false, true], 'the old order drops one frame')

  const board = readFileSync('src/components/DrawingBoard.tsx', 'utf8')
  const lib = readFileSync('src/lib/inkRepaintJob.ts', 'utf8')
  const bodyOf = (source, start, end) => {
    const from = source.indexOf(start)
    assert.ok(from >= 0, `missing ${start}`)
    const to = source.indexOf(end, from)
    assert.ok(to > from, `missing ${end} after ${start}`)
    return source.slice(from, to)
  }
  assert.match(board, /mayWipeLiveInk\(\{ committedHasStroke/, 'pen-up only wipes once the committed layer has the stroke')

  // Pen-up while a job runs: the redraw that follows (and every later redraw) must not wipe the
  // live stroke either. Before, only the viewport-raster branch had this guard.
  const redrawTail = bodyOf(board, 'const activeStroke = activeStrokeRef.current\n    if (!activeStroke) {\n      // A heavy page is still filling', 'paintLiveInk(context, activeStroke, [])')
  const redrawGuard = 'if (liveCanvasHasInkRef.current && !mayWipeLiveInkAfterRedraw({ committedPaintRunning: Boolean(inkPaintJobRef.current) })) return'
  assert.ok(redrawTail.includes(redrawGuard), 'a running chunked repaint keeps the live stroke across redraws')
  assert.ok(redrawTail.indexOf(redrawGuard) < redrawTail.indexOf('context.clearRect'), 'the guard comes before the live layer is cleared')
  const rasterBody = bodyOf(board, 'const redrawViewportRaster = useCallback(', 'const redraw = useCallback(')
  assert.match(rasterBody, /cancelInkPaint\(\)/, 'the raster takes the bitmap over: no slice job may swap a page over its tiles')
  assert.doesNotMatch(rasterBody, /inkPaintJobRef\.current/, 'the raster path has no job left to wait for')
  assert.ok(rasterBody.indexOf('cancelInkPaint()') < rasterBody.indexOf('committedCanvas.width = width'), 'the job ends before the raster resizes the bitmap')

  assert.equal(mayWipeLiveInkAfterRedraw({ committedPaintRunning: false }), true, 'a synchronous repaint shows every stroke: the live copy can go')
  assert.equal(mayWipeLiveInkAfterRedraw({ committedPaintRunning: true }), false, 'a redraw during a heavy repaint must not wipe the live stroke')

  // The direct commit into the committed bitmap is refused while a job runs (the bitmap is stale or
  // at another size), so the live stroke is the only copy until the swap.
  assert.equal(mayCommitStrokeToBitmap({ placed: true, dirty: false, committedPaintRunning: false }), true)
  assert.equal(mayCommitStrokeToBitmap({ placed: true, dirty: false, committedPaintRunning: true }), false, 'a running job owns the bitmap')
  assert.equal(mayCommitStrokeToBitmap({ placed: true, dirty: true, committedPaintRunning: false }), false)
  assert.equal(mayCommitStrokeToBitmap({ placed: false, dirty: false, committedPaintRunning: false }), false)
  const commitBody = bodyOf(board, 'const commitStrokeToCanvas = useCallback(', 'useEffect(() => {\n    if (inline && !inputActive)')
  assert.match(commitBody, /mayCommitStrokeToBitmap\(/)
  assert.match(commitBody, /committedPaintRunning: Boolean\(inkPaintJobRef\.current\)/)
  assert.match(commitBody, /\} finally \{\n      context\.restore\(\)/, 'a throwing stroke must not leave a clip or composite mode on the bitmap')

  // Heavy-page repaint is double-buffered: slices go to an offscreen page and
  // the visible committed canvas is replaced in one copy.
  assert.match(board, /paintInkBudgetSlice\(running\.buffer,/, 'slices paint into the offscreen buffer')
  assert.doesNotMatch(board, /paintInkBudgetSlice\(committedCanvas/, 'no slice paints on the visible canvas')
  const jobBody = bodyOf(board, 'const buffer = inkBufferRef.current?.acquire(', 'stepInkRepaint(job, 0, host)')
  assert.doesNotMatch(jobBody, /clearRect/, 'the repaint job never clears the visible canvas')
  assert.doesNotMatch(jobBody, /committedCanvas\.(width|height) =/, 'the repaint job never resizes the visible canvas before the swap')
  assert.match(jobBody, /swapInkBuffer\(committedCanvas, running\.buffer\)/, 'the page is swapped in once, when finished')
  assert.match(jobBody, /committedBitmapRef\.current = null/, 'the stale visible bitmap is unsealed while the job runs')
  assert.match(jobBody, /if \(!buffer\) \{[\s\S]*?paintInPlace\(\)/, 'no offscreen page: paint the visible bitmap in one pass instead of swapping nothing')
  assert.match(jobBody, /failed: \(broken, error\) => \{[\s\S]*?inkBufferRef\.current\?\.release\(\)[\s\S]*?paintInPlace\(\)/, 'a failed job frees its page and paints in place')
  assert.match(jobBody, /dropped: \(stale\) => \{[\s\S]*?cancelInkPaint\(\)[\s\S]*?redrawRef\.current\(\)/, 'an outdated job is dropped, not left behind')
  assert.match(jobBody, /finished: \(done\) => \{[\s\S]*?inkBufferRef\.current\?\.settle\(\)/, 'the page is freed after an idle spell once the swap is done')

  // Only paintInPlace and the swap size the visible canvas; a redraw never clears it up front.
  assert.equal(board.match(/committedCanvas\.width = pixelWidth/g)?.length, 1, 'the visible canvas is resized in one place')
  assert.match(bodyOf(board, 'const paintInPlace = () => {', 'const heavyRepaint'), /committedCanvas\.width = pixelWidth[\s\S]*?renderDocument\(/, 'resize then paint in the same task')
  assert.match(board, /const samePaint = keepsInkPaintJob\(painting,/, 'a dead job is not "still filling in"')
  assert.doesNotMatch(board, /const cancelInkPaint = \(\) =>/, 'one cancel for redraw, the raster path, unmount and export')

  // paintInkBudgetSlice: a missing context is a failure, never "finished"; state never leaks.
  const sliceBody = bodyOf(board, 'const paintInkBudgetSlice = (', 'const shiftInkWindowBitmap')
  assert.match(sliceBody, /if \(!inkContextUsable\(context\)\) return \{ next: from, coverage, failed: true \}/)
  assert.doesNotMatch(sliceBody, /next: strokes\.length/, 'a missing context must not count as every stroke painted')
  assert.match(sliceBody, /context\.save\(\)\n  try \{[\s\S]*?\} finally \{[\s\S]*?context\.restore\(\)/)
  for (const name of ['const shiftInkWindowBitmap', 'const shiftCanvasBitmap']) {
    const body = bodyOf(board, name, '\n}\n')
    assert.match(body, /\} finally \{[\s\S]*?context\.restore\(\)/, `${name} restores in finally`)
  }

  // Unmount and export free the page; the raster path and redraw share one cancel.
  assert.match(bodyOf(board, 'useEffect(() => () => {\n    // The board is gone', '[cancelInkPaint])'), /cancelInkPaint\(\)\n    inkBufferRef\.current\?\.release\(\)/, 'unmount frees the offscreen page')
  assert.match(bodyOf(board, 'const restoreModel = () => {', 'strokesRef.current = saved.strokes'), /cancelInkPaint\(\)\n      inkBufferRef\.current\?\.release\(\)/)
  assert.match(bodyOf(board, 'const cancelInkPaint = useCallback(', '}, [])'), /spareInkCoverageRef\.current = job\.coverage[\s\S]*?inkBufferRef\.current\?\.settle\(\)/, 'a cancelled job keeps its mask and arms the idle release')

  const swapSource = bodyOf(lib, 'export const swapInkBuffer', 'export type InkBufferHolderDeps')
  assert.match(swapSource, /globalCompositeOperation = 'copy'/)
  assert.match(swapSource, /globalAlpha = 1/)
  assert.match(swapSource, /\} finally \{\n    context\.restore\(\)/)

  // swapInkBuffer: resize and copy happen together, or not at all.
  {
    const visible = makeCanvas(800, 600, { content: 'old' })
    const buffer = makeCanvas(1600, 1200, { content: 'new' })
    assert.equal(swapInkBuffer(visible, buffer), true)
    assert.equal(visible.content, 'new')
    assert.deepEqual([visible.width, visible.height], [1600, 1200], 'the visible canvas takes the page size at the swap')
    assert.deepEqual(visible.log.filter((entry) => /^(width|height|drawImage)/.test(entry)), ['width=1600', 'height=1200', 'drawImage'], 'resize is immediately followed by the copy')
    assert.equal(visible.state.globalCompositeOperation, 'source-over', 'copy compositing does not outlive the swap')
    assert.equal(visible.state.globalAlpha, 1)

    const same = makeCanvas(800, 600, { content: 'old' })
    assert.equal(swapInkBuffer(same, makeCanvas(800, 600, { content: 'new' })), true)
    assert.equal(same.content, 'new')
    assert.ok(!same.log.some((entry) => entry.startsWith('width=') || entry.startsWith('height=')), 'a same-size swap never resizes (never clears)')

    for (const [label, bad] of [['zero width', makeCanvas(0, 600)], ['zero height', makeCanvas(800, 0)], ['released', makeCanvas(0, 0)]]) {
      const target = makeCanvas(800, 600, { content: 'old' })
      assert.equal(swapInkBuffer(target, bad), false, label)
      assert.equal(target.content, 'old', `${label}: the visible page is untouched`)
      assert.deepEqual(target.log, [], `${label}: not even resized`)
    }
    const noContext = makeCanvas(800, 600, { content: 'old', context: false })
    assert.equal(swapInkBuffer(noContext, makeCanvas(800, 600, { content: 'new' })), false)
    assert.equal(noContext.content, 'old')
    const lostContext = makeCanvas(800, 600, { content: 'old', lost: true })
    assert.equal(swapInkBuffer(lostContext, makeCanvas(800, 600, { content: 'new' })), false, 'a lost context cannot show the page')

    const broken = makeCanvas(800, 600, { content: 'old' })
    broken.failDraw = true
    assert.throws(() => swapInkBuffer(broken, makeCanvas(800, 600, { content: 'new' })), /drawImage failed/)
    assert.equal(broken.state.globalCompositeOperation, 'source-over', 'a throwing copy must not leave `copy` on the visible context')
  }

  // prepareInkBuffer: a reused page starts clean; a context that is gone frees the page.
  {
    const reused = makeCanvas(10, 10, { content: 'stale' })
    reused.state.globalCompositeOperation = 'copy'
    assert.equal(prepareInkBuffer(reused), true)
    assert.equal(reused.content, 'blank')
    assert.equal(reused.state.globalCompositeOperation, 'source-over', 'leftover context state is reset')
    const noReset = makeCanvas(10, 10, { content: 'stale', reset: false })
    assert.equal(prepareInkBuffer(noReset), true)
    assert.equal(noReset.content, 'blank', 'without context.reset() the size assignment resets it')
    assert.equal(prepareInkBuffer(makeCanvas(10, 10, { context: false })), false)
    assert.equal(prepareInkBuffer(makeCanvas(10, 10, { lost: true })), false)
    assert.equal(inkContextUsable(null), false)
    assert.equal(inkContextUsable({}), true)
    assert.equal(inkContextUsable({ isContextLost: () => true }), false)
  }

  // Buffer size policy.
  assert.equal(inkBufferAction(null, { width: 10, height: 10 }), 'create')
  assert.equal(inkBufferAction({ width: 10, height: 10 }, { width: 10, height: 10 }), 'reuse')
  assert.equal(inkBufferAction({ width: 10, height: 10 }, { width: 20, height: 10 }), 'resize')
  assert.equal(inkBufferAction({ width: 10, height: 10 }, { width: 10, height: 0 }), 'refuse')
  assert.equal(inkBufferAction(null, { width: Number.NaN, height: 10 }), 'refuse')

  // Buffer lifecycle: reused by size, freed when idle and on request, never while a job holds it.
  {
    const timers = new Map()
    let nextTimer = 1
    let busy = false
    let releases = 0
    const created = []
    const holder = createInkBufferHolder({
      create: () => { const canvas = makeCanvas(0, 0); created.push(canvas); return canvas },
      prepare: prepareInkBuffer,
      setTimer: (run, ms) => { const id = nextTimer++; timers.set(id, { ms, run: () => { timers.delete(id); run() } }); return id },
      clearTimer: (id) => { timers.delete(id) },
      busy: () => busy,
      onRelease: () => { releases += 1 },
    })
    const first = holder.acquire(300, 200)
    assert.ok(first)
    assert.deepEqual([first.width, first.height], [300, 200])
    assert.equal(holder.acquire(300, 200), first, 'the same size reuses the same canvas')
    assert.equal(created.length, 1)
    assert.equal(holder.acquire(600, 400), first, 'a new size resizes the one canvas')
    assert.deepEqual([first.width, first.height], [600, 400])
    assert.equal(created.length, 1)

    holder.settle()
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].ms, INK_BUFFER_IDLE_MS, 'freed after the idle spell')
    assert.equal(holder.acquire(600, 400), first)
    assert.equal(timers.size, 0, 'a new job disarms the idle release')

    holder.settle()
    busy = true
    ;[...timers.values()][0].run()
    assert.equal(holder.peek(), first, 'never freed while a job holds it')
    assert.deepEqual([first.width, first.height], [600, 400])
    busy = false
    timers.clear()
    holder.settle()
    assert.equal(timers.size, 1, 'the next settle arms the release again')
    ;[...timers.values()][0].run()
    assert.equal(holder.peek(), null, 'freed after the idle spell')
    assert.deepEqual([first.width, first.height], [0, 0], 'the backing store is given back')
    assert.ok(releases >= 1, 'whatever hangs on the page (spare mask) is dropped with it')

    const second = holder.acquire(300, 200)
    assert.notEqual(second, first)
    assert.equal(created.length, 2)
    holder.settle()
    assert.equal(timers.size, 1)
    holder.release()
    assert.equal(timers.size, 0, 'an explicit release (unmount) disarms the timer')
    assert.equal(holder.peek(), null)
    assert.deepEqual([second.width, second.height], [0, 0])

    assert.equal(holder.acquire(0, 100), null, 'no page for an empty size')
    assert.equal(created.length, 2, 'nothing allocated for it')
    holder.settle()
    assert.equal(timers.size, 0, 'nothing to free')

    const failing = createInkBufferHolder({
      create: () => makeCanvas(0, 0, { context: false }),
      prepare: prepareInkBuffer,
      setTimer: () => 1,
      clearTimer: () => {},
      busy: () => false,
    })
    assert.equal(failing.acquire(100, 100), null, 'a page without a 2D context is not handed out')
    assert.equal(failing.peek(), null, 'and is not kept')
  }

  // Job decisions.
  assert.equal(inkJobGate({ current: true, sameStrokes: true, sameSize: true, dirty: false }), 'run')
  assert.equal(inkJobGate({ current: false, sameStrokes: true, sameSize: true, dirty: false }), 'superseded')
  assert.equal(inkJobGate({ current: false, sameStrokes: false, sameSize: false, dirty: true }), 'superseded', 'a job that was replaced stops quietly, whatever else changed')
  assert.equal(inkJobGate({ current: true, sameStrokes: true, sameSize: true, dirty: true }), 'stale', 'undo, erase or paste outdates the page')
  assert.equal(inkJobGate({ current: true, sameStrokes: false, sameSize: true, dirty: false }), 'stale')
  assert.equal(inkJobGate({ current: true, sameStrokes: true, sameSize: false, dirty: false }), 'stale')
  assert.equal(inkJobAfterSlice({ failed: false, from: 0, next: 4, total: 10 }), 'continue')
  assert.equal(inkJobAfterSlice({ failed: false, from: 6, next: 10, total: 10 }), 'swap')
  assert.equal(inkJobAfterSlice({ failed: true, from: 0, next: 10, total: 10 }), 'fail', 'a failed slice is never "finished", even if it claims every stroke')
  assert.equal(inkJobAfterSlice({ failed: false, from: 3, next: 3, total: 10 }), 'fail', 'a slice without progress would spin forever')
  assert.equal(inkJobAfterSlice({ failed: false, from: 0, next: 0, total: 0 }), 'swap', 'an empty page is complete')
  const full = { complete: true, failed: false, buffer: { width: 10, height: 6 }, target: { width: 10, height: 6 } }
  assert.equal(inkBufferMaySwap(full), true)
  assert.equal(inkBufferMaySwap({ ...full, complete: false }), false, 'a partial page is never swapped in')
  assert.equal(inkBufferMaySwap({ ...full, failed: true }), false)
  assert.equal(inkBufferMaySwap({ ...full, buffer: { width: 10, height: 5 } }), false, 'size mismatch')
  assert.equal(inkBufferMaySwap({ ...full, buffer: { width: 0, height: 0 } }), false, 'a released page')

  const strokes = [{}, {}]
  const alive = { key: 'k', strokes, frame: 7 }
  const now = { key: 'k', strokes, dirty: false, activeStroke: false }
  assert.equal(keepsInkPaintJob(alive, now), true)
  assert.equal(keepsInkPaintJob(null, now), false)
  assert.equal(keepsInkPaintJob({ ...alive, frame: 0 }, now), false, 'a job with no queued frame is dead and is replaced, not "kept"')
  assert.equal(keepsInkPaintJob(alive, { ...now, dirty: true }), false)
  assert.equal(keepsInkPaintJob(alive, { ...now, key: 'other' }), false)
  assert.equal(keepsInkPaintJob(alive, { ...now, strokes: [...strokes] }), false)
  assert.equal(keepsInkPaintJob(alive, { ...now, activeStroke: true }), false)

  // The job runner: the one place that decides whether the offscreen page may be shown.
  const harness = ({ total = 10, perSlice = 3, swapResult = true, bufferSize } = {}) => {
    const events = []
    const queue = []
    const state = {
      strokes: Array.from({ length: total }, () => ({})),
      size: { width: 100, height: 50 },
      dirty: false,
      current: null,
      throwAt: -1,
      failAt: -1,
      swapThrows: false,
    }
    const buffer = { width: bufferSize?.width ?? 100, height: bufferSize?.height ?? 50, painted: 0 }
    const job = { key: 'k', strokes: state.strokes, frame: 0, buffer, width: 100, height: 50, coverage: null }
    state.current = job
    const host = {
      isCurrent: (running) => state.current === running,
      strokes: () => state.strokes,
      size: () => state.size,
      dirty: () => state.dirty,
      paint: (running, from) => {
        events.push(`paint:${from}`)
        if (state.throwAt === from) throw new Error('bad stroke')
        if (state.failAt === from) return { next: from, coverage: null, failed: true }
        const next = Math.min(from + perSlice, running.strokes.length)
        buffer.painted = next
        return { next, coverage: { mask: next } }
      },
      swap: (running) => {
        events.push(`swap:${buffer.painted}/${running.strokes.length}`)
        if (state.swapThrows) throw new Error('drawImage failed')
        return swapResult
      },
      schedule: (run) => { queue.push(run); return queue.length },
      finished: () => events.push('finished'),
      dropped: () => events.push('dropped'),
      failed: (_job, error) => events.push(`failed:${error instanceof Error ? error.message : error}`),
    }
    const drain = (limit = 100) => {
      for (let guard = 0; queue.length && guard < limit; guard += 1) queue.shift()()
    }
    return { events, queue, state, buffer, job, host, drain, start: () => stepInkRepaint(job, 0, host) }
  }
  {
    const run = harness()
    run.start()
    assert.notEqual(run.job.frame, 0, 'a running job has a queued frame')
    run.drain()
    assert.deepEqual(run.events, ['paint:0', 'paint:3', 'paint:6', 'paint:9', 'swap:10/10', 'finished'], 'swapped once, after the last slice, never earlier')
    assert.equal(run.job.frame, 0)

    const grown = harness()
    grown.start()
    grown.state.strokes.push({}, {}, {}) // a stroke written while the job runs is painted too
    grown.drain()
    assert.ok(grown.events.includes('swap:13/13'), 'strokes added mid-job are in the page that is swapped in')

    const slow = harness()
    slow.state.failAt = 3
    slow.start()
    slow.drain()
    assert.deepEqual(slow.events, ['paint:0', 'paint:3', 'failed:The offscreen ink page could not be painted.'])
    assert.ok(!slow.events.some((entry) => entry.startsWith('swap')), 'a failed slice never swaps a partial page')
    assert.equal(slow.job.frame, 0)
    assert.equal(slow.queue.length, 0, 'and queues nothing more')

    const noContext = harness()
    noContext.state.failAt = 0
    noContext.start()
    assert.ok(noContext.events.some((entry) => entry.startsWith('failed')) && !noContext.events.some((entry) => entry.startsWith('swap')), 'a context that is missing from the first slice no longer reads as "finished"')

    const thrown = harness()
    thrown.state.throwAt = 6
    thrown.start()
    thrown.drain()
    assert.deepEqual(thrown.events.filter((entry) => entry.startsWith('failed') || entry.startsWith('swap')), ['failed:bad stroke'], 'a throw is a failure, not an uncaught error that wedges the repaint')
    assert.equal(keepsInkPaintJob(thrown.job, { key: 'k', strokes: thrown.state.strokes, dirty: false, activeStroke: false }), false, 'and the dead job is not "still filling in"')

    const dirty = harness()
    dirty.start()
    dirty.state.dirty = true
    dirty.drain()
    assert.deepEqual(dirty.events, ['paint:0', 'dropped'], 'an outdated job is dropped (so a repaint follows), never swapped')
    assert.equal(dirty.job.frame, 0)
    assert.equal(keepsInkPaintJob(dirty.job, { key: 'k', strokes: dirty.state.strokes, dirty: false, activeStroke: false }), false)

    const replaced = harness()
    replaced.start()
    replaced.state.current = {}
    replaced.drain()
    assert.deepEqual(replaced.events, ['paint:0'], 'a cancelled/replaced job stops without touching anything')

    const restroked = harness()
    restroked.start()
    restroked.state.strokes = [...restroked.state.strokes]
    restroked.drain()
    assert.deepEqual(restroked.events, ['paint:0', 'dropped'], 'a replaced stroke array outdates the job')

    const resized = harness()
    resized.start()
    resized.state.size = { width: 200, height: 100 }
    resized.drain()
    assert.deepEqual(resized.events, ['paint:0', 'dropped'], 'a page size change outdates the job')

    const refused = harness({ swapResult: false })
    refused.start()
    refused.drain()
    assert.deepEqual(refused.events.slice(-2), ['swap:10/10', 'failed:The finished ink page could not replace the visible one.'])

    const swapThrows = harness()
    swapThrows.state.swapThrows = true
    swapThrows.start()
    swapThrows.drain()
    assert.deepEqual(swapThrows.events.slice(-2), ['swap:10/10', 'failed:drawImage failed'])

    const wrongSize = harness({ bufferSize: { width: 50, height: 50 } })
    wrongSize.start()
    wrongSize.drain()
    assert.deepEqual(wrongSize.events.slice(-1), ['failed:The finished ink page could not replace the visible one.'])
    assert.ok(!wrongSize.events.some((entry) => entry.startsWith('swap')), 'a page of the wrong size is refused before any copy')
  }

  // An erase during a running job must not punch into the stale bitmap.
  const { decideCommittedEraseHole } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
  const base = { patchMatchesStrokes: true, held: true, keyMatches: true, topMatches: true, resized: false, activeStroke: false }
  assert.deepEqual(decideCommittedEraseHole({ ...base, budgetCleared: true }), { punch: false, seal: false })
  assert.deepEqual(decideCommittedEraseHole({ ...base, held: false, budgetCleared: false }), { punch: false, seal: false }, 'an unsealed bitmap is never punched')
  assert.equal(decideCommittedEraseHole({ ...base, budgetCleared: false }).punch, true)
  console.log('live-ink-handoff ok')
} finally {
  await server.close()
}
