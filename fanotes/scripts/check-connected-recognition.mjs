import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(appRoot, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-connected-recognition-'))
const output = path.join(temporary, 'dist')
const profile = path.join(temporary, 'chromium')

try {
  await build({
    root: workspaceRoot,
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(appRoot, 'scripts/fixtures/connected-recognition-harness.ts'),
        formats: ['es'],
        fileName: () => 'harness.js',
      },
    },
  })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><body><script type="module" src="./harness.js"></script></body></html>')
  const chromium = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--js-flags=--max-old-space-size=${process.env.FANOTES_TEST_HEAP_MB || '768'}`,
    '--allow-file-access-from-files', `--user-data-dir=${profile}`, '--virtual-time-budget=30000',
    '--dump-dom', pathToFileURL(path.join(output, 'index.html')).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  chromium.stdout.on('data', (chunk) => { stdout += chunk })
  chromium.stderr.on('data', (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolve) => chromium.on('close', resolve))
  assert.equal(exitCode, 0, `Chromium konnte die Erkennungsprüfung nicht ausführen: ${stderr}`)
  const error = /<pre id="error">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.equal(error, undefined, error)
  const encoded = /<pre id="result">([\s\S]*?)<\/pre>/u.exec(stdout)?.[1]
  assert.ok(encoded, `Kein Ergebnis der verbundenen Erkennung: ${stdout.slice(-1000)}`)
  const result = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&amp;', '&'))
  if (process.env.FANOTES_SEGMENTATION_DEBUG === '1') console.log(JSON.stringify({
    continuousGuidedPairs: result.continuousGuidedPairs,
    delayedAccessoryPair: result.delayedAccessoryPair,
    delayedOverhangingT: result.delayedOverhangingT,
  }, null, 2))
  assert.equal(result.baseClusterCount, 1, 'Der verbundene Teststrich muss zunächst als eine physische Komponente vorliegen.')
  assert.ok(result.hypothesisSizes.includes(4), `Die Vier-Buchstaben-Hypothese fehlt: ${JSON.stringify({ sizes: result.hypothesisSizes, bounds: result.baseStrokeBounds, cuts: result.baseCutCandidates })}`)
  assert.ok(result.baselineTokenCount >= 3, `Das Standardmodell muss verbundene Tinte ohne Training auftrennen: ${JSON.stringify(result)}`)
  assert.ok(
    result.reusedIdFeatureDistance > 0.02,
    `Ein neu importiertes Trainingsbeispiel mit wiederverwendeter ID darf nicht die alte Form aus dem Feature-Cache behalten: ${result.reusedIdFeatureDistance}`,
  )
  assert.equal(
    result.correctionResegmentationCount,
    4,
    'Eine bestätigte Vier-Buchstaben-Korrektur muss auch dann vier Trainingszeichen erzeugen, wenn die vorherige Erkennung das Wort zusammengezogen hat.',
  )
  assert.deepEqual(
    result.normalTMathLabels,
    ['latin_upper_T'],
    `Ein normales zweistrichiges T darf selbst im Mathematikpfad niemals als Integral erscheinen: ${JSON.stringify(result.normalTMathLabels)}`,
  )
  assert.equal(result.normalTAutomatic.mode, 'text', `Die automatische Erkennung muss ein einzelnes normales T als Text wählen: ${JSON.stringify(result.normalTAutomatic)}`)
  assert.equal(result.normalTAutomatic.value, 'T')
  assert.deepEqual(result.normalTAutomatic.labels, ['latin_upper_T'])
  assert.equal(result.correctedTAutomatic.mode, 'text', 'Ein bestätigtes und trainiertes T muss auch bei Mathematik als vorherigem Modus T bleiben.')
  assert.equal(result.correctedTAutomatic.value, 'T')
  assert.deepEqual(result.correctedTAutomatic.labels, ['latin_upper_T'])
  assert.equal(
    result.wideTWithCloseE.baseClusters,
    1,
    `Der harte T-Fall muss Querstrich, Stamm und direkt folgenden Buchstaben zunächst als eine physische Komponente abbilden: ${JSON.stringify(result.wideTWithCloseE)}`,
  )
  assert.ok(
    result.wideTWithCloseE.twoPartHypotheses > 0,
    `Für T plus Folgebuchstaben fehlt der Zwei-Zeichen-Pfad: ${JSON.stringify(result.wideTWithCloseE)}`,
  )
  assert.equal(
    result.wideTWithCloseE.completeTopBarHypotheses,
    result.wideTWithCloseE.twoPartHypotheses,
    `Der obere T-Strich wurde in mindestens einer Segmentierung abgeschnitten oder als eigenes Zeichen behandelt: ${JSON.stringify(result.wideTWithCloseE)}`,
  )
  assert.equal(result.wideTWithCloseE.tokenCount, 2, `T und Folgebuchstabe wurden zusammengezogen: ${JSON.stringify(result.wideTWithCloseE)}`)
  assert.equal(result.wideTWithCloseE.selectedTopBarComplete, true, `Die gewählte Erkennung hat den T-Querstrich beschädigt: ${JSON.stringify(result.wideTWithCloseE)}`)
  assert.equal(result.wideTWithCloseE.value.toLocaleLowerCase('de'), 'te', `Der geschützte T-Fall wird nicht als Te gelesen: ${JSON.stringify(result.wideTWithCloseE)}`)
  assert.equal(result.conflictResolvedT.mode, 'text', 'Die neueste explizite Korrektur muss ein exakt widersprüchliches altes Label dauerhaft überstimmen.')
  assert.equal(result.conflictResolvedT.value, 'T')
  assert.deepEqual(result.conflictResolvedT.labels, ['latin_upper_T'])
  assert.equal(result.conflictResolvedT.staleWrongExamples, 0, 'Ein exakt identischer, veralteter Fehl-Trainingsdatensatz darf nicht weiter im Modell abstimmen.')
  assert.ok(
    result.realDoubleIntegralLabels.includes('operator_double_integral') ||
      result.realDoubleIntegralLabels.filter((label) => label === 'operator_integral').length === 2,
    `Ein echtes Doppelintegral muss weiterhin als Integralstruktur lesbar bleiben: ${JSON.stringify(result.realDoubleIntegralLabels)}`,
  )
  if (process.env.FANOTES_RECOGNITION_DEBUG === '1') console.log(JSON.stringify(result.zeroShotIsolated))
  if (process.env.FANOTES_RECOGNITION_DEBUG === '1') console.log(JSON.stringify(result.zeroShotWords.map((entry) => ({
    expected: entry.expected,
    recognized: entry.recognized,
    tokens: entry.tokens.map((token) => `${token.char}:${token.confidence.toFixed(3)} [${token.alternatives.slice(0, 6).map((alternative) => `${alternative.char}:${alternative.confidence.toFixed(3)}`).join(' ')}]`),
  })), null, 2))
  if (process.env.FANOTES_RECOGNITION_DEBUG === '1') console.log(JSON.stringify({
    baselineSentenceAutomatic: result.baselineSentenceAutomatic,
    baselineDottedSentenceAutomatic: result.baselineDottedSentenceAutomatic,
    automaticTextCases: result.automaticTextCases,
    incrementalTextCases: result.incrementalTextCases,
    rapidClosePairs: result.rapidClosePairs,
    continuousGuidedPairs: result.continuousGuidedPairs,
    delayedAccessoryPair: result.delayedAccessoryPair,
    delayedOverhangingT: result.delayedOverhangingT,
    realDoubleIntegralAutomatic: result.realDoubleIntegralAutomatic,
    personalSentenceAutomatic: result.largePersonalBenchmark.sentenceAutomatic,
  }, null, 2))
  assert.deepEqual(result.zeroShotIsolated.map((entry) => entry.recognized), result.zeroShotIsolated.map((entry) => entry.expected), `Das Standardmodell muss einzelne Handschriftzeichen ohne Training lesen: ${JSON.stringify(result.zeroShotIsolated)}`)
  assert.deepEqual(result.zeroShotWords.map((entry) => entry.recognized), result.zeroShotWords.map((entry) => entry.expected), `Das Standardmodell muss häufige verbundene Wörter ohne Training lesen: ${JSON.stringify(result.zeroShotWords)}`)
  assert.equal(
    result.baselineSentenceAutomatic.mode,
    'text',
    `Ein normaler deutscher Satz darf im automatischen GlyphenWerk-Test nicht als Mathematik erscheinen: ${JSON.stringify(result.baselineSentenceAutomatic)}`,
  )
  assert.equal(
    result.baselineDottedSentenceAutomatic.mode,
    'text',
    `i-Punkte und unterschiedliche Buchstabenhöhen dürfen einen Textsatz nicht in eine Formel verwandeln: ${JSON.stringify(result.baselineDottedSentenceAutomatic)}`,
  )
  assert.ok(
    result.automaticTextCases.every((entry) => entry.mode === 'text'),
    `Deutsche und englische Textfolgen werden fälschlich als Mathematik erkannt: ${JSON.stringify(result.automaticTextCases)}`,
  )
  assert.ok(
    result.automaticTextInkCases.every((entry) => entry.mode === 'text'),
    `Text mit Zahlen oder mehreren physischen Zeilen wird fälschlich als Mathematik erkannt: ${JSON.stringify(result.automaticTextInkCases)}`,
  )
  assert.ok(
    result.automaticMathModeMatrix.every((entry) => entry.mode === 'math'),
    `Echte mathematische Strukturen werden fälschlich als Text erkannt: ${JSON.stringify(result.automaticMathModeMatrix)}`,
  )
  assert.deepEqual(
    result.incrementalTextCases.map((entry) => ({ mode: entry.mode, value: entry.value.toLocaleLowerCase('de') })),
    result.incrementalTextCases.map((entry) => ({ mode: 'text', value: entry.expected })),
    `Beim Anhängen eines Buchstabens darf eine stabile Textfolge nicht vorübergehend zu ∞, ∫ oder einem anderen Mathematiksymbol kollabieren: ${JSON.stringify(result.incrementalTextCases)}`,
  )
  assert.ok(
    result.rapidClosePairs.every((entry) => entry.mode === 'text' && entry.tokenCount === 2),
    `Zwei schnell geschriebene, leicht überlappende Buchstabenkörper dürfen nicht zu einem Einzelglyph oder Mathematiksymbol kollabieren: ${JSON.stringify(result.rapidClosePairs)}`,
  )
  assert.deepEqual(
    result.rapidClosePairs
      .filter((entry) => entry.expected === 'te' || entry.expected === 'st')
      .map((entry) => entry.value.toLocaleLowerCase('de')),
    ['te', 'st'],
    `Die kontrollierten eng geschriebenen Buchstabenpaare müssen vollständig gelesen werden: ${JSON.stringify(result.rapidClosePairs)}`,
  )
  assert.equal(
    result.incrementalTextRecovery.mode,
    'text',
    `Ein weiterer Strich desselben Buchstabens muss nach einem vorübergehenden Mathematikmodus wieder zur stabilen Textfolge zurückfinden: ${JSON.stringify(result.incrementalTextRecovery)}`,
  )
  assert.equal(result.incrementalTextRecovery.value.toLocaleLowerCase('de'), 'te')
  assert.equal(
    result.realDoubleIntegralAutomatic.mode,
    'math',
    `Die inkrementelle Text-Hysterese darf ein echtes Doppelintegral nicht überschreiben: ${JSON.stringify(result.realDoubleIntegralAutomatic)}`,
  )
  assert.equal(
    result.largePersonalBenchmark.sentenceAutomatic.mode,
    'text',
    `Ein großes persönliches Modell darf einen Textsatz nicht in den Mathematikmodus kippen: ${JSON.stringify(result.largePersonalBenchmark.sentenceAutomatic)}`,
  )
  assert.equal(
    result.automaticEquation.mode,
    'math',
    `Die stärkere Satzabsicherung darf eine echte Gleichung nicht als Text behandeln: ${JSON.stringify(result.automaticEquation)}`,
  )
  if (process.env.FANOTES_RECOGNITION_DEBUG === '1') console.log(JSON.stringify(result.zeroShotMath, null, 2))
  assert.deepEqual(result.zeroShotMath.map((entry) => entry.recognized), result.zeroShotMath.map((entry) => [entry.expected]), `Das Standardmodell muss Ziffern und Mathematiksymbole ohne Training lesen: ${JSON.stringify(result.zeroShotMath)}`)
  assert.equal(result.personalMathBenchmark.suppliedSamples, 216)
  assert.equal(result.personalMathBenchmark.retainedSamples, 216)
  assert.deepEqual(
    result.personalMathBenchmark.holdouts.map((entry) => entry.recognized),
    result.personalMathBenchmark.holdouts.map((entry) => [entry.expected]),
    `Persönlich trainierte Mathematikformen versagen auf verzerrten Holdouts: ${JSON.stringify(result.personalMathBenchmark)}`,
  )
  assert.equal(result.zeroShotStructures.radical, '\\sqrt{7}', `Die untrainierte Engine muss eine Ziffer innerhalb der Wurzel gruppieren: ${JSON.stringify(result.zeroShotStructures)}`)
  assert.equal(result.zeroShotStructures.fraction, '\\frac{2}{3}', `Die untrainierte Engine muss echte Bruchlayouts erkennen: ${JSON.stringify(result.zeroShotStructures)}`)
  assert.equal(result.personalValue.toLocaleLowerCase('de'), 'test', `Drei einzelne Trainingsbeispiele müssen das verbundene Wort erkennen: ${JSON.stringify(result)}`)
  assert.equal(result.personalTokenCount, 4)
  assert.equal(result.densePersonalValue.toLocaleLowerCase('de'), 'test', 'Viele persönliche Varianten müssen als robuste Stilklasse erhalten bleiben.')
  assert.equal(
    result.compressedNeuralGuidance.guided.toLocaleLowerCase('de'),
    'test',
    `Der Zeilenmodell-Hinweis muss auch bei irreführend schmaler verbundener Schrift exakt vier persönliche Zeichen ausrichten: ${JSON.stringify(result.compressedNeuralGuidance)}`,
  )
  assert.equal(result.compressedNeuralGuidance.guidedTokenCount, 4)
  assert.ok(result.compressedNeuralGuidance.preferredHypothesisSizes.includes(4))
  assert.equal(
    result.personalizedFusion.text.toLocaleLowerCase('de'),
    'test',
    `Das generische Zeilenmodell darf ein stark persönlich trainiertes e nicht wieder zu o überschreiben: ${JSON.stringify(result.personalizedFusion)}`,
  )
  assert.ok(result.personalizedFusion.personalizedCharacters >= 1, 'Die Sequenzfusion hat keine persönliche Zeichenevidenz verwendet.')
  assert.equal(result.largePersonalBenchmark.suppliedSamples, 1001, 'Der große Personalisierungstest enthält nicht die verlangten rund 1000 Beispiele.')
  assert.equal(
    result.largePersonalBenchmark.retainedSamples,
    1001,
    'Die Engine darf bei einem ausgewogenen Datensatz keine persönlichen Beispiele mehr bei 60 pro Klasse abschneiden.',
  )
  assert.equal(
    result.largePersonalBenchmark.classifierSamples,
    624,
    'Die vollständige Trainingshistorie muss erhalten bleiben, während die Laufzeitklassifikation pro Klasse einen diversen repräsentativen Satz verwendet.',
  )
  assert.equal(result.largePersonalBenchmark.prototypeClasses, 13)
  assert.ok(result.largePersonalBenchmark.evaluatedSamples >= 50, 'Die Gewichtsauswahl des 1001-Sample-Modells wurde nicht klassenbalanciert geprüft.')
  assert.ok(result.largePersonalBenchmark.estimatedAccuracy >= 95, `Die adaptiven Gewichte verschlechtern den internen Holdout: ${JSON.stringify(result.largePersonalBenchmark)}`)
  if (process.env.FANOTES_RECOGNITION_DEBUG === '1') console.log(JSON.stringify({
    ...result.largePersonalBenchmark,
    words: result.largePersonalBenchmark.words.map((entry) => ({
      expected: entry.expected,
      recognized: entry.recognized,
      durationMs: entry.durationMs,
      tokens: entry.tokens.map((token) => `${token.char}:${token.confidence}/${token.personalConfidence}@${token.bbox[0].toFixed(3)}+${token.bbox[2].toFixed(3)}`),
    })),
  }, null, 2))
  assert.deepEqual(
    result.largePersonalBenchmark.words.map((entry) => entry.recognized),
    result.largePersonalBenchmark.words.map((entry) => entry.expected),
    `Das Modell mit rund 1000 Beispielen versagt auf verbundenen Holdout-Wörtern: ${JSON.stringify(result.largePersonalBenchmark)}`,
  )
  assert.equal(
    result.largePersonalBenchmark.integratedFusion.text.toLocaleLowerCase('de'),
    'test',
    `Der sichtbare GlyphenWerk/FaNotes-Sequenzpfad muss trotz eines falschen generischen Drei-Zeichen-Ergebnisses die rund 1000 persönlichen Beispiele verwenden: ${JSON.stringify({ fusion: result.largePersonalBenchmark.integratedFusion, tokens: result.largePersonalBenchmark.integratedTokens })}`,
  )
  assert.ok(
    result.largePersonalBenchmark.integratedFusion.personalizedCharacters >= 3,
    'Der integrierte Sequenzpfad hat die persönliche Zeichenevidenz nicht tatsächlich verwendet.',
  )
  if (process.env.FANOTES_SKIP_PERFORMANCE_ASSERT !== '1') {
    assert.ok(
      result.largePersonalBenchmark.words.every((entry) => entry.durationMs < 1_800),
      `Die persönliche Erkennung wird mit rund 1000 Beispielen zu langsam: ${JSON.stringify(result.largePersonalBenchmark.words.map((entry) => ({ word: entry.expected, durationMs: entry.durationMs })))}`,
    )
  }
  assert.deepEqual(
    result.largePersonalBenchmark.letters.map((entry) => entry.recognized),
    result.largePersonalBenchmark.letters.map((entry) => entry.expected),
    `Das Modell mit rund 1000 Beispielen versagt auf deutlich verzerrten Holdout-Zeichen: ${JSON.stringify(result.largePersonalBenchmark)}`,
  )
  assert.equal(
    result.personalizedAppearanceValue.toLocaleLowerCase('de'),
    'a',
    'Ein nahes persönliches Trainingsbeispiel muss gegenüber der generischen Standardform leicht bevorzugt werden.',
  )
  assert.equal(
    result.weakPersonalFusion.text.toLocaleLowerCase('de'),
    'c',
    'Ein einziges schwaches persönliches Beispiel darf ein sehr sicheres Zeilenmodell nicht blind überstimmen.',
  )
  assert.equal(
    result.germanSpecialFusion.text,
    'ü',
    'Das kompakte ASCII-Zeilenmodell darf eine starke geometrische Umlaut-Erkennung nicht zu u abflachen.',
  )
  assert.equal(
    result.noisyPersonalValue.toLocaleLowerCase('de'),
    'a',
    `Eine mit alten Fehl-Labels verunreinigte Klasse darf eine konsistente persönliche a-Klasse nicht überstimmen: ${JSON.stringify(result.noisyPersonalStats)}`,
  )
  assert.ok(
    result.noisyPersonalStats.a.reliability > result.noisyPersonalStats.o.reliability,
    `Die klassenweise Zuverlässigkeit erkennt die verunreinigte o-Klasse nicht: ${JSON.stringify(result.noisyPersonalStats)}`,
  )
  assert.deepEqual(result.personalPrototypeLabels.sort(), ['latin_lower_e', 'latin_lower_s', 'latin_lower_t'])
  assert.deepEqual(result.wideLetterHypotheses, [1], 'Ein einzelner breiter Buchstabe darf nicht künstlich getrennt werden.')
  assert.equal(result.dottedIClusterCount, 1, 'Der getrennt geschriebene i-Punkt muss mit seinem Stamm gruppiert werden.')
  assert.equal(result.detachedExitClusterCount, 1, 'Ein kurzer, getrennt gesetzter Anschlussstrich rechts am Buchstaben muss zum Buchstaben gehören.')
  assert.equal(result.detachedExitValue.toLocaleLowerCase('de'), 'a', 'Das a mit getrenntem Anschlussstrich muss weiterhin als einzelnes a gelesen werden.')
  assert.equal(result.mathLineCount, 2, 'Mehrzeilige Mathematik muss in zwei räumliche Rechenzeilen getrennt werden.')
  assert.equal(
    result.multiLineMath.replace(/\s+/gu, ''),
    '\\begin{aligned}1+2\\\\3=3\\end{aligned}',
    `Mehrzeilige Mathematik muss als ausgerichtete Formel formatiert werden: ${result.multiLineMath}`,
  )
  assert.equal(result.integralLimitLineCount, 1, 'Integralgrenzen dürfen nicht als separate Textzeilen abgetrennt werden.')
  assert.match(result.integralWithLimits, /\\int/u, `Das Integralzeichen wurde nicht stabil erkannt: ${result.integralWithLimits}`)
  assert.match(result.integralWithLimits, /_\{1\}/u, `Die untere Integralgrenze fehlt: ${result.integralWithLimits}`)
  assert.match(result.integralWithLimits, /\^\{5\}/u, `Die obere Integralgrenze fehlt: ${result.integralWithLimits}`)
  assert.equal(result.sumLimitLineCount, 1, 'Summengrenzen dürfen nicht als separate Textzeilen abgetrennt werden.')
  assert.match(result.sumWithLimits, /\\sum/u, `Das Summenzeichen wurde nicht stabil erkannt: ${result.sumWithLimits}`)
  assert.match(result.sumWithLimits, /_\{1\}/u, `Die untere Summengrenze fehlt: ${result.sumWithLimits}`)
  assert.match(result.sumWithLimits, /\^\{5\}/u, `Die obere Summengrenze fehlt: ${result.sumWithLimits}`)
  assert.equal(result.productLimitLineCount, 1, 'Produktgrenzen dürfen nicht als separate Textzeilen abgetrennt werden.')
  assert.match(result.productWithLimits, /\\prod/u, `Das Produktzeichen wurde nicht stabil erkannt: ${result.productWithLimits}`)
  assert.match(result.productWithLimits, /_\{1\}/u, `Die untere Produktgrenze fehlt: ${result.productWithLimits}`)
  assert.match(result.productWithLimits, /\^\{5\}/u, `Die obere Produktgrenze fehlt: ${result.productWithLimits}`)
  assert.ok(
    result.tripleIntegralLabels.includes('operator_triple_integral')
      || result.tripleIntegralLabels.filter((label) => label === 'operator_integral').length === 3,
    `Drei echte Integralzüge müssen als Dreifachintegral erhalten bleiben: ${JSON.stringify(result.tripleIntegralLabels)}`,
  )
  assert.match(result.tripleIntegral, /\\iiint|\\int.*\\int.*\\int/u, `Das Dreifachintegral wird nicht korrekt formatiert: ${result.tripleIntegral}`)
  assert.equal(result.ordinaryScriptLineCount, 1, 'Hoch- und Tiefstellungen dürfen nicht als getrennte Rechenzeilen enden.')
  assert.match(result.ordinaryScripts, /2/u, `Die Basis der Hoch-/Tiefstellung fehlt: ${JSON.stringify({ latex: result.ordinaryScripts, tokens: result.ordinaryScriptTokens })}`)
  assert.match(result.ordinaryScripts, /_\{4\}/u, `Der normale Tiefindex fehlt: ${result.ordinaryScripts}`)
  assert.match(result.ordinaryScripts, /\^\{3\}/u, `Der normale Hochindex fehlt: ${result.ordinaryScripts}`)
  assert.ok(result.standardCount > 300, 'Das erweiterte sofort nutzbare Standardmodell ist unvollständig.')
  console.log(`Erkennung geprüft: zero-shot ${result.zeroShotIsolated.length} Einzelbuchstaben, ${result.zeroShotWords.map((entry) => entry.recognized).join('/')}, ${result.zeroShotMath.length} Ziffern/Mathematiksymbole, ${result.zeroShotStructures.radical}, ${result.zeroShotStructures.fraction}; personalisiert ${result.largePersonalBenchmark.suppliedSamples} Text- und ${result.personalMathBenchmark.suppliedSamples} Mathematikbeispiele mit Holdouts, Rauschunterdrückung und Sequenzfusion.`)
  if (process.env.FANOTES_RECOGNITION_DEBUG === '1') console.log(JSON.stringify(result.baselineTokens, null, 2))
} finally {
  fs.rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 100,
  })
}
