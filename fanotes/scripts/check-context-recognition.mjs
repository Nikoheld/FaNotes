import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const {
    applyTextReranking,
    calibratePersonalBaseEvidence,
    recognizedLatex,
    recognizedSentence,
    suggestMathLayoutAssignments,
  } = await server.ssrLoadModule('/../src/lib/recognition.ts')
  const {
    cleanUnsupportedTerminalWordForTests,
    fusePersonalizedTextRecognition,
    personalizedTextFusionSelectionScore,
  } = await server.ssrLoadModule('/src/lib/personalizedTextRecognition.ts')
  const {
    applyFinalNeuralWordContext,
    applyMeasuredNeuralWordContext,
    applyNeuralWordContext,
    installNeuralWordContextCandidates,
    isExtendedNeuralContextWord,
    repairNeuralWordSpacing,
    visualWordDistance,
  } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const {
    applyNeuralPhysicalWordBoundariesForTests,
    fuseNeuralPhysicalWordsForTests,
    neuralTextPhysicalWordGroupsForTests,
    preferNeuralContextCandidateForTests,
    rareContextCommonNeighbourForTests,
    rankTrocrCandidateTextsForTests,
    repairNeuralPhysicalWordSpacingForTests,
    shouldRequestIndependentTrocrViewForTests,
    trocrStructuralRewritePenaltyForTests,
    trocrOrdinaryWordNamePenaltyForTests,
    trocrDenseGermanNamePenaltyForTests,
  } = await server.ssrLoadModule('/src/lib/neuralTextRecognition.ts')
  const {
    assessNeuralTextModeCandidate,
    hasDecisiveAutomaticMathLayout,
    hasDecisiveMathLayout,
    hasStrongPersonalizedTextEvidence,
    hasStrongNeuralWordEvidence,
    isScriptOnlyBaselineTextConflict,
    neuralTextMayOverrideAutomaticMode,
  } = await server.ssrLoadModule('/src/lib/recognitionModeSelection.ts')
  const { BASE_CATALOG } = await server.ssrLoadModule('/../src/data/catalog.ts')
  const labelByChar = new Map(BASE_CATALOG.map((label) => [label.char, label]))

  const uncertainNeuralWord = {
    text: 'münt',
    confidence: 71,
    lines: [],
    engine: 'trocr-bilingual',
  }
  const mostlyPersonalWordScore = personalizedTextFusionSelectionScore({
    text: 'mathe',
    confidence: 74,
    source: 'hybrid',
    personalizedCharacters: 4,
    neuralCharacters: 0,
    classicalCharacters: 1,
    unsupportedChanges: 4,
  }, uncertainNeuralWord, 'de')
  const fluentButWeaklyPersonalScore = personalizedTextFusionSelectionScore({
    text: 'Mont',
    confidence: 73,
    source: 'hybrid',
    personalizedCharacters: 1,
    neuralCharacters: 3,
    classicalCharacters: 0,
    unsupportedChanges: 1,
  }, uncertainNeuralWord, 'de')
  assert.ok(
    mostlyPersonalWordScore > fluentButWeaklyPersonalScore,
    'Vier unabhängig persönlich erkannte Glyphen müssen ein nur einmal persönlich gestütztes flüssiges Ersatzwort überstimmen.',
  )
  assert.equal(cleanUnsupportedTerminalWordForTests('rechnen]', 'reckeren', 'de', false), 'rechnen')
  assert.equal(cleanUnsupportedTerminalWordForTests('rechnen]', 'rechnen]', 'de', false), 'rechnen]')
  assert.equal(cleanUnsupportedTerminalWordForTests('rechnen]', 'rechnen', 'de', true), 'rechnen]')
  assert.equal(cleanUnsupportedTerminalWordForTests('FaNotes]', 'FaNotes', 'de', false), 'FaNotes]')
  assert.equal(
    preferNeuralContextCandidateForTests('mallo test', 66, 'malla tert', 88, 'de', true),
    false,
    'Das Web-Kontextmodell darf eine sichere gleich lange CTC-Zeile mit mehr häufiger Wortstützung nicht verdrängen.',
  )
  const explainedTerminalDebrisScore = personalizedTextFusionSelectionScore({
    text: 'rechnen',
    confidence: 83,
    source: 'hybrid',
    personalizedCharacters: 6,
    neuralCharacters: 0,
    classicalCharacters: 1,
    unsupportedChanges: 0,
    discardedUnsupportedCharacters: 1,
  }, { ...uncertainNeuralWord, text: 'reckeren', confidence: 83 }, 'de')
  const distantPersonalDictionaryScore = personalizedTextFusionSelectionScore({
    text: 'zeichnen',
    confidence: 83,
    source: 'personalized',
    personalizedCharacters: 8,
    neuralCharacters: 0,
    classicalCharacters: 0,
    unsupportedChanges: 2,
  }, { ...uncertainNeuralWord, text: 'reckeren', confidence: 83 }, 'de')
  assert.ok(
    explainedTerminalDebrisScore > distantPersonalDictionaryScore,
    'Ein vollständig erklärtes bekanntes Wort mit untrainiertem Endartefakt muss vor einer weiter entfernten Wörterbuchumschreibung liegen.',
  )

  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'to have an open quarrel',
      'to have an open quarrel',
      'to have an open quarrel any',
      'to have an open quarrel any',
      'en',
      5,
      91,
    ),
    'to have an open quarrel',
    'Ein flüssiges TrOCR-Randwort ohne eigene physische Wortgruppe muss entfernt werden.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'By Trewer Williams A move',
      'By Trewer Williams A move',
      'By Trevor Williams A move any',
      'By Trevor Williams A move any',
      'en',
      5,
      88,
    ),
    'By Trevor Williams A move',
    'Das Entfernen eines ungestützten Randworts darf echte interne Kontextkorrekturen nicht verlieren.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'we are done',
      'we are done',
      'so we are done for now',
      'so we are done for now',
      'en',
      3,
      92,
    ),
    'we are done',
    'Mehrere eindeutig ungestützte häufige Wörter vor und hinter der Tinte müssen gemeinsam entfernt werden.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'we are done',
      'we are done',
      'we really are done',
      'we really are done',
      'en',
      3,
      92,
    ),
    'we are done',
    'Ein eindeutig ungestütztes häufiges Wort innerhalb der Kontextzeile muss entfernt werden.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'we we wait',
      'we we wait',
      'we we we wait',
      'we we we wait',
      'en',
      3,
      92,
    ),
    'we we we wait',
    'Bei wiederholten Wörtern darf keine von mehreren gleich guten Entfernungspositionen geraten werden.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'we are done',
      'we are done',
      'we are done xylophone',
      'we are done xylophone',
      'en',
      3,
      92,
    ),
    'we are done xylophone',
    'Ein unbekanntes Randwort darf nicht durch reine Sprachannahmen abgeschnitten werden.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'York city',
      'York city',
      'New York city',
      'New York city',
      'en',
    ),
    'New York city',
    'Ohne unabhängige Wortgruppenevidenz darf ein Kontextwort niemals abgeschnitten werden.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'we cannot wait',
      'we cannot wait',
      'we can not wait',
      'we can not wait',
      'en',
      3,
      94,
    ),
    'we can not wait',
    'Eine interne Wortaufteilung ist keine Randhalluzination und muss unangetastet bleiben.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'several trips to',
      'several trips to',
      'several trips to sing',
      'several trips to sing',
      'en',
      3,
      60,
    ),
    'several trips to sing',
    'Unsichere Einzelworterkennung darf ein zusätzliches Kontextwort nicht verwerfen.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'findet an dem Ribosomen im Zytosol einer Zelle statt',
      'findet an dem Ribosomen im Zytosol einer Zelle statt',
      'findet an den',
      'findet an den',
      'de',
      9,
      82,
    ),
    'findet an den Ribosomen im Zytosol einer Zelle statt',
    'Ein vorzeitig beendeter Kontextpfad darf den bestätigten Zeilenrest nicht löschen, soll aber seine lokal gestützte Korrektur behalten.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'findet an dem Ribosomen im Zytosol einer Zelle statt',
      'findet an dem Ribosomen im Zytosol einer Zelle statt',
      'vollständig anderer Anfang',
      'vollständig anderer Anfang',
      'de',
      9,
      82,
    ),
    'findet an dem Ribosomen im Zytosol einer Zelle statt',
    'Ein nicht ausrichtbarer abgeschnittener Kontextpfad darf auch den bestätigten Wortanfang nicht ersetzen.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'findet an dem Ribosomen im Zytosol einer Zelle statt',
      'findet an dem Ribosomen im Zytosol einer Zelle statt',
      'findet an den',
      'findet an den',
      'de',
    ),
    'findet an den Ribosomen im Zytosol einer Zelle statt',
    'Zwei unabhängige Zeilenmodelle dürfen einen eindeutig passenden vollständigen CTC-Rest auch ohne einzelne Wortcrops nicht löschen.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'findet an den Ribosomen',
      'findet an den Ribosomen',
      'findet an den.',
      'findet an den.',
      'de',
    ),
    'findet an den.',
    'Ein Kontextpfad mit echtem Satzende darf nicht durch eine nur längere CTC-Hypothese verlängert werden.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'findet an den Ribosomen',
      'findet an den Fantasiewort',
      'findet an den',
      'findet an den',
      'de',
    ),
    'findet an den',
    'Ein zwischen roher und korrigierter CTC-Ausgabe widersprüchlicher Rest ist kein sicherer Beleg für abgeschnittene Tinte.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'mallo test',
      'mallo test',
      'malta test',
      'malla tert',
      'de',
      2,
      83,
    ),
    'hallo test',
    'Zwei nahe visuelle Lesarten müssen gemeinsam ein eindeutiges häufiges Wort zurückholen.',
  )
  assert.equal(
    fuseNeuralPhysicalWordsForTests(
      'rennen macht',
      'rennen macht',
      'learner macht',
      'learner macht',
      'de',
      2,
      83,
    ),
    'lernen macht',
    'Zwei unabhängig und an verschiedenen Positionen beschädigte Wörter müssen ihren eindeutigen gemeinsamen visuellen Mittelpunkt finden.',
  )
  assert.equal(visualWordDistance('wehn', 'when'), 1)
  assert.equal(visualWordDistance('dsa', 'das'), 1)
  assert.equal(visualWordDistance('whem', 'when'), 1, 'Eine Substitution muss weiterhin genau ein visueller Edit sein.')
  assert.equal(visualWordDistance('wneh', 'when'), 2, 'Nicht benachbarte Umstellungen dürfen nicht als sichere Einzelvertauschung gelten.')
  assert.equal(
    applyNeuralWordContext('wehn movement', 'en'),
    'when movement',
    'Vertauschte verbundene Nachbarbuchstaben müssen in einem eindeutigen englischen Wort korrigiert werden.',
  )
  assert.equal(
    applyNeuralWordContext('dsa ist', 'de'),
    'das ist',
    'Vertauschte verbundene Nachbarbuchstaben müssen auch im deutschen Wortkontext korrigiert werden.',
  )
  installNeuralWordContextCandidates('en', [
    'break', 'breve', 'computed', 'computer', 'gave', 'movement', 'tests', 'twists',
  ])
  installNeuralWordContextCandidates('de', ['das', 'des', 'hallo', 'malo'])
  assert.equal(
    applyNeuralWordContext('she gave movement', 'en'),
    'she gave movement',
    'Gültige Wörter aus dem vollständigen OCR-Wörterbuch dürfen nicht zu häufigeren Nachbarn umgeschrieben werden.',
  )
  assert.equal(
    applyNeuralWordContext('des Landes', 'de'),
    'des Landes',
    'Eine korrekte deutsche Flexionsform darf nicht allein wegen der häufigeren Form das ersetzt werden.',
  )
  assert.equal(
    applyNeuralWordContext('wehn movement', 'en'),
    'when movement',
    'Der Vollwörterbuchschutz darf ein weiterhin unbekanntes, eindeutiges Leseartefakt nicht blockieren.',
  )
  assert.equal(
    rareContextCommonNeighbourForTests('campenten', 'computed', 'computed.', 'en'),
    'computer',
    'Ein seltenes gültiges Kontextwort mit genau einem gleich langen häufigen Nachbarn muss eine zweite visuelle Ansicht anfordern.',
  )
  assert.equal(
    rareContextCommonNeighbourForTests('computed', 'computed', 'computed.', 'en'),
    '',
    'Stimmen kompakter und kontextueller Pfad überein, darf keine alternative Wortform gesucht werden.',
  )
  assert.equal(
    rareContextCommonNeighbourForTests('gavin', 'Gavin', 'Gavin', 'en'),
    '',
    'Ein grossgeschriebener Name darf keine häufigere Alternativansicht erzwingen.',
  )
  const independentViewWords = (word) => ['hallo', 'taboo', 'test'].includes(word.toLocaleLowerCase('de-CH'))
  assert.equal(
    shouldRequestIndependentTrocrViewForTests(1, 'mallo', 'mallo', true, 'de', independentViewWords),
    true,
    'Ein weiterhin kontextbedürftiger Einzelpfad muss eine echte unabhängige Bildansicht erhalten.',
  )
  assert.equal(
    shouldRequestIndependentTrocrViewForTests(1, 'mallo', 'xyqaro', false, 'de', independentViewWords),
    true,
    'Ein unbekannter Kontextpfad, der dem kompakten Bildpfad widerspricht, braucht eine zweite Bildansicht.',
  )
  assert.equal(
    shouldRequestIndependentTrocrViewForTests(1, 'test', 'hallo', false, 'de', independentViewWords),
    false,
    'Zwei bekannte, bereits plausible Wörter dürfen nicht pauschal eine zweite teure Inferenz auslösen.',
  )
  assert.equal(
    shouldRequestIndependentTrocrViewForTests(1, 'Fabio', 'taboo', false, 'de', independentViewWords),
    true,
    'Ein unbekannter visueller Name gegen ein bekanntes Kontextwort braucht eine unabhängige zweite Ansicht.',
  )
  assert.equal(
    shouldRequestIndependentTrocrViewForTests(2, 'mallo', 'xyqaro', true, 'de', independentViewWords),
    false,
    'Liegen tatsächlich mehrere Modellkandidaten vor, darf keine redundante Bildansicht gestartet werden.',
  )
  assert.equal(
    applyFinalNeuralWordContext('mallo', 'de'),
    'hallo',
    'Ein anders langer Wörterbuchnachbar darf die einzige gleich lange und positionsgetreue Wortkorrektur nicht blockieren.',
  )
  assert.equal(
    applyFinalNeuralWordContext("Something's up and John didn't answer", 'en'),
    "Something's up and John didn't answer",
    'Apostrophe dürfen weder Wortteile korrigieren noch die echte Grenze nach einer Kontraktion entfernen.',
  )
  assert.equal(
    applyFinalNeuralWordContext('Richard Harris und Helena', 'de'),
    'Richard Harris und Helena',
    'Unbekannte Namen innerhalb eines Satzes dürfen nicht zu Wörterbuchnachbarn umgeschrieben werden.',
  )
  installNeuralWordContextCandidates('de', ['geänderten', 'gesonderten', 'graduell', 'graduelle'])
  assert.equal(
    applyFinalNeuralWordContext('die gesnderten Positionen', 'de'),
    'die gesnderten Positionen',
    'Gleich nahe Wörterbuchtreffer unterschiedlicher Länge sind mehrdeutig und dürfen keine visuelle Form ersetzen.',
  )
  assert.equal(
    applyNeuralWordContext('jap. Sengoku', 'de'),
    'jap. Sengoku',
    'Eine kurze beschriftete Punkt-Abkürzung darf nicht als beschädigtes gewöhnliches Wort korrigiert werden.',
  )
  assert.equal(
    applyNeuralWordContext('terst', 'de', {
      preserveExtendedWords: false,
      requirePlausibilityLead: false,
    }),
    'test',
    'Der visuell schwächere CTC-Pfad muss weiterhin eine eindeutige häufige Ein-Edit-Alternative anbieten dürfen.',
  )
  assert.equal(
    applyNeuralWordContext('Niko Fabio OpenCode', 'de'),
    'Niko Fabio OpenCode',
    'Die Vertauschungsregel darf unbekannte Namen und gemischte Fachbegriffe nicht umschreiben.',
  )
  const englishNbestWords = new Set([
    'fast', 'and', 'supper', 'supplier', 'support', 'consisted', 'of', 'a',
    'fascinated', 'fashioned', 'by', 'the', 'way', 'he', 'looked', 'when', 'you',
    'together', 'porter', 'brought', 'gavin', 'dawn', 'bag', 'out', 'to',
    'hardly', 'likely', 'my', 'sweet', 'luke', 'surgery', 'goes', 'on', 'for',
    'sucked', 'struck', 'in', 'his', 'baggy', 'black', 'meet', 'deanes', 'danes',
    'soon', 'as', 'guy', 'had', 'dark', 'moustache', 'mustache', 'wearing',
    'frockcoat', 'specialised', 'specialized', 'enquiry', 'inquiry', 'royal',
    'commission', 'last', 'night', 'deputise', 'deprive',
    'break', 'breve', 'tests', 'twists',
  ])
  const englishNbestMembership = (word) => englishNbestWords.has(word.toLocaleLowerCase('en-US'))
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'fast andsuper consisted of a',
      'fast and supper consisted of a',
      'fast and supplier consisted of a',
      'fast and support consisted of a',
    ], 'en', englishNbestMembership)[0]?.rawText,
    'fast and supper consisted of a',
    'Starke Wörterbuch- und Abstandsevidenz muss einen klar beschädigten visuellen Top-Pfad korrigieren.',
  )
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'fascinated by the way he looked when you',
      'fashioned by the way he looked when you',
    ], 'en', englishNbestMembership)[0]?.rawText,
    'fascinated by the way he looked when you',
    'Ein nur geringfügig flüssigerer Beam darf den visuell besten vollständigen Satz nicht ersetzen.',
  )
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'Hardly likely, my sureet. Luke surgery goes on for',
      'Hardly likely, my sweet. Luke surgery goes on for',
    ], 'en', englishNbestMembership)[0]?.rawText,
    'Hardly likely, my sweet. Luke surgery goes on for',
    'Ein eng benachbarter zweiter Beam darf genau ein unbekanntes Kleinwort in ein klar bekanntes Wort reparieren.',
  )
  assert.equal(applyFinalNeuralWordContext('brege', 'en'), 'breve')
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'course - one brege will not do it',
      'course - one break will not do it',
    ], 'en', englishNbestMembership)[0]?.rawText,
    'course - one brege will not do it',
    'Besitzt der visuell erste Beam bereits eine andere eindeutige Wortkorrektur, darf der zweite bekannte Nachbar ihn nicht allein per Wörterbuchbonus verdrängen.',
  )
  assert.equal(applyFinalNeuralWordContext('tsists', 'en'), 'twists')
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'with the fringes ( the tsists )',
      'with the fringes ( the tests )',
    ], 'en', englishNbestMembership)[0]?.rawText,
    'with the fringes ( the tsists )',
    'Auch bei gleich langen Alternativen muss die eindeutige eigene Reparatur des visuell ersten Beams Vorrang vor einem anderen Wörterbuchwort behalten.',
  )
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'out and sucked in his baggy black',
      'out and struck in his baggy black',
    ], 'en', englishNbestMembership)[0]?.rawText,
    'out and sucked in his baggy black',
    'Ein bereits bekanntes Wort darf nicht allein wegen eines ebenfalls plausiblen Wörterbuchnachbarn ersetzt werden.',
  )
  for (const [visual, alternative] of [
    ['a dark moustache and wearing a frockcoat', 'a dark mustache and wearing a frockcoat'],
    ['in the specialised enquiry for the Royal Commission', 'in the specialized inquiry for the Royal Commission'],
    ['last night to deputise', 'last night to deprive'],
  ]) assert.equal(
    rankTrocrCandidateTextsForTests([visual, alternative], 'en', englishNbestMembership)[0]?.rawText,
    visual,
    `Eine gültige britische Bildlesung darf nicht von der US- oder Alltagsalternative ersetzt werden: ${visual}`,
  )
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'meet the Deanes, and as soon as Guy had',
      'meet the Danes, and as soon as Guy had',
    ], 'en', englishNbestMembership)[0]?.rawText,
    'meet the Deanes, and as soon as Guy had',
    'Ein titelgeschriebener Name muss trotz eines häufigeren Wörterbuchnachbarn visuell führend bleiben.',
  )
  assert.equal(
    rankTrocrCandidateTextsForTests([
      "together . The porter brought Gavin's bag out to the",
      "together . The porter brought dawn's bag out to the",
    ], 'en', englishNbestMembership)[0]?.rawText,
    "together . The porter brought Gavin's bag out to the",
    'Ein häufiges Wörterbuchwort darf einen visuell führenden Eigennamen nicht verdrängen.',
  )
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'Troja (IIion) durch das Heer der Griechen',
      'Troja (Illinois) durch das Heer der Griechen',
      'Troja (Ilion) durch das Heer der Griechen',
    ], 'de', (word) => ['troja', 'illinois', 'ilion', 'durch', 'das', 'heer', 'der', 'griechen'].includes(word))[0]?.rawText,
    'Troja (IIion) durch das Heer der Griechen',
    'Eine intern grossgeschriebene visuelle Form darf nicht allein wegen eines häufigeren Wörterbuchnamens ersetzt werden.',
  )
  assert.equal(applyFinalNeuralWordContext('gradwell', 'de'), 'graduell')
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'sind, sondern nur gradwell',
      'sind, sondern nur graduelle',
    ], 'de', (word) => ['sind', 'sondern', 'nur', 'graduell', 'graduelle'].includes(word))[0]?.rawText,
    'sind, sondern nur gradwell',
    'Eine deutsche Flexionsvariante darf die eindeutig reparierbare visuelle Grundform nicht während der N-Best-Wahl verdrängen.',
  )
  assert.equal(trocrStructuralRewritePenaltyForTests('der', 'der der', 'de'), 4)
  assert.equal(trocrStructuralRewritePenaltyForTests('zwischen einem Coach und', 'zwischen einem (oach und', 'de'), 4)
  assert.equal(trocrStructuralRewritePenaltyForTests(
    'zur Neuordnung des Hamburges Eisenbahnwesens',
    'zur Neuordnung des Hamburg, Eisenbahnwesens',
    'de',
  ), 4)
  assert.equal(trocrStructuralRewritePenaltyForTests(
    'Weltskiverband. FIS ausgetragene',
    'Weltskiverband FIS ausgetragene',
    'de',
  ), 0)
  assert.equal(
    rankTrocrCandidateTextsForTests([
      'zur Neuordnung des Hamburges Eisenbahnwesens',
      'zur Neuordnung des Hamburg, Eisenbahnwesens',
    ], 'de', (word) => ['zur', 'neuordnung', 'des', 'hamburg', 'eisenbahnwesens'].includes(word))[0]?.rawText,
    'zur Neuordnung des Hamburges Eisenbahnwesens',
    'Ein Wörterbuchwort darf keine neue interne Interpunktion erfinden, um den visuell führenden Beam zu verdrängen.',
  )
  assert.equal(trocrStructuralRewritePenaltyForTests(
    'that they use Dan as a specimen demonstra-',
    'that they use Dan as a specimen demonstrations -',
    'en',
  ), 4)
  const englishNameMembership = (word) => [
    'blackhead', 'cassius', 'celeste', 'eleanor', 'graphing', 'passions', 'tremendous',
  ].includes(word.toLocaleLowerCase('en-US'))
  assert.equal(trocrOrdinaryWordNamePenaltyForTests(
    'and it is the opinion of Bassius that',
    'and it is the opinion of Passions that',
    'en',
    englishNameMembership,
  ), 3)
  assert.equal(trocrOrdinaryWordNamePenaltyForTests(
    'You made some sort of a protest to Grafburg .',
    'You made some sort of a protest to Graphing .',
    'en',
    englishNameMembership,
  ), 3)
  assert.equal(trocrOrdinaryWordNamePenaltyForTests(
    'mysteries , like the Maria Geleste . Then things',
    'mysteries , like the Maria Celeste . Then things',
    'en',
    englishNameMembership,
  ), 0)
  const germanNameMembership = (word) => ['busen', 'marken'].includes(word.toLocaleLowerCase('de-CH'))
  assert.equal(trocrDenseGermanNamePenaltyForTests(
    'Markin Heidesger',
    'Marken Heidesger',
    'de',
    germanNameMembership,
  ), 3)
  assert.equal(trocrDenseGermanNamePenaltyForTests(
    'Matswo Kasa Buson Kobayashi Issa',
    'Matsue Kasa Busen Kobayashi Issa',
    'de',
    germanNameMembership,
  ), 3)
  assert.equal(trocrDenseGermanNamePenaltyForTests(
    'auf der Insel Madagaskar und in Anstralein',
    'auf der Insel Madagaskar und in Australien',
    'de',
    (word) => word === 'australien',
  ), 0)
  assert.equal(trocrOrdinaryWordNamePenaltyForTests(
    'Even worse is to laugh . Transendous damage',
    'Even worse is to laugh . tremendous damage',
    'en',
    englishNameMembership,
  ), 0)
  assert.equal(trocrOrdinaryWordNamePenaltyForTests(
    'Rabbi Eleasar ben Assarja said',
    'Rabbi Eleanor ben Assarja said',
    'en',
    englishNameMembership,
  ), 3)
  assert.equal(trocrStructuralRewritePenaltyForTests('einen Stadtkreis.', 'einen Stadt kreis.', 'de'), 4)
  assert.equal(trocrStructuralRewritePenaltyForTests('der Genreder Brettspielt', 'der Genre der Brettspielt', 'de'), 0)
  assert.equal(trocrStructuralRewritePenaltyForTests('tax atreble the rate', 'tax a treble the rate', 'en'), 0)
  assert.equal(trocrStructuralRewritePenaltyForTests(
    'I will leave you unnecessary pre-',
    'I will leave you the necessary pre-',
    'en',
  ), 4)

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

  // A short lowercase body after a tall capital sits lower by construction.
  // Even a stale learned "subscript" relation must not turn ordinary baseline
  // text into T_{e}; only a child visibly outside the base box is a script.
  const baselineWordTokens = [
    token('T', 96, [['T', 96]], 100, [0.05, 0.18, 0.06, 0.18]),
    token('e', 94, [['e', 94]], 101, [0.115, 0.25, 0.045, 0.12]),
    token('s', 95, [['s', 95]], 102, [0.165, 0.25, 0.044, 0.12]),
    token('t', 95, [['t', 95]], 103, [0.214, 0.23, 0.04, 0.14]),
  ]
  const staleBaselineSubscriptExample = [{
    id: 'stale-baseline-subscript',
    anchorLabelId: baselineWordTokens[0].labelId,
    childLabelId: baselineWordTokens[1].labelId,
    role: 'subscript',
    relativeCenterX: ((0.115 + 0.045 / 2) - (0.05 + 0.06 / 2)) / 0.06,
    relativeCenterY: ((0.25 + 0.12 / 2) - (0.18 + 0.18 / 2)) / 0.18,
    relativeWidth: 0.045 / 0.06,
    relativeHeight: 0.12 / 0.18,
    createdAt: '2026-07-18T00:00:00.000Z',
  }]
  const baselineWordLatex = recognizedLatex(baselineWordTokens, staleBaselineSubscriptExample)
  assert.doesNotMatch(
    baselineWordLatex,
    /[_^]\{/u,
    `Grundlinienbuchstaben dürfen trotz altem Layoutbeispiel keine Indexe werden: ${baselineWordLatex}`,
  )
  assert.equal(
    suggestMathLayoutAssignments(baselineWordTokens, staleBaselineSubscriptExample).length,
    0,
    'Für ein normales Wort dürfen keine Hoch-/Tiefstellungs-Zuweisungen vorgeschlagen werden.',
  )

  // Real handwriting rarely follows a perfectly straight baseline. A short
  // lowercase letter after a tall capital can extend a few pixels below it
  // without becoming a mathematical index. This used to format "Hallo" as
  // H_{a}llo once the deviation exceeded only six percent of the H height.
  const jitteredBaselineWordTokens = [
    token('H', 96, [['H', 96]], 104, [0.05, 0.18, 0.06, 0.18]),
    token('a', 94, [['a', 94]], 105, [0.115, 0.256, 0.045, 0.12]),
    token('l', 95, [['l', 95]], 106, [0.165, 0.205, 0.035, 0.165]),
    token('l', 95, [['l', 95]], 107, [0.205, 0.204, 0.035, 0.166]),
    token('o', 95, [['o', 95]], 108, [0.245, 0.251, 0.046, 0.121]),
  ]
  const jitteredBaselineLatex = recognizedLatex(jitteredBaselineWordTokens)
  assert.doesNotMatch(
    jitteredBaselineLatex,
    /[_^]\{/u,
    `Natürliche Grundlinienschwankung darf keine Buchstaben in Indexe verwandeln: ${jitteredBaselineLatex}`,
  )
  assert.equal(
    suggestMathLayoutAssignments(jitteredBaselineWordTokens).length,
    0,
    'Leicht tiefer geschriebene Kleinbuchstaben dürfen keine Layout-Zuweisung erhalten.',
  )

  // Pairwise geometry alone still sees an index once the first tall letter is
  // almost twenty percent above the following x-height letters.  The local
  // word baseline must resolve that otherwise realistic handwriting case.
  const locallyAlignedWordTokens = [
    token('T', 96, [['T', 96]], 1090, [0.05, 0.18, 0.06, 0.18]),
    token('e', 94, [['e', 94]], 1091, [0.115, 0.275, 0.045, 0.12]),
    token('s', 95, [['s', 95]], 1092, [0.165, 0.276, 0.044, 0.119]),
    token('t', 95, [['t', 95]], 1093, [0.214, 0.255, 0.04, 0.14]),
  ]
  const locallyAlignedWordLatex = recognizedLatex(locallyAlignedWordTokens)
  assert.doesNotMatch(
    locallyAlignedWordLatex,
    /[_^]\{/u,
    `Die gemeinsame Wortgrundlinie muss scheinbare Indexe nach einem hohen Anfangsbuchstaben verhindern: ${locallyAlignedWordLatex}`,
  )
  assert.equal(
    suggestMathLayoutAssignments(locallyAlignedWordTokens).length,
    0,
    'Ein normal ausgerichtetes Wort darf auch bei starker lokaler Höhendifferenz keine Index-Trainingsdaten erzeugen.',
  )

  const locallyAlignedNameTokens = [
    token('F', 96, [['F', 96]], 1094, [0.05, 0.18, 0.06, 0.18]),
    token('a', 94, [['a', 94]], 1095, [0.115, 0.275, 0.045, 0.12]),
    token('b', 95, [['b', 95]], 1096, [0.165, 0.225, 0.044, 0.17]),
    token('i', 95, [['i', 95]], 1097, [0.214, 0.275, 0.027, 0.12]),
    token('o', 95, [['o', 95]], 1098, [0.246, 0.275, 0.045, 0.12]),
  ]
  assert.doesNotMatch(
    recognizedLatex(locallyAlignedNameTokens),
    /[_^]\{/u,
    'Ein titelgeschriebener Name muss auch ohne Wörterbucheintrag der gemeinsamen Wortgrundlinie folgen.',
  )

  const trueMultiLetterSubscriptTokens = [
    token('x', 96, [['x', 96]], 1099, [0.05, 0.2, 0.06, 0.18]),
    token('m', 95, [['m', 95]], 1100, [0.115, 0.365, 0.04, 0.08]),
    token('a', 95, [['a', 95]], 1101, [0.16, 0.366, 0.04, 0.08]),
    token('x', 95, [['x', 95]], 1102, [0.205, 0.365, 0.04, 0.08]),
  ]
  assert.match(
    recognizedLatex(trueMultiLetterSubscriptTokens),
    /x_\{m a x\}/u,
    'Ein klar kleiner und auf eigener Grundlinie geschriebener Buchstabenindex muss erhalten bleiben.',
  )

  let baselineSweepCases = 0
  for (const word of ['Test', 'Hallo', 'Fabio', 'Lernen']) {
    for (const baseHeight of [0.14, 0.18, 0.22]) {
      for (const bodyHeight of [0.08, 0.1, 0.12, 0.14]) {
        for (const jitterRatio of [-0.15, -0.12, -0.08, 0, 0.08, 0.12, 0.15]) {
          const baseY = 0.2
          const baseline = baseY + baseHeight + baseHeight * jitterRatio
          let x = 0.05
          const sweptTokens = [
            token(word[0], 95, [[word[0], 95]], 2000 + baselineSweepCases * 10, [x, baseY, 0.055, baseHeight]),
          ]
          x += 0.06
          Array.from(word).slice(1).forEach((char, index) => {
            sweptTokens.push(token(
              char,
              94,
              [[char, 94]],
              2001 + baselineSweepCases * 10 + index,
              [x, baseline - bodyHeight, 0.045, bodyHeight],
            ))
            x += 0.05
          })
          const sweptLatex = recognizedLatex(sweptTokens)
          assert.doesNotMatch(
            sweptLatex,
            /[_^]\{/u,
            `Normale Wortgeometrie darf im Grundlinien-Sweep kein Index werden (${word}, H=${baseHeight}, h=${bodyHeight}, j=${jitterRatio}): ${sweptLatex}`,
          )
          baselineSweepCases += 1
        }
      }
    }
  }
  assert.equal(baselineSweepCases, 336, 'Der systematische Grundlinien-Sweep ist unvollständig.')

  let localWordBaselineSweepCases = 0
  for (const word of ['Test', 'Hallo', 'Fabio', 'Lernen']) {
    for (const baseHeight of [0.16, 0.2, 0.24]) {
      for (const bodyRatio of [0.58, 0.66, 0.74]) {
        for (const jitterRatio of [0.17, 0.2, 0.22]) {
          const baseY = 0.2
          const bodyHeight = baseHeight * bodyRatio
          const baseline = baseY + baseHeight * (1 + jitterRatio)
          let x = 0.05
          const sweptTokens = [
            token(word[0], 95, [[word[0], 95]], 4000 + localWordBaselineSweepCases * 10, [x, baseY, 0.055, baseHeight]),
          ]
          x += 0.06
          Array.from(word).slice(1).forEach((char, index) => {
            sweptTokens.push(token(
              char,
              94,
              [[char, 94]],
              4001 + localWordBaselineSweepCases * 10 + index,
              [x, baseline - bodyHeight, 0.045, bodyHeight],
            ))
            x += 0.05
          })
          const sweptLatex = recognizedLatex(sweptTokens)
          assert.doesNotMatch(
            sweptLatex,
            /[_^]\{/u,
            `Die lokale Wortgrundlinie muss starke natürliche Abweichung ohne Index halten (${word}, H=${baseHeight}, h=${bodyRatio}, j=${jitterRatio}): ${sweptLatex}`,
          )
          assert.equal(
            suggestMathLayoutAssignments(sweptTokens).length,
            0,
            `Die starke Wortabweichung darf keine trainierbare Indexbeziehung erzeugen (${word}, H=${baseHeight}, h=${bodyRatio}, j=${jitterRatio}).`,
          )
          localWordBaselineSweepCases += 1
        }
      }
    }
  }
  assert.equal(localWordBaselineSweepCases, 108, 'Der lokale Wortgrundlinien-Sweep ist unvollständig.')

  const trueScriptTokens = [
    token('x', 96, [['x', 96]], 110, [0.3, 0.3, 0.065, 0.2]),
    token('1', 95, [['1', 95]], 111, [0.37, 0.505, 0.038, 0.09]),
    token('2', 95, [['2', 95]], 112, [0.37, 0.205, 0.038, 0.09]),
  ]
  const trueScriptLatex = recognizedLatex(trueScriptTokens)
  assert.match(trueScriptLatex, /x_\{1\}\^\{2\}/u, `Echte Indexe müssen erhalten bleiben: ${trueScriptLatex}`)
  assert.deepEqual(
    suggestMathLayoutAssignments(trueScriptTokens).map((assignment) => assignment.role).sort(),
    ['subscript', 'superscript'],
    'Echte Hoch- und Tiefstellungen müssen weiterhin beide erkannt werden.',
  )

  let trueScriptSweepCases = 0
  for (const baseHeight of [0.14, 0.18, 0.22]) {
    for (const childRatio of [0.35, 0.45, 0.55]) {
      for (const displacementRatio of [0.18, 0.25, 0.35]) {
        const baseY = 0.3
        const childHeight = baseHeight * childRatio
        const subscriptBottom = baseY + baseHeight * (1 + displacementRatio)
        const superscriptY = baseY - baseHeight * displacementRatio
        const subscriptLatex = recognizedLatex([
          token('x', 96, [['x', 96]], 6000 + trueScriptSweepCases * 4, [0.3, baseY, 0.065, baseHeight]),
          token('1', 95, [['1', 95]], 6001 + trueScriptSweepCases * 4, [0.37, subscriptBottom - childHeight, 0.038, childHeight]),
        ])
        const superscriptLatex = recognizedLatex([
          token('x', 96, [['x', 96]], 6002 + trueScriptSweepCases * 4, [0.3, baseY, 0.065, baseHeight]),
          token('2', 95, [['2', 95]], 6003 + trueScriptSweepCases * 4, [0.37, superscriptY, 0.038, childHeight]),
        ])
        assert.match(
          subscriptLatex,
          /x_\{1\}/u,
          `Echter Tiefindex ging im Geometrie-Sweep verloren (H=${baseHeight}, h=${childRatio}, d=${displacementRatio}): ${subscriptLatex}`,
        )
        assert.match(
          superscriptLatex,
          /x\^\{2\}/u,
          `Echter Hochindex ging im Geometrie-Sweep verloren (H=${baseHeight}, h=${childRatio}, d=${displacementRatio}): ${superscriptLatex}`,
        )
        trueScriptSweepCases += 1
      }
    }
  }
  assert.equal(trueScriptSweepCases, 27, 'Der echte Hoch-/Tiefstellungs-Sweep ist unvollständig.')

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

  const untrainedCalibration = calibratePersonalBaseEvidence({
    confidence: 82,
    baseConfidence: 82,
    personalSupport: 0,
    personalConfidence: 0,
  }, 82)
  const consensusCalibration = calibratePersonalBaseEvidence({
    confidence: 84,
    baseConfidence: 88,
    personalSupport: 1,
    personalConfidence: 30,
  }, 91)
  const weakConflictCalibration = calibratePersonalBaseEvidence({
    confidence: 84,
    baseConfidence: 20,
    personalSupport: 1,
    personalConfidence: 70,
  }, 95)
  const repeatedConflictCalibration = calibratePersonalBaseEvidence({
    confidence: 84,
    baseConfidence: 20,
    personalSupport: 8,
    personalConfidence: 75,
  }, 95)
  assert.equal(untrainedCalibration.scoreAdjustment, 0, 'Ohne Trainingsdaten darf die Kalibrierung die Grunderkennung nicht verändern.')
  assert.equal(consensusCalibration.consensus, true)
  assert.ok(
    consensusCalibration.scoreAdjustment > weakConflictCalibration.scoreAdjustment,
    'Übereinstimmende Grund- und Trainingsdaten müssen stärker sein als ein einzelnes widersprüchliches Beispiel.',
  )
  assert.equal(weakConflictCalibration.decisive, false)
  assert.equal(repeatedConflictCalibration.decisive, true, 'Viele passende persönliche Beispiele müssen einen echten individuellen Schreibstil lernen dürfen.')
  assert.ok(repeatedConflictCalibration.authority > weakConflictCalibration.authority)

  const mixedEvidenceTest = ambiguousTest.map((entry, index) => index !== 1 ? entry : ({
    ...entry,
    baseConfidence: 82,
    personalSupport: 1,
    personalConfidence: 10,
    alternatives: entry.alternatives.map((alternative) => alternative.char === 'e' ? {
      ...alternative,
      baseConfidence: 80,
      personalSupport: 4,
      personalConfidence: 60,
    } : {
      ...alternative,
      baseConfidence: 82,
      personalSupport: 1,
      personalConfidence: 10,
    }),
  }))
  const mixedEvidenceGerman = applyTextReranking(mixedEvidenceTest, BASE_CATALOG, 'de')
  assert.equal(recognizedSentence(mixedEvidenceGerman), 'Test')
  assert.equal(mixedEvidenceGerman[1].personalSupport, 4, 'Eine Sprachkorrektur muss die Trainingsstützung des gewählten Zeichens übernehmen.')
  assert.equal(mixedEvidenceGerman[1].personalConfidence, 60, 'Eine Sprachkorrektur darf keine Trainingskonfidenz des verworfenen Zeichens behalten.')
  assert.equal(mixedEvidenceGerman[1].baseConfidence, 80, 'Auch die unabhängige Grunderkennung muss zum tatsächlich gewählten Zeichen gehören.')

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
  assert.equal(
    applyNeuralWordContext('leRnen und TEst', 'de'),
    'lernen und Test',
    'Interne Grossbuchstaben in bekannten Wörtern müssen normalisiert werden, ohne die Wortanfangsform zu verlieren.',
  )
  assert.equal(
    applyNeuralWordContext('FaNotes OpenCode', 'de'),
    'FaNotes OpenCode',
    'Bewusst gemischte Gross-/Kleinschreibung in unbekannten Produkt- und Fachnamen muss erhalten bleiben.',
  )

  const penPoint = (x, y, t) => ({
    x, y, t, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen',
  })
  const spacingStroke = (from, to, time) => ({
    baseWidth: 3,
    pressureEnabled: true,
    points: [penPoint(from, 0.3, time), penPoint(to, 0.7, time + 1)],
  })
  assert.equal(
    repairNeuralPhysicalWordSpacingForTests(
      'will kommen',
      [spacingStroke(0.1, 0.4, 0), spacingStroke(0.43, 0.8, 2)],
      'de',
    ),
    'willkommen',
    'Ohne physische Wortlücke muss ein erfundener Modellabstand auch zwischen zwei einzeln gültigen Fragmenten verschwinden.',
  )
  assert.equal(
    repairNeuralPhysicalWordSpacingForTests(
      'will kommen',
      [spacingStroke(0.1, 0.4, 0), spacingStroke(0.65, 0.92, 2)],
      'de',
    ),
    'will kommen',
    'Eine echte breite Wortlücke darf durch den Sprachkontext nicht entfernt werden.',
  )
  const connectedUnknownWord = {
    baseWidth: 3,
    pressureEnabled: true,
    points: Array.from({ length: 31 }, (_, index) => penPoint(
      0.1 + index * 0.024,
      0.48 + Math.sin(index * 0.8) * 0.13,
      index,
    )),
  }
  assert.equal(
    repairNeuralPhysicalWordSpacingForTests('Xyq aro', [connectedUnknownWord], 'de'),
    'Xyqaro',
    'Ein neuronaler Abstand in einem durchgehend geschriebenen unbekannten Namen muss auch ohne Wörterbucheintrag verschwinden.',
  )
  assert.equal(
    repairNeuralPhysicalWordSpacingForTests(
      'Xyq aro',
      [spacingStroke(0.1, 0.43, 0), spacingStroke(0.46, 0.82, 2)],
      'de',
    ),
    'Xyq aro',
    'Zwei nur eng beieinanderliegende unabhängige Stiftkörper dürfen bei einem unbekannten Ausdruck nicht blind verbunden werden.',
  )
  const twoPhysicalWords = [
    spacingStroke(0.1, 0.45, 0),
    spacingStroke(0.65, 0.93, 2),
  ]
  assert.equal(
    applyNeuralPhysicalWordBoundariesForTests('hallotest', twoPhysicalWords, 'de'),
    'hallo test',
    'Eine eindeutige physische Wortlücke muss einen vom Zeilenmodell ausgelassenen Abstand zurückholen.',
  )
  assert.equal(
    applyNeuralPhysicalWordBoundariesForTests('hal lo test', twoPhysicalWords, 'de'),
    'hallo test',
    'Zusätzliche Modellabstände müssen auf die zwei tatsächlich sichtbaren Wortgruppen zurückgeführt werden.',
  )
  assert.equal(
    applyNeuralPhysicalWordBoundariesForTests('hallo test', twoPhysicalWords, 'de'),
    'hallo test',
    'Ein bereits passender Modellabstand darf nicht verschoben werden.',
  )
  const fourteenPhysicalWords = Array.from({ length: 14 }, (_, index) => (
    spacingStroke(0.02 + index * 0.068, 0.055 + index * 0.068, index * 2)
  ))
  assert.equal(
    neuralTextPhysicalWordGroupsForTests(fourteenPhysicalWords, 1_000, 100)[0]?.length,
    14,
    'Eine dichte lange Schreibzeile mit mehr als zwölf klaren Wortgruppen darf nicht wieder zu einem einzigen Decoderbild zusammenfallen.',
  )
  const dottedBody = {
    baseWidth: 3.6,
    pressureEnabled: true,
    points: [penPoint(0.075, 0.205, 0), penPoint(0.076, 0.305, 1)],
  }
  const firstDot = {
    baseWidth: 3.6,
    pressureEnabled: true,
    points: [penPoint(0.076, 0.165, 2)],
  }
  const secondDot = {
    baseWidth: 3.6,
    pressureEnabled: true,
    points: [penPoint(0.09, 0.164, 3)],
  }
  const dottedI = {
    ...token('l', 76, [['l', 76], ['i', 74]], 0),
    strokes: [dottedBody, firstDot],
  }
  assert.equal(
    recognizedSentence(applyTextReranking([
      dottedI,
      token('x', 91, [['x', 91]], 1),
    ], BASE_CATALOG, 'de')),
    'ix',
    'Ein real vorhandener oberer Punkt muss i gegenüber l/I/1 als unabhängigen Strichbeweis absichern.',
  )
  const dottedUmlaut = {
    ...token('u', 76, [['u', 76], ['ü', 74]], 0),
    strokes: [dottedBody, firstDot, secondDot],
  }
  assert.equal(
    recognizedSentence(applyTextReranking([
      dottedUmlaut,
      token('x', 91, [['x', 91]], 1),
    ], BASE_CATALOG, 'de')),
    'üx',
    'Zwei obere Punkte müssen einen Umlaut gegenüber dem undiakritisierten Grundbuchstaben absichern.',
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

  const unknownNameWithNaturalGap = [...'Xyqaro'].map((char, index) => {
    const x = 0.05 + index * 0.055 + (index >= 3 ? 0.012 : 0)
    return token(char, 98, [[char, 98]], index, [x, 0.22, 0.05, 0.1])
  })
  assert.equal(
    recognizedSentence(applyTextReranking(unknownNameWithNaturalGap, BASE_CATALOG, 'de')),
    'Xyqaro',
    'Natürliche Abstandsvariation innerhalb eines unbekannten Namens darf keine Wortgrenze erzeugen.',
  )

  const unknownNameWithDetachedJoin = [...'Xyqaro'].map((char, index) => {
    const x = 0.05 + index * 0.055 + (index >= 3 ? 0.025 : 0)
    return token(char, 98, [[char, 98]], index, [x, 0.22, 0.05, 0.1])
  })
  assert.equal(
    recognizedSentence(applyTextReranking(unknownNameWithDetachedJoin, BASE_CATALOG, 'de')),
    'Xyqaro',
    'Ein einzelner deutlich abgesetzter Anschluss innerhalb eines unbekannten Wortes darf nicht als Wortabstand enden.',
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
  assert.equal(
    repairNeuralWordSpacing('Te st ist gu t', 'de'),
    'Test ist gut',
    'Erfundene neuronale Abstände dürfen nur verschwinden, wenn die verbundene Form eindeutig ein echtes Wort ist.',
  )
  assert.equal(
    repairNeuralWordSpacing('in form', 'en'),
    'in form',
    'Zwei bereits gültige Wörter dürfen nicht nur deshalb verbunden werden, weil auch ihre Verkettung ein Wort ist.',
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
  const calibratedToken = (
    selected,
    selectedEvidence,
    alternative,
    alternativeEvidence,
  ) => {
    const base = token(
      selected,
      selectedEvidence.confidence,
      [[selected, selectedEvidence.confidence], [alternative, alternativeEvidence.confidence]],
      0,
    )
    return {
      ...base,
      baseConfidence: selectedEvidence.baseConfidence,
      personalSupport: selectedEvidence.personalSupport,
      personalConfidence: selectedEvidence.personalConfidence,
      alternatives: base.alternatives.map((entry) => ({
        ...entry,
        ...(entry.char === selected ? selectedEvidence : alternativeEvidence),
      })),
    }
  }
  const baseTrainingConsensus = calibratedToken(
    'e',
    { confidence: 86, baseConfidence: 90, personalSupport: 1, personalConfidence: 30 },
    'o',
    { confidence: 78, baseConfidence: 70, personalSupport: 0, personalConfidence: 0 },
  )
  assert.equal(
    fusePersonalizedTextRecognition([baseTrainingConsensus], neuralResult('o', 90), 'de', 1).text,
    'e',
    'Ein persönliches Beispiel und eine klar zustimmende Grunderkennung müssen gemeinsam ein abweichendes Sequenzmodell schlagen.',
  )
  const weakTrainingConflict = calibratedToken(
    'a',
    { confidence: 84, baseConfidence: 20, personalSupport: 1, personalConfidence: 70 },
    'c',
    { confidence: 82, baseConfidence: 95, personalSupport: 0, personalConfidence: 0 },
  )
  assert.equal(
    fusePersonalizedTextRecognition([weakTrainingConflict], neuralResult('c', 96), 'de', 1).text,
    'c',
    'Ein einzelnes widersprüchliches Trainingsbeispiel darf eine sehr sichere Grund- und Sequenzentscheidung nicht überschreiben.',
  )
  const repeatedTrainingConflict = calibratedToken(
    'a',
    { confidence: 84, baseConfidence: 20, personalSupport: 8, personalConfidence: 75 },
    'c',
    { confidence: 82, baseConfidence: 95, personalSupport: 0, personalConfidence: 0 },
  )
  assert.equal(
    fusePersonalizedTextRecognition([repeatedTrainingConflict], neuralResult('c', 96), 'de', 1).text,
    'a',
    'Wiederholte nahe persönliche Beispiele müssen einen echten vom Grundmodell abweichenden Schreibstil erlernen.',
  )
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

  const trainedUnknownName = [...'Xyqaro'].map((char, index) => ({
    ...token(char, 88, [[char, 88]], index),
    personalSupport: 24,
    personalConfidence: 91,
    alternatives: token(char, 88, [[char, 88]], index).alternatives.map((alternative) => ({
      ...alternative,
      personalSupport: 24,
      personalConfidence: 91,
    })),
  }))
  assert.equal(
    fusePersonalizedTextRecognition(
      trainedUnknownName,
      neuralResult('Xyq aro', 91),
      'de',
    ).text,
    'Xyqaro',
    'Ein neuronales Leerzeichen ohne physische Wortgrenze darf einen unbekannten Namen nicht teilen.',
  )

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
  const falseWordScripts = {
    ...ambiguousFraction,
    mode: 'math',
    value: 'T_{e s t}',
    textValue: 'Test',
    mathValue: 'T_{e s t}',
    textScore: 6.2,
    mathScore: 6.7,
    evidence: {
      text: {
        visibleCharacters: 4, letters: 4, digits: 0, letterRatio: 1, words: 1,
        knownWords: 1, knownWordRatio: 1, baselineAlignment: 1, lines: 1, strongSentence: false,
      },
      math: {
        visibleCharacters: 4, digits: 0, operators: 0, balancedOperators: 0,
        strongSymbols: 0, largeOperators: 0, relations: 0, fractions: 0,
        layoutAssignments: 3, lines: 1, latexStructure: false, decisiveStructure: false,
      },
    },
  }
  assert.equal(isScriptOnlyBaselineTextConflict(falseWordScripts), true)
  assert.equal(
    hasDecisiveAutomaticMathLayout(falseWordScripts),
    false,
    'Eine bereits widerlegte reine Indexhypothese darf in der Fusionsschicht nicht erneut zu harter Mathematik werden.',
  )
  assert.equal(
    assessNeuralTextModeCandidate('Test', 'de', {
      ...neuralResult('Test', 91), wordCount: 1, knownWordRatio: 1,
    }, falseWordScripts).shouldUseText,
    true,
    'Ein vollständiges Wort auf gemeinsamer Grundlinie muss eine reine falsche Indexhypothese überstimmen.',
  )
  const falseShortWordScripts = {
    ...falseWordScripts,
    value: 'd_{e r}',
    textValue: 'der',
    mathValue: 'd_{e r}',
    evidence: {
      ...falseWordScripts.evidence,
      text: {
        ...falseWordScripts.evidence.text,
        visibleCharacters: 3,
        letters: 3,
        knownWords: 1,
        baselineAlignment: 0.9,
      },
      math: {
        ...falseWordScripts.evidence.math,
        visibleCharacters: 3,
        layoutAssignments: 2,
      },
    },
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(falseShortWordScripts),
    true,
    'Auch ein kurzes bekanntes Wort darf nicht als Indexkette gelten.',
  )
  assert.equal(
    assessNeuralTextModeCandidate('der', 'de', {
      ...neuralResult('der', 91), wordCount: 1, knownWordRatio: 1,
    }, falseShortWordScripts).shouldUseText,
    true,
    'Dreistellige Alltagswörter auf gemeinsamer Grundlinie müssen eine reine Indexhypothese überstimmen.',
  )
  const falseUnknownNameScripts = {
    ...falseWordScripts,
    value: 'F_{a b i o}',
    textValue: 'Fabio',
    mathValue: 'F_{a b i o}',
    evidence: {
      ...falseWordScripts.evidence,
      text: {
        ...falseWordScripts.evidence.text,
        visibleCharacters: 5,
        letters: 5,
        knownWords: 0,
        knownWordRatio: 0,
        baselineAlignment: 0.92,
      },
      math: {
        ...falseWordScripts.evidence.math,
        visibleCharacters: 5,
        layoutAssignments: 4,
      },
    },
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(falseUnknownNameScripts),
    true,
    'Auch ein unbekannter Name auf klarer gemeinsamer Grundlinie darf nicht als Indexkette gelten.',
  )
  assert.equal(
    assessNeuralTextModeCandidate('Fabio', 'de', {
      ...neuralResult('Fabio', 82), wordCount: 1, knownWordRatio: 0,
    }, falseUnknownNameScripts).shouldUseText,
    true,
    'Eigennamen und Fachwörter müssen eine reine falsche Indexhypothese überstimmen können.',
  )
  const verticallyDisplacedUnknownScripts = {
    ...falseUnknownNameScripts,
    textValue: 'xyqar',
    evidence: {
      ...falseUnknownNameScripts.evidence,
      text: {
        ...falseUnknownNameScripts.evidence.text,
        baselineAlignment: 0.6,
      },
    },
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(verticallyDisplacedUnknownScripts),
    false,
    'Eine unbekannte Buchstabenfolge mit echter vertikaler Verschiebung muss als mögliche Indexstruktur geschützt bleiben.',
  )
  const verticallyDisplacedKnownWordScripts = {
    ...verticallyDisplacedUnknownScripts,
    textValue: 'Hallo',
    evidence: {
      ...verticallyDisplacedUnknownScripts.evidence,
      text: {
        ...verticallyDisplacedUnknownScripts.evidence.text,
        knownWords: 1,
        knownWordRatio: 1,
      },
    },
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(verticallyDisplacedKnownWordScripts),
    true,
    'Ein vollständiges bekanntes Wort muss auch bei unruhiger Grundlinie eine reine Indexhypothese überstimmen.',
  )
  assert.equal(
    assessNeuralTextModeCandidate('Hallo', 'de', {
      ...neuralResult('Hallo', 91), wordCount: 1, knownWordRatio: 1,
    }, verticallyDisplacedKnownWordScripts).shouldUseText,
    true,
    'Starke Worterkennung muss falsche Hoch-/Tiefstellungen unabhängig von normaler Grundliniendrift auflösen.',
  )
  const plausibleCompoundScripts = {
    ...verticallyDisplacedUnknownScripts,
    textValue: 'Schulnotizen',
    evidence: {
      ...verticallyDisplacedUnknownScripts.evidence,
      text: {
        ...verticallyDisplacedUnknownScripts.evidence.text,
        visibleCharacters: 12,
        letters: 12,
        plausibleWords: 1,
        strongSentence: false,
      },
      math: {
        ...verticallyDisplacedUnknownScripts.evidence.math,
        visibleCharacters: 12,
        layoutAssignments: 4,
        latexStructure: true,
        decisiveStructure: true,
      },
    },
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(plausibleCompoundScripts),
    true,
    'Eine plausible Flexions- oder Kompositumsform darf nicht nur wegen unruhiger Grundlinie als Indexkette bleiben.',
  )
  const sentenceWithOneUnknownWordScripts = {
    ...plausibleCompoundScripts,
    textValue: 'Diese Xyqaro Notiz',
    evidence: {
      ...plausibleCompoundScripts.evidence,
      text: {
        ...plausibleCompoundScripts.evidence.text,
        visibleCharacters: 16,
        letters: 16,
        words: 3,
        knownWords: 2,
        plausibleWords: 2,
        knownWordRatio: 0.667,
        strongSentence: true,
      },
    },
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(sentenceWithOneUnknownWordScripts),
    true,
    'Ein einzelner unbekannter Name in einem sonst klaren Satz darf die falsche Indexhypothese nicht wieder aktivieren.',
  )
  const verticallyDisplacedProperNameScripts = {
    ...verticallyDisplacedUnknownScripts,
    textValue: 'Fabio',
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(verticallyDisplacedProperNameScripts),
    true,
    'Ein klar titelgeschriebener Name darf nicht wegen fehlendem Wörterbucheintrag als Indexkette erscheinen.',
  )
  assert.equal(
    assessNeuralTextModeCandidate('Fabio', 'de', {
      ...neuralResult('Fabio', 82), wordCount: 1, knownWordRatio: 0,
    }, verticallyDisplacedProperNameScripts).shouldUseText,
    true,
    'Das Zeilenmodell muss einen klaren Eigennamen gegen eine reine Indexhypothese durchsetzen können.',
  )
  const trueVariableScript = {
    ...falseWordScripts,
    value: 'x_{1}',
    textValue: 'x1',
    mathValue: 'x_{1}',
    evidence: {
      text: {
        visibleCharacters: 2, letters: 1, digits: 1, letterRatio: 0.5, words: 0,
        knownWords: 0, knownWordRatio: 0, baselineAlignment: 0.5, lines: 1, strongSentence: false,
      },
      math: {
        ...falseWordScripts.evidence.math,
        visibleCharacters: 2,
        digits: 1,
        layoutAssignments: 1,
        latexStructure: true,
        decisiveStructure: true,
      },
    },
  }
  assert.equal(isScriptOnlyBaselineTextConflict(trueVariableScript), false)
  assert.equal(
    hasDecisiveAutomaticMathLayout(trueVariableScript),
    true,
    'Ein echtes variables Tiefindexmuster muss harte Mathematik bleiben.',
  )
  const trueLetterIndex = {
    ...falseWordScripts,
    value: 'x_{m a x}',
    textValue: 'xmax',
    mathValue: 'x_{m a x}',
    evidence: {
      text: {
        visibleCharacters: 4, letters: 4, digits: 0, letterRatio: 1, words: 1,
        knownWords: 0, knownWordRatio: 0, baselineAlignment: 0.45, lines: 1, strongSentence: false,
      },
      math: {
        ...falseWordScripts.evidence.math,
        visibleCharacters: 4,
        layoutAssignments: 3,
        latexStructure: true,
        decisiveStructure: true,
      },
    },
  }
  assert.equal(
    isScriptOnlyBaselineTextConflict(trueLetterIndex),
    false,
    'Ein tatsächlich versetzter Buchstabenindex darf nicht pauschal als Wort behandelt werden.',
  )
  assert.equal(
    assessNeuralTextModeCandidate('xmax', 'de', {
      ...neuralResult('xmax', 96), wordCount: 1, knownWordRatio: 0,
    }, trueLetterIndex).shouldUseText,
    false,
    'Eine sichere, aber lexikalisch unbelegte Buchstabenfolge darf einen echten Buchstabenindex nicht verdrängen.',
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
  const trainedTConflict = {
    ...standaloneIntegral,
    textValue: 'T',
    evidence: {
      ...standaloneIntegral.evidence,
      text: {
        visibleCharacters: 1, letters: 1, digits: 0, letterRatio: 1, words: 0,
        knownWords: 0, knownWordRatio: 0, baselineAlignment: 1, lines: 1, strongSentence: false,
      },
    },
  }
  assert.equal(
    assessNeuralTextModeCandidate('T', 'de', {
      ...neuralResult('T', 92), wordCount: 0, knownWordRatio: 0,
    }, trainedTConflict, {
      confidence: 91, source: 'personalized', personalizedCharacters: 1,
    }).shouldUseText,
    true,
    'Wenn Textbeam und persönliche T-Form übereinstimmen, darf ein kontextloses falsches Integral nicht gewinnen.',
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
