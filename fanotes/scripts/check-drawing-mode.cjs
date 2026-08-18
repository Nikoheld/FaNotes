'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src', 'components', 'DrawingBoard.tsx'), 'utf8')
const paperView = fs.readFileSync(path.join(root, 'src', 'lib', 'paperView.ts'), 'utf8')
const markdownEditor = fs.readFileSync(path.join(root, 'src', 'components', 'MarkdownEditor.tsx'), 'utf8')
const paperCaret = fs.readFileSync(path.join(root, 'src', 'lib', 'paperCaretScroll.ts'), 'utf8')
const inkMap = fs.readFileSync(path.join(root, 'src', 'lib', 'inkSampleMap.ts'), 'utf8')
const toolErase = fs.readFileSync(path.join(root, 'src', 'lib', 'toolErase.ts'), 'utf8')
const inkPolicy = fs.readFileSync(path.join(root, 'src', 'lib', 'inkPointerPolicy.ts'), 'utf8')
const paperGrow = fs.readFileSync(path.join(root, 'src', 'lib', 'paperGrow.ts'), 'utf8')
const defaults = fs.readFileSync(path.join(root, 'src', 'defaults.ts'), 'utf8')
const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
const drafting = fs.readFileSync(path.join(root, 'src', 'lib', 'draftingTools.ts'), 'utf8')
const bugReport = fs.readFileSync(path.join(root, 'src', 'lib', 'bugReport.ts'), 'utf8')
const settingsModal = fs.readFileSync(path.join(root, 'src', 'components', 'SettingsModal.tsx'), 'utf8')
const lockSource = [source, markdownEditor, paperCaret, inkMap, toolErase, inkPolicy, paperGrow, defaults, appSource, drafting, bugReport, settingsModal].join('\n')

const requiredBrushes = ['fineliner', 'pencil', 'marker', 'paintbrush', 'calligraphy', 'highlighter', 'watercolor', 'spray']
const requiredEffects = ['solid', 'rainbow', 'aurora', 'sunset', 'ocean', 'gold', 'silver', 'neon']
const requiredSymbols = ['book', 'calculator', 'flask', 'atom', 'globe', 'lightbulb', 'pencil', 'laptop', 'star', 'heart', 'check', 'warning', 'info', 'question', 'flag', 'arrow', 'home', 'user', 'users', 'clock', 'calendar', 'camera', 'music', 'smile', 'chat']

for (const brush of requiredBrushes) {
  if (!source.includes(`'${brush}'`)) throw new Error(`Der Zeichenpinsel „${brush}“ fehlt.`)
}
for (const effect of requiredEffects) {
  if (!source.includes(`'${effect}'`)) throw new Error(`Die Spezialfarbe „${effect}“ fehlt.`)
}
for (const symbol of requiredSymbols) {
  if (!source.includes(`id: '${symbol}'`)) throw new Error(`Das Piktogramm „${symbol}“ fehlt.`)
}

