/**
 * Heavy-page ink repaint (DrawingBoard): strokes are painted a few per frame
 * into an offscreen page, and the visible committed bitmap is replaced once,
 * when every stroke is in. The decisions live here as plain functions so the
 * cases a real device only hits by accident (a failed context, a job that
 * throws, a resize in flight) can be checked without a canvas.
 *
 * Rules the board relies on:
 *  - the visible bitmap is never cleared or resized while a job fills the page;
 *    the resize happens in the same task as the swap;
 *  - a page that is not complete (failed slice, thrown error, cancelled or
 *    outdated job, size mismatch) is never swapped in;
 *  - a job that stops without finishing is dropped, so a later repaint is not
 *    mistaken for "still filling in";
 *  - the offscreen page is freed after an idle spell and on unmount, and reused
 *    while the size stays the same.
 */

/** How long the offscreen page stays allocated after the last job ended. */
export const INK_BUFFER_IDLE_MS = 2000

export type InkBufferSize = { width: number; height: number }

export type InkBufferAction = 'create' | 'reuse' | 'resize' | 'refuse'

/** What to do with the offscreen page for a job of size `want`. */
export const inkBufferAction = (have: InkBufferSize | null, want: InkBufferSize): InkBufferAction => {
  if (!(want.width >= 1) || !(want.height >= 1)) return 'refuse'
  if (!have) return 'create'
  return have.width === want.width && have.height === want.height ? 'reuse' : 'resize'
}

export type InkRepaintJob<Coverage = unknown> = {
  key: string
  strokes: readonly unknown[]
  /** Queued animation frame of the next slice; 0 when no slice is queued. */
  frame: number
  /** Offscreen page the slices paint into. */
  buffer: InkBufferSize
  /** Pixel size of the page the job paints (the buffer must have it). */
  width: number
  height: number
  coverage: Coverage | null
}

/**
 * The running job may be kept instead of restarted: it paints this very page,
 * nothing changed the page since, and a frame is queued to continue it. A job
 * without a queued frame is dead and must not block the next repaint.
 */
export const keepsInkPaintJob = (
  job: Pick<InkRepaintJob, 'key' | 'strokes' | 'frame'> | null,
  now: { key: string; strokes: readonly unknown[]; dirty: boolean; activeStroke: boolean },
) => Boolean(
  job
  && job.frame !== 0
  && job.key === now.key
  && job.strokes === now.strokes
  && !now.dirty
  && !now.activeStroke,
)

export type InkJobGate = 'run' | 'superseded' | 'stale'

/**
 * Before a slice. `superseded`: another job or a synchronous paint took over,
 * stop quietly. `stale`: the job is still the current one, but the page changed
 * under it (undo, erase, paste, a new stroke array, another pixel size); it
 * must be dropped and a repaint requested, or it would linger as a dead job.
 */
export const inkJobGate = (input: {
  current: boolean
  sameStrokes: boolean
  sameSize: boolean
  dirty: boolean
}): InkJobGate => {
  if (!input.current) return 'superseded'
  return input.dirty || !input.sameStrokes || !input.sameSize ? 'stale' : 'run'
}

export type InkSliceVerdict = 'continue' | 'swap' | 'fail'

/**
 * After a slice. Only a slice that reached the last stroke on a working
 * context completes the page; a failed slice, or one that made no progress,
 * fails the job instead of counting as finished.
 */
export const inkJobAfterSlice = (input: {
  failed: boolean
  from: number
  next: number
  total: number
}): InkSliceVerdict => {
  if (input.failed) return 'fail'
  if (input.next >= input.total) return 'swap'
  return input.next > input.from ? 'continue' : 'fail'
}

/** The offscreen page may replace the visible bitmap only when it is complete and has the size the job was started for. */
export const inkBufferMaySwap = (input: {
  complete: boolean
  failed: boolean
  buffer: InkBufferSize
  target: InkBufferSize
}) => (
  input.complete
  && !input.failed
  && input.buffer.width >= 1
  && input.buffer.height >= 1
  && input.buffer.width === input.target.width
  && input.buffer.height === input.target.height
)

type MaybeLostContext = { isContextLost?: () => boolean }

/** A context that exists and was not lost; a lost one draws nothing and reads as blank. */
export const inkContextUsable = <T extends object>(context: T | null | undefined): context is T => {
  if (!context) return false
  const lost = (context as MaybeLostContext).isContextLost
  return typeof lost === 'function' ? !lost.call(context) : true
}

export type InkBufferContext = MaybeLostContext & {
  /** Present on every 2D context; keeps this from being a weak type. */
  save(): void
  reset?: () => void
}
export type InkBufferCanvas = {
  width: number
  height: number
  getContext(kind: '2d'): InkBufferContext | null
}

/**
 * Back to a blank page with default context state. A job that threw can leave
 * a clip, a transform or a composite mode behind, and the next job on the same
 * canvas would paint through it (its first clear is clipped, old ink stays).
 */
export const prepareInkBuffer = (canvas: InkBufferCanvas): boolean => {
  const context = canvas.getContext('2d')
  if (!inkContextUsable(context)) return false
  if (typeof context.reset === 'function') context.reset()
  else canvas.width = canvas.width
  return true
}

export type InkSwapContext<Image> = {
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  drawImage(image: Image, dx: number, dy: number): void
  globalAlpha: number
  globalCompositeOperation: GlobalCompositeOperation
}
export type InkSwapCanvas<Image> = {
  width: number
  height: number
  getContext(kind: '2d'): InkSwapContext<Image> | null
}

/**
 * Replaces the visible bitmap with a finished page in one copy, never a clear
 * and then a refill. When the page size changed, the visible canvas is resized
 * here, in the same task as the copy: no frame can show it blank. Returns
 * false, with the visible canvas untouched, when the page cannot be shown.
 */
