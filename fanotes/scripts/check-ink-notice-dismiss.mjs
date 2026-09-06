import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  FORM_DETECT_NOTICE_TEXT,
  INK_TRANSIENT_NOTICE_MS,
  SCRIBBLE_ERASE_NOTICE_TEXT,
  applyInkNoticeOp,
  emptyInkNoticeState,
  inkNoticeAutoClearDelayMs,
  inkNoticeShouldAutoClear,
} = await server.ssrLoadModule('/src/lib/inkNotice.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

try {
  assert.equal(
    SCRIBBLE_ERASE_NOTICE_TEXT,
    'Durchkritzeln erkannt: Handschrift gelöscht. Mit Strg+Z kannst du sie sofort zurückholen.',
  )
  assert.equal(
    FORM_DETECT_NOTICE_TEXT,
    'Form erkannt — halte still, um sie zu glätten.',
  )
  assert.ok(Number.isFinite(INK_TRANSIENT_NOTICE_MS) && INK_TRANSIENT_NOTICE_MS > 0 && INK_TRANSIENT_NOTICE_MS < 60_000)

  const drive = (text, kind) => {
    const shown = applyInkNoticeOp(emptyInkNoticeState(), {
      type: 'show',
      notice: { kind, text },
      now: 1_000,
    })
    const delay = inkNoticeAutoClearDelayMs(shown.notice)
    assert.equal(inkNoticeShouldAutoClear(shown.notice), true)
    assert.equal(delay, INK_TRANSIENT_NOTICE_MS)
    assert.notEqual(delay, null)
    assert.ok(Number.isFinite(delay))
    assert.equal(shown.notice?.text, text)
    assert.equal(shown.clearAt, 1_000 + INK_TRANSIENT_NOTICE_MS)

    const before = applyInkNoticeOp(shown, { type: 'tick', now: 1_000 + INK_TRANSIENT_NOTICE_MS - 1 })
    assert.equal(before.notice?.text, text, `${text} must still be visible before the delay`)

    const after = applyInkNoticeOp(shown, { type: 'tick', now: 1_000 + INK_TRANSIENT_NOTICE_MS })
    assert.equal(after.notice, null, `${text} must auto-clear after the delay`)
    assert.equal(after.clearAt, null)

    const closed = applyInkNoticeOp(shown, { type: 'close' })
    assert.equal(closed.notice, null, `${text} must clear immediately on close`)
    assert.equal(closed.clearAt, null)
    return { delay, text }
  }

  const scribble = drive(SCRIBBLE_ERASE_NOTICE_TEXT, 'success')
  const form = drive(FORM_DETECT_NOTICE_TEXT, 'info')

  const sticky = applyInkNoticeOp(emptyInkNoticeState(), {
    type: 'show',
    notice: { kind: 'error', text: 'Die gespeicherte Zeichnung konnte nicht gelesen werden.' },
    now: 1_000,
  })
  assert.equal(inkNoticeAutoClearDelayMs(sticky.notice), null)
  assert.equal(applyInkNoticeOp(sticky, { type: 'tick', now: 1_000 + INK_TRANSIENT_NOTICE_MS * 10 }).notice?.text, sticky.notice.text)

  assert.match(board, /inkNoticeAutoClearDelayMs\(notice\)/)
  assert.match(board, /applyInkNoticeOp/)
  assert.match(board, /SCRIBBLE_ERASE_NOTICE_TEXT/)
  assert.match(board, /FORM_DETECT_NOTICE_TEXT/)
  assert.match(board, /type: 'close'/)
  assert.match(board, /type: 'tick'/)
  assert.doesNotMatch(board, /text: 'Durchkritzeln erkannt: Handschrift gelöscht/)
  assert.doesNotMatch(board, /text: 'Form erkannt — halte still/)

  console.log(JSON.stringify({
    scribble: scribble.text,
    form: form.text,
    delayMs: scribble.delay,
    autoClears: true,
    closeImmediate: true,
  }))
  console.log('ink-notice-dismiss ok')
} finally {
  await server.close()
}