const safeguards = [
  ['purpose?: \'handwriting\' | \'art\'', 'rückwärtskompatible Trennung von Handschrift und Kunst'],
  ["const isHandwritingStroke = (stroke: InkStroke) => stroke.purpose !== 'art'", 'Abschirmung der Erkennung'],
  ["purpose: raw.purpose === 'art' ? 'art' : 'handwriting'", 'sichere Dokumentmigration'],
  ["brush: raw.brush && artBrushIds.has(raw.brush) ? raw.brush : undefined", 'Pinsel-Validierung beim Laden'],
  ["colorEffect: raw.colorEffect && inkEffectIds.has(raw.colorEffect) ? raw.colorEffect : 'solid'", 'Farb-Validierung beim Laden'],
  ["textureSeed: Math.round(clamp", 'stabile Textur beim erneuten Öffnen'],
  ['symbolId?: ArtSymbolId', 'rückwärtskompatibles Piktogrammformat'],
  ['raw.symbolId && artSymbolIds.has(raw.symbolId)', 'Piktogramm-Validierung beim Laden'],
  ['context.stroke(new Path2D(path))', 'auflösungsunabhängige Vektordarstellung'],
  ["purpose: 'art',\n        brush: 'fineliner'", 'direkte Piktogramm-Platzierung'],
  ["updateTranscript: gestureToolRef.current !== 'pen' || activeStroke?.purpose !== 'art'", 'kein unnötiger Erkennungsdurchlauf für Zeichnungen'],
  ['@media(max-width:640px){.lw-art-studio-body{grid-template-columns:1fr}', 'mobile Zeichenpalette'],
  ['@media(prefers-reduced-motion:reduce)', 'reduzierte Bewegung'],
  ['const releasePointerCaptureSafe', 'sichere Pointer-Capture-Freigabe nach Stift (Hyprland/Wayland)'],
  ['const releaseStuckInputFocus', 'Fokusfreigabe nach Stiftnutzung'],
  ["window.addEventListener('pointerup', onWindowPointerEnd, true)", 'globale Pointer-Ende-Absicherung'],
  ["window.addEventListener('pointerdown', onWindowPointerDown, true)", 'Cross-Device-Freigabe bei Trackpad/Maus'],
  ['const forceEndActivePointer', 'harte Beendigung hängender Stift-Capture'],
  ['shouldRejectNonPenInk', 'Nur-Stift-Modus ignoriert Finger und Maus'],
  ['const SHAPE_DWELL_MS = 700', 'Form-Snap nach kurzem Stillhalten'],
  ['const armShapeDwell', 'Form-Timer läuft auch ohne neue Stiftpunkte'],
  ['strokeLooksLikeShape', 'Hinweis nur bei erkannter Figur'],
  ["event.pointerType === 'mouse'", 'kein setPointerCapture für Stift (Hyprland-Freeze)'],
  ['!inline && event.pointerType === \'mouse\'', 'kein Pointer-Capture auf dem Notizblatt'],
  ['const releaseInkPointerCaptures', 'Capture wird auf Fläche, Canvas und Board gelöst'],
  ['const isInkSurfaceTarget', 'Klick auf Leiste/Tabs beendet hängenden Stift'],
  ['const hitTestChrome', 'Klicks treffen die echte Schaltfläche, nicht eine hängende Stift-Capture'],
  ['document.elementFromPoint', 'Treffer unter dem Cursor unabhängig von Pointer-Capture'],
  [".closest('.lw-canvas-surface, .lw-tablet-canvas')", 'nur die Tintenfläche zählt als Stiftziel, nicht die ganze Tafel'],
  ['position:fixed;z-index:80;top:78px;right:16px', 'Konvertierungs-Panel bleibt im Viewport'],
  ["addEventListener('wheel', onWheel", 'Trackpad-Zoom löst Stift-Capture sofort'],
  ["from '../lib/inkPointerSession'", 'Wacom-Lift-Regeln liegen im gelieferten Session-Helper'],
  ['shouldHardEndInkPointerSession', 'hängende Stift-Session endet bei Tipp-oben oder Idle'],
  ['Linux Wacom sent pressure 0 while the tip button is still down', 'Druck-Flicker beendet den Strich nicht lokal'],
  ['resolveInkFinishSample(native)', 'Hard-End hängt keinen Punkt in die Blattmitte'],
  ['shouldAllowNewInkPointer', 'Trackpad/Maus darf nach Stift-Lift wieder Tint'],
  ['inkSessionRef.current', 'letzte Stift-Kontaktzeit steuert den Watchdog'],
  ['const paintActiveStrokeNow', 'Tinte erscheint sofort, nicht erst im nächsten Frame'],
  ['getPredictedEvents', 'Stift-Vorhersage verkürzt die sichtbare Verzögerung'],
  ['const wipeLiveInkCanvas', 'Live-Tinte wird nach dem Abheben vollständig geleert'],
  ['replaceLive', 'Vorhersagepunkte ersetzen die Live-Tinte statt sie zu übermalen'],
  ['const applyViewTransform', 'Blatt-Zoom und -Rotation während Handschrift'],
  ['snapToDraftingTools', 'Lineal und Geodreieck fangen die Tinte an der Kante'],
  ['<Ruler size={16} />', 'Lineal in der Stiftleiste'],
  ['defaultCompassPose', 'Zirkel mit Nadel, Radius und Drehpunkt'],
  ['<Compass size={16} />', 'Zirkel in der Stiftleiste'],
  ['sampleCompassCircle', 'Zirkel zeichnet Kreis und Bogen als Tinte'],
  ['MAX_CANVAS_PIXELS_TALL = 4_200_000', 'enges Tintenbudget auf langen PDF-Seiten'],
  ['const measureInkWindow', 'Tinten-Bitmap nur für den sichtbaren Blattausschnitt'],
  ['const applyInkWindowToCanvases', 'sichtbares Tintenfenster auf den Canvases'],
  ['syncInkWindow(true)', 'Tintenfenster folgt Scroll und Stiftkante'],
  ['const handleWheel = useCallback', 'Strg/Alt-Mausrad für Zoom und Rotation'],
  ["aria-label=\"Blattansicht\"", 'Toolbar-Steuerung für Zoom und Drehung'],
  ['// Use layout size (offset*), not getBoundingClientRect: CSS zoom/rotation of the', 'Bitmap-Größe unabhängig vom Ansichtszoom'],
  ['WRITE_SLACK_HEIGHT', 'Papier wächst nur mit Tinte plus Absatz-Puffer, nicht durch Scrollen'],
  ['PAGE_GROW_STEP_HEIGHT', 'Neues Blatt wächst in festen Schritten, nicht bei jedem Sample'],
  ['neededWriteExtent', 'Wachstumsschwelle kommt aus dem gelieferten Grow-Helper'],
  ['growLiveInkAndMapNext', 'nächster Stiftpunkt nach Grow kommt aus dem gelieferten Helper'],
  ['pendingGrowScale', 'Remap wartet auf die gemalte Box, nicht auf die Source-Höhe'],
  ['const commitPendingGrowRemap = useCallback', 'Grow-Flush ist ein gemeinsamer Helper'],
  ['activeRenderedPointCountRef.current = 0\n    wipeLiveInkCanvas(canvasRef.current)\n    redraw(true)', 'Flush nach Grow zeichnet die Live-Tinte vollständig neu'],
  ['fanotes-ink-toolbar-slot', 'Handschrift-Werkzeuge sitzen in der oberen Leiste'],
  ['is-docked-chrome', 'Stiftleiste dockt in das normale Menü, statt zu schweben'],
  ['is-viewport-chrome', 'Hinweise und Studio liegen außerhalb des Blatt-Zooms'],
]

