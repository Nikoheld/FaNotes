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
  assert.match(drawingSource, /renderDocument\(committedCanvas, strokesRef\.current/u)
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
  assert.match(appSource, /activePathRef\.current[\s\S]*tabsRef\.current\.find/u)
  assert.match(appSource, /const NoteTabButton = memo/u)
  assert.match(fileTreeSource, /sortedEntryCache = new WeakMap/u)
  assert.match(mainSource, /backgroundThrottling: true/u)
  assert.match(mainSource, /currentSettings\.backgroundTaskLimit/u)
  assert.match(settingsSource, /RAM-Limit pro Renderer/u)
  assert.match(settingsSource, /OCR-Rechenkerne/u)
  assert.match(settingsSource, /Desktop-Erkennungsmodell/u)
  assert.match(settingsSource, /OCR-Modell im RAM behalten/u)
  assert.match(settingsSource, /Parallele Hintergrundaufgaben/u)
  assert.match(mainSource, /spellcheck:\s*false/u)
  assert.doesNotMatch(mainSource, /setSpellCheckerLanguages|configureSpellChecker/u)
  assert.match(editorSource, /this\.schedule\(view, 3200\)/u)

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