export const swapInkBuffer = <Image extends InkBufferSize>(target: InkSwapCanvas<NoInfer<Image>>, buffer: Image): boolean => {
  if (!(buffer.width >= 1) || !(buffer.height >= 1)) return false
  const context = target.getContext('2d')
  if (!inkContextUsable(context)) return false
  if (target.width !== buffer.width) target.width = buffer.width
  if (target.height !== buffer.height) target.height = buffer.height
  context.save()
  try {
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.globalAlpha = 1
    context.globalCompositeOperation = 'copy'
    context.drawImage(buffer, 0, 0)
  } finally {
    context.restore()
  }
  return true
}

export type InkBufferHolderDeps<T extends InkBufferSize> = {
  create: () => T
  /** Blanks the page and checks that it can be painted; false frees it. */
  prepare: (buffer: T) => boolean
  setTimer: (run: () => void, ms: number) => number
  clearTimer: (id: number) => void
  /** A repaint job holds the buffer: it must not be freed. */
  busy: () => boolean
  /** The buffer was freed (idle, unmount, failed prepare): drop whatever goes with it. */
  onRelease?: () => void
  idleMs?: number
}

/**
 * Owns the offscreen page: one canvas, reused while the size stays the same,
 * freed (size 0, reference dropped) after an idle spell or on request. Never
 * freed while a job holds it.
 */
export const createInkBufferHolder = <T extends InkBufferSize>(deps: InkBufferHolderDeps<T>) => {
  let buffer: T | null = null
  let timer = 0
  const idleMs = deps.idleMs ?? INK_BUFFER_IDLE_MS
  const disarm = () => {
    if (!timer) return
    deps.clearTimer(timer)
    timer = 0
  }
  const free = () => {
    disarm()
    if (buffer) {
      buffer.width = 0
      buffer.height = 0
      buffer = null
    }
    deps.onRelease?.()
  }
  return {
    /** A blank page of exactly this size, or null when none can be had (the caller paints in place). */
    acquire(width: number, height: number): T | null {
      disarm()
      const action = inkBufferAction(buffer ? { width: buffer.width, height: buffer.height } : null, { width, height })
      if (action === 'refuse') return null
      if (action === 'create') buffer = deps.create()
      if (!buffer) return null
      if (action !== 'reuse') {
        buffer.width = width
        buffer.height = height
      }
      if (!deps.prepare(buffer)) {
        free()
        return null
      }
      return buffer
    },
    /** A job ended or was cancelled: free the page after an idle spell unless a new job takes it first. */
    settle() {
      disarm()
      if (!buffer || deps.busy()) return
      timer = deps.setTimer(() => {
        timer = 0
        if (deps.busy()) return
        free()
      }, idleMs)
    },
    /** Free the page now (unmount, export, a failed job). */
    release: free,
    peek: () => buffer,
  }
}

export type InkBufferHolder<T extends InkBufferSize> = ReturnType<typeof createInkBufferHolder<T>>

export type InkSliceResult<Coverage> = { next: number; coverage: Coverage | null; failed?: boolean }

export type InkRepaintHost<Coverage, Job extends InkRepaintJob<Coverage>> = {
  /** `job` is still the job the board waits for. */
  isCurrent: (job: Job) => boolean
  /** The stroke list that is on the page now. */
  strokes: () => readonly unknown[]
  /** The pixel size the page needs now. */
  size: () => InkBufferSize
  /** The page changed since the job started. */
  dirty: () => boolean
  paint: (job: Job, from: number) => InkSliceResult<Coverage>
  /** Show the finished page. False (or a throw) when it could not. */
  swap: (job: Job) => boolean
  schedule: (run: () => void) => number
  /** The finished page is on screen. */
  finished: (job: Job) => void
  /** The page changed or was replaced under the job: drop it and repaint. */
  dropped: (job: Job) => void
  /** The job cannot finish: nothing was swapped; paint the visible bitmap directly. */
  failed: (job: Job, error: unknown) => void
}

/** One slice of a job, then the next frame; the single place that decides whether the page may be shown. */
export const stepInkRepaint = <Coverage, Job extends InkRepaintJob<Coverage>>(
  job: Job,
  from: number,
  host: InkRepaintHost<Coverage, Job>,
): void => {
  // The frame that ran this step is spent: a job that stops here has none queued.
  job.frame = 0
  const size = host.size()
  const gate = inkJobGate({
    current: host.isCurrent(job),
    sameStrokes: host.strokes() === job.strokes,
    sameSize: size.width === job.width && size.height === job.height,
    dirty: host.dirty(),
  })
  if (gate === 'superseded') return
  if (gate === 'stale') {
    host.dropped(job)
    return
  }
  let painted: InkSliceResult<Coverage>
  try {
    painted = host.paint(job, from)
  } catch (error) {
    host.failed(job, error)
    return
  }
  const verdict = inkJobAfterSlice({
    failed: painted.failed === true,
    from,
    next: painted.next,
    total: job.strokes.length,
  })
  if (verdict === 'fail') {
    host.failed(job, new Error('The offscreen ink page could not be painted.'))
    return
  }
  job.coverage = painted.coverage
  if (verdict === 'continue') {
    job.frame = host.schedule(() => stepInkRepaint(job, painted.next, host))
    return
  }
  let shown = false
  try {
    shown = inkBufferMaySwap({ complete: true, failed: false, buffer: job.buffer, target: job }) && host.swap(job)
  } catch (error) {
    host.failed(job, error)
    return
  }
  if (!shown) {
    host.failed(job, new Error('The finished ink page could not replace the visible one.'))
    return
  }
  host.finished(job)
}