const worksheetLayer = fs.readFileSync(path.join(root, 'src', 'components', 'WorksheetLayer.tsx'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
const worksheetSafeguards = [
  ['const enqueuePdfRender', 'PDF-Seiten werden nacheinander gerendert, nicht parallel'],
  ['const loadVaultPdfBytes', 'PDF-Bytes ohne riesige Data-URL'],
  ['const HIDE_DEBOUNCE_MS', 'Off-Screen-Seiten werden nicht sofort zerstört'],
  ['MAX_PDF_PIXELS = 2_400_000', 'enges Pixelbudget pro PDF-Seite'],
  ['disableAutoFetch: true', 'PDF.js lädt keine Extra-Requests'],
  ['{mounted && <PdfPageCanvas', 'getPage nur für sichtbare Seiten'],
]
const worksheetStyleSafeguards = [
  ['width: min(calc(100% - 36px), 900px)', 'PDF-Leiste bleibt auf der A4-Spalte, nicht am rechten Infinite-Rand'],
  ['left: 18px', 'Entfernen-Button klebt im sichtbaren Viewport'],
  ['margin-left: max(32px, calc((100% - var(--paper-width)) / 2))', 'gewachsenes Blatt bleibt links verankert'],
  ['width: min(100%, var(--paper-width, 900px))', 'Text umbricht auf der A4-Spalte'],
  ['Sit above the full-sheet ink canvas so Entfernen stays clickable in pen mode.', 'PDF-Entfernen bleibt im Stiftmodus klickbar'],
]

const paperViewSafeguards = [
  ['target.style.zoom = String(zoom)', 'Zoom über CSS zoom statt transform:scale (scharfer Text)'],
  ["classList.toggle('is-view-transformed', active)", 'Inline-Papier markiert Zoom/Drehung'],
  ["'.editor-pane'", 'Zoom trifft das ganze Blatt, nicht die Toolbar'],
  ['willChange = \'auto\'', 'kein 1×-Compositor-Layer für Text'],
  ["setProperty('--view-zoom', String(zoom))", 'Zoom-Faktor als CSS-Variable auf dem Blatt'],
  ["closest('.paper-sheet-plane')", 'eine Zoom-Ebene für Text, Tinte und Lineatur'],
  ["removeProperty('zoom')", 'kein Zoom-1 auf Kindschichten (Text bleibt sonst 1×)'],
]
const paperStyleSafeguards = [
  ['.unified-paper > .paper-ruling', 'Lineatur liegt auf einer Kind-Schicht und zoomt mit Tinte'],
  ['background-repeat: repeat;', 'Kästchen nicht per round neu kacheln'],
  ['.paper-sheet-plane', 'Text, Tinte und Lineatur liegen in einer Zoom-Hülle'],
]
const lockSafeguards = [
  ['acceptCommittedInkSample', 'Ghost-Samples werden vor dem Commit verworfen'],
  ['mapClientToPaperPoint', 'fehlende Fläche fällt nicht auf die Blattmitte'],
  ['applyPaperArrowNavigation', 'Pfeiltasten scrollen das Blatt, nicht den Text'],
  ['lockPaperEditorLayerScroll', 'Editor-Layer bleibt am Lineal fest'],
  ['handlePaperEditorScroll', 'scrollIntoView wird vor dem cm-scroller abgefangen'],
  ['lockPaperEditorScrollIfNeeded', 'Snapshot-Scroll auf dem Editor-Layer wird zurückgesetzt'],
  ['EditorView.scrollHandler', 'CodeMirror scrollHandler sitzt auf dem ausgelieferten Pfad'],
  ['applyToolErase', 'Werkzeug-Radierer trifft nur schneidende Tinte'],
  ['strokeTouchesEraser', 'Ein-Punkt-Piktogramm und Pfad nutzen dieselbe Hit-Fläche'],
  ['radius + visibleHalfWidth(stroke)', 'Radierer berücksichtigt die sichtbare Piktogrammgröße'],
  ['applyWheelInkPolicy', 'Trackpad-Wheel beendet den Stift-Status'],
  ['classifyInkJumpAppend', 'Sprungfilter unabhängig von der Seitenhöhe'],
  ['shouldIgnorePointerAfterPen', 'Maus nach Stift wird kurz ignoriert'],
  ['shouldRejectNonPenInk', 'Windows-Handfläche startet keine Tinte'],
  ['defaultPenOnlyForPlatform', 'Windows-Standard ist Nur-Stift'],
  ['defaultSettingsForPlatform', 'Windows-Reset kommt aus dem Plattform-Default'],
  ['defaultSettingsForPlatform(window.fanotes.platform)', 'Reset speichert den Windows-Pen-only-Default'],
  ['liveGrowScale', 'Wachstum remappt nur wenn das Blatt wirklich höher wird'],
  ['applyLiveHandwritingGrow', 'Papierpixel bleiben beim Wachsen'],
  ['resolveInkPointerDown', '0,0-Down öffnet den Strich ohne Geisterpunkt'],
  ['millimetresAlongEdge', 'Kantenmaß in echten A4-Millimetern'],
  ['SET_SQUARE_PROTRACTOR_DEGREES', 'Geodreieck-Winkelmesser 0–180°'],
  ['rulerDrawingEdges', 'Lineal hat zwei lange Zeichenkanten'],
  ['createBugReportLog', '5-Minuten-Diagnosefenster für Fehlerberichte'],
  ['BUG_REPORT_MAX_BODY_BYTES', 'Fehlerbericht bleibt unter dem fasrv-256k-Limit'],
  ['BUG_REPORT_PEN_SAMPLE_MS', 'Stift-Samples passen in das 5-Minuten-Fenster'],
  ['bugReportSubmitTarget', 'Fehlerberichte gehen nur an fanotes.fasrv.ch'],
  ['Fehler melden', 'Bug-Report-Schalter in den Einstellungen'],
]

for (const [needle, label] of safeguards) {
  if (!source.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
}
for (const [needle, label] of paperViewSafeguards) {
  if (!paperView.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
}
for (const [needle, label] of worksheetSafeguards) {
  if (!worksheetLayer.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
}
for (const [needle, label] of worksheetStyleSafeguards) {
  if (!styles.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
}
for (const [needle, label] of paperStyleSafeguards) {
  if (!styles.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
}
for (const [needle, label] of lockSafeguards) {
  if (!lockSource.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
}

const brushCatalog = source.slice(source.indexOf('const ART_BRUSHES'), source.indexOf('type ArtSymbolDefinition'))
const brushDefinitions = brushCatalog.match(/\{ id: '(fineliner|pencil|marker|paintbrush|calligraphy|highlighter|watercolor|spray)', label:/gu) ?? []
const effectDefinitions = source.match(/\{ id: '(rainbow|aurora|sunset|ocean|gold|silver|neon)', label:/gu) ?? []
const symbolCatalog = source.slice(source.indexOf('const ART_SYMBOLS'), source.indexOf('const artSymbolIds'))
const symbolDefinitions = symbolCatalog.match(/\{ id: '(book|calculator|flask|atom|globe|lightbulb|pencil|laptop|star|heart|check|warning|info|question|flag|arrow|home|user|users|clock|calendar|camera|music|smile|chat)', label:/gu) ?? []
if (brushDefinitions.length !== requiredBrushes.length || effectDefinitions.length !== requiredEffects.length - 1) {
  throw new Error(`Unerwartete Werkzeugdefinitionen: ${brushDefinitions.length} Pinsel, ${effectDefinitions.length} Spezialfarben.`)
}
if (symbolDefinitions.length !== requiredSymbols.length) {
  throw new Error(`Unerwartete Piktogrammbibliothek: ${symbolDefinitions.length} statt ${requiredSymbols.length} Symbole.`)
}

console.log(`Zeichenmodus-Prüfung erfolgreich: ${brushDefinitions.length} Pinsel, 14 Vollfarben, ${effectDefinitions.length} Spezialfarben, ${symbolDefinitions.length} Icons/Piktogramme, sichere Speicherung und Erkennungstrennung, Zoom/Rotation + Hyprland-Pointer-Freigabe.`)
