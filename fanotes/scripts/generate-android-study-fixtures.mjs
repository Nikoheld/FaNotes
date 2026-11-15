// Writes the desktop study-tool results the Android core tests compare against.
// Run from fanotes/: node scripts/generate-android-study-fixtures.mjs
// Output: ../android/core/src/test/resources/study/vectors.json (synthetic data only).
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
try {
  const load = (path) => server.ssrLoadModule(path)
  const blocks = await load('/src/lib/study/blocks.ts')
  const tasks = await load('/src/lib/study/tasks.ts')
  const key = await load('/src/lib/study/keyTree.ts')
  const sort = await load('/src/lib/study/sortBoard.ts')
  const map = await load('/src/lib/study/conceptMap.ts')
  const cards = await load('/src/lib/study/cardsModels.ts')

  const page = (n, text) => ({ page: n, lines: text.split('\n') })
  const pages = [
    page(3, [
      'Rechercheauftrag (erweitertes Lernziel): Der Stamm der Gliederfüsser',
      'Auftrag 1: Zeichnen Sie ein Insekt oder Ausschnitte davon ab und achten Sie auf die im',
      'Grundbauplan beschriebenen Details! Schreiben Sie diese Details an! (ca. 1 Lektion)',
      '',
      'Auftrag 2: Zeichnen Sie die einzelnen Teile der Mundwerkzeuge einer Biene so genau wie',
      'möglich unter dem Binokular ab. Vergleichen Sie dann Ihre Skizze mit der Abbildung (Ca. 20',
      'Minuten)',
      'Aufgabe der Hormone ist die Steuerung der Häutung.',
    ].join('\n')),
    page(4, [
      'Auftrag 4: Lesen Sie die folgenden Texte durch und markieren Sie die wesentlichen Punkte!',
      '(Ca. 20 Minuten)',
      '   Auftrag 5 (ca. 60 Minuten): In der Powerpoint-Präsentation zu den Gliederfüssern finden Sie',
      'auf der letzten Folie eine Zusammenstellung mit 15 Insektenordnungen.',
      'Auftrag 7: Recherchieren Sie im Internet, was man unter Mimikry versteht. (10 Minuten)',
      'Auftrag 10: Studieren Sie zur Hemi- und Holometablie die Seiten 48 und 49 in Ihrem Biolo-',
      'giebuch',
      'Auftrag 12: Erklären Sie den Zusam-',
      'menhang zwischen den beiden Hor-',
      'monen und den Häutungen. Task 3 ist ein Hinweis.',
    ].join('\n')),
    page(6, 'Auftrag 4 beantwortet die Frage nicht.\nAuftrag: Nennen Sie die Nützlinge aus dem Film. Weshalb ist es von Vorteil? (ca. 1,5 h)\nExercise 9: Übung für Fortgeschrittene (15 min)'),
    page(7, 'Hier steht alles in einer Zeile. Auftrag 14: Beobachten Sie die Grillen (ca. 15 Minuten) und schreiben Sie auf. Auftrag 15: Fassen Sie die Bienensprache zusammen (ca. 15 Minuten). Das war es.'),
    page(8, ['Aufgabe 3a) Skizzieren Sie den Körper (2 Doppellektionen)', 'Übung 4. Weiter so', 'Arbeitsauftrag 6 – Lesen Sie den Text ½ Std.'].join('\n')),
  ]
  const detected = tasks.detectTasks(pages)
  const hints = ['(ca. 20 Minuten)', '1 Lektion', 'siehe Abb. 9 h', '(10-20 Min.)', 'Doppellektion', '(2 Doppellektionen)', 'ca. 1,5 h', '(45 min)', "(5')", '30 Minuten', '(ca. 2 Stunden)', 'etwa 90 min', '(1000 Min.)']
  const hyphen = [['Beob-', 'achte', 'Ein-', 'Zahl'], ['Hemi-', 'und Holo', 'Hor-', 'monen und']]

  // stored list with a "-->" inside a title, plus another embedded block that must survive
  let pdfNote = 'Notiz\n<!-- fanotes-pdf-marks-v1\n{"marks":[]}\n-->\n'
  const list = tasks.mergeDetected(null, detected)
  list.tasks[0] = { ...list.tasks[0], done: true, spentSec: 125, title: 'Mit --> im Titel' }
  list.tasks[1] = { ...list.tasks[1], manual: true, minutes: 30, title: 'Mein "Text"\nzweite Zeile' }
  pdfNote = tasks.writeTaskList(pdfNote, { tasks: list.tasks, removed: ['auftrag-7'] })
  const stored = tasks.readTaskList(pdfNote)
  const rescan = tasks.mergeDetected(stored, detected)

  // blocks: raw (what a hand edited note may hold) and the desktop's normalised serialisation
  const table = {
    features: ['Flügel', 'Mundwerkzeuge saugend', 'Verwandlung'],
    items: [
      { id: 'a', name: 'Käfer', values: ['ja', 'nein', 'holometabol'] },
      { id: 'b', name: 'Schmetterlinge', values: ['ja', 'ja', 'holometabol'] },
      { id: 'c', name: 'Wanzen', values: ['ja', 'ja', 'hemimetabol'] },
      { id: 'd', name: 'Flöhe', values: ['nein', 'ja', 'holometabol'] },
      { id: 'e', name: 'Silberfischchen', values: ['nein', 'nein', 'ametabol'] },
    ],
  }
  const tree = key.skeletonFromTable(table)
  const vaultImage = '.fanotes/worksheets/0b3e4f5a-1111-4222-8333-444455556666.jpg'
  const raw = {
    key: { title: 'Schlüssel', junk: 1, table: { ...table, items: [...table.items, { id: 'f', name: 'Biene', values: ['ja'] }] }, tree, compareImage: vaultImage, compareLabel: 'Buch S. 12' },
    sort: { title: 'Verwandlung', mode: 'groups', cards: [{ id: 'c1', text: 'Käfer' }, { id: 'c2', text: 'Wanzen' }, { id: 'c3', text: 'Flöhe' }, { id: 'c4', text: '' }, { id: 'c5', text: 'Fünfte Karte' }], groups: [{ id: 'g1', title: 'hemimetabol', cards: ['c2', 'zzz'] }, { id: 'g2', title: 'holometabol', cards: ['c1', 'c2'] }, { id: 'g3', title: 'ametabol', cards: [] }] },
    map: { title: 'Häutung', dir: 'LR', nodes: [{ id: 'a', text: 'Häutungshormon' }, { id: 'b', text: 'Häutung' }, { id: 'c', text: 'Wachstum bei Insekten mit langem Namen' }, { id: 'a', text: 'dup' }], edges: [{ id: 'e1', from: 'a', to: 'b', label: 'löst aus' }, { id: 'e2', from: 'b', to: 'c', label: '' }, { id: 'e3', from: 'c', to: 'a', label: 'hemmt' }, { id: 'e4', from: 'a', to: 'a' }, { id: 'e5', from: 'a', to: 'zz' }] },
    plate: { title: 'Schmetterlinge', cols: 3, items: [{ id: 'p1', label: 'Distelfalter', note: 'wandert', img: vaultImage }, { id: 'p2', label: 'Admiral', img: 'http://evil/x.png' }, { id: 'p3', label: '', img: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }], showLabels: false },
    term: { terms: [{ id: 't1', term: 'Mimikry', definition: 'Nachahmung einer wehrhaften Art.', example: 'Schwebfliege', source: 'Buch S. 52' }, { id: 't2', term: 'Mimese', definition: '' }, { id: 't3', term: 'Dritter', definition: 'x' }] },
  }
  const normalisers = {
    key: key.normaliseKeyData, sort: sort.normaliseSortData, map: map.normaliseMapData, plate: cards.normalisePlateData, term: cards.normaliseTermData,
  }
  const fixtures = {}
  const rawBlocks = []
  const normalised = {}
  for (const kind of Object.keys(raw)) {
    const data = normalisers[kind](raw[kind])
    normalised[kind] = data
    fixtures[kind] = { raw: raw[kind], expectedBlock: blocks.serializeStudyBlock(kind, data) }
    rawBlocks.push(`\`\`\`fanotes-${kind}\n${JSON.stringify(raw[kind])}\n\`\`\``)
  }
  const note = `# Biologie\n\n${rawBlocks.join('\n\n')}\n\n\`\`\`js\n\`\`\`fanotes-key\nnot a block\n\`\`\`\n\nEnde\n`
  const desktopNote = `# Biologie\n\n${Object.keys(raw).map((kind) => fixtures[kind].expectedBlock).join('\n\n')}\n\nEnde\n`

  const cmap = map.normaliseMapData(raw.map)
  const sortData = normalised.sort
  const moved = sort.moveCard(sort.moveCard(sortData, 'c3', 'g1', 0), 'c1', null)
  const out = {
    detect: { pages, tasks: detected },
    timeHints: hints.map((text) => [text, tasks.parseTimeHint(text)]),
    dehyphenate: hyphen.map((lines) => [lines, tasks.dehyphenate(lines)]),
    clocks: [0, 65, 3725, 86399].map((seconds) => [seconds, tasks.formatClock(seconds)]),
    pdfNote,
    stored,
    rescan,
    progress: tasks.taskProgress(stored.tasks),
    blocks: fixtures,
    note,
    desktopNote,
    keyLayout: key.layoutKeyTree(normalised.key.tree),
    mapLayout: map.layoutMap(cmap),
    mapLayers: map.layerMap(cmap),
    sortMoved: { block: blocks.serializeStudyBlock('sort', moved), unsorted: sort.unsortedCards(moved).map((card) => card.id) },
    cardSources: cards.studyCardSources(desktopNote),
    wrap: [['Mundwerkzeuge saugend leckend', 14], ['Superlangeswortohnezwischenraumdasumgebrochenwerdenmuss', 10], ['', 5]].map(([text, max]) => [text, max, key.wrapText(text, max)]),
  }
  const target = new URL('../../android/core/src/test/resources/study/vectors.json', import.meta.url)
  await mkdir(new URL('./', target), { recursive: true })
  await writeFile(target, `${JSON.stringify(out, null, 1)}\n`)
  console.log(`wrote ${target.pathname}: ${detected.length} tasks, ${out.cardSources.length} card sources`)
} finally {
  await server.close()
}
