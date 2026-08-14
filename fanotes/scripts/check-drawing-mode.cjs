'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src', 'components', 'DrawingBoard.tsx'), 'utf8')
const paperView = fs.readFileSync(path.join(root, 'src', 'lib', 'paperView.ts'), 'utf8')

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
  ['radius + stroke.baseWidth / 2', 'Radierer berücksichtigt die sichtbare Piktogrammgröße'],
  ["updateTranscript: gestureToolRef.current !== 'pen' || activeStroke?.purpose !== 'art'", 'kein unnötiger Erkennungsdurchlauf für Zeichnungen'],
  ['@media(max-width:640px){.lw-art-studio-body{grid-template-columns:1fr}', 'mobile Zeichenpalette'],
  ['@media(prefers-reduced-motion:reduce)', 'reduzierte Bewegung'],
  ['const releasePointerCaptureSafe', 'sichere Pointer-Capture-Freigabe nach Stift (Hyprland/Wayland)'],
  ['const releaseStuckInputFocus', 'Fokusfreigabe nach Stiftnutzung'],
  ["window.addEventListener('pointerup', onWindowPointerEnd, true)", 'globale Pointer-Ende-Absicherung'],
  ["window.addEventListener('pointerdown', onWindowPointerDown, true)", 'Cross-Device-Freigabe bei Trackpad/Maus'],
  ['const forceEndActivePointer', 'harte Beendigung hängender Stift-Capture'],
  ["settings.penOnly && event.pointerType !== 'pen'", 'Nur-Stift-Modus ignoriert Finger und Maus'],
  ['const SHAPE_DWELL_MS = 2_000', 'Form-Snap erst nach etwa zwei Sekunden Stillhalten'],
  ['strokeLooksLikeShape', 'Form-Timer nur bei erkannter Figur'],
  ["event.pointerType === 'mouse'", 'kein setPointerCapture für Stift (Hyprland-Freeze)'],
  ['const applyViewTransform', 'Blatt-Zoom und -Rotation während Handschrift'],
  ['const handleWheel = useCallback', 'Strg/Alt-Mausrad für Zoom und Rotation'],
  ["aria-label=\"Blattansicht\"", 'Toolbar-Steuerung für Zoom und Drehung'],
  ['// Use layout size (offset*), not getBoundingClientRect: CSS zoom/rotation of the', 'Bitmap-Größe unabhängig vom Ansichtszoom'],
  ['position:fixed;z-index:90;left:50%', 'Handschrift-Toolbar bleibt oben fixiert und klickbar'],
]

const paperViewSafeguards = [
  ['paper.style.zoom', 'Zoom über CSS zoom statt transform:scale (scharfer Text)'],
  ["classList.toggle('is-view-transformed', active)", 'Inline-Papier markiert Zoom/Drehung'],
  ['.editor-pane, .worksheet-layer, .lw-canvas-surface', 'Zoom trifft das ganze Blatt, nicht die Toolbar'],
  ['willChange = \'auto\'', 'kein 1×-Compositor-Layer für Text'],
]

for (const [needle, label] of safeguards) {
  if (!source.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
}
for (const [needle, label] of paperViewSafeguards) {
  if (!paperView.includes(needle)) throw new Error(`Zeichenmodus-Prüfung fehlgeschlagen: ${label}.`)
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
