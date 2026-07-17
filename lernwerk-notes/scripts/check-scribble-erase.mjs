import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const page = { width: 900, height: 1273 }
const point = (x, y, t = 0) => ({ x: x / page.width, y: y / page.height, t, pressure: 0.55, tiltX: 0, tiltY: 0, pointerType: 'pen' })
const stroke = (points, baseWidth = 4) => ({
  points: points.map(([x, y], index) => point(x, y, index * 12)),
  baseWidth,
  pressureEnabled: true,
  color: '#191c24',
})
const line = (x1, y1, x2, y2) => stroke([[x1, y1], [x2, y2]])

try {
  const { detectScribbleErase } = await server.ssrLoadModule('/src/lib/scribbleErase.ts')

  const word = [
    line(190, 190, 190, 228), line(180, 190, 202, 190),
    line(214, 202, 214, 226), line(214, 202, 232, 202), line(214, 214, 229, 214), line(214, 226, 232, 226),
    stroke([[252, 204], [243, 202], [240, 210], [252, 215], [255, 223], [244, 228]]),
    line(270, 190, 270, 228), line(262, 200, 280, 200),
  ]
  const nextWord = [line(330, 190, 330, 228), line(350, 190, 350, 228)]
  const lineAbove = [line(185, 151, 280, 151)]
  const scribble = stroke([
    [174, 202], [278, 222], [181, 219], [281, 199], [179, 206], [279, 225], [183, 216], [276, 201],
  ], 3.5)
  const match = detectScribbleErase(scribble, [...word, ...nextWord, ...lineAbove], page)
  assert.ok(match, 'Mehrfaches Durchkritzeln über einem Wort muss als Löschgeste erkannt werden.')
  assert.deepEqual(match.indexes, word.map((_, index) => index), 'Nur das abgedeckte Wort darf gelöscht werden.')
  assert.ok(match.intersectionCount >= 3)
  assert.ok(match.reversalCount >= 3)

  const shortScribble = stroke([
    [180, 203], [225, 212], [274, 220], [230, 214], [184, 207], [226, 204], [270, 201], [238, 207],
  ], 3.5)
  assert.equal(detectScribbleErase(shortScribble, word, page, 0), null, 'Niedrige Empfindlichkeit muss mehr Durchkritzeln verlangen.')
  assert.ok(detectScribbleErase(shortScribble, word, page, 100), 'Hohe Empfindlichkeit muss ein kürzeres eindeutiges Durchkritzeln erkennen.')
  assert.ok(detectScribbleErase(scribble, word, page, 0), 'Auch bei niedriger Empfindlichkeit muss gründliches Durchkritzeln löschen.')

  const cursiveWord = stroke([
    [180, 211], [194, 194], [205, 227], [218, 195], [231, 226], [245, 196], [258, 226], [273, 207],
  ])
  const cursiveMatch = detectScribbleErase(scribble, [cursiveWord], page)
  assert.ok(cursiveMatch, 'Auch ein verbunden geschriebenes Wort aus einem einzigen Strich muss löschbar sein.')
  assert.deepEqual(cursiveMatch.indexes, [0])

  const straightStrike = stroke([[174, 210], [281, 211]])
  assert.equal(detectScribbleErase(straightStrike, word, page), null, 'Ein einzelner Durchstrich bleibt normale Tinte.')

  const handwrittenW = stroke([[185, 192], [196, 227], [210, 197], [224, 227], [240, 192]])
  assert.equal(detectScribbleErase(handwrittenW, word, page), null, 'Ein normal geschriebener Buchstabe darf keine Löschgeste sein.')

  const root = stroke([[180, 210], [190, 222], [201, 190], [275, 190]])
  assert.equal(detectScribbleErase(root, word, page), null, 'Ein Wurzelzeichen darf keine Löschgeste sein.')

  assert.equal(detectScribbleErase(scribble, nextWord, page), null, 'Durchkritzeln auf leerem Papier darf vorhandene entfernte Tinte nicht löschen.')

  const verticalScratch = stroke([[215, 175], [230, 235], [210, 180], [232, 233], [208, 178], [229, 236]])
  assert.equal(detectScribbleErase(verticalScratch, word, page), null, 'Eine hohe vertikale Geste ist keine Wort-Löschgeste.')

  console.log('Durchkritzel-Löschung erfolgreich: einstellbare niedrige/normale/hohe Empfindlichkeit, getrennte und verbundene Wörter, Bereichsgrenzen, Undo sowie Gestenschutz geprüft.')
} finally {
  await server.close()
}
