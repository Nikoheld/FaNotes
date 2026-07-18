import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { applyTextReranking, recognizedSentence } = await server.ssrLoadModule('/../src/lib/recognition.ts')
  const {
    fusePersonalizedTextRecognition,
    personalizedTextFusionSelectionScore,
  } = await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts')
  const {
    applyFinalNeuralWordContext,
    applyMeasuredNeuralWordContext,
    applyNeuralWordContext,
    installNeuralWordContextCandidates,
    isExtendedNeuralContextWord,
  } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const {
    assessNeuralTextModeCandidate,
    hasDecisiveMathLayout,
    hasStrongPersonalizedTextEvidence,
    hasStrongNeuralWordEvidence,
    neuralTextMayOverrideAutomaticMode,
  } = await server.ssrLoadModule('/src/lib/recognitionModeSelection.ts')
  const { BASE_CATALOG } = await server.ssrLoadModule('/../src/data/catalog.ts')
  const labelByChar = new Map(BASE_CATALOG.map((label) => [label.char, label]))

  const orderedDictionaryProbe = ['abend', 'test', 'zebra', 'äpfel', 'über']
  installNeuralWordContextCandidates('de', orderedDictionaryProbe)
  orderedDictionaryProbe.forEach((word) => assert.equal(
    isExtendedNeuralContextWord(word, 'de'),
    true,
    `Die Binärsuche muss ${word} auch über die Umlautgrenze hinweg im exakt gleich sortierten Index finden.`,
  ))

  const token = (char, confidence, alternatives, index, bbox = [0.05 + index * 0.055, 0.2, 0.05, 0.1]) => {
    const label = labelByChar.get(char)
    assert.ok(label, `Testzeichen fehlt im Katalog: ${char}`)
    return {
      id: `token-${index}`,
      strokes: [],
      imageData: '',
      bbox,
      labelId: label.id,
      char: label.char,
      name: label.name,
      latex: label.latex,
      confidence,
      alternatives: alternatives.map(([alternativeChar, alternativeConfidence]) => {
        const alternative = labelByChar.get(alternativeChar)
        assert.ok(alternative, `Alternativzeichen fehlt im Katalog: ${alternativeChar}`)
        return {
          labelId: alternative.id,
          char: alternative.char,
          name: alternative.name,
          confidence: alternativeConfidence,
        }
      }),
      visualLabelId: label.id,
      visualConfidence: confidence,
    }
  }

  const ambiguousTest = [
    token('T', 95, [['T', 95]], 0),
    token('o', 58, [['o', 58], ['e', 54]], 1),
    token('s', 94, [['s', 94]], 2),
    token('t', 93, [['t', 93]], 3),
  ]
  const german = applyTextReranking(ambiguousTest, BASE_CATALOG, 'de')
  assert.equal(recognizedSentence(german), 'Test', 'Der deutsche Wortkontext muss Test gegenüber Tost bevorzugen.')
  assert.equal(german[1].context?.changed, true)
  assert.equal(german[1].context?.knownWord, true)
  assert.equal(german[1].context?.autoLearn, true, 'Eine visuell plausible, eindeutige Kontextkorrektur soll lernbar sein.')
  assert.ok(german[1].context.scoreMargin >= 0.5)

  const english = applyTextReranking(ambiguousTest, BASE_CATALOG, 'en')
  assert.equal(recognizedSentence(english), 'Test', 'Der englische Wortkontext muss denselben mehrdeutigen Fall lösen.')

  const visuallyImplausible = [
    token('T', 95, [['T', 95]], 0),
    token('o', 66, [['o', 66], ['e', 20]], 1),
    token('s', 94, [['s', 94]], 2),
    token('t', 93, [['t', 93]], 3),
  ]
  const guarded = applyTextReranking(visuallyImplausible, BASE_CATALOG, 'de')
  assert.equal(recognizedSentence(guarded), 'Tost', 'Der Wortkontext darf eine visuell unplausible Alternative nicht erzwingen.')
  assert.equal(guarded.some((entry) => entry.context?.autoLearn), false, 'Ein unbekanntes Wort darf keine Pseudo-Labels erzeugen.')

  const shortUnknown = [
    token('a', 82, [['a', 82], ['o', 67]], 0),
    token('c', 69, [['c', 69], ['n', 64]], 1),
  ]
  assert.equal(
    recognizedSentence(applyTextReranking(shortUnknown, BASE_CATALOG, 'de')),
    'ac',
    'Ein starkes Zwei-Zeichen-Wörterbuchprior darf ein sichtbar besseres c nicht zu n und damit ac zu an umschreiben.',
  )

  const shortDoubleRewrite = [
    token('o', 80, [['o', 80], ['a', 74]], 0),
    token('s', 58, [['s', 58], ['n', 44]], 1),
  ]
  assert.equal(
    recognizedSentence(applyTextReranking(shortDoubleRewrite, BASE_CATALOG, 'de')),
    'os',
    'Ein kurzes bekanntes Wort darf niemals durch den Austausch beider sichtbaren Buchstaben entstehen.',
  )

  const unknown = [
    token('Q', 96, [['Q', 96]], 0),
    token('z', 95, [['z', 95]], 1),
    token('x', 94, [['x', 94]], 2),
  ]
  const unknownResult = applyTextReranking(unknown, BASE_CATALOG, 'de')
  assert.equal(unknownResult.some((entry) => entry.context?.autoLearn), false)

  const fabio = [
    token('F', 72, [['F', 72], ['t', 69]], 0, [0.05, 0.14, 0.05, 0.16]),
    token('a', 84, [['a', 84]], 1),
    token('b', 86, [['b', 86]], 2),
    token('i', 72, [['i', 72], ['o', 69]], 3),
    token('o', 88, [['o', 88]], 4),
  ]
  assert.equal(
    recognizedSentence(applyTextReranking(fabio, BASE_CATALOG, 'de')),
    'Fabio',
    'Der deutsche Wortstrahl darf einen visuell gross geschriebenen unbekannten Namen nicht zu einem Wörterbuchfragment umformen.',
  )
  assert.equal(
    recognizedSentence(applyTextReranking(fabio, BASE_CATALOG, 'en')),
    'Fabio',
    'Der englische Wortstrahl darf einen visuell gross geschriebenen unbekannten Namen nicht zu einem Wörterbuchfragment umformen.',
  )
  for (const language of ['de', 'en']) {
    const names = 'Fabio Niko Livia Aylin Marco Tobias'
    assert.equal(applyNeuralWordContext(names, language), names)
    assert.equal(applyFinalNeuralWordContext(names, language), names)
  }

  const caseAware = [
    token('t', 76, [['t', 76], ['T', 74]], 0, [0.05, 0.14, 0.05, 0.16]),
    token('e', 91, [['e', 91]], 1),
    token('s', 92, [['s', 92]], 2),
    token('t', 92, [['t', 92]], 3),
  ]
  assert.equal(
    recognizedSentence(applyTextReranking(caseAware, BASE_CATALOG, 'de')),
    'Test',
    'Zeichenhöhe und Wortposition müssen Gross- und Kleinbuchstaben auseinanderhalten.',
  )

  const internalCaseAware = [...'fensTer'].map((char, index) => token(
    char,
    char === 'T' ? 78 : 82,
    char === 'T' ? [['T', 78], ['t', 68]] : [[char, 82]],
    index,
  ))
  assert.equal(
    recognizedSentence(applyTextReranking(internalCaseAware, BASE_CATALOG, 'de')),
    'fenster',
    'Ein höhengleicher innerer Buchstabe muss bei einer nahen Kleinbuchstabenform klein bleiben.',
  )

  const lowLine = [
    token('a', 90, [['a', 90]], 0),
    token('−', 70, [['−', 70], ['_', 70]], 1, [0.105, 0.294, 0.05, 0.006]),
    token('b', 90, [['b', 90]], 2),
  ]
  assert.equal(
    recognizedSentence(applyTextReranking(lowLine, BASE_CATALOG, 'de')),
    'a_b',
    'Ein Strich an der Grundlinie muss als Unterstrich gelesen werden.',
  )
  const centeredLine = [
    token('a', 90, [['a', 90]], 0),
    token('_', 70, [['_', 70], ['−', 70]], 1, [0.105, 0.247, 0.05, 0.006]),
    token('b', 90, [['b', 90]], 2),
  ]
  assert.equal(
    recognizedSentence(applyTextReranking(centeredLine, BASE_CATALOG, 'de')),
    'a-b',
    'Ein mittiger Strich muss als Binde-/Minusstrich gelesen werden.',
  )

  const multipleLines = [
    token('H', 94, [['H', 94]], 0, [0.05, 0.12, 0.05, 0.14]),
    token('a', 94, [['a', 94]], 1, [0.105, 0.15, 0.05, 0.1]),
    token('l', 94, [['l', 94]], 2, [0.16, 0.15, 0.04, 0.1]),
    token('l', 94, [['l', 94]], 3, [0.205, 0.15, 0.04, 0.1]),
    token('o', 94, [['o', 94]], 4, [0.25, 0.15, 0.05, 0.1]),
    token('T', 94, [['T', 94]], 5, [0.05, 0.5, 0.05, 0.14]),
    token('e', 94, [['e', 94]], 6, [0.105, 0.53, 0.05, 0.1]),
    token('s', 94, [['s', 94]], 7, [0.16, 0.53, 0.05, 0.1]),
    token('t', 94, [['t', 94]], 8, [0.215, 0.53, 0.05, 0.1]),
  ]
  assert.equal(
    recognizedSentence(applyTextReranking(multipleLines, BASE_CATALOG, 'de')),
    'Hallo\nTest',
    'Mehrere physische Textzeilen müssen in der richtigen Lesereihenfolge erhalten bleiben.',
  )

  const narrowConnectedWord = [...'lernen'].map((char, index) => (
    token(char, 96, [[char, 96]], index, [0.05 + index * 0.043, 0.22, 0.024, 0.1])
  ))
  assert.equal(
    recognizedSentence(applyTextReranking(narrowConnectedWord, BASE_CATALOG, 'de')),
    'lernen',
    'Gleichmässig eng geschriebene schmale Buchstaben dürfen keine künstlichen Wortabstände erzeugen.',
  )

  const anomalousIntraWordGap = [...'lernen'].map((char, index) => {
    const x = index < 3
      ? 0.05 + index * 0.031
      : 0.05 + index * 0.031 + 0.021
    return token(char, 96, [[char, 96]], index, [x, 0.22, 0.026, 0.1])
  })
  assert.equal(
    recognizedSentence(applyTextReranking(anomalousIntraWordGap, BASE_CATALOG, 'de')),
    'lernen',
    'Ein einzelner grösserer Buchstabenabstand innerhalb eines bekannten Wortes darf nicht als Leerzeichen enden.',
  )

  const compactTwoWords = [...'hallotest'].map((char, index) => {
    const x = 0.05 + index * 0.071 + (index >= 5 ? 0.029 : 0)
    return token(char, 97, [[char, 97]], index, [x, 0.22, 0.066, 0.1])
  })
  assert.equal(
    recognizedSentence(applyTextReranking(compactTwoWords, BASE_CATALOG, 'de')),
    'hallo test',
    'Ein lokaler Abstandssprung muss auch zwischen breiten Buchstaben als Wortgrenze erkannt werden.',
  )

  const neuralLine = (text, confidence = 88) => {
    let pendingSpace = false
    const visible = []
    Array.from(text).forEach((char) => {
      if (/\s/u.test(char)) {
        pendingSpace = visible.length > 0
        return
      }
      visible.push({ char, spaceBefore: pendingSpace })
      pendingSpace = false
    })
    return {
      text,
      rawText: text,
      confidence,
      bbox: [0.05, 0.2, 0.7, 0.12],
      characters: visible.map((entry, index) => ({
        ...entry,
        confidence,
        start: index / Math.max(1, visible.length),
        end: (index + 1) / Math.max(1, visible.length),
      })),
    }
  }
  const neuralResult = (text, confidence = 88) => ({
    text,
    confidence,
    engine: 'trocr-bilingual',
    lines: [neuralLine(text, confidence)],
  })
  const cleanPersonalWordScore = personalizedTextFusionSelectionScore({
    text: 'mathe',
    confidence: 71,
    source: 'personalized',
    personalizedCharacters: 5,
    neuralCharacters: 0,
    classicalCharacters: 0,
    unsupportedChanges: 4,
  }, neuralResult('münt', 71), 'de')
  const partialWordWithDebrisScore = personalizedTextFusionSelectionScore({
    text: 'man2',
    confidence: 71,
    source: 'hybrid',
    personalizedCharacters: 3,
    neuralCharacters: 0,
    classicalCharacters: 1,
    unsupportedChanges: 1,
  }, neuralResult('münt', 71), 'de')
  assert.ok(
    cleanPersonalWordScore > partialWordWithDebrisScore,
    `Ein bekanntes Teilwort darf angehängten OCR-/Mathematikmüll nicht vor einer vollständigen persönlichen Buchstabenfolge verstecken: ${JSON.stringify({ cleanPersonalWordScore, partialWordWithDebrisScore })}`,
  )
  const oneShotGarten = [...'garten'].map((char, index) => {
    const confidence = [73, 69, 56, 74, 70, 51][index]
    const base = token(
      char,
      confidence,
      index === 0 ? [['g', 73], ['s', 55]] : [[char, confidence]],
      index,
    )
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: [30, 23, 0, 32, 25, 0][index],
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: alternative.char === char ? 1 : 0,
        personalConfidence: alternative.char === char
          ? [30, 23, 0, 32, 25, 0][index]
          : 0,
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(oneShotGarten, neuralResult('sarten', 71), 'de', 6).text,
    'garten',
    'Ein klar ausgewähltes persönliches Einmalbeispiel muss einen schwächeren gleich langen Zeilenmodell-Buchstaben korrigieren.',
  )
  const completeGartenScore = personalizedTextFusionSelectionScore({
    text: 'garten',
    confidence: 71,
    source: 'hybrid',
    personalizedCharacters: 4,
    neuralCharacters: 2,
    classicalCharacters: 0,
    unsupportedChanges: 0,
  }, neuralResult('sarten', 71), 'de')
  const mergedSagenScore = personalizedTextFusionSelectionScore({
    text: 'sagen',
    confidence: 71,
    source: 'hybrid',
    personalizedCharacters: 3,
    neuralCharacters: 0,
    classicalCharacters: 2,
    unsupportedChanges: 2,
  }, neuralResult('sarten', 71), 'de')
  assert.ok(
    completeGartenScore > mergedSagenScore,
    `Ein kürzeres bekanntes Wort darf einen vollständigen gleich langen persönlichen Buchstabenpfad nicht verdrängen: ${JSON.stringify({ completeGartenScore, mergedSagenScore })}`,
  )
  const oneShotFenster = [...'fenster'].map((char, index) => {
    const confidence = [72, 58, 77, 71, 68, 58, 89][index]
    const personalConfidence = [28, 4, 38, 26, 21, 4, 59][index]
    const base = token(char, confidence, [[char, confidence]], index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence,
      })),
    }
  })
  const oneShotFensterFusion = fusePersonalizedTextRecognition(
    oneShotFenster,
    neuralResult('heinster', 71),
    'de',
  )
  assert.equal(
    oneShotFensterFusion.text,
    'fenster',
    'Eine vollständig sichtbare, persönlich belegte unbekannte Wortform muss eine Einfügung plus Ersetzung des Zeilenmodells schlagen.',
  )
  assert.equal(
    oneShotFensterFusion.unsupportedChanges,
    0,
    'Die streng bestätigte vollständige persönliche Unbekanntwortfolge darf nicht zugleich als unbelegte Abweichung gewertet werden.',
  )
  for (const language of ['de', 'en']) {
    const visibleFabio = [...'Fabio'].map((char, index) => {
      const base = token(
        char,
        82,
        [[char, 82]],
        index,
        index === 0 ? [0.05, 0.14, 0.05, 0.16] : [0.05 + index * 0.055, 0.2, 0.05, 0.1],
      )
      return {
        ...base,
        personalSupport: 1,
        personalConfidence: 20,
        alternatives: base.alternatives.map((alternative) => ({
          ...alternative,
          personalSupport: 1,
          personalConfidence: 20,
        })),
      }
    })
    assert.equal(
      fusePersonalizedTextRecognition(visibleFabio, neuralResult('taboo', 86), language, 5).text,
      'Fabio',
      `Ein frequenzlastiges ${language}-Zeilenmodell darf den vollständig sichtbaren Eigennamen Fabio nicht zu taboo halluzinieren.`,
    )
  }
  const trainedTest = [...'Test'].map((char, index) => ({
    ...token(char, 88, [[char, 88]], index),
    personalSupport: 24,
    personalConfidence: 91,
    alternatives: token(char, 88, [[char, 88]], index).alternatives.map((alternative) => ({
      ...alternative,
      personalSupport: 24,
      personalConfidence: 91,
    })),
  }))
  const shortNeuralFusion = fusePersonalizedTextRecognition(
    trainedTest,
    neuralResult('ort', 86),
    'de',
  )
  assert.equal(
    shortNeuralFusion.text,
    'Test',
    'Vier stark trainierte persönliche Zeichen dürfen nicht auf drei generische Zeilenzeichen zusammengezogen werden.',
  )
  assert.ok(shortNeuralFusion.personalizedCharacters >= 3)

  const falseSpaceFusion = fusePersonalizedTextRecognition(
    trainedTest,
    neuralResult('Te st', 89),
    'de',
  )
  assert.equal(falseSpaceFusion.text, 'Test', 'Ein erfundener neuronaler Abstand innerhalb eines bekannten Wortes muss verschwinden.')

  const oneShotFamilie = [...'familie'].map((char, index) => {
    const confidence = [71, 59, 84, 72, 83, 72, 67][index]
    const personalConfidence = [26, 5, 49, 29, 48, 29, 19][index]
    const base = token(char, confidence, [[char, confidence]], index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence,
      })),
    }
  })
  const lengthHallucinationFusion = fusePersonalizedTextRecognition(
    oneShotFamilie,
    neuralResult('sohrsibilie', 71),
    'de',
  )
  assert.equal(
    lengthHallucinationFusion.text,
    'familie',
    'Eine vollständig persönlich belegte bekannte Sequenz muss eine unbekannte neuronale Längenhallu­zination schlagen.',
  )
  assert.equal(lengthHallucinationFusion.personalizedCharacters, 7)

  const shortOneShotZeit = [...'ZeIt'].map((char, index) => {
    const confidence = [86, 60, 67, 40][index]
    const personalConfidence = [51, 8, 19, 0][index]
    const base = token(char, confidence, [[char, confidence]], index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence,
      })),
    }
  })
  installNeuralWordContextCandidates('de', ['zeile', 'zeit'])
  const measuredNeuralWordFusion = fusePersonalizedTextRecognition(
    shortOneShotZeit,
    neuralResult('zeile', 83),
    'de',
    5,
  )
  assert.equal(
    measuredNeuralWordFusion.text.toLocaleLowerCase('de-CH'),
    'zeile',
    'Ein korrektes neuronales Wörterbuchwort mit passender gemessener Länge darf nicht durch eine zu kurze Einmal-Segmentierung ersetzt werden.',
  )

  const oneShotAufyabe = [...'aufyabe'].map((char, index) => {
    const confidence = [62, 56, 89, 61, 62, 68, 68][index]
    const personalConfidence = [11, 1, 57, 9, 11, 21, 22][index]
    const alternatives = index === 3
      ? [['y', 61], ['g', 58], ['h', 32]]
      : [[char, confidence]]
    const base = token(char, confidence, alternatives, index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: alternative.char === 'g' ? 4 : alternative.char === 'h' ? 0 : personalConfidence,
      })),
    }
  })
  installNeuralWordContextCandidates('de', [
    'abstand',
    'aufgabe',
    'aufgetaut',
    'aufhabe',
    'buchsbaum',
    'buchstabe',
    'biologie',
    'chemie',
    'creme',
    'datei',
    'daten',
    'durchlauf',
    'fallen',
    'familie',
    'informatik',
    'instruktiv',
    'korrektur',
    'keinen',
    'lernen',
    'modell',
    'papier',
    'summe',
    'test',
    'verstehen',
    'versuchen',
    'zeichen',
    'zeichnen',
    'zeile',
    'zeit',
  ])
  const correctedAufgabe = (await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts'))
    .personalizedDictionaryWordForTests('aufyabe', oneShotAufyabe, 'de')
  assert.equal(
    correctedAufgabe.text,
    'aufgabe',
    'Eine eindeutige visuell plausible Ein-Buchstaben-Korrektur darf nicht an einer Rundungsgrenze knapp verworfen werden.',
  )

  const ambiguousVerstchen = [...'verstchen'].map((char, index) => {
    const alternatives = index === 4
      ? [[char, 60], ['u', 58]]
      : index === 5
        ? [[char, 60], ['e', 58]]
        : [[char, 60]]
    const base = token(char, 60, alternatives, index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: 0,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: 0,
      })),
    }
  })
  const ambiguousVerstchenCorrection = (await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts'))
    .personalizedDictionaryWordForTests('verstchen', ambiguousVerstchen, 'de')
  assert.equal(
    ambiguousVerstchenCorrection.text,
    'verstchen',
    'Gleich nahe Wörter wie verstehen/versuchen dürfen ohne echten visuellen Vorsprung nicht willkürlich gewählt werden.',
  )

  assert.equal(
    applyMeasuredNeuralWordContext('instrumatik', 'de', 10),
    'informatik',
    'Eine einzelne neuronale Einfügung darf nur auf das eindeutige häufige Wort mit der unabhängig gemessenen Länge korrigiert werden.',
  )
  assert.equal(
    applyMeasuredNeuralWordContext('instrumatik', 'de', 9),
    'instrumatik',
    'Eine unpassende Längenmessung darf keine weitreichende Wörterbuchkorrektur auslösen.',
  )
  assert.equal(
    applyMeasuredNeuralWordContext('korrekt vor', 'de', 9),
    'korrektur',
    'Ein langes Wort mit einem kurzen erfundenen neuronalen Endfragment muss über die gemessene Gesamtlänge repariert werden.',
  )

  const sparseBuchstabe = [...'auchltaul'].map((char, index) => {
    const alternatives = index === 0 ? [[char, 56], ['b', 38]] : [[char, 58]]
    const base = token(char, 58, alternatives, index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: index < 4 ? 12 : 0,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: alternative.char === char && index < 4 ? 12 : 0,
      })),
    }
  })
  const sparseBuchstabeFusion = fusePersonalizedTextRecognition(
    sparseBuchstabe,
    neuralResult('deutsch', 74),
    'de',
    9,
  )
  const sparseBuchstabeDictionary = (await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts'))
    .personalizedDictionaryWordForTests('auchltaul', sparseBuchstabe, 'de')
  assert.equal(
    sparseBuchstabeDictionary.text,
    'buchstabe',
    `Die abgesicherte Langwortkorrektur muss buchstabe wählen: ${JSON.stringify(sparseBuchstabeDictionary)}`,
  )
  assert.equal(
    sparseBuchstabeDictionary.changes,
    4,
    `Die Langwortkorrektur muss alle vier ersetzten Positionen melden: ${JSON.stringify(sparseBuchstabeDictionary)}`,
  )
  assert.equal(
    sparseBuchstabeFusion.text,
    'buchstabe',
    'Bei exakter Zeichenanzahl muss ein einziges langes Grundwort mit überwiegend positionsgleichen persönlichen Glyphen ein falsches, kürzeres Zeilenwort schlagen.',
  )

  const oneShotCreme = [...'creme'].map((char, index) => {
    const base = token(char, 72, [[char, 72]], index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: 24,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: 24,
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(oneShotCreme, neuralResult('chemie', 71), 'de', 5).text,
    'chemie',
    'Ein einmal beobachtetes, anders langes Wörterbuchwort darf ein hochkonfidentes häufiges Zeilenwort nicht zerstören.',
  )

  const sparseBiologie = [..."l'ioogie"].map((char, index) => {
    const base = token(char, 68, [[char, 68]], index)
    const isLetter = /^\p{L}$/u.test(char)
    return {
      ...base,
      personalSupport: isLetter ? 1 : 0,
      personalConfidence: isLetter ? 18 : 0,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: isLetter ? 1 : 0,
        personalConfidence: isLetter ? 18 : 0,
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(sparseBiologie, neuralResult('biologie', 83), 'de', 7).text,
    'biologie',
    'Ein generisches Satzzeichen in einer einmal beobachteten Textfolge darf ein exaktes, hochkonfidentes Grundwort nicht überschreiben.',
  )

  const sparseModell = [...'mode[['].map((char, index) => {
    const alternatives = char === '[' ? [[char, 69], ['l', 52]] : [[char, 72]]
    const base = token(char, char === '[' ? 69 : 72, alternatives, index)
    return {
      ...base,
      personalSupport: /^\p{L}$/u.test(char) ? 1 : 0,
      personalConfidence: /^\p{L}$/u.test(char) ? 22 : 0,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: /^\p{L}$/u.test(alternative.char) ? 1 : 0,
        personalConfidence: alternative.char === char && /^\p{L}$/u.test(char) ? 22 : 0,
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(sparseModell, neuralResult('undodelt', 71), 'de', 6).text,
    'modell',
    'Schmale persönliche l-Alternativen müssen in einem reinen Textwort generische Klammern ersetzen können.',
  )

  const sparseDatei = [...'datet'].map((char, index) => {
    const alternatives = index === 4 ? [[char, 61], ['i', 52]] : [[char, 70]]
    const base = token(char, index === 4 ? 61 : 70, alternatives, index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: index === 4 ? 9 : 25,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: alternative.char === char ? (index === 4 ? 9 : 25) : 0,
      })),
    }
  })
  const sparseDateiDictionary = (await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts'))
    .personalizedDictionaryWordForTests('datet', sparseDatei, 'de', 'das bei')
  assert.equal(
    sparseDateiDictionary.text,
    'datei',
    `Die gemeinsame visuelle und neuronale Wörterbuchbewertung muss datei wählen: ${JSON.stringify(sparseDateiDictionary)}`,
  )
  assert.equal(
    fusePersonalizedTextRecognition(sparseDatei, neuralResult('das bei', 83), 'de', 5).text,
    'datei',
    'Eine schwache visuelle Buchstabenalternative und der kompakte Zeilenkontext müssen gemeinsam datei gegenüber daten auflösen.',
  )

  const sparseLernen = [...'lernen'].map((char, index) => {
    const confidence = [83, 74, 68, 87, 74, 87][index]
    const base = token(char, confidence, [[char, confidence]], index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: 30,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: 30,
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(sparseLernen, neuralResult('keinen', 83), 'de', 6).text,
    'lernen',
    'Eine vollständige, sichere persönliche Grundwortfolge muss ein gleich langes falsches neuronales Grundwort schlagen.',
  )

  const sparseTest = [...'test'].map((char, index) => {
    const confidence = [48, 67, 59, 48][index]
    const base = token(char, confidence, [[char, confidence]], index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: index === 1 ? 19 : index === 2 ? 8 : 0,
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: index === 1 ? 19 : index === 2 ? 8 : 0,
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(sparseTest, neuralResult('acta', 71), 'de', 4).text,
    'test',
    'Ein vollständig beobachtetes kurzes Grundwort darf nicht wegen einer Rundungsgrenze bei 55 Prozent verworfen werden.',
  )
  assert.equal(
    fusePersonalizedTextRecognition(sparseTest, neuralResult('fast', 83), 'de', 4).text,
    'test',
    'Eine vollständige persönliche Grundwortfolge muss auch ein gleich langes falsches neuronales Grundwort schlagen.',
  )

  const sparseZeichnen = [...'zeichmem'].map((char, index) => {
    const confidence = [65, 48, 71, 82, 62, 62, 69, 62][index]
    const alternatives = char === 'm' ? [[char, 62], ['n', 52]] : [[char, confidence]]
    const base = token(char, confidence, alternatives, index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: [17, 0, 27, 45, 12, 12, 24, 12][index],
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: alternative.char === char ? [17, 0, 27, 45, 12, 12, 24, 12][index] : 0,
      })),
    }
  })
  const sparseZeichnenDictionary = (await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts'))
    .personalizedDictionaryWordForTests('zeichmem', sparseZeichnen, 'de', 'zeichen')
  assert.equal(
    sparseZeichnenDictionary.text,
    'zeichnen',
    `Die verbundene persönliche Langwortkorrektur muss zeichnen wählen: ${JSON.stringify(sparseZeichnenDictionary)}`,
  )
  assert.equal(
    fusePersonalizedTextRecognition(sparseZeichnen, neuralResult('zeichen', 83), 'de', 7).text,
    'zeichnen',
    'Ein verbundenes Zusatzzeichen muss bei zwei passenden persönlichen Alternativen und eindeutigem Grundwort erhalten bleiben.',
  )

  const sparseAbstand = [...'abstnen'].map((char, index) => {
    const confidence = [53, 72, 55, 84, 40, 46, 57][index]
    const alternatives = index === 5 ? [[char, 46], ['n', 42]] : [[char, confidence]]
    const base = token(char, confidence, alternatives, index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: [0, 29, 0, 50, 0, 0, 2][index],
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: alternative.char === char ? [0, 29, 0, 50, 0, 0, 2][index] : 0,
      })),
    }
  })
  const sparseAbstandDictionary = (await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts'))
    .personalizedDictionaryWordForTests('abstnen', sparseAbstand, 'de', 'undtainal')
  assert.equal(
    sparseAbstandDictionary.text,
    'abstand',
    `Der gemeinsam eindeutige persönliche Langwortkandidat muss abstand wählen: ${JSON.stringify(sparseAbstandDictionary)}`,
  )
  assert.equal(
    fusePersonalizedTextRecognition(sparseAbstand, neuralResult('undtainal', 71), 'de', 7).text,
    'abstand',
    'Ein gemeinsam eindeutiges Grundwort mit mehrheitlicher persönlicher Positionsabdeckung muss eine weit entfernte neuronale Folge schlagen.',
  )

  const sparseSumme = [...'sumnn'].map((char, index) => {
    const confidence = [59, 72, 84, 73, 44][index]
    const alternatives = index === 3
      ? [[char, 73], ['m', 57]]
      : index === 4
        ? [[char, 44], ['m', 35]]
        : [[char, confidence]]
    const base = token(char, confidence, alternatives, index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: [8, 28, 49, 31, 0][index],
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: alternative.char === 'm' && index === 3 ? 2 : 0,
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(sparseSumme, neuralResult('simone', 71), 'de', 5).text,
    'summe',
    'Ein fünfstelliges Grundwort muss bei passender Länge und visuellen Alternativen zwei schwache Zeichen korrigieren können.',
  )

  const sparseFaller = [...'Faller'].map((char, index) => {
    const confidence = [71, 74, 50, 54, 60, 47][index]
    const base = token(char, confidence, [[char, confidence]], index)
    return {
      ...base,
      personalSupport: 1,
      personalConfidence: [28, 33, 28, 28, 7, 0][index],
      alternatives: base.alternatives.map((alternative) => ({
        ...alternative,
        personalSupport: 1,
        personalConfidence: [28, 33, 28, 28, 7, 0][index],
      })),
    }
  })
  assert.equal(
    fusePersonalizedTextRecognition(sparseFaller, neuralResult('papier', 83), 'de', 6).text,
    'papier',
    'Eine schwache Einmal-Folge darf ein exaktes hochkonfidentes neuronales Grundwort gleicher Länge nicht umdeuten.',
  )

  const untrainedLengthDisagreement = fusePersonalizedTextRecognition(
    [...'familie'].map((char, index) => token(char, 75, [[char, 75]], index)),
    neuralResult('persoenlicher', 90),
    'de',
  )
  assert.notEqual(
    untrainedLengthDisagreement.text,
    'familie',
    'Generische Standardformen dürfen eine anders lange neuronale Folge nicht ohne persönliche Belege überschreiben.',
  )

  const trainedTwoWords = [...'hallotest'].map((char, index) => ({
    ...token(char, 89, [[char, 89]], index, [0.05 + index * 0.055 + (index >= 5 ? 0.04 : 0), 0.2, 0.045, 0.1]),
    spaceBefore: index === 5,
    personalSupport: 18,
    personalConfidence: 88,
  }))
  const missingSpaceFusion = fusePersonalizedTextRecognition(
    trainedTwoWords,
    neuralResult('hallotest', 82),
    'de',
  )
  assert.equal(missingSpaceFusion.text, 'hallo test', 'Ein geometrisch klarer Wortabstand darf vom Zeilenmodell nicht entfernt werden.')

  const weakFluentAlternative = [...'bergenketten'].map((char, index) => ({
    ...token(char, 52, [[char, 52]], index),
    spaceBefore: index === 6,
    personalSupport: 1,
    personalConfidence: 0,
  }))
  assert.equal(
    fusePersonalizedTextRecognition(
      weakFluentAlternative,
      neuralResult('morgen keinen', 83),
      'de',
    ).text,
    'morgen keinen',
    'Schwache Einmal-Alternativen dürfen einen sicheren Satz nicht durch andere Wörter ersetzen.',
  )

  const trainedSentence = [...'lernenwir'].map((char, index) => ({
    ...token(char, 89, [[char, 89]], index),
    spaceBefore: index === 6,
    personalSupport: 18,
    personalConfidence: 88,
  }))
  assert.equal(
    fusePersonalizedTextRecognition(
      trainedSentence,
      neuralResult('keinen bin', 83),
      'de',
    ).text,
    'lernen wir',
    'Wiederholt trainierte Wörter müssen auch innerhalb eines ganzen Satzes unabhängig fusioniert werden.',
  )

  const classicalOnly = fusePersonalizedTextRecognition(
    [...'Test'].map((char, index) => token(char, 92, [[char, 92]], index)),
    { text: '', confidence: 0, engine: 'trocr-bilingual', lines: [] },
    'de',
  )
  assert.equal(classicalOnly.source, 'classical')
  assert.equal(classicalOnly.personalizedCharacters, 0, 'Standardformen dürfen nicht fälschlich als persönliche Trainingsbelege gezählt werden.')
  assert.equal(classicalOnly.classicalCharacters, 4)
  assert.ok(
    personalizedTextFusionSelectionScore(shortNeuralFusion, neuralResult('ort', 86), 'de') >
      personalizedTextFusionSelectionScore(classicalOnly, neuralResult('ort', 86), 'de'),
    'Wiederholt trainierte persönliche Sequenzen müssen bei der Kandidatenwahl vor generischer Geometrie liegen.',
  )

  const falselyMathematicalSentence = {
    mode: 'math',
    tokens: [],
    value: '\\int \\int',
    textValue: 'Hallo das ist ein Test',
    mathValue: '\\int \\int',
    confidence: 85,
    reason: 'falsche Integralformen',
    textScore: 2.1,
    mathScore: 8.4,
  }
  const strongSentence = {
    ...neuralResult('Hallo das ist ein Test', 83),
    wordCount: 5,
    knownWordRatio: 1,
  }
  assert.equal(
    neuralTextMayOverrideAutomaticMode(strongSentence, falselyMathematicalSentence, 18, true),
    true,
    'Eine klare Textzeile muss eine geometrische Integral-Fehlklassifikation korrigieren können.',
  )
  assert.equal(hasDecisiveMathLayout('\\frac{2}{3}'), true)
  assert.equal(hasDecisiveMathLayout('2+2=4'), true)
  assert.equal(hasDecisiveMathLayout('x + y'), true)
  assert.equal(hasDecisiveMathLayout('\\int_{1}^{5} x'), true)
  assert.equal(hasDecisiveMathLayout('2_{4}^{3}'), true)
  assert.equal(hasDecisiveMathLayout('\\int \\int'), false)
  assert.equal(
    hasStrongNeuralWordEvidence(
      { ...neuralResult('Test', 72), wordCount: 1, knownWordRatio: 1 },
      4,
      true,
    ),
    true,
    'Ein sicher erkanntes bekanntes Einzelwort muss im GlyphenWerk-Test als Text gelten.',
  )
  assert.equal(
    hasStrongPersonalizedTextEvidence(
      { confidence: 72, source: 'personalized', personalizedCharacters: 1 },
      1,
      1,
      false,
    ),
    true,
    'Ein persönlich trainiertes T darf nicht durch die alte Integral-Vermutung verworfen werden.',
  )
  assert.equal(
    hasStrongPersonalizedTextEvidence(
      { confidence: 72, source: 'personalized', personalizedCharacters: 1 },
      1,
      1,
      true,
    ),
    false,
    'Ein Resultat mit expliziter Mathematikstruktur darf nicht als persönlicher Text erzwungen werden.',
  )
  assert.equal(
    hasStrongPersonalizedTextEvidence(
      { confidence: 72, source: 'neural', personalizedCharacters: 4 },
      4,
      4,
      false,
    ),
    false,
    'Ein rein neuronales Resultat darf keine persönliche Trainingsentscheidung vortäuschen.',
  )
  assert.equal(
    neuralTextMayOverrideAutomaticMode(
      { ...neuralResult('Test', 72), wordCount: 1, knownWordRatio: 1 },
      falselyMathematicalSentence,
      4,
      true,
    ),
    true,
    'Ein sicher erkanntes bekanntes Einzelwort muss auch auf der Notizseite eine Integral-Fehlklassifikation korrigieren.',
  )
  assert.equal(
    hasStrongNeuralWordEvidence(
      { ...neuralResult('abc', 72), wordCount: 1, knownWordRatio: 0 },
      3,
      true,
    ),
    false,
    'Eine unbekannte Variablenfolge darf nicht allein wegen ihrer Buchstaben zu Text werden.',
  )
  assert.equal(
    neuralTextMayOverrideAutomaticMode(
      strongSentence,
      { ...falselyMathematicalSentence, mathValue: '\\frac{2}{3}', value: '\\frac{2}{3}' },
      18,
      true,
    ),
    false,
    'Eine echte Bruchstruktur darf nicht von einem Text-Halluzinat überschrieben werden.',
  )
  assert.equal(
    neuralTextMayOverrideAutomaticMode(
      { ...neuralResult('Tost', 70), wordCount: 1, knownWordRatio: 0 },
      falselyMathematicalSentence,
      4,
      true,
    ),
    false,
    'Ein unsicheres Einzelwort reicht nicht aus, um eine deutliche Modusentscheidung umzuwerfen.',
  )
  assert.equal(
    assessNeuralTextModeCandidate(
      'Hallo das ist ein Test',
      'de',
      strongSentence,
      falselyMathematicalSentence,
    ).shouldUseText,
    true,
    'Die gemeinsame FaNotes-/GlyphenWerk-Entscheidung muss einen sicheren Satz vor falschen Integralhypothesen schützen.',
  )
  assert.equal(
    assessNeuralTextModeCandidate(
      '2 + 2 = 4',
      'de',
      { ...neuralResult('2 + 2 = 4', 98), wordCount: 0, knownWordRatio: 0 },
      null,
    ).shouldUseText,
    false,
    'Eine vom Zeilenmodell lesbare Formel darf nicht wegen hoher OCR-Sicherheit zu Text werden.',
  )
  const ambiguousFraction = {
    ...falselyMathematicalSentence,
    mathValue: '\\frac{2}{3}',
    value: '\\frac{2}{3}',
    textScore: 7.6,
    mathScore: 7.8,
    evidence: {
      text: {
        visibleCharacters: 5, letters: 5, digits: 0, letterRatio: 1, words: 1,
        knownWords: 1, knownWordRatio: 1, baselineAlignment: 1, lines: 1, strongSentence: false,
      },
      math: {
        visibleCharacters: 3, digits: 2, operators: 1, balancedOperators: 0,
        strongSymbols: 0, largeOperators: 0, relations: 0, fractions: 3,
        layoutAssignments: 0, lines: 1, latexStructure: true, decisiveStructure: true,
      },
    },
  }
  assert.equal(
    assessNeuralTextModeCandidate('Hallo', 'de', {
      ...neuralResult('Hallo', 96), wordCount: 1, knownWordRatio: 1,
    }, ambiguousFraction).shouldUseText,
    false,
    'Bruch-, Wurzel-, Relations- und Indexevidenz muss auch bei knappem Scoreabstand vor Text-Halluzinationen geschützt bleiben.',
  )
  const standaloneIntegral = {
    ...ambiguousFraction,
    mathValue: '\\int',
    value: '\\int',
    evidence: {
      ...ambiguousFraction.evidence,
      math: {
        ...ambiguousFraction.evidence.math,
        visibleCharacters: 1,
        digits: 0,
        operators: 0,
        strongSymbols: 1,
        largeOperators: 1,
        fractions: 0,
        latexStructure: true,
        decisiveStructure: true,
      },
    },
  }
  assert.equal(
    assessNeuralTextModeCandidate('T', 'de', {
      ...neuralResult('T', 98), wordCount: 0, knownWordRatio: 0,
    }, standaloneIntegral, {
      confidence: 95, source: 'personalized', personalizedCharacters: 1,
    }).shouldUseText,
    false,
    'Ein geometrisch bestätigtes einzelnes Integral darf nicht durch eine feindliche persönliche T-Antwort überschrieben werden.',
  )
  assert.equal(
    assessNeuralTextModeCandidate('Fabio', 'de', {
      ...neuralResult('Fabio', 82), wordCount: 1, knownWordRatio: 0,
    }, { ...falselyMathematicalSentence, textScore: 6.7, mathScore: 7.4 }).shouldUseText,
    true,
    'Ein visuell sicherer unbekannter Name soll bei einer mehrdeutigen geometrischen Entscheidung Text bleiben.',
  )

  console.log('Kontextprüfung erfolgreich: Wortkorrektur, Gross-/Kleinschreibung, adaptive Abstände, persönliche Sequenzfusion, Strichposition und sicheres Pseudo-Labeling.')
} finally {
  await server.close()
}
