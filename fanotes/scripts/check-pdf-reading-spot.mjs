import assert from 'node:assert/strict'
import { createServer } from 'vite'

// Book-pane PDFs reopen at the page and the offset inside the page.
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})
const spot = await server.ssrLoadModule('/src/lib/pdfReadingSpot.ts')

const boxes = [{ page: 1, top: -900, height: 800 }, { page: 2, top: -100, height: 800 }, { page: 3, top: 700, height: 800 }]
const found = spot.pdfSpotFromBoxes(0, boxes)
assert.equal(found.page, 2)
assert.equal(found.frac, 0.125)
assert.equal(spot.pdfScrollDeltaForSpot(0, { top: -100, height: 800 }, 0.125), 0)
assert.equal(spot.pdfScrollDeltaForSpot(0, { top: 300, height: 800 }, 0.5), 700)

let store = {}
for (let i = 0; i < 5; i += 1) store = spot.rememberPdfReadingSpot(store, `/b${i}.pdf`, { page: i + 1, frac: 0.5 }, 1000 + i, 3)
assert.deepEqual(Object.keys(store).sort(), ['/b2.pdf', '/b3.pdf', '/b4.pdf'])
assert.equal(spot.parsePdfReadingSpots('{"a":{"page":0,"frac":1}}').a, undefined)
assert.deepEqual(Object.keys(spot.parsePdfReadingSpots(JSON.stringify(store))).length, 3)

await server.close()
console.log('pdf reading spot ok')
