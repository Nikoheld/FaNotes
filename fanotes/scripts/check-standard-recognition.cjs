const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(appRoot, '..')
const readApp = (file) => fs.readFileSync(path.join(appRoot, file), 'utf8')
const readWorkspace = (file) => fs.readFileSync(path.join(workspaceRoot, file), 'utf8')

const standard = readWorkspace('src/lib/standardRecognition.ts')
const recognition = readWorkspace('src/lib/recognition.ts')
const database = readApp('src/lib/handwritingDb.ts')
const board = readApp('src/components/DrawingBoard.tsx')
const glyphenWerk = readWorkspace('src/App.tsx')

assert.match(standard, /createStandardRecognitionSamples/u)
assert.match(standard, /STANDARD_RECOGNITION_SESSION/u)
assert.match(standard, /hershey\/src\/rowmans\.js/u)
assert.match(standard, /connectedHersheyPaths/u)
assert.match(recognition, /connectedTextSegmentationHypotheses/u)
assert.match(recognition, /PERSONAL_SAMPLE_DISTANCE_BONUS/u)
assert.match(recognition, /blendVectors/u)
for (const labelId of [
  'digit_7',
  'operator_integral',
  'operator_sqrt',
  'operator_sum',
  'relation_equal',
  'operator_divide',
]) {
  assert.match(standard, new RegExp(`${labelId}:`), `Standardvorlage fehlt: ${labelId}`)
}
assert.match(recognition, /STANDARD_WEIGHTS/u)
assert.match(recognition, /training\.standard \? STANDARD_WEIGHTS : weights/u)
assert.match(recognition, /personalEntries\.length >= 4/u)
assert.match(database, /createStandardRecognitionSamples\(BASE_CATALOG\)/u)
assert.match(database, /buildRecognitionModel\(\[\.\.\.samples, \.\.\.baselineSamples\]\)/u)
assert.match(database, /baselineSampleCount/u)
assert.match(database, /modelClassCount/u)
assert.doesNotMatch(board, /Importiere zuerst dein GlyphenWerk-Training, damit FaNotes den Rechenweg lesen kann/u)
assert.doesNotMatch(board, /Importiere zuerst dein GlyphenWerk-Training, damit die lokale Erkennung deine Handschrift kennt/u)
assert.match(board, /Standardmodell aktiv/u)
assert.match(board, /Korrektur sofort gelernt/u)
assert.match(board, /learnFromRecognitionCorrection\(\s*\[sourceToken\]/u)
assert.match(glyphenWerk, /Standardmodell aktiv · Training optional/u)
assert.match(glyphenWerk, /Sofort bereit, passt sich dir an/u)

console.log('Standarderkennung geprüft: Offline-Basismodell, Text-/Mathematikvorlagen, Personalisierungs-Priorität und Oberfläche sind verbunden.')
