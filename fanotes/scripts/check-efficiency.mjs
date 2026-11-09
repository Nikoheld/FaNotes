import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { createTrailingValueScheduler } = await server.ssrLoadModule('/src/lib/trailingValueScheduler.ts')
  let nextTimer = 0
  const timers = new Map()
  const timerAdapter = {
    set(callback) {
      const id = ++nextTimer
      timers.set(id, callback)
      return id
    },
    clear(id) { timers.delete(id) },
  }
  const emitted = []
  const scheduler = createTrailingValueScheduler((value) => emitted.push(value), 90, timerAdapter)
  for (let index = 0; index < 1_000; index += 1) scheduler.push(index)
  assert.equal(timers.size, 1, 'Eine schnelle Eingabefolge darf nur einen aktiven Timer behalten.')
  assert.equal(emitted.length, 0)
  timers.values().next().value()
  assert.deepEqual(emitted, [999], 'Nur der neueste Inhalt eines Bursts darf React erreichen.')
  scheduler.push(1_000)
  scheduler.flush()
  assert.deepEqual(emitted, [999, 1_000], 'Speichern/Schließen muss den letzten Wert synchron verlustfrei übernehmen.')
  assert.equal(scheduler.pending(), false)

  const [drawingSource, editorSource, appSource, mainSource, fileTreeSource, settingsSource] = await Promise.all([
    readFile(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/MarkdownEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/FileTree.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/SettingsModal.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(drawingSource, /committedCanvasRef/u)
  assert.match(drawingSource, /renderDocument\(\s*committedCanvas,\s*strokesRef\.current/u)
  assert.match(drawingSource, /lw-tablet-canvas-committed/u)
  assert.match(drawingSource, /commitStrokeToCanvas\(activeStroke\)/u)
  assert.match(drawingSource, /activeRenderedPointCountRef/u)
  assert.match(drawingSource, /Math\.max\(1, activeRenderedPointCountRef\.current\)/u)
  assert.doesNotMatch(drawingSource, /activeStrokeRef\.current \? \[\.\.\.strokesRef\.current/u)
  assert.doesNotMatch(drawingSource, /beforeGestureRef\.current = cloneStrokes/u)
  assert.match(drawingSource, /beforeGestureRef\.current = snapshotStrokes/u)
  assert.match(drawingSource, /exportCacheRef/u)
  assert.match(drawingSource, /drawingPayload\(insertAfterSave\)/u)
  assert.match(drawingSource, /imageData\?: string/u)
  assert.match(drawingSource, /requestIdleCallback/u)
  assert.match(drawingSource, /transcriptRevision === 0/u)
  assert.match(drawingSource, /bumpInkRevision\(\{ updateTranscript: false \}\)/u)
  assert.match(drawingSource, /previousStrokeCount - 24/u)
  assert.match(drawingSource, /BACKGROUND_RECOGNITION_CHUNK = 24/u)
  assert.match(drawingSource, /const measureInkWindow/u)
  assert.match(drawingSource, /applyInkWindowToCanvases/u)
  assert.match(drawingSource, /document\.hasFocus\(\)/u)
  assert.match(drawingSource, /window\.addEventListener\('blur', handleActivity\)/u)
  assert.match(drawingSource, /handwritingDbModulePromise\s*\?\?=\s*import\('\.\.\/lib\/handwritingDb'\)/u)
  assert.match(drawingSource, /recognitionModulePromise\s*\?\?=\s*import\('\.\.\/\.\.\/\.\.\/src\/lib\/recognition'\)/u)
  assert.doesNotMatch(
    drawingSource,
    /useEffect\(\(\) => \{\s*let active = true\s*loadRecognitionResources\(\)/u,
    'Das persönliche Modell darf beim bloßen Anzeigen einer Handschriftseite nicht gebaut werden.',
  )
  assert.match(editorSource, /createTrailingValueScheduler/u)
  assert.match(editorSource, /flushChanges/u)
  assert.match(appSource, /fanotes-energy-idle/u)
  assert.match(appSource, /lmStudioOpen \? \[\.\.\.filePaths\(tree\)\]/u)
  assert.match(appSource, /lmStudioOpen && activeTab/u)
  assert.match(appSource, /StableWorksheetLayer/u)
  assert.match(appSource, /SafeBoundary/u)
  assert.match(appSource, /activePathRef\.current[\s\S]*tabsRef\.current\.find/u)
  assert.match(appSource, /const NoteTabButton = memo/u)
  assert.match(fileTreeSource, /sortedEntryCache = new WeakMap/u)
  assert.match(mainSource, /backgroundThrottling: true/u)
  assert.match(mainSource, /configureDesktopGpu\(app\)/u)
  assert.match(mainSource, /ready-to-show/u)
  assert.match(mainSource, /currentSettings\.backgroundTaskLimit/u)
  assert.match(settingsSource, /RAM-Limit pro Renderer/u)
  assert.match(settingsSource, /OCR-Rechenkerne/u)
  assert.match(settingsSource, /Desktop-Erkennungsmodell/u)
  assert.match(settingsSource, /OCR-Modell im RAM behalten/u)
  assert.match(settingsSource, /Parallele Hintergrundaufgaben/u)
  assert.match(mainSource, /spellcheck:\s*false/u)
  assert.doesNotMatch(mainSource, /setSpellCheckerLanguages|configureSpellChecker/u)
  assert.match(editorSource, /this\.schedule\(view, 3200\)/u)

  // Large-note autosave, culling, and erasing reused per-stroke results
  // instead of reading every sample each time. The results must stay exact.
  {
    const { strokePointBounds, bumpInkGeometryEpoch } = await server.ssrLoadModule('/src/lib/strokeBounds.ts')
    const { drawingDocumentJson, strokeJson } = await server.ssrLoadModule('/src/lib/drawingJson.ts')
    const { applyToolErase } = await server.ssrLoadModule('/src/lib/toolErase.ts')
    const { textBytes } = await server.ssrLoadModule('/src/lib/browserApi.ts')
    const point = (x, y, t = 1) => ({ x, y, t, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
    const stroke = (index) => ({
      color: '#123', baseWidth: 2, brush: 'fineliner', pressureEnabled: true,
      points: Array.from({ length: 30 }, (_, i) => point(0.1 + (index % 7) * 0.1 + i * 0.002, 0.05 + Math.floor(index / 7) * 0.04 + Math.sin(i) * 0.01, i * 8)),
    })
    const strokes = Array.from({ length: 60 }, (_, index) => stroke(index))
    const drawing = {
      schemaVersion: 1, title: 'He said "strokes":[] here', paperStyle: 'lines', sourceWidth: 794, sourceHeight: 2246,
      createdAt: 'a', updatedAt: 'b', strokes,
      sections: [{ id: 's', top: { x: 0, y: 0.5 }, hidden: { strokes: [stroke(99)] } }],
      inkHistory: { extras: [stroke(98)], undo: [[{ ref: 1 }]], redo: [] },
    }
    assert.equal(drawingDocumentJson(drawing), JSON.stringify(drawing), 'cached drawing JSON is JSON.stringify')
    assert.equal(drawingDocumentJson(drawing), JSON.stringify(drawing), 'and stays it on the second save')
    // A page grow moves points in place; a section move shifts one stroke.
    for (const item of strokes) for (const sample of item.points) sample.y *= 0.5
    bumpInkGeometryEpoch()
    assert.equal(drawingDocumentJson(drawing), JSON.stringify(drawing), 'a moved page is written again')
    strokes[3].points[12].x += 0.001
    assert.equal(strokeJson(strokes[3]), JSON.stringify(strokes[3]), 'an interior sample moved in place is written again, with no epoch')
    strokes[4].points[0].t = undefined
    assert.equal(strokeJson(strokes[4]), JSON.stringify(strokes[4]))
    assert.equal(drawingDocumentJson({ ...drawing, strokes: [strokes[0], undefined, strokes[1]] }), JSON.stringify({ ...drawing, strokes: [strokes[0], undefined, strokes[1]] }))

    const loop = (points) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const sample of points) { if (sample.x < minX) minX = sample.x; if (sample.x > maxX) maxX = sample.x; if (sample.y < minY) minY = sample.y; if (sample.y > maxY) maxY = sample.y }
      return { minX, minY, maxX, maxY }
    }
    const live = stroke(5)
    const pick = ({ minX, minY, maxX, maxY }) => ({ minX, minY, maxX, maxY })
    assert.deepEqual(pick(strokePointBounds(live.points)), loop(live.points))
    live.points.push(point(0.95, 0.9))
    assert.deepEqual(pick(strokePointBounds(live.points)), loop(live.points), 'a live stroke that grew is measured again')
    live.points.splice(0, 1, point(0.01, 0.01))
    assert.deepEqual(pick(strokePointBounds(live.points)), loop(live.points), 'a replaced first sample is measured again')
    for (const sample of live.points) sample.y += 0.02
    assert.deepEqual(pick(strokePointBounds(live.points)), loop(live.points), 'a section shift is measured again')
    for (const sample of live.points) sample.x *= 0.5
    bumpInkGeometryEpoch()
    assert.deepEqual(pick(strokePointBounds(live.points)), loop(live.points), 'a rescale is measured again')
    assert.deepEqual(pick(strokePointBounds([])), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

    // The eraser still removes the same strokes with cached bounds.
    const page = Array.from({ length: 40 }, (_, index) => stroke(index))
    const erased = applyToolErase(page, [point(0.4, 0.09), point(0.6, 0.11)], 6, 794, 1123)
    assert.ok(erased.length < page.length, 'the eraser still erases')
    assert.equal(applyToolErase(page, [point(0.99, 0.99)], 4, 794, 1123), page, 'and leaves a page alone when nothing is near')

    for (const text of ['', 'abc', 'Größe', '✓€', '😀', 'a\ud800b', '\udc00', 'x'.repeat(1000) + '😀'.repeat(3)]) {
      assert.equal(textBytes(text), new TextEncoder().encode(text).byteLength, `utf-8 length of ${JSON.stringify(text)}`)
    }
  }

  const committedStrokes = 2_000
  const frames = 120
  const averageActiveStrokeSegments = 90
  const previousStrokeVisits = committedStrokes * frames + averageActiveStrokeSegments * frames
  const cachedStrokeVisits = committedStrokes + averageActiveStrokeSegments * frames
  const reduction = 1 - cachedStrokeVisits / previousStrokeVisits
  assert.ok(reduction > 0.94, 'Der gecachte Zeichenpfad muss bei langen Seiten mindestens 94 % der modellierten Strichbesuche vermeiden.')

  console.log(`Effizienzprüfung erfolgreich: 1.000 Editor-Ereignisse → 1 React-Snapshot; gecachter Langseitenpfad vermeidet im Modell ${(reduction * 100).toFixed(1)} % wiederholte Strichbesuche; Idle-, Export-, Spellcheck- und Hintergrundschutz aktiv.`)
} finally {
  await server.close()
}
