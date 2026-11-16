import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

try {
  const load = (path) => server.ssrLoadModule(path)
  const blocks = await load('/src/lib/study/blocks.ts')
  const tasks = await load('/src/lib/study/tasks.ts')
  const key = await load('/src/lib/study/keyTree.ts')
  const sort = await load('/src/lib/study/sortBoard.ts')
  const map = await load('/src/lib/study/conceptMap.ts')
  const cards = await load('/src/lib/study/cardsModels.ts')
  const render = await load('/src/lib/study/render.ts')
  const registry = await load('/src/lib/study/registry.ts')
  const marks = await load('/src/lib/study/marks.ts')
  const flash = await load('/src/lib/flashcards.ts')
  const lines = await load('/src/lib/study/pdfLines.ts')

  // -- fenced blocks ------------------------------------------------------------
  const note = [
    '# Notiz', '', '```js', '```fanotes-key', 'not a block', '```', '',
    '```fanotes-sort', '{"v":1,"title":"S","mode":"groups","cards":[],"groups":[]}', '```', '', 'Text', '',
    '````fanotes-term', '{"v":1,"terms":[]}', '````',
  ].join('\n')
  const found = blocks.findStudyBlocks(note)
  assert.deepEqual(found.map((block) => block.kind), ['sort', 'term'], 'blocks inside other fences are ignored')
  assert.equal(note.slice(found[0].from, found[0].to).startsWith('```fanotes-sort'), true)
  assert.equal(note.slice(found[0].from, found[0].to).endsWith('```'), true)
  const crlf = '```fanotes-map\r\n{"v":1}\r\n```\r\ntext'
  assert.equal(blocks.findStudyBlocks(crlf).length, 1)
  assert.equal(blocks.findStudyBlocks('```fanotes-map\n{"v":1}').length, 0, 'unclosed block is not a block')
  const replaced = blocks.replaceStudyBlock(note, found[0], 'sort', { v: 1, title: 'neu' })
  assert.equal(blocks.findStudyBlocks(replaced).length, 2)
  assert.ok(replaced.includes('"title": "neu"'))
  assert.ok(replaced.endsWith('````'), 'text after the block is untouched')
  const appended = blocks.insertStudyBlock('Hallo', 'map', { v: 1 })
  assert.equal(appended, 'Hallo\n\n```fanotes-map\n{\n "v": 1\n}\n```\n')
  assert.equal(blocks.findStudyBlocks(appended)[0].kind, 'map')
  assert.deepEqual(blocks.parseJsonObject('[1]'), {})
  assert.deepEqual(blocks.parseJsonObject('{broken'), {})

  // -- task detection -----------------------------------------------------------
  const page = (n, text) => ({ page: n, lines: text.split('\n') })
  const detected = tasks.detectTasks([
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
  ])
  const byId = Object.fromEntries(detected.map((task) => [task.id, task]))
  assert.deepEqual(detected.filter((task) => task.number).map((task) => task.number), ['1', '2', '4', '5', '7', '10', '12', '9', '14', '15'])
  assert.equal(byId['auftrag-1'].minutes, 45, '1 Lektion = 45 min')
  assert.equal(byId['auftrag-2'].minutes, 20, 'hint split across lines')
  assert.equal(byId['auftrag-2'].page, 3)
  assert.equal(byId['auftrag-4'].page, 4, 'first heading per number wins')
  assert.equal(byId['auftrag-4'].minutes, 20)
  assert.equal(byId['auftrag-5'].minutes, 60)
  assert.ok(byId['auftrag-5'].title.startsWith('In der Powerpoint-Präsentation'), 'time hint is not part of the title')
  assert.equal(byId['auftrag-7'].minutes, 10)
  assert.ok(byId['auftrag-10'].title.includes('Biologiebuch'), 'line-end hyphen joined')
  assert.ok(byId['auftrag-10'].title.includes('Hemi- und'), 'hyphen before "und" kept')
  assert.ok(byId['auftrag-12'].title.startsWith('Erklären Sie den Zusammenhang zwischen den beiden Hormonen'))
  assert.equal(byId['auftrag-9'].minutes, 15)
  assert.equal(byId['auftrag-14'].minutes, 15, 'collapsed one-line pages are split')
  assert.equal(byId['auftrag-15'].page, 7)
  assert.ok(!detected.some((task) => /Hormone ist/u.test(task.title)), '"Aufgabe der Hormone" is prose')
  const unnumbered = detected.find((task) => !task.number)
  assert.ok(unnumbered && unnumbered.minutes === 90 && unnumbered.page === 6, '"Auftrag:" without number and 1,5 h')
  assert.equal(tasks.parseTimeHint('siehe Abb. 9 h'), 0, 'loose hours need "ca."')
  assert.equal(tasks.parseTimeHint('(10-20 Min.)'), 15)
  assert.equal(tasks.parseTimeHint('Doppellektion'), 0)
  assert.equal(tasks.parseTimeHint('(2 Doppellektionen)'), 180)
  assert.deepEqual(tasks.dehyphenate(['Beob-', 'achte', 'Ein-', 'Zahl']), ['Beobachte', 'Ein-', 'Zahl'])

  // stored list round trip, edits survive a re-scan, JSON containing "-->" stays intact
  let pdfNote = 'Notiz\n<!-- fanotes-pdf-marks-v1\n{"marks":[]}\n-->\n'
  let list = tasks.mergeDetected(null, detected)
  list.tasks[0] = { ...list.tasks[0], done: true, spentSec: 125, title: 'Mit --> im Titel' }
  pdfNote = tasks.writeTaskList(pdfNote, list)
  const read = tasks.readTaskList(pdfNote)
  assert.equal(read.tasks.length, list.tasks.length)
  assert.equal(read.tasks[0].title, 'Mit --> im Titel')
  assert.ok(pdfNote.includes('fanotes-pdf-marks-v1'), 'other embedded data is kept')
  const again = tasks.mergeDetected({ tasks: read.tasks.map((task) => (task.id === 'auftrag-2' ? { ...task, manual: true, title: 'Mein Text', minutes: 30 } : task)), removed: ['auftrag-7'] }, detected)
  assert.equal(again.tasks.find((task) => task.id === 'auftrag-2').title, 'Mein Text')
  assert.equal(again.tasks.find((task) => task.id === 'auftrag-2').minutes, 30)
  assert.ok(!again.tasks.some((task) => task.id === 'auftrag-7'), 'removed tasks stay removed')
  assert.equal(again.tasks.find((task) => task.id === read.tasks[0].id).done, true, 'progress survives re-detection')
  assert.equal(tasks.writeTaskList(pdfNote, { tasks: [], removed: [] }).includes('fanotes-tasks'), false)
  assert.equal(tasks.readTaskList('plain'), null)
  const progress = tasks.taskProgress([{ ...list.tasks[0], done: true, minutes: 10 }, { ...list.tasks[1], done: false, minutes: 20, spentSec: 600 }])
  assert.equal(progress.done, 1)
  assert.equal(progress.ratio, 0.5)
  assert.equal(progress.remainingMinutes, 10)
  assert.equal(tasks.formatClock(3725), '1:02:05')
  assert.equal(tasks.formatClock(65), '01:05')
  assert.equal(tasks.newManualTask([{ ...list.tasks[0], number: '4' }], 2).number, '5')

  // pdf.js items -> lines
  assert.deepEqual(lines.itemsToLines([
    { str: 'Auftrag 3:', transform: [1, 0, 0, 1, 0, 700] }, { str: ' Skizzieren', transform: [1, 0, 0, 1, 50, 700], hasEOL: false },
    { str: 'zweite Zeile', transform: [1, 0, 0, 1, 0, 686] }, { str: ' dritte', hasEOL: true }, { str: 'vierte' },
  ]), ['Auftrag 3: Skizzieren', 'zweite Zeile dritte', 'vierte'])

  // -- table and key ---------------------------------------------------------------
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
  const leafNames = tree.nodes.filter((node) => node.kind === 'leaf').flatMap((node) => node.text.split(', ')).sort()
  assert.deepEqual(leafNames, table.items.map((item) => item.name).sort(), 'every item ends in exactly one leaf')
  assert.equal(tree.nodes.find((node) => node.id === tree.root).kind, 'question')
  assert.deepEqual(key.normaliseKeyTree(tree), tree, 'skeleton is already normalised')
  const layout = key.layoutKeyTree(tree)
  assert.equal(layout.nodes.length, tree.nodes.length)
  for (let i = 0; i < layout.nodes.length; i += 1) for (let j = i + 1; j < layout.nodes.length; j += 1) assert.ok(!overlap(layout.nodes[i], layout.nodes[j]), `tree nodes ${i}/${j} overlap`)
  for (const node of layout.nodes) assert.ok(node.x >= 0 && node.x + node.w <= layout.width + 1 && node.y + node.h <= layout.height + 1)
  const root = layout.nodes.find((node) => node.id === tree.root)
  assert.equal(root.y, Math.min(...layout.nodes.map((node) => node.y)), 'root is on top')
  const kids = layout.edges.filter((edge) => edge.from === tree.root)
  assert.ok(Math.abs((Math.min(...kids.map((edge) => edge.x2)) + Math.max(...kids.map((edge) => edge.x2))) / 2 - (root.x + root.w / 2)) < 1, 'parent centred above children')
  const cyclic = key.normaliseKeyTree({ root: 'a', nodes: [
    { id: 'a', kind: 'question', text: 'A?', branches: [{ label: 'x', to: 'b' }, { label: 'y', to: 'a' }, { label: 'z', to: 'ghost' }] },
    { id: 'b', kind: 'question', text: 'B?', branches: [{ label: 'back', to: 'a' }, { label: 'again', to: 'c' }] },
    { id: 'c', kind: 'leaf', text: 'C', branches: [{ label: 'no', to: 'a' }] },
    { id: 'orphan', kind: 'leaf', text: 'unreachable', branches: [] },
  ] })
  assert.deepEqual(cyclic.nodes.map((node) => node.id), ['a', 'b', 'c'])
  assert.deepEqual(cyclic.nodes[0].branches.map((branch) => branch.to), ['b'])
  assert.deepEqual(cyclic.nodes[2].branches, [])
  const grown = key.addChild(tree, tree.root, 'leaf', 'vielleicht')
  assert.equal(grown.nodes.length, tree.nodes.length + 1)
  const shrunk = key.removeSubtree(grown, tree.nodes.find((node) => node.id === tree.root).branches[0].to)
  assert.ok(shrunk.nodes.length < grown.nodes.length)
  assert.equal(key.removeSubtree(tree, tree.root), tree, 'root cannot be removed')
  assert.deepEqual(key.wrapText('Mundwerkzeuge saugend leckend', 14), ['Mundwerkzeuge', 'saugend', 'leckend'])
  const md = key.keyTableToMarkdown({ features: ['A|B'], items: [{ id: 'x', name: 'Käfer', values: ['ja\nnein'] }] })
  assert.equal(md, '| Art | A\\|B |\n| --- | --- |\n| Käfer | ja nein |')
  const grid = key.parseTablePaste('Art\tFlügel\tBeine\nKäfer\tja\t6\nFloh\tnein\t6')
  assert.deepEqual(key.tableFromGrid(grid).features, ['Flügel', 'Beine'])
  assert.equal(key.tableFromGrid(grid).items[1].values[0], 'nein')
  assert.deepEqual(key.parseTablePaste('| Art | X |\n| --- | --- |\n| a | b |'), [['Art', 'X'], ['a', 'b']])
  const keyData = key.normaliseKeyData({ title: 'Schlüssel', table, tree, compareImage: 'data:image/png;base64,AAAA' })
  assert.equal(keyData.compareImage, 'data:image/png;base64,AAAA')
  assert.equal(key.normaliseKeyData({ compareImage: 'javascript:alert(1)' }).compareImage, '', 'only small image data URLs are kept')
  const keyBlock = blocks.serializeStudyBlock('key', keyData)
  assert.deepEqual(key.parseKeyData(blocks.findStudyBlocks(keyBlock)[0].body), keyData, 'key block round-trips')
  assert.equal(key.parseKeyData('garbage').table.items.length, 2, 'bad JSON yields the starter key')

  // -- sort board -------------------------------------------------------------------
  assert.deepEqual(sort.parseCardList('1. Käfer\n- Fliegen\n• Flöhe\n\n  Wanzen '), ['Käfer', 'Fliegen', 'Flöhe', 'Wanzen'])
  assert.deepEqual(sort.parseCardList('Käfer, Fliegen; Flöhe'), ['Käfer', 'Fliegen', 'Flöhe'])
  let board = sort.addCards(sort.normaliseSortData({ title: 'Verwandlung', groups: [{ id: 'g1', title: 'hemimetabol' }, { id: 'g2', title: 'holometabol' }, { id: 'g3', title: 'ametabol' }] }), ['Käfer', 'Wanzen', 'Silberfischchen', 'Flöhe'])
  const ids = board.cards.map((card) => card.id)
  assert.equal(sort.unsortedCards(board).length, 4)
  board = sort.moveCard(board, ids[0], 'g2')
  board = sort.moveCard(board, ids[3], 'g2', 0)
  board = sort.moveCard(board, ids[1], 'g1')
  assert.deepEqual(board.groups[1].cards, [ids[3], ids[0]])
  board = sort.moveCard(board, ids[0], 'g3')
  assert.deepEqual(board.groups.map((group) => group.cards.length), [1, 1, 1], 'a card lives in one group only')
  assert.equal(sort.unsortedCards(board).length, 1)
  assert.equal(sort.moveCard(board, 'nope', 'g1'), board)
  const stored = blocks.findStudyBlocks(blocks.serializeStudyBlock('sort', board))[0]
  const reloaded = sort.parseSortData(stored.body)
  assert.deepEqual(reloaded, board, 'sorting persists through the fenced block')
  const text = sort.sortToMarkdown(board)
  assert.ok(text.startsWith('| hemimetabol | holometabol | ametabol |'))
  assert.ok(text.includes('| Wanzen | Flöhe | Käfer |'))
  const seq = sort.setMode(board, 'sequence')
  assert.equal(seq.groups.length, 1)
  assert.equal(seq.groups[0].cards.length, 3)
  assert.ok(sort.sortToMarkdown(seq).startsWith('1. '))
  assert.equal(sort.removeCard(board, ids[1]).cards.length, 3)
  const shuffled = sort.shuffleCards(board, () => 0.3)
  assert.equal(shuffled.cards.length, 4)
  assert.equal(sort.unsortedCards(shuffled).length, 4)
  assert.equal(sort.normaliseSortData({ cards: [{ id: 'a', text: 'x' }], groups: [{ id: 'g', cards: ['a'] }, { id: 'h', cards: ['a', 'zzz'] }] }).groups[1].cards.length, 0, 'duplicate placements are dropped')

  // -- concept map ------------------------------------------------------------------
  let cmap = map.defaultMapData()
  cmap = map.mapFromText({ ...cmap, nodes: [], edges: [] }, 'Häutungshormon -> löst aus -> Häutung\nJuvenilhormon -(hemmt)-> Verpuppung\nHäutung -> Wachstum\nWachstum -> Häutungshormon')
  assert.equal(cmap.nodes.length, 5)
  assert.equal(cmap.edges.length, 4)
  assert.equal(cmap.edges[0].label, 'löst aus')
  assert.equal(cmap.edges[1].label, 'hemmt')
  const placed = map.layoutMap(cmap)
  assert.equal(placed.nodes.length, 5)
  assert.equal(placed.edges.length, 4)
  for (let i = 0; i < placed.nodes.length; i += 1) for (let j = i + 1; j < placed.nodes.length; j += 1) assert.ok(!overlap(placed.nodes[i], placed.nodes[j]), 'map nodes overlap')
  const layerOf = (id) => placed.layers.findIndex((layer) => layer.includes(id))
  const idOf = (name) => cmap.nodes.find((node) => node.text === name).id
  assert.ok(layerOf(idOf('Häutungshormon')) < layerOf(idOf('Häutung')) && layerOf(idOf('Häutung')) < layerOf(idOf('Wachstum')), 'causes sit above effects despite the cycle')
  const sideways = map.layoutMap({ ...cmap, dir: 'LR' })
  assert.ok(sideways.nodes.find((node) => node.id === idOf('Wachstum')).x > sideways.nodes.find((node) => node.id === idOf('Häutungshormon')).x, 'left-to-right layout')
  assert.equal(map.normaliseMapData({ nodes: [{ id: 'a', text: 'A' }], edges: [{ from: 'a', to: 'a' }, { from: 'a', to: 'zz' }] }).edges.length, 0)
  assert.deepEqual(map.parseMapData(blocks.findStudyBlocks(blocks.serializeStudyBlock('map', cmap))[0].body), cmap)

  // -- plate, terms, flashcards ----------------------------------------------------
  const png = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  const plate = cards.normalisePlateData({ title: 'Schmetterlinge', cols: 3, items: [{ id: 'p1', label: 'Distelfalter', img: png }, { id: 'p2', label: 'Admiral', img: 'http://evil/x.png' }, { id: 'p3', label: '', img: png }] })
  assert.equal(plate.items[1].img, '', 'remote images are not accepted')
  const terms = cards.normaliseTermData({ terms: [{ id: 't1', term: 'Mimikry', definition: 'Nachahmung einer wehrhaften Art.', example: 'Schwebfliege', source: 'Buch S. 52' }, { id: 't2', term: 'Mimese', definition: '' }] })
  const cardNote = `# Biologie\n\n${blocks.serializeStudyBlock('plate', plate)}\n\n${blocks.serializeStudyBlock('term', terms)}\n`
  const sources = cards.studyCardSources(cardNote)
  assert.deepEqual(sources.map((source) => source.id), ['plate:p1', 'term:t1'], 'only complete entries become cards')
  const now = new Date(2026, 10, 15, 12)
  const deck = flash.cardsFromMarkdown(cardNote, now)
  assert.equal(deck.length, 2)
  const imageCard = deck.find((card) => card.id === 'plate:p1')
  assert.equal(imageCard.frontImage, png)
  assert.equal(imageCard.back, 'Distelfalter')
  const termCard = deck.find((card) => card.id === 'term:t1')
  assert.equal(termCard.front, 'Mimikry')
  assert.ok(termCard.back.includes('Beispiel: Schwebfliege') && termCard.back.includes('Quelle: Buch S. 52'))
  const graded = flash.applyReview(cardNote, 'plate:p1', 'good', now)
  assert.ok(!graded.includes('frontImage'), 'the schedule does not copy the picture')
  assert.equal(graded.split(png).length, cardNote.split(png).length, 'pictures stay only in the plate block')
  const regraded = flash.cardsFromMarkdown(graded, now)
  assert.equal(regraded.find((card) => card.id === 'plate:p1').reps, 1, 'schedule is kept by id')
  assert.equal(regraded.find((card) => card.id === 'plate:p1').frontImage, png)
  assert.equal(flash.cardsFromMarkdown('## Lernfragen\n\n<details><summary>Q?</summary>A</details>', now).length, 1, 'existing question cards still work')

  // sort result as Markdown: separator row, padded columns, escaped pipes, list form
  {
    let uneven = sort.addCards(sort.normaliseSortData({ groups: [{ id: 'g1', title: 'hemi | holo' }, { id: 'g2', title: 'ametabol' }, { id: 'g3', title: '' }] }), ['A | B', 'C', 'D', 'E'])
    const [a, c, d, e] = uneven.cards.map((card) => card.id)
    uneven = sort.moveCard(sort.moveCard(sort.moveCard(sort.moveCard(uneven, a, 'g1'), c, 'g1'), d, 'g1'), e, 'g2')
    const rows = sort.sortToMarkdown(uneven).split('\n')
    assert.equal(rows.length, 5, 'header, separator and three rows')
    assert.equal(rows[0], '| hemi \\| holo | ametabol | Gruppe 3 |')
    assert.equal(rows[1], '| --- | --- | --- |')
    assert.equal(rows[2], '| A \\| B | E |  |')
    assert.equal(rows[4], '| D |  |  |')
    assert.ok(rows.every((row) => row.split(/(?<!\\)\|/u).length === 5), 'every row has the same number of cells')
    assert.equal(sort.sortToMarkdown(uneven, 'list'), '**hemi | holo**\n- A | B\n- C\n- D\n\n**ametabol**\n- E')
    assert.equal(sort.sortToMarkdown(sort.normaliseSortData({ groups: [{ id: 'g1', title: 'x' }, { id: 'g2', title: 'y' }] })).split('\n').length, 3, 'empty board still yields a valid table')
  }

  // pictures: vault files are kept as paths, data URLs still read, hydration hook rendered
  {
    const ref = '.fanotes/worksheets/0b3e4f5a-1111-4222-8333-444455556666.jpg'
    assert.equal(blocks.asImage(ref), ref)
    assert.equal(blocks.asImage('.fanotes/worksheets/../../secret.jpg'), '')
    assert.equal(blocks.asImage('notes/x.png'), '')
    assert.equal(blocks.asImage('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA', 'old data URLs still read')
    const sheet = cards.normalisePlateData({ items: [{ id: 'p1', label: 'Admiral', img: ref }] })
    assert.equal(sheet.items[0].img, ref)
    const html = registry.renderStudyBlockHtml('plate', JSON.stringify(sheet))
    assert.ok(html.includes(`data-vault-src="${ref}"`) && !html.includes('src="."'), 'vault pictures are resolved after rendering')
    const note = `${blocks.serializeStudyBlock('plate', sheet)}\n`
    assert.ok(!note.includes('base64'), 'the note holds only the path')
    const deck = flash.cardsFromMarkdown(note, new Date(2026, 10, 15))
    assert.equal(deck[0].frontImage, ref, 'flashcards reference the same file')
    assert.ok(!flash.applyReview(note, 'plate:p1', 'good', new Date(2026, 10, 15)).includes('frontImage'))
  }

  // -- rendering ----------------------------------------------------------------------
  const evil = '<img src=x onerror=alert(1)>"&'
  const html = registry.renderStudyBlockHtml('key', JSON.stringify({ title: evil, table: { features: [evil], items: [{ id: 'a', name: evil, values: [evil] }] }, tree: { root: 'a', nodes: [{ id: 'a', kind: 'leaf', text: evil, branches: [] }] } }))
  assert.ok(!html.includes('<img src=x'), 'user text is escaped in the key view')
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  for (const kind of ['sort', 'map', 'plate', 'term']) {
    const out = registry.renderStudyBlockHtml(kind, JSON.stringify({ title: evil, terms: [{ id: 'a', term: evil, definition: evil }], items: [{ id: 'a', label: evil }], cards: [{ id: 'c', text: evil }], nodes: [{ id: 'a', text: evil }, { id: 'b', text: 'B' }], edges: [{ from: 'a', to: 'b', label: evil }], groups: [{ id: 'g', title: evil, cards: ['c'] }] }))
    assert.ok(!/<img src=x/u.test(out), `${kind} escapes user text`)
  }
  const exported = render.renderKeyTreeSvg(keyData, render.EXPORT_PALETTE)
  assert.ok(exported.svg.startsWith('<svg xmlns='))
  assert.ok(exported.svg.includes('#ffffff') && !exported.svg.includes('var(--'), 'export uses fixed colours')
  assert.ok(render.renderKeyTreeSvg(keyData).svg.includes('var(--text'), 'live view follows the theme')
  assert.ok(render.renderMapSvg(cmap, render.EXPORT_PALETTE).svg.includes('marker-end'))
  assert.equal(registry.renderStudyBlockHtml('map', '{}').includes('<svg'), true, 'broken data falls back to the starter map')

  // -- hostile block data ---------------------------------------------------------------
  // Whatever a note, a shared note or a synced file puts into a block must come out as inert markup.
  {
    const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'b', 'pre', 'figure', 'figcaption', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'svg', 'rect', 'path', 'text', 'defs', 'marker'])
    const SAFE_SRC = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/u
    /** Every tag and attribute of rendered markup: no scripts, handlers, links, styles that load things, or odd pictures. */
    const inert = (html, label) => {
      for (const [tag, closing, name, rest] of [...html.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>/gu)].map((match) => match.slice(0, 4))) {
        assert.ok(ALLOWED_TAGS.has(name.toLowerCase()), `${label}: unexpected tag ${tag.slice(0, 60)}`)
        if (closing) continue
        const attributes = [...rest.matchAll(/\s([A-Za-z][\w:-]*)="([^"]*)"/gu)]
        const leftover = rest.replace(/\s([A-Za-z][\w:-]*)="([^"]*)"/gu, '').replace(/\s*\/?\s*$/u, '')
        assert.equal(leftover, '', `${label}: attribute syntax in ${tag.slice(0, 80)}`)
        for (const [, attribute, value] of attributes) {
          const lower = attribute.toLowerCase()
          assert.ok(!lower.startsWith('on'), `${label}: event handler ${attribute}`)
          assert.ok(!['href', 'xlink:href', 'srcset', 'action', 'formaction', 'poster', 'background'].includes(lower), `${label}: link attribute ${attribute}`)
          if (lower === 'src') assert.ok(SAFE_SRC.test(value), `${label}: src ${value.slice(0, 60)}`)
          if (lower === 'data-vault-src') assert.ok(blocks.isVaultImageRef(value.replaceAll('&amp;', '&')), `${label}: data-vault-src ${value.slice(0, 60)}`)
          if (lower === 'style') assert.ok(!/url\s*\(|@import|expression\s*\(|javascript:|behavior|-moz-binding/iu.test(value), `${label}: style ${value.slice(0, 80)}`)
        }
      }
    }
    const texts = [
      '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "' onmouseover='alert(1)", '</text><script>alert(1)</script>',
      '&lt;b&gt; & &amp;', 'javascript:alert(1)', '<style>*{background:url(//tracker.example/p.png)}</style>', 'x\u2028<!--', '`${alert(1)}`',
    ]
    const hostileRefs = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/svg+xml,<svg onload=alert(1)>', 'data:image/png;base64,AAAA" onerror="alert(1)',
      'https://tracker.example/pixel.gif', '//tracker.example/p.png', 'http://127.0.0.1:1234/x.png', 'file:///etc/passwd', 'blob:https://x/uuid',
      '.fanotes/worksheets/abcdefgh.svg', '.fanotes/worksheets/../../secret.png', '.fanotes/worksheets/abcdefgh.png" onerror="alert(1)',
      '.fanotes/worksheets/abcdefgh.png\n', ' .fanotes/worksheets/abcdefgh.png', 'x', '',
    ]
    const vaultRef = '.fanotes/worksheets/0b3e4f5a-1111-4222-8333-444455556666.png'
    const dataRef = 'data:image/png;base64,iVBORw0KGgo='
    const keyData = (text, ref = '') => ({
      v: 1, title: text, compareImage: ref, compareLabel: text,
      table: { features: [text], items: [{ id: 'a', name: text, values: [text] }] },
      tree: { root: 'n1', nodes: [{ id: 'n1', kind: 'question', text, branches: [{ label: text, to: 'n2' }, { label: 'x', to: 'n3' }] }, { id: 'n2', kind: 'leaf', text }, { id: 'n3', kind: 'leaf', text }] },
    })
    const plateData = (text, ref = '', cols = 4) => ({ v: 1, title: text, cols, showLabels: true, items: [{ id: 'p1', label: text, note: text, img: ref }] })
    const mapData = (text) => ({ v: 1, title: text, nodes: [{ id: 'a', text }, { id: 'b', text }], edges: [{ id: 'e1', from: 'a', to: 'b', label: text }] })
    const sortData = (text) => ({ v: 1, title: text, mode: 'groups', cards: [{ id: 'c1', text }, { id: 'c2', text: `${text}2` }], groups: [{ id: 'g1', title: text, cards: ['c1'] }] })
    const termData = (text) => ({ v: 1, terms: [{ id: 't1', term: text, definition: text, example: text, source: text }] })
    const render1 = (kind, data) => registry.renderStudyBlockHtml(kind, JSON.stringify(data))

    // 1. Hostile text in every slot: the block renders (it is valid data) and nothing becomes markup.
    for (const text of texts) {
      for (const [kind, data] of [['key', keyData(text)], ['plate', plateData(text)], ['map', mapData(text)], ['sort', sortData(text)], ['term', termData(text)]]) {
        const html = render1(kind, data)
        assert.ok(!html.includes('lw-error'), `${kind} with hostile text still renders: ${text.slice(0, 16)}`)
        inert(html, `${kind} text=${text.slice(0, 16)}`)
      }
      // A block that is not valid JSON, or that FaNotes would not read completely, shows its source as escaped text.
      inert(registry.renderStudyBlockHtml('map', `{ ${text}`), `broken block ${text.slice(0, 16)}`)
      inert(registry.renderStudyBlockHtml('key', JSON.stringify({ ...keyData(text), extra: text })), `lossy block ${text.slice(0, 16)}`)
    }
    // 2. Hostile picture references and column counts through the whole pipeline: refused or shown as source, never rendered.
    for (const ref of hostileRefs) {
      inert(render1('plate', plateData('x', ref)), `plate ref=${ref.slice(0, 24)}`)
      inert(render1('key', keyData('x', ref)), `key ref=${ref.slice(0, 24)}`)
    }
    for (const cols of ['4;background:url(//tracker.example/p.png)', '4" onclick="alert(1)', 1.5, -3, 9, 1e9, '0x2', {}, [3], null, true]) inert(render1('plate', plateData('x', '', cols)), `cols ${JSON.stringify(cols)}`)
    // Allowed pictures still render.
    assert.match(render1('plate', plateData('x', vaultRef)), /<img data-vault-src="\.fanotes\/worksheets\/0b3e4f5a-1111-4222-8333-444455556666\.png" alt="x"\/>/u)
    assert.match(render1('plate', plateData('x', dataRef)), /<img alt="x" src="data:image\/png;base64,iVBORw0KGgo="\/>/u)
    assert.ok(render1('key', keyData('x', vaultRef)).includes('lw-compare'), 'a vault picture next to the key still renders')

    // 3. The renderer on its own, as a future caller that does not read the block through the normaliser would use it.
    const rawPlate = (img, cols = 4) => ({ v: 1, title: 't', cols, showLabels: true, items: [{ id: 'p', label: 'l', note: '', img }] })
    const rawKey = (ref) => ({ ...key.normaliseKeyData(keyData('k')), compareImage: ref })
    for (const ref of hostileRefs) {
      assert.equal(render.imgTag(ref, 'alt'), '', `imgTag refuses ${JSON.stringify(ref.slice(0, 30))}`)
      const plate = render.renderStudyHtml('plate', rawPlate(ref))
      inert(plate, `renderStudyHtml plate ref=${ref.slice(0, 24)}`)
      assert.ok(plate.includes('lw-plate-empty') && !plate.includes('<img'), `a refused picture leaves the placeholder: ${ref.slice(0, 24)}`)
      const keyHtml = render.renderStudyHtml('key', rawKey(ref))
      inert(keyHtml, `renderStudyHtml key ref=${ref.slice(0, 24)}`)
      assert.ok(!keyHtml.includes('lw-compare'), `a refused comparison picture drops the whole figure: ${ref.slice(0, 24)}`)
    }
    assert.equal(render.imgTag(vaultRef, 'a"b'), `<img data-vault-src="${vaultRef}" alt="a&quot;b"/>`)
    assert.equal(render.imgTag(dataRef, '<b>'), `<img alt="&lt;b&gt;" src="${dataRef}"/>`)
    assert.equal(render.imgTag(`data:image/png;base64,${'A'.repeat(blocks.IMAGE_DATA_LIMIT)}`, 'big'), '', 'oversized data URLs are refused')
    assert.equal(render.imgTag(undefined, 'x'), '')
    for (const cols of ['4;background:url(//tracker.example/p.png)', '4" onclick="alert(1)', 1.5, -3, 0, 9, 1e9, {}, null, undefined, NaN, Infinity, '', ' ', 'x']) {
      const html = render.renderStudyHtml('plate', rawPlate('', cols))
      inert(html, `renderStudyHtml cols ${JSON.stringify(cols)}`)
      assert.match(html, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/u, `cols ${String(cols).slice(0, 12)} falls back to the default`)
    }
    // Values the reader has always coerced with Number() (hex strings, one-element arrays, booleans) still come out as one integer 1..8.
    for (const cols of ['0x2', [3], true, '5', ' 6 ']) {
      const html = render.renderStudyHtml('plate', rawPlate('', cols))
      inert(html, `renderStudyHtml coerced cols ${JSON.stringify(cols)}`)
      assert.match(html, /grid-template-columns:repeat\([1-8],minmax\(0,1fr\)\)"/u, `cols ${JSON.stringify(cols)} stays one integer 1..8`)
    }
    for (const [cols, expected] of [[1, 1], [8, 8], [3, 3], ['5', 5]]) assert.match(render.renderStudyHtml('plate', rawPlate('', cols)), new RegExp(`repeat\\(${expected},minmax`, 'u'), `cols ${cols}`)
    assert.deepEqual([1.5, '4;x', 9, 0, 3].map(cards.plateColumns), [4, 4, 4, 4, 3], 'the reader and the renderer share one rule')
  }

  // -- highlights overview -------------------------------------------------------------
  const sample = [
    { id: 'm2', page: 5, quote: 'Zweite Stelle', kind: 'highlight' },
    { id: 'm1', page: 2, quote: 'Erste Stelle', kind: 'underline' },
    { id: 'm3', page: 5, quote: 'Dritte Stelle', kind: 'highlight' },
  ]
  const grouped = marks.groupMarksByPage(sample)
  assert.deepEqual(grouped.map((group) => [group.page, group.marks.length]), [[2, 1], [5, 2]])
  const noteMd = marks.marksToMarkdown('Gliederfüsser.pdf', sample)
  assert.ok(noteMd.startsWith('# Markierungen: Gliederfüsser.pdf\n\n## Seite 2\n\n- __Erste Stelle__ (S. 2)'))
  assert.ok(noteMd.includes('## Seite 5\n\n- ==Zweite Stelle== (S. 5)\n- ==Dritte Stelle== (S. 5)'))

  // -- integrity regressions ----------------------------------------------------------
  {
    const fresh = { tasks: [{ id: 'auftrag-1', number: '1', title: 'Neu', minutes: 5, page: 1, done: true, spentSec: 0, manual: false }], removed: [] }
    const count = (text, marker) => text.split(marker).length - 1

    // (1) a broken or unterminated tasks comment must not be duplicated or lose data silently
    const brokenClosed = 'Text\n<!-- fanotes-tasks-v1\n{ "tasks": [ oops\n-->\nMehr Text\n'
    assert.equal(tasks.readTaskList(brokenClosed), null)
    const repaired = tasks.writeTaskList(brokenClosed, fresh)
    assert.equal(count(repaired, '<!-- fanotes-tasks-v1\n'), 1, 'exactly one live comment')
    assert.ok(repaired.includes('<!-- fanotes-tasks-v1-broken\n{ "tasks": [ oops'), 'the broken text is kept, renamed')
    assert.equal(tasks.readTaskList(repaired).tasks[0].title, 'Neu', 'the new list reads back')
    assert.equal(tasks.writeTaskList(repaired, { ...fresh, tasks: [{ ...fresh.tasks[0], title: 'Zwei' }] }).split('fanotes-tasks-v1-broken').length, 2, 'a second write does not rename again or duplicate')
    const twice = '<!-- fanotes-tasks-v1\n{bad\n-->\nx\n<!-- fanotes-tasks-v1\n' + JSON.stringify(fresh) + '\n-->\n'
    assert.equal(tasks.readTaskList(twice).tasks[0].title, 'Neu', 'a valid later comment is used when the first is broken')
    const dupValid = `<!-- fanotes-tasks-v1\n${JSON.stringify(fresh)}\n-->\nmid\n<!-- fanotes-tasks-v1\n${JSON.stringify(fresh)}\n-->\n`
    const merged1 = tasks.writeTaskList(dupValid, fresh)
    assert.equal(count(merged1, '<!-- fanotes-tasks-v1\n'), 1, 'older duplicates are collapsed into one')
    assert.ok(merged1.includes('mid'))
    const open = 'Vor\n<!-- fanotes-tasks-v1\n{ "tasks": [\nNach dem Kommentar steht Text.'
    assert.equal(tasks.writeTaskList(open, fresh), null, 'an unterminated comment is not written around')
    assert.equal(tasks.writeTaskList(open, { tasks: [], removed: [] }), null)
    const swallow = 'Vor\n<!-- fanotes-tasks-v1 {bad\ntext\n<!-- fanotes-tasks-v1\n' + JSON.stringify(fresh) + '\n-->\n'
    assert.equal(tasks.writeTaskList(swallow, fresh), null, 'a broken comment that runs into the next marker is refused')

    // (2) clearing the list touches only the comment, not blank lines elsewhere
    const user = 'Zeile\n\n\n\nDrei Leerzeilen davor\n```\ncode\n\n\n\nmehr code\n```\n'
    const withList = tasks.writeTaskList(user, fresh)
    assert.equal(tasks.writeTaskList(withList, { tasks: [], removed: [] }), user, 'add then clear gives the note back byte for byte')
    const middle = 'A\n\n\n\nB\n<!-- fanotes-tasks-v1\n' + JSON.stringify(fresh) + '\n-->\nC\n\n\n\nD\n'
    assert.equal(tasks.writeTaskList(middle, { tasks: [], removed: [] }), 'A\n\n\n\nB\nC\n\n\n\nD\n', 'blank lines in the user text survive')
    assert.equal(tasks.writeTaskList(user, { tasks: [], removed: [] }), user, 'clearing with nothing stored changes nothing')

    // (3) a block that cannot be read, or would be cut, is reported and never rewritten
    assert.equal(registry.readStudyBlock('sort', '{ "cards": [ broken').ok, false)
    assert.equal(registry.readStudyBlock('sort', '[1,2]').ok, false)
    assert.equal(registry.readStudyBlock('key', '').ok, true, 'an empty body is the starter block')
    const tooMany = JSON.stringify({ v: 1, cards: Array.from({ length: 130 }, (_, index) => ({ id: `c${index}`, text: `K${index}` })), groups: [{ id: 'g', title: 'x', cards: [] }] })
    const capped = registry.readStudyBlock('sort', tooMany)
    assert.equal(capped.ok, false, 'a list past the cap is refused, not cut')
    assert.ok(/130/u.test(capped.error))
    assert.equal(registry.readStudyBlock('term', JSON.stringify({ terms: [{ id: 't', term: 'A', definition: 'x'.repeat(2500) }] })).ok, false, 'long text is refused, not shortened')
    assert.equal(registry.readStudyBlock('plate', JSON.stringify({ items: [{ id: 'p', label: 'x', img: 'http://evil/x.png' }] })).ok, false, 'a rejected picture is reported')
    assert.equal(registry.readStudyBlock('key', JSON.stringify({ tree: { root: 'a', nodes: [{ id: 'a', kind: 'leaf', text: 'A' }, { id: 'lost', kind: 'leaf', text: 'unreachable' }] } })).ok, false, 'dropped nodes are reported')
    const html = registry.renderStudyBlockHtml('sort', '{ "cards": [ broken')
    assert.ok(html.includes('lw-error') && html.includes('{ &quot;cards&quot;: [ broken'.replace('&quot;', '&quot;')), 'the preview shows the reason and the source')
    const withExtra = { v: 1, title: 'T', mode: 'groups', cards: [{ id: 'c1', text: 'A' }], groups: [{ id: 'g1', title: 'G', cards: ['c1'] }], futureField: { keep: [1, 2, 3] }, note: 'von Hand' }
    const readExtra = registry.readStudyBlock('sort', JSON.stringify(withExtra))
    assert.equal(readExtra.ok, true)
    assert.deepEqual(readExtra.extra, { futureField: { keep: [1, 2, 3] }, note: 'von Hand' })
    const written = blocks.studyBlockBody(sort.moveCard(readExtra.data, 'c1', null), readExtra.extra)
    assert.deepEqual(JSON.parse(written).futureField, { keep: [1, 2, 3] }, 'unknown top-level fields survive a write')
    assert.equal(JSON.parse(written).note, 'von Hand')
    for (const [kind, data] of [['key', key.defaultKeyData()], ['sort', board], ['map', cmap], ['plate', plate], ['term', terms]]) {
      assert.equal(registry.readStudyBlock(kind, blocks.studyBlockBody(data)).ok, true, `${kind} data made by the editors reads back without loss`)
    }
    assert.equal(registry.readStudyBlock('key', blocks.studyBlockBody(keyData)).ok, true, 'a skeleton key reads back without loss')

    // (4) the block is found again by its fingerprint, never by position alone
    const bodyA = blocks.studyBlockBody({ v: 1, title: 'A', mode: 'groups', cards: [], groups: [] })
    const bodyB = blocks.studyBlockBody({ v: 1, title: 'B', mode: 'groups', cards: [], groups: [] })
    const docText = `Intro\n\n\`\`\`fanotes-sort\n${bodyA}\n\`\`\`\n\nMitte\n\n\`\`\`fanotes-sort\n${bodyB}\n\`\`\`\n`
    const refA = blocks.findStudyBlocks(docText)[0]
    const hashA = blocks.hashText(refA.body)
    assert.equal(blocks.locateStudyBlock(docText, 'sort', hashA, refA.from).from, refA.from)
    const shifted = `Neuer Absatz davor.\n${docText}`
    assert.equal(blocks.locateStudyBlock(shifted, 'sort', hashA, refA.from).body, bodyA, 'block found after text was added before it')
    const swapped = docText.replace(bodyA, blocks.studyBlockBody({ v: 1, title: 'A geändert', mode: 'groups', cards: [], groups: [] }))
    assert.equal(blocks.locateStudyBlock(swapped, 'sort', hashA, refA.from), null, 'a block edited meanwhile is not overwritten')
    const removedFirst = docText.replace(/```fanotes-sort\n[\s\S]*?\n```\n\nMitte\n\n/u, '')
    const left = blocks.locateStudyBlock(removedFirst, 'sort', hashA, refA.from)
    assert.equal(left, null, 'when the block is gone, the one that moved into its place is not taken')
    const twins = `\`\`\`fanotes-sort\n${bodyA}\n\`\`\`\n\nx\n\n\`\`\`fanotes-sort\n${bodyA}\n\`\`\`\n`
    const second = blocks.findStudyBlocks(twins)[1]
    assert.equal(blocks.locateStudyBlock(twins, 'sort', hashA, second.from).from, second.from, 'identical twins: the one at the remembered offset')
    assert.equal(blocks.locateStudyBlock(twins, 'sort', hashA, 9999), null, 'identical twins elsewhere: refuse')
    assert.equal(blocks.locateStudyBlock(docText, 'map', hashA, refA.from), null, 'kind must match')
  }

  console.log('study tools checks passed')
} finally {
  await server.close()
}
