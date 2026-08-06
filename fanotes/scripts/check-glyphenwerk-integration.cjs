'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const workspace = path.resolve(root, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const readWorkspace = (file) => fs.readFileSync(path.join(workspace, file), 'utf8')

const app = read('src/App.tsx')
const panel = read('src/components/GlyphenWerkWorkspace.tsx')
const personalizedLine = read('src/lib/personalizedLineRecognition.ts')
const database = read('src/lib/handwritingDb.ts')
const drawing = read('src/components/DrawingBoard.tsx')
const settings = read('src/components/SettingsModal.tsx')
const styles = read('src/styles.css')
const main = read('electron/main.cjs')
const packageJson = JSON.parse(read('package.json'))
const glyphenWerkApp = readWorkspace('src/App.tsx')
const glyphenWerkStyles = readWorkspace('src/styles.css')
const glyphenWerkCanvas = readWorkspace('src/components/DrawingCanvas.tsx')
const stagedIndex = path.join(root, 'public', 'glyphenwerk', 'index.html')

assert.ok(fs.existsSync(stagedIndex), 'Der lokale GlyphenWerk-Build wurde nicht in FaNotes eingebettet.')
assert.match(fs.readFileSync(stagedIndex, 'utf8'), /\.\/assets\/index-[^"']+\.js/u)
assert.match(packageJson.scripts['build:web'], /build:glyphenwerk/u)
assert.match(packageJson.scripts.dev, /build:glyphenwerk/u)

assert.match(app, /GlyphenWerkWorkspace/u)
assert.match(app, /Ctrl ⇧ G/u)
assert.match(app, /title="GlyphenWerk"/u)
assert.match(app, /glyphenwerk-sidebar-nav/u)
for (const sidebarEntry of ['Training', 'Erkennung testen', 'Sammlung', 'Exportieren']) {
  assert.match(app, new RegExp(sidebarEntry))
}
assert.match(styles, /\.sidebar\.is-glyphenwerk/u)
assert.match(drawing, /onOpenGlyphenWerk/u)
assert.match(settings, /GlyphenWerk ist in FaNotes integriert/u)

assert.match(panel, /event\.source !== iframeRef\.current\?\.contentWindow/u)
assert.match(panel, /schemaVersion !== 1/u)
assert.match(panel, /sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"/u)
assert.match(panel, /glyphenwerk:navigate/u)
assert.match(panel, /glyphenwerk:view-changed/u)
assert.match(panel, /glyphenwerk:appearance/u)
assert.match(panel, /glyphenwerk:ready/u)
assert.match(panel, /glyphenwerk:recognize-neural/u, 'Der eingebettete Test fragt das neuronale Zeilenmodell nicht an.')
assert.match(panel, /glyphenwerk:neural-result/u, 'Das neuronale Ergebnis wird nicht an GlyphenWerk zurückgegeben.')
assert.match(panel, /recognizeNeuralText/u)
assert.match(panel, /recognizePersonalizedTextLine/u, 'GlyphenWerk darf das persönliche Training beim sichtbaren Testergebnis nicht umgehen.')
assert.match(panel, /personalized\.fusion\.text/u, 'GlyphenWerk muss das fusionierte statt des rohen neuronalen Ergebnisses anzeigen.')
assert.match(personalizedLine, /fusePersonalizedTextRecognition/u)
assert.match(personalizedLine, /personalizedTextFusionSelectionScore/u)
assert.match(personalizedLine, /let primary: RecognitionToken\[\] \| null = null/u, 'Die unbeschränkte persönliche Segmentierung braucht einen verzögerten Fallback.')
assert.match(personalizedLine, /if \(!separatedWordCandidates\.length\) \{[\s\S]*?const primaryCandidate = getPrimary\(\)/u, 'Mehrdeutige Wortgrenzen müssen weiterhin die unbeschränkte persönliche Segmentierung verwenden.')
assert.match(personalizedLine, /if \(!candidates\.length\) candidates\.push\(getPrimary\(\)\)/u, 'Die persönliche Segmentierung darf auch ohne neuronalen Kandidaten nie entfallen.')
assert.match(panel, /MAX_RECOGNITION_POINTS/u, 'Stiftpunkte aus der Frame-Brücke müssen strikt begrenzt werden.')
assert.match(panel, /APPEARANCE_VARIABLES/u)
assert.match(panel, /ZIP importieren/u, 'Der sichtbare GlyphenWerk-ZIP-Import fehlt.')
assert.match(panel, /accept="\.zip,application\/zip"/u)
assert.match(app, /onImportTraining=\{importTrainingFromSettings\}/u)
assert.match(glyphenWerkApp, /glyphenwerk:navigate/u)
assert.match(glyphenWerkApp, /glyphenwerk:view-changed/u)
assert.match(glyphenWerkApp, /glyphenwerk:appearance/u)
assert.match(glyphenWerkApp, /glyphenwerk:ready/u)
assert.match(glyphenWerkApp, /glyphenwerk:recognize-neural/u)
assert.match(glyphenWerkApp, /glyphenwerk:neural-result/u)
assert.match(glyphenWerkApp, /neuralTestText \|\| recognizedSentence/u)
assert.match(glyphenWerkApp, /neuronale Satzanalyse/u)
assert.match(glyphenWerkApp, /recognizeAutomaticExpression\([\s\S]*?getGlyphenWerkLanguage\(\)/u, 'Der GlyphenWerk-Test muss die aktive deutsche oder englische Sprache verwenden.')
assert.match(glyphenWerkApp, /recognizeAutomaticExpression/u)
assert.match(
  glyphenWerkApp,
  /embeddedTextRecognitionHints\(incrementalHint\)/u,
  'Die eingebettete Erkennung muss ausschließlich den bereits stabilen Präfix ableiten.',
)
assert.doesNotMatch(
  glyphenWerkApp,
  /textCharacterCountHint/u,
  'Inkrementelle Strichgeometrie darf nie als harter Text-Count zurückgekoppelt werden.',
)
assert.doesNotMatch(
  glyphenWerkApp,
  /textCharacterHint/u,
  'Neu geratene Buchstaben dürfen nicht als vollständige Textvorgabe zurückgekoppelt werden.',
)
assert.match(
  readWorkspace('src/lib/incrementalTextRecognition.ts'),
  /previousText[\s\S]*?textPrefixHint/u,
  'Die Brücke braucht eine explizite Präfix- statt Volltext-/Count-Semantik.',
)
assert.doesNotMatch(
  readWorkspace('src/lib/incrementalTextRecognition.ts'),
  /textCharacterCountHint/u,
  'Auch der klassische Textzweig darf keinen zirkulären Count erzeugen.',
)
assert.match(
  panel,
  /recognizePersonalizedTextLine\([\s\S]*?560,\s*undefined,\s*undefined,\s*textPrefixHint/u,
  'Der Host muss Count und Volltext überspringen und den Präfix am angehängten Argumentplatz weiterreichen.',
)
assert.match(
  glyphenWerkApp,
  /recognitionFallbackRef\.current,\s*undefined,\s*undefined,\s*incrementalTextHints\.textPrefixHint/u,
  'Die eingebettete Automatik muss Count/Volltext auslassen und ausschließlich den Präfix am neuen Argumentplatz setzen.',
)
assert.match(
  glyphenWerkApp,
  /incrementalTextHints\.textPrefixHint,\s*confirmedTextPrefixHint/u,
  'Explizit bestätigte Präfixpositionen müssen getrennt von automatisch stabilisierten Positionen gewichtet werden.',
)
assert.match(
  glyphenWerkApp,
  /const continuationPreviousState = hasLooseTextContinuation\(previousIncrementalState, testStrokes\)[\s\S]*?const confirmedTextPrefixHint = continuationPreviousState/u,
  'Auch bestätigte Präfixe dürfen nur in eine räumlich plausible Fortsetzung derselben Zeile gelangen.',
)
assert.match(
  glyphenWerkApp,
  /else if \(canCarryUncertainTextState\(previousIncrementalState, testStrokes\)\)[\s\S]*?carryStableTextPrefixAcrossUncertainInk/u,
  'Ein unsicherer Textzustand muss vor dem Carry das Einmal-Budget und die räumliche Kontinuität prüfen.',
)
assert.match(
  panel,
  /glyphenWerkExactProjectionIsIndependent\([\s\S]*?exactProjectionSafe/u,
  'Der Host muss präfixbeeinflusste Ergebnisse als nicht unabhängig markieren.',
)
assert.match(
  glyphenWerkApp,
  /hardProjectionAllowed \? modeAssessment\.visibleCharacters : undefined[\s\S]*?hardProjectionAllowed \? text : undefined/u,
  'Ein präfixbeeinflusstes Host-Ergebnis darf nicht wieder als harter Count/Volltext projiziert werden.',
)
assert.match(
  glyphenWerkApp,
  /if \(exactProjectionSafe\) recognitionFallbackRef\.current = 'text'/u,
  'Eine präfixabhängige Host-Fusion darf den nächsten automatischen Modus nicht vorgeben.',
)
assert.match(
  glyphenWerkApp,
  /const hardProjectionAllowed = neuralTestResult\.exactProjectionSafe &&[\s\S]*?compactHostText\.startsWith\(confirmedTextPrefix\)/u,
  'Ein unabhängiger Hosttext darf eine explizit bestätigte Zeichenfolge nicht überschreiben.',
)
assert.match(
  glyphenWerkApp,
  /const localTokenText = recognizedSentence\(textTokens\)\.trim\(\)[\s\S]*?const exactProjectionSafe = hardProjectionAllowed && textProjectionMatchesTokens\(text, localTokenText\)[\s\S]*?const projectedText = exactProjectionSafe[\s\S]*?: localTokenText[\s\S]*?value: projectedText,[\s\S]*?textValue: projectedText/u,
  'Bei unsicherer Host-Fusion müssen Anzeige, Korrekturtext und lokale Tokens dieselbe Projektion behalten.',
)
assert.match(
  glyphenWerkApp,
  /exactProjectionSafe &&[\s\S]{0,120}\^\\p\{L\}\{1,24\}\$[\s\S]{0,500}incrementalTextRecognitionRef\.current/u,
  'Eine präfixabhängige Host-Fusion darf den stabilen Präfixzustand nicht selbst fortschreiben.',
)
assert.match(glyphenWerkApp, /correctedRecognitionInputRef/u)
assert.match(glyphenWerkApp, /bestätigte manuelle Korrektur/u)
assert.match(glyphenWerkApp, /correctedRecognitionInputRef\.current === testStrokes/u)
assert.match(
  glyphenWerkApp,
  /const timer = window\.setTimeout\(\(\) => \{[\s\S]{0,420}correctedRecognitionInputRef\.current === testStrokes[\s\S]{0,180}return/u,
  'Auch ein bereits geplanter lokaler Debounce muss eine inzwischen korrigierte Tintenaufnahme unangetastet lassen.',
)
assert.match(
  glyphenWerkApp,
  /const correctedVisibleIndex[\s\S]*?textPrefixAfterTokenCorrection\([\s\S]*?correctedVisibleIndex/u,
  'Eine Einzelkorrektur darf nur ihre tatsächlich zusammenhängende Präfixposition bestätigen.',
)
assert.match(
  glyphenWerkApp,
  /value: correctedTextValue,\s*textValue: correctedTextValue/u,
  'Tokenkorrektur, sichtbarer Wert und automatischer Textwert müssen synchron bleiben.',
)
assert.match(
  glyphenWerkApp,
  /const handleConfirmRecognition[\s\S]*?prefixText: compactConfirmedText,\s*confirmedPrefixLength: confirmedCharacters\.length/u,
  'Der explizite Bestätigen-Button muss im Gegensatz zur Einzelkorrektur die vollständige geprüfte Textfolge fixieren.',
)
assert.match(
  glyphenWerkApp,
  /neuralTestResult\.requestId !== neuralRequestIdRef\.current[\s\S]{0,180}correctedRecognitionInputRef\.current === testStrokes/u,
  'Auch der Host-Result-Effect muss einen bereits korrigierten Snapshot unangetastet lassen.',
)
assert.match(
  glyphenWerkApp,
  /const handleTestStrokesChange[\s\S]*?neuralRequestIdRef\.current = ''[\s\S]*?setTestStrokes\(strokes\)/u,
  'Neue Tinte muss ausstehende Hostantworten des alten Canvas sofort invalidieren.',
)
assert.match(
  glyphenWerkApp,
  /correctedRecognitionInputRef\.current = testStrokes[\s\S]{0,260}neuralRequestIdRef\.current = ''[\s\S]{0,120}setNeuralTestResult\(null\)/u,
  'Eine manuelle Zeichenkorrektur muss jede verspätete automatische Hostantwort invalidieren.',
)
assert.match(glyphenWerkApp, /Text &amp; Mathematik testen/u)
assert.doesNotMatch(glyphenWerkApp, /className="recognition-mode-switch"/u)
assert.match(glyphenWerkStyles, /\.app-shell\.is-fanotes-embedded \.sidebar \{ display: none; \}/u)
assert.match(glyphenWerkStyles, /html\[data-fanotes-theme\]/u)
assert.match(glyphenWerkStyles, /--fanotes-panel/u)
assert.match(glyphenWerkStyles, /touch-action:\s*pan-x pan-y pinch-zoom/u, 'Trackpad-/Touch-Scrollen darf durch die Zeichenfläche nicht blockiert werden.')
assert.match(glyphenWerkCanvas, /if \(event\.pointerType === 'touch'\) return/u, 'Touch-Navigation darf nicht als Wacom-Tinte gecaptured werden.')
assert.match(glyphenWerkCanvas, /onLostPointerCapture=\{handleLostPointerCapture\}/u, 'Ein verlorenes Wacom-Capture muss den aktiven Stiftzustand aufräumen.')
assert.match(glyphenWerkCanvas, /window\.addEventListener\('blur', releaseStalePointer\)/u, 'Ein Fokuswechsel muss einen verwaisten Stiftzustand aufräumen.')
for (const message of ['sync', 'samples-added', 'samples-removed', 'labels-added', 'layouts-replaced']) {
  assert.match(panel, new RegExp(`glyphenwerk:${message}`))
  assert.match(glyphenWerkApp, new RegExp(`glyphenwerk:${message}`))
}

for (const operation of [
  'putHandwritingLabels',
  'putHandwritingSamples',
  'removeHandwritingSamples',
  'replaceManagedMathLayoutExamples',
  'loadRecognitionResources',
]) assert.match(panel, new RegExp(operation))
assert.match(database, /export const removeHandwritingSamples/u)
assert.match(database, /export const putHandwritingLabels/u)
assert.match(database, /export const replaceManagedMathLayoutExamples/u)

assert.match(main, /isEmbeddedGlyphenWerkResource/u)
assert.match(main, /"frame-src 'self'"/u)
assert.match(main, /isEmbeddedGlyphenWerkResource \? "frame-ancestors 'self'" : "frame-ancestors 'none'"/u)

console.log('GlyphenWerk-Integration: Oberfläche, sichere Datenbrücke, lokaler Build und Electron-CSP geprüft.')
