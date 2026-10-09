import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { noteLinkMarkerCss, noteLinksAfterOriginGrow } = await server.ssrLoadModule('/src/lib/noteLink.ts')
const { keepMarkOnPage, liveWriteStayPut, scrollForZoomedOriginPad } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const layerSource = readFileSync(new URL('../src/components/NoteLinkLayer.tsx', import.meta.url), 'utf8')
const boardSource = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

const near = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} must be ${expected}`)
}

/**
 * Paper point shared by a glyph and a note-link pin.
 * CSS left/top are unzoomed layout px. At zoom 2 a 0.25 fraction of an
 * 800px layout column is 200 layout px (visual 400), never 400 layout px.
 */
const runOnce = () => {
  const markdownPaper = {
    layoutWidth: 800,
    layoutHeight: 1000,
    visualWidth: 800,
    visualHeight: 1000,
  }
  const markdownLink = { x: 0.25, y: 0.4 }
  const atZoom1 = noteLinkMarkerCss(markdownLink, markdownPaper, null, null)
  near(atZoom1.left, 200, 'zoom-1 markdown left')
  near(atZoom1.top, 400, 'zoom-1 markdown top')

  const zoomedPaper = {
    layoutWidth: 800,
    layoutHeight: 1000,
    visualWidth: 1600,
    visualHeight: 2000,
  }
  const zoomed = noteLinkMarkerCss(markdownLink, zoomedPaper, null, null)
  near(zoomed.left, markdownLink.x * zoomedPaper.layoutWidth, 'zoom-2 markdown left')
  near(zoomed.top, markdownLink.y * zoomedPaper.layoutHeight, 'zoom-2 markdown top')
  assert.notEqual(zoomed.left, markdownLink.x * zoomedPaper.visualWidth)
  const pinVisualX = zoomed.left * (zoomedPaper.visualWidth / zoomedPaper.layoutWidth)
  const glyphVisualX = markdownLink.x * zoomedPaper.visualWidth
  near(pinVisualX, glyphVisualX, 'zoom-2 pin visual x matches glyph')

  const pdfPaper = {
    layoutWidth: 800,
    layoutHeight: 1000,
    visualWidth: 1600,
    visualHeight: 2000,
  }
  const pdfPage = { left: 100, top: 80, width: 1600, height: 2000 }
  const pdfLayer = { left: 0, top: 0 }
  const pdfLink = { x: 0.5, y: 0.25 }
  const zoomX = pdfPaper.visualWidth / pdfPaper.layoutWidth
  const zoomY = pdfPaper.visualHeight / pdfPaper.layoutHeight
  const pdfCss = noteLinkMarkerCss(pdfLink, pdfPaper, pdfPage, pdfLayer)
  near(pdfCss.left, (pdfPage.left - pdfLayer.left) / zoomX + pdfLink.x * (pdfPage.width / zoomX), 'pdf pin left')
  near(pdfCss.top, (pdfPage.top - pdfLayer.top) / zoomY + pdfLink.y * (pdfPage.height / zoomY), 'pdf pin top')
  near(pdfCss.left, 450, 'pdf pin left paper px')
  near(pdfCss.top, 290, 'pdf pin top paper px')

  const pdfZoom1 = noteLinkMarkerCss(
    pdfLink,
    { layoutWidth: 800, layoutHeight: 1000, visualWidth: 800, visualHeight: 1000 },
    { left: 100, top: 80, width: 800, height: 1000 },
    { left: 0, top: 0 },
  )
  near(pdfZoom1.left, 100 + 0.5 * 800, 'pdf zoom-1 left')
  near(pdfZoom1.top, 80 + 0.25 * 1000, 'pdf zoom-1 top')

  const scroll = { x: 100, y: 200 }
  const pad = { x: 0, y: 48 }
  const shift = { x: 0, y: 0 }
  const visual = scrollForZoomedOriginPad(scroll, pad, shift, 2.5)
  const contentMoveY = pad.y * 2.5
  near(visual.y - scroll.y, contentMoveY, 'zoomed grow scroll matches pad*zoom')
  near(visual.y, 320, 'zoom 2.5 pad 48 scroll y')
  near(visual.x, 100, 'zoom 2.5 no pad x')

  const shifted = scrollForZoomedOriginPad({ x: 100, y: 200 }, { x: 48, y: 48 }, { x: 10, y: 10 }, 2)
  near(shifted.x, 206, 'shift stays visual px')
  near(shifted.y, 306, 'shift stays visual px y')

  const atOne = scrollForZoomedOriginPad(scroll, pad, shift, 1)
  near(atOne.y, 248, 'zoom 1 scroll is unscaled pad')
  const badZoom = scrollForZoomedOriginPad(scroll, pad, shift, Number.NaN)
  near(badZoom.y, 248, 'NaN zoom falls back to 1')
  const zeroZoom = scrollForZoomedOriginPad(scroll, pad, shift, 0)
  near(zeroZoom.y, 248, '0 zoom falls back to 1')

  const stay = liveWriteStayPut({
    paperX: 120,
    paperY: 80,
    camX: 100,
    camY: 472,
    width: 800,
    height: 1000,
    originX: 0,
    originY: 0,
    editorX: 0,
    editorY: 0,
  }, {
    grown: { width: 800, height: 1048, padX: 0, padY: 48 },
    sheetShift: { x: 0, y: 0 },
  })
  near(stay.camY, 520, 'reducer camera stays unzoomed pad')
  near(stay.paperY, 128, 'paper y moves by the pad only')
  const pinned = scrollForZoomedOriginPad({ x: stay.camX - 0, y: 472 }, { x: 0, y: 48 }, { x: 0, y: 0 }, 2.5)
  near(pinned.y, 472 + 48 * 2.5, 'DOM pin uses pad*zoom, not reducer cam')
  assert.notEqual(pinned.y, stay.camY)

  const heading = {
    id: 'nl-heading',
    sourcePath: 'Faecher/Mechanik.md',
    targetPath: 'Faecher/Mechanik · Notiz.md',
    page: 1,
    x: 0.25,
    y: 0.4,
    style: 'symbol',
    label: 'Notiz',
  }
  const prevSheet = { width: 800, height: 1000 }
  const glyphY = heading.y * prevSheet.height
  const padY = 48
  let pinPaperY = 0
  for (const item of [
    { height: 1000, zoom: 1 },
    { height: 1000, zoom: 2.5 },
    { height: 1048, zoom: 1 },
    { height: 1048, zoom: 2.5 },
  ]) {
    const grownLinks = noteLinksAfterOriginGrow([heading], prevSheet, {
      width: prevSheet.width,
      height: item.height,
      padX: 0,
      padY,
    })
    const textY = glyphY + padY
    const inkY = keepMarkOnPage(heading.y, prevSheet.height, item.height, padY) * item.height
    near(inkY, textY, `ink paper y matches text after pad at h ${item.height}`)
    const css = noteLinkMarkerCss(grownLinks[0], {
      layoutWidth: prevSheet.width,
      layoutHeight: item.height,
      visualWidth: prevSheet.width * item.zoom,
      visualHeight: item.height * item.zoom,
    })
    near(css.top, textY, `pin paper y after pad ${padY} zoom ${item.zoom} h ${item.height}`)
    near(css.top * item.zoom, textY * item.zoom, `pin visual y zoom ${item.zoom} h ${item.height}`)
    near(grownLinks[0].y, keepMarkOnPage(heading.y, prevSheet.height, item.height, padY), `stored fraction zoom ${item.zoom} h ${item.height}`)
    pinPaperY = css.top
  }

  assert.match(layerSource, /noteLinkMarkerCss\(/)
  assert.match(layerSource, /layoutWidth = host\.offsetWidth/)
  assert.match(layerSource, /readUsedSheetZoom\(host\)/)
  assert.match(layerSource, /visualWidth: layoutWidth \* zoom/)
  assert.doesNotMatch(layerSource, /link\.x \* paperRect\.width/)
  assert.doesNotMatch(layerSource, /link\.x \* rect\.width/)
  assert.doesNotMatch(layerSource, /visualWidth: paperRect\.width/)
  assert.match(boardSource, /scrollForZoomedOriginPad\(\s*originCamera/)
  assert.match(boardSource, /readUsedSheetZoom\(paper\)/)
  assert.match(boardSource, /pinPaperViewportAfterExtentGrow\(scroller, stayScroll\)/)
  assert.match(boardSource, /applyVisualGrowCorrection\(scroller, stayScroll/)
  assert.match(boardSource, /liveWriteStayPut\(/)
  assert.doesNotMatch(boardSource, /pinPaperViewportAfterExtentGrow\(scroller, \{ x: nextStay\.camX/)
  assert.match(boardSource, /noteLinksAfterOriginGrow\(\s*noteLinksRef\.current/)
  assert.match(appSource, /onNoteLinksExtent=\{remapPlacedNoteLinks\}/)
  assert.match(appSource, /persistNoteLinks\(path, links\)/)
  assert.match(appSource, /if \(isPdfActive\) return/)

  return {
    zoomedLeft: zoomed.left,
    pdfLeft: pdfCss.left,
    growY: visual.y,
    reducerY: stay.camY,
    pinPaperY,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('canvas-text-stay ok')
} finally {
  await server.close()
}
