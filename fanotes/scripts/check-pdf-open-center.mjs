import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { SCROLL_ROOM } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  pdfOpenCamera,
  pdfOpenCameraFromScroller,
  pdfPageCenterInViewport,
  pdfPageScrollIntoViewBlock,
  pdfStartBlockCamera,
} = await server.ssrLoadModule('/src/lib/pdfOpenCamera.ts')

const paperSource = readFileSync(join(root, 'src/components/PaperView.tsx'), 'utf8')
const pdfSource = readFileSync(join(root, 'src/components/PdfNoteView.tsx'), 'utf8')

const runOnce = () => {
  const page = { pageWidth: 900, pageHeight: 1408, viewWidth: 1200, viewHeight: 700, room: SCROLL_ROOM }
  const centered = pdfOpenCamera(page)
  assert.equal(pdfPageCenterInViewport(centered, page), true, 'centered camera must keep the page center in view')
  const start = pdfStartBlockCamera(page)
  assert.equal(
    pdfPageCenterInViewport(start, page),
    false,
    'block:start / origin-only camera must still fail the center assertion',
  )
  assert.equal(pdfPageScrollIntoViewBlock('start'), 'start')
  assert.equal(pdfPageScrollIntoViewBlock('center'), 'center')

  const tall = { pageWidth: 900, pageHeight: 2400, viewWidth: 1200, viewHeight: 700, room: SCROLL_ROOM }
  const tallCentered = pdfOpenCamera(tall)
  assert.equal(pdfPageCenterInViewport(tallCentered, tall), true, 'a tall PDF must open with the page center in view')
  const tallFromWidthOnly = pdfOpenCameraFromScroller({
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 900 + SCROLL_ROOM * 2,
    scrollHeight: 2400 + SCROLL_ROOM * 2,
    clientWidth: 1200,
    clientHeight: 700,
    pageWidth: 900,
    pageHeight: 2400,
    room: SCROLL_ROOM,
  })
  assert.ok(tallFromWidthOnly)
  assert.equal(
    pdfPageCenterInViewport(tallFromWidthOnly, tall),
    true,
    'vertical-only overflow must still apply the centered camera',
  )
  assert.notEqual(tallFromWidthOnly.y, 0)
  assert.equal(pdfOpenCameraFromScroller({
    ...tall,
    scrollLeft: 40,
    scrollTop: 0,
    scrollWidth: 900 + SCROLL_ROOM * 2,
    scrollHeight: 2400 + SCROLL_ROOM * 2,
    clientWidth: 1200,
    clientHeight: 700,
  }), null, 'an already-scrolled sheet must keep the user camera')

  assert.match(paperSource, /pdfOpenCameraFromScroller\(/)
  assert.match(paperSource, /scrollHeight/)
  assert.match(pdfSource, /pdfPageScrollIntoViewBlock\('center'\)/)
  assert.doesNotMatch(pdfSource, /block: 'start'/)
  return {
    camX: centered.x,
    camY: centered.y,
    tallCamY: tallFromWidthOnly.y,
    startFails: !pdfPageCenterInViewport(start, page),
    room: SCROLL_ROOM,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('pdf-open-center ok')
} finally {
  await server.close()
}
