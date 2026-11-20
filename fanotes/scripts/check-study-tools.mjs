import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  const key = await load('/src/lib/study/keyTree.ts')
  const sort = await load('/src/lib/study/sortBoard.ts')
  const map = await load('/src/lib/study/conceptMap.ts')
  const cards = await load('/src/lib/study/cardsModels.ts')
  const render = await load('/src/lib/study/render.ts')
  const registry = await load('/src/lib/study/registry.ts')
  const flash = await load('/src/lib/flashcards.ts')

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

  // -- integrity regressions ----------------------------------------------------------
  {
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

  // -- editor states are written in a form the reader accepts again (the editors used to lock out their own author) --
  {
    const read = (kind, data) => registry.readStudyBlock(kind, blocks.studyBlockBody(data))
    const keyed = { ...key.defaultKeyData(), table, tree: key.skeletonFromTable(table) }
    const inner = keyed.tree.nodes.find((node) => node.kind === 'question' && node.id !== keyed.tree.root)
    const below = key.descendantIds(keyed.tree, inner.id)
    assert.ok(below.length > 0, 'fixture: a question with something below it')

    // Question -> "Ergebnis" used to patch only the kind: the branches stayed in the written JSON, the reader cut them, and the block was refused.
    const stale = { ...keyed, tree: { ...keyed.tree, nodes: keyed.tree.nodes.map((node) => (node.id === inner.id ? { ...node, kind: 'leaf' } : node)) } }
    assert.equal(read('key', stale).ok, false, 'the old editor state is exactly what the reader refuses')
    assert.equal(read('key', registry.normaliseStudyData('key', stale)).ok, true, 'normalising before the write keeps the block readable')

    // The toggle itself: a result has no branches, so everything below goes with it ...
    const asLeaf = key.setNodeKind(keyed.tree, inner.id, 'leaf')
    assert.equal(asLeaf.nodes.length, keyed.tree.nodes.length - below.length)
    assert.ok(below.every((id) => !asLeaf.nodes.some((node) => node.id === id)), 'no orphans are left behind')
    assert.deepEqual(asLeaf.nodes.find((node) => node.id === inner.id), { id: inner.id, kind: 'leaf', text: inner.text, branches: [] })
    assert.deepEqual(key.normaliseKeyTree(asLeaf), asLeaf, 'nothing is left for the normaliser to cut')
    assert.equal(read('key', { ...keyed, tree: asLeaf }).ok, true, 'question -> result reads back whole')
    // ... and back: an empty question that reads back too and takes branches again.
    const asQuestion = key.setNodeKind(asLeaf, inner.id, 'question')
    assert.equal(asQuestion.nodes.find((node) => node.id === inner.id).kind, 'question')
    assert.deepEqual(asQuestion.nodes.find((node) => node.id === inner.id).branches, [])
    assert.equal(read('key', { ...keyed, tree: asQuestion }).ok, true, 'result -> question reads back whole')
    const regrown = key.addChild(asQuestion, inner.id, 'leaf', 'ja')
    assert.equal(regrown.nodes.length, asQuestion.nodes.length + 1)
    assert.equal(read('key', { ...keyed, tree: regrown }).ok, true)
    assert.equal(key.setNodeKind(asLeaf, inner.id, 'leaf'), asLeaf, 'the same kind changes nothing')
    // Round trip through the real write path (normalise, serialise, read): the data comes back as it went in.
    const written = blocks.serializeStudyBlock('key', registry.normaliseStudyData('key', { ...keyed, tree: regrown }))
    const again = registry.readStudyBlock('key', blocks.findStudyBlocks(written)[0].body)
    assert.equal(again.ok, true)
    assert.deepEqual(again.data.tree, key.normaliseKeyTree(regrown), 'toggle round trip: question -> result -> question -> new branch survives a save and a reopen')
    assert.equal(again.data.tree.nodes.length, regrown.nodes.length, 'and nothing is dropped on the way')
    // The root can be switched as well.
    const rootLeaf = key.setNodeKind(keyed.tree, keyed.tree.root, 'leaf')
    assert.equal(rootLeaf.nodes.length, 1)
    assert.equal(read('key', { ...keyed, tree: rootLeaf }).ok, true)

    // Every other editor state the models cannot hold is cut down before it is written, not after.
    const many = (count, make) => Array.from({ length: count }, (_, index) => make(index))
    const bad = {
      key: { ...keyed, table: { features: many(25, (i) => `M${i}`), items: many(61, (i) => ({ id: `i${i}`, name: `A${i}`, values: many(25, () => 'x') })) }, title: 'x'.repeat(130), tree: { root: 'a', nodes: [{ id: 'a', kind: 'question', text: 'y'.repeat(310), branches: many(9, (i) => ({ label: 'l', to: `c${i}` })) }, ...many(9, (i) => ({ id: `c${i}`, kind: 'leaf', text: `c${i}`, branches: [] }))] } },
      sort: { v: 1, title: 'S', mode: 'groups', cards: many(125, (i) => ({ id: `c${i}`, text: `K${i}` })), groups: [{ id: 'g1', title: 'x', cards: ['c1', 'ghost'] }, { id: 'g2', title: 'y', cards: ['c1'] }] },
      map: { v: 1, title: 'M', dir: 'TB', nodes: many(81, (i) => ({ id: `n${i}`, text: `B${i}` })), edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'x' }, { id: 'e2', from: 'n1', to: 'n2', label: 'x' }, { id: 'e3', from: 'n3', to: 'n3', label: '' }, { id: 'e4', from: 'n3', to: 'ghost', label: '' }] },
      plate: { v: 1, title: 'P', cols: 4, showLabels: true, items: many(41, (i) => ({ id: `p${i}`, label: `L${i}`, note: '', img: '' })) },
      term: { v: 1, terms: [{ id: 'long', term: 'x', definition: 'z'.repeat(2100), example: '', source: '' }, ...many(30, (i) => ({ id: `t${i}`, term: `T${i}`, definition: 'd', example: '', source: '' }))] },
    }
    for (const [kind, data] of Object.entries(bad)) {
      assert.equal(read(kind, data).ok, false, `${kind}: fixture is beyond what the reader accepts`)
      const fixed = registry.normaliseStudyData(kind, data)
      assert.equal(read(kind, fixed).ok, true, `${kind}: a normalised editor state reads back whole`)
      assert.deepEqual(registry.normaliseStudyData(kind, fixed), fixed, `${kind}: normalising twice changes nothing`)
      assert.ok(registry.findLoss(data, fixed), `${kind}: the host can tell that something was cut`)
    }
    assert.equal(registry.findLoss(keyed, registry.normaliseStudyData('key', keyed)), null, 'a clean state reports no loss')
    assert.equal(registry.findLoss(asLeaf, registry.normaliseStudyData('key', { ...keyed, tree: asLeaf }).tree), null)

    // The editors stop short of the caps instead of being cut.
    const wide = { ...key.emptyKeyTree(), nodes: key.emptyKeyTree().nodes.map((node) => (node.id === 'n1' ? { ...node, branches: many(8, (i) => ({ label: '', to: `n${i + 2}` })) } : node)).concat(many(6, (i) => ({ id: `n${i + 4}`, kind: 'leaf', text: '', branches: [] }))) }
    assert.equal(key.canAddChild(wide, 'n1'), false, 'a question takes at most 8 branches')
    assert.equal(key.addChild(wide, 'n1', 'leaf', 'x'), wide)
    assert.equal(key.canAddChild(key.emptyKeyTree(), 'n2'), false, 'a result takes no branches')
    assert.equal(key.addChild(key.emptyKeyTree(), 'n2', 'leaf', 'x').nodes.length, 3, 'and no orphan node is created for it')
    const full = { root: 'r', nodes: [{ id: 'r', kind: 'question', text: 'r', branches: [{ label: '', to: 'x0' }] }, ...many(199, (i) => ({ id: `x${i}`, kind: 'leaf', text: '', branches: [] }))] }
    assert.equal(key.canAddChild(full, 'r'), false, 'a key holds at most 200 nodes')
    assert.equal(key.wrapInQuestion(full, 'x0'), full)
    let net = map.defaultMapData()
    for (let step = 0; step < 100; step += 1) net = map.addMapNode(net)
    assert.equal(net.nodes.length, map.MAP_LIMITS.nodes, 'the "+ Box" button stops at the cap')
    assert.equal(map.addMapNode(net), net)
    let small = { ...map.defaultMapData(), edges: [] }
    small = map.addMapNode(small)
    for (let step = 0; step < 20; step += 1) small = map.addMapEdge(small)
    assert.equal(small.edges.length, 6, '"+ Pfeil" fills the three boxes with all six possible arrows and then stops')
    assert.equal(new Set(small.edges.map((edge) => `${edge.from}>${edge.to}`)).size, 6, 'every new arrow joins a pair that had none')
    assert.equal(map.freeMapPair(small), null)
    assert.deepEqual(map.normaliseMapData(small), small, 'the arrows added by the editor survive the normaliser')
    const [first] = small.edges
    assert.equal(map.patchMapEdge(small, first.id, { to: first.from }), 'loop', 'an arrow cannot return to its own box')
    const other = small.edges.find((edge) => edge.from === first.from && edge.to !== first.to)
    assert.equal(map.patchMapEdge(small, other.id, { to: first.to, label: first.label }), 'copy', 'nor repeat another arrow')
    assert.equal(map.patchMapEdge(small, other.id, { label: 'neu' }).edges.find((edge) => edge.id === other.id).label, 'neu')
    // Quick entry: a chain makes one arrow per step, and a repeated line makes none.
    const chain = map.mapFromText({ ...map.defaultMapData(), nodes: [], edges: [] }, 'Licht -> Photosynthese -> Zucker -> Wachstum\nLicht -> Photosynthese')
    assert.deepEqual(chain.edges.map((edge) => [chain.nodes.find((node) => node.id === edge.from).text, chain.nodes.find((node) => node.id === edge.to).text]), [['Licht', 'Photosynthese'], ['Photosynthese', 'Zucker'], ['Zucker', 'Wachstum']])
    // Pasted cards that do not fit stay with the caller.
    const pile = sort.parseCardList(many(130, (i) => `Karte ${i}`).join('\n'))
    assert.equal(pile.length, 130, 'parsing keeps every line')
    const filled = sort.addCards(sort.defaultSortData(), pile)
    assert.equal(filled.cards.length, sort.SORT_LIMITS.cards)
    assert.equal(pile.slice(sort.cardRoom(sort.defaultSortData())).length, 10, 'the ten that did not fit are known')
    assert.equal(sort.cardRoom(filled), 0)
    assert.equal(sort.addCards(filled, ['mehr']).cards.length, sort.SORT_LIMITS.cards)
    // A deleted card comes back where it was.
    const withCards = sort.addCards(sort.defaultSortData(), ['A', 'B', 'C'])
    const [cardA, cardB, cardC] = withCards.cards.map((card) => card.id)
    const arranged = sort.moveCard(sort.moveCard(sort.moveCard(withCards, cardA, 'g1'), cardB, 'g1'), cardC, 'g2')
    const taken = sort.takeCard(arranged, cardB)
    assert.deepEqual(taken.data.groups[0].cards, [cardA])
    assert.equal(taken.data.cards.length, 2)
    assert.deepEqual(sort.restoreCard(taken.data, taken.removed), arranged, 'undo puts the card back in place')
    assert.equal(sort.restoreCard(arranged, taken.removed), arranged, 'a card that is already there is not duplicated')
    assert.equal(sort.takeCard(arranged, 'nope'), null)

  }

  // -- key layout: descriptive branch labels never collide ----------------------------------------------------------
  {
    const rng = (seed) => () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const words = ['Flügel', 'häutig', 'Hinterflügel', 'Vorderflügel', 'Mundwerkzeuge', 'stechend-saugend', 'beißend', 'Flügeldecken', 'harten', 'umgebildet', 'Schmetterlingsschuppen', 'fehlen', 'Fühler', 'fadenförmig', 'geknickt', 'Hinterleibsende', 'Schwanzfäden', 'Springgabel', 'Körperanhänge', 'Insektenordnung', 'Zweiflügler', 'Hautflügler', 'Schnabelkerfe', 'Geradflügler', 'dicht', 'netzartig', 'Larven', 'aquatisch', 'wasserlebend', 'Rüssel', 'gegliedert', 'zu', 'mit', 'und', 'oder', 'ohne', 'kleiner', 'als', 'die', 'der', 'Metamorphose', 'Hinterflügelgeäderdiagnosemerkmal']
    const phrase = (random, min, max) => {
      let out = ''
      const target = min + Math.floor(random() * (max - min + 1))
      while (out.length < target) out += `${out ? ' ' : ''}${words[Math.floor(random() * words.length)]}`
      return out.slice(0, max).trim()
    }
    const longLabel = (random) => (random() < 0.12 ? '' : random() < 0.2 ? (random() < 0.5 ? 'ja' : 'nein') : phrase(random, 24, 80))
    /** A random key: `ladder` hangs each next question under the previous one, `any` grows at random places. */
    const randomKey = (random, shape, size) => {
      const nodes = [{ id: 'n1', kind: 'question', text: phrase(random, 3, 60), branches: [] }]
      const open = [nodes[0]]
      while (nodes.length < size && open.length) {
        const parent = shape === 'ladder' ? open[open.length - 1] : open[Math.floor(random() * open.length)]
        if (parent.branches.length >= 8) { open.splice(open.indexOf(parent), 1); continue }
        const id = `n${nodes.length + 1}`
        const kind = shape === 'ladder' ? (parent.branches.length === 0 ? 'leaf' : 'question') : random() < 0.4 ? 'question' : 'leaf'
        const node = { id, kind, text: phrase(random, 2, kind === 'leaf' ? 40 : 60), branches: [] }
        parent.branches.push({ label: longLabel(random), to: id })
        nodes.push(node)
        if (kind === 'question') open.push(node)
        if (shape === 'ladder' && parent.branches.length >= 2) open.splice(open.indexOf(parent), 1)
      }
      return key.normaliseKeyTree({ root: 'n1', nodes })
    }
    const segments = (edge) => [
      { part: 'stem', x: edge.x1 - 0.5, y: edge.y1, w: 1, h: edge.busY - edge.y1 },
      { part: 'bus', x: Math.min(edge.x1, edge.x2), y: edge.busY - 0.5, w: Math.max(1, Math.abs(edge.x2 - edge.x1)), h: 1 },
      { part: 'drop', x: edge.x2 - 0.5, y: edge.busY, w: 1, h: edge.y2 - edge.busY },
    ]
    const checkLayout = (tree, name) => {
      const placedLayout = key.layoutKeyTree(tree)
      assert.equal(placedLayout.nodes.length, tree.nodes.length, `${name}: every node is placed once`)
      const boxes = placedLayout.nodes.map((node) => ({ what: `box ${node.id}`, ...node }))
      const labels = placedLayout.edges.filter((edge) => edge.labelBox).map((edge) => ({ what: `label ${edge.from}>${edge.to}`, edge, ...edge.labelBox }))
      const all = [...boxes, ...labels]
      for (let i = 0; i < all.length; i += 1) {
        const item = all[i]
        assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= placedLayout.width && item.y + item.h <= placedLayout.height, `${name}: ${item.what} lies outside the drawing`)
        for (let j = i + 1; j < all.length; j += 1) assert.ok(!overlap(item, all[j]), `${name}: ${item.what} overlaps ${all[j].what}`)
      }
      for (const edge of placedLayout.edges) {
        const child = placedLayout.nodes.find((node) => node.id === edge.to)
        for (const line of segments(edge)) {
          for (const item of all) {
            const own = item.edge === edge
            if (own && line.part === 'drop') continue // a label sits on the line of its own branch, that is the idea
            assert.ok(!overlap(line, item), `${name}: the ${line.part} of ${edge.from}>${edge.to} runs through ${item.what}`)
          }
        }
        if (edge.labelBox) {
          assert.ok(edge.labelBox.y >= edge.busY && edge.labelBox.y + edge.labelBox.h < child.y, `${name}: the label of ${edge.to} sits between the run and its box, with line left below`)
          assert.ok(Math.abs(edge.labelBox.x + edge.labelBox.w / 2 - (child.x + child.w / 2)) <= 1, `${name}: the label of ${edge.to} is centred on its branch`)
        }
      }
      return placedLayout
    }

    let checked = 0
    let longest = 0
    for (let seed = 1; seed <= 120; seed += 1) {
      const random = rng(seed)
      const shape = seed % 3 === 0 ? 'ladder' : 'any'
      const tree = randomKey(random, shape, 4 + Math.floor(random() * (shape === 'ladder' ? 30 : 56)))
      checkLayout(tree, `${shape} ${seed}`)
      longest = Math.max(longest, ...tree.nodes.flatMap((node) => node.branches.map((branch) => branch.label.length)))
      checked += 1
    }
    assert.ok(checked === 120 && longest >= 70, 'the generated keys really carry long descriptive labels')

    // Fixed shapes that hurt: a 15-order ladder, one question with eight long branches, a tall chain, odd glyphs.
    const lab = 'Vorderflügel zu harten Flügeldecken (Elytren) umgebildet, Hinterflügel häutig, 2 Paar'
    assert.ok(lab.length > 80)
    const ladderNodes = []
    for (let i = 1; i <= 15; i += 1) {
      ladderNodes.push({ id: `q${i}`, kind: 'question', text: `Merkmal ${i} vorhanden?`, branches: [{ label: lab.slice(0, 80), to: `o${i}` }, ...(i < 15 ? [{ label: 'Mundwerkzeuge stechend-saugend, Rüssel gegliedert', to: `q${i + 1}` }] : [{ label: 'ja', to: 'o16' }])] })
      ladderNodes.push({ id: `o${i}`, kind: 'leaf', text: `Ordnung ${i} (Insecta)`, branches: [] })
    }
    ladderNodes.push({ id: 'o16', kind: 'leaf', text: 'Restgruppe', branches: [] })
    const ladder = key.normaliseKeyTree({ root: 'q1', nodes: ladderNodes })
    assert.equal(ladder.nodes.length, 31, 'fixture: a 15-order ladder, 31 nodes')
    const ladderLayout = checkLayout(ladder, '15-order ladder')
    const star = key.normaliseKeyTree({ root: 'r', nodes: [{ id: 'r', kind: 'question', text: 'Frage', branches: Array.from({ length: 8 }, (_, i) => ({ label: `${lab.slice(i, 80)}`, to: `k${i}` })) }, ...Array.from({ length: 8 }, (_, i) => ({ id: `k${i}`, kind: 'leaf', text: `K${i}`, branches: [] }))] })
    checkLayout(star, 'eight long branches')
    const chainNodes = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, kind: 'question', text: 'Weiter?', branches: [{ label: lab, to: `c${i + 1}` }] }))
    chainNodes.push({ id: 'c30', kind: 'leaf', text: 'Ende', branches: [] })
    checkLayout(key.normaliseKeyTree({ root: 'c0', nodes: chainNodes }), 'chain of 30')
    for (const [name, label] of [['one long word', 'Ä'.repeat(80)], ['capitals', 'FLÜGEL HÄUTIG MUNDWERKZEUGE STECHEND SAUGEND ÜBERSEITE DICHT BEHAART']] ) {
      checkLayout(key.normaliseKeyTree({ root: 'a', nodes: [{ id: 'a', kind: 'question', text: 'X?', branches: [{ label, to: 'b' }, { label, to: 'c' }] }, { id: 'b', kind: 'leaf', text: 'B', branches: [] }, { id: 'c', kind: 'leaf', text: 'C', branches: [] }] }), name)
    }
    checkLayout(key.normaliseKeyTree({ root: 'a', nodes: [{ id: 'a', kind: 'question', text: 'X?', branches: [{ label: '翅は膜質で、後翅は小さい昆虫類の分類群を示す形質', to: 'b' }, { label: '🪲🪲🪲🪲🪲🪲🪲🪲🪲🪲🪲🪲🪲🪲🪲🪲', to: 'c' }] }, { id: 'b', kind: 'leaf', text: 'B', branches: [] }, { id: 'c', kind: 'leaf', text: 'C', branches: [] }] }), 'wide glyphs')
    // A single leaf, an empty tree and a damaged tree (cycle, shared child) still lay out.
    assert.equal(key.layoutKeyTree({ root: 'x', nodes: [{ id: 'x', kind: 'leaf', text: 'Nur ein Ergebnis', branches: [] }] }).edges.length, 0)
    assert.equal(key.layoutKeyTree({ root: 'none', nodes: [] }).nodes.length, 0)
    const cyc = key.layoutKeyTree({ root: 'a', nodes: [{ id: 'a', kind: 'question', text: 'A', branches: [{ label: 'x', to: 'b' }, { label: 'y', to: 'b' }] }, { id: 'b', kind: 'question', text: 'B', branches: [{ label: 'back', to: 'a' }] }] })
    assert.equal(cyc.nodes.length, 2, 'a cycle or a shared child does not loop or place a node twice')
    // A result that still carries branches (raw editor state) has none in the picture.
    assert.equal(key.layoutKeyTree({ root: 'a', nodes: [{ id: 'a', kind: 'leaf', text: 'A', branches: [{ label: 'x', to: 'b' }] }, { id: 'b', kind: 'leaf', text: 'B', branches: [] }] }).nodes.length, 1)
    // Short labels keep the usual gap between two rows; labels with several lines give their row the room they need.
    const rowGaps = (placedLayout) => {
      const tops = [...new Set(placedLayout.nodes.map((node) => node.y))].sort((a, b) => a - b)
      return tops.slice(1).map((top, index) => top - (tops[index] + Math.max(...placedLayout.nodes.filter((node) => node.y === tops[index]).map((node) => node.h))))
    }
    assert.deepEqual([...new Set(rowGaps(checkLayout(tree, 'skeleton from the table')))], [54], 'one-line labels fit the usual gap')
    assert.ok(Math.max(...rowGaps(ladderLayout)) > 54, 'long labels widen the gap between two rows')

    // The picture: wrapped label lines are drawn, nothing is drawn outside the viewBox.
    const drawing = render.renderKeyTreeSvg({ ...key.defaultKeyData(), title: 'Insektenordnungen', tree: ladder })
    const view = /viewBox="0 0 (\d+) (\d+)"/u.exec(drawing.svg)
    assert.deepEqual([Number(view[1]), Number(view[2])], [drawing.width, drawing.height])
    for (const [, x, y, w, h] of drawing.svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/gu)) {
      assert.ok(Number(x) >= 0 && Number(y) >= 0 && Number(x) + Number(w) <= drawing.width && Number(y) + Number(h) <= drawing.height, 'every box and label is inside the viewBox')
    }
    const wrapped = key.wrapText(lab.slice(0, 80), key.LABEL_METRICS.wrap)
    assert.ok(wrapped.length >= 3 && wrapped.every((line) => line.length <= key.LABEL_METRICS.wrap + 6), 'a long label is wrapped to narrow lines')
    for (const line of wrapped) assert.ok(drawing.svg.includes(`>${blocks.escapeHtml(line)}</text>`), `label line "${line}" is drawn`)
    assert.ok(!drawing.svg.includes(lab.slice(0, 80)), 'the label is never one long line')
    assert.ok(render.renderKeyTreeSvg(keyData, render.EXPORT_PALETTE).svg.includes('>ja</text>'), 'short labels are still drawn on one line')
  }

  // -- concept map drawing -------------------------------------------------------------------------------------------
  {
    const labelled = { ...map.defaultMapData(), nodes: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], edges: [{ id: 'e', from: 'a', to: 'b', label: 'führt zu' }] }
    const themed = render.renderMapSvg(labelled).svg
    assert.ok(!/fill:#fff[;"]/u.test(themed), 'the live drawing has no white patches behind the labels in the dark theme')
    assert.ok(themed.includes('fill:var(--panel'), 'label backgrounds follow the panel colour')
    assert.ok(render.renderMapSvg(labelled, render.EXPORT_PALETTE).svg.includes('fill:#ffffff;opacity:.92'), 'the export stays on white')
    const [one, two] = [render.renderMapSvg(labelled).svg, render.renderMapSvg(labelled).svg]
    const marker = (svg) => /<marker id="([^"]+)"/u.exec(svg)[1]
    assert.notEqual(marker(one), marker(two), 'every map has its own arrowhead id')
    assert.ok(one.includes(`marker-end="url(#${marker(one)})"`) && two.includes(`marker-end="url(#${marker(two)})"`), 'and uses it')
  }

  // -- building a key from a table, pasting a table, restructuring a key -----------------------------------------------
  {
    // A free-text column is skipped, and the editor is told which one and which items stayed together.
    const freeText = {
      features: ['Flügel', 'Beschreibung'],
      items: [
        { id: '1', name: 'Käfer', values: ['ja', 'Flügeldecken hart, Hinterflügel häutig'] },
        { id: '2', name: 'Wanzen', values: ['ja', 'Halbflügeldecken, Stinkdrüsen'] },
        { id: '3', name: 'Libellen', values: ['ja', 'zwei Paar netzartig geädert'] },
        { id: '4', name: 'Schmetterlinge', values: ['ja', 'beschuppt, Rollrüssel'] },
        { id: '5', name: 'Bienen', values: ['ja', 'häutig, Stechapparat'] },
        { id: '6', name: 'Silberfischchen', values: ['nein', 'Körper beschuppt'] },
      ],
    }
    const report = key.skeletonReport(freeText)
    assert.deepEqual(report.unusable, ['Beschreibung'], 'the column with five different texts is named as skipped')
    assert.deepEqual(report.merged.map((names) => [...names].sort()), [['Bienen', 'Käfer', 'Libellen', 'Schmetterlinge', 'Wanzen']], 'and so are the items that stayed together in one result')
    assert.deepEqual(report.tree, key.skeletonFromTable(freeText))
    const clean = key.skeletonReport(table)
    assert.deepEqual([clean.unusable, clean.merged], [[], []], 'a table the skeleton can fully split reports nothing')
    assert.deepEqual(key.skeletonReport({ features: [], items: [] }).merged, [])

    // Spreadsheet paste: an empty top-left cell keeps its place, quoted cells keep line breaks, quotes and the other separators.
    assert.deepEqual(key.parseTablePaste('\tFlügel\tBeine\nKäfer\tja\t6\r\nFloh\tnein\t6\r\n'), [['', 'Flügel', 'Beine'], ['Käfer', 'ja', '6'], ['Floh', 'nein', '6']])
    assert.deepEqual(key.tableFromGrid(key.parseTablePaste('\tFlügel\tBeine\nKäfer\tja\t6')).features, ['Flügel', 'Beine'], 'no column is lost or shifted')
    assert.deepEqual(key.parseTablePaste('Art\tNotiz\n"Käfer"\t"Flügel: häutig,\n2 Paar, ""hart"""\nFloh\tein Semikolon; hier\n'), [['Art', 'Notiz'], ['Käfer', 'Flügel: häutig,\n2 Paar, "hart"'], ['Floh', 'ein Semikolon; hier']])
    assert.deepEqual(key.parseTablePaste('Art\tA\tB\t\nx\t1\t2\t\n'), [['Art', 'A', 'B'], ['x', '1', '2']], 'columns a spreadsheet pads on the right are dropped')
    assert.deepEqual(key.parseTablePaste('Art;Flügel\nKäfer;ja\n\nFloh;nein'), [['Art', 'Flügel'], ['Käfer', 'ja'], ['Floh', 'nein']])
    assert.deepEqual(key.parseTablePaste('| Art | X |\n| :--- | ---: |\n| a \\| b | c |'), [['Art', 'X'], ['a | b', 'c']], 'an escaped pipe stays in its cell')
    assert.deepEqual(key.parseTablePaste(key.keyTableToMarkdown({ features: ['A|B'], items: [{ id: 'x', name: 'Käfer', values: ['ja | nein'] }] })), [['Art', 'A|B'], ['Käfer', 'ja | nein']], 'the table we export can be pasted back')
    assert.deepEqual(key.parseTablePaste('  \n\n'), [])

    // Restructuring.
    const base = key.skeletonFromTable(table)
    const q = base.nodes.find((node) => node.id === base.root)
    const [firstBranch, secondBranch] = q.branches
    const swapped = key.moveNode(base, secondBranch.to, -1)
    assert.deepEqual(swapped.nodes.find((node) => node.id === base.root).branches.map((branch) => branch.to), [secondBranch.to, firstBranch.to], 'a branch moves up with its label')
    assert.equal(key.moveNode(base, firstBranch.to, -1), base, 'the first branch cannot move up')
    assert.equal(key.moveNode(base, base.root, 1), base, 'the root has no siblings')
    assert.deepEqual(key.normaliseKeyTree(swapped).nodes.length, base.nodes.length)
    const beside = key.addSibling(base, firstBranch.to)
    const order = beside.nodes.find((node) => node.id === base.root).branches.map((branch) => branch.to)
    assert.equal(order.length, q.branches.length + 1)
    assert.equal(order[1], key.nextNodeId(base), 'a sibling goes in right after the node, not at the end')
    assert.equal(key.addSibling(base, base.root), base)
    const wrapped = key.wrapInQuestion(base, secondBranch.to)
    const wrapper = wrapped.nodes.find((node) => node.id === key.nextNodeId(base))
    assert.deepEqual([wrapper.kind, wrapper.text, wrapper.branches.map((branch) => branch.to)[0]], ['question', '', secondBranch.to])
    assert.equal(wrapped.nodes.find((node) => node.id === base.root).branches[1].to, wrapper.id, 'the new question takes the place of the node')
    assert.equal(wrapped.nodes.length, base.nodes.length + 2)
    assert.equal(key.wrapInQuestion(base, base.root).root, key.nextNodeId(base), 'wrapping the root puts the new question on top')
    for (const tree of [swapped, beside, wrapped, key.wrapInQuestion(base, base.root)]) assert.deepEqual(key.normaliseKeyTree(tree).nodes.length, tree.nodes.length, 'restructuring never leaves anything for the normaliser to cut')
    assert.equal(registry.readStudyBlock('key', blocks.studyBlockBody({ ...key.defaultKeyData(), tree: wrapped })).ok, true)

    // The key as numbered couplets, for the note.
    assert.equal(key.keyToCoupletsMarkdown({ root: 'a', nodes: [
      { id: 'a', kind: 'question', text: 'Flügel vorhanden?', branches: [{ label: 'ja', to: 'b' }, { label: 'nein', to: 'c' }] },
      { id: 'b', kind: 'question', text: 'Mundwerkzeuge saugend?', branches: [{ label: 'ja', to: 'd' }, { label: 'nein', to: 'e' }] },
      { id: 'c', kind: 'leaf', text: 'Silberfischchen', branches: [] },
      { id: 'd', kind: 'leaf', text: 'Wanzen', branches: [] },
      { id: 'e', kind: 'leaf', text: 'Käfer', branches: [] },
    ] }), '1. Flügel vorhanden?\n   - a) ja → 2\n   - b) nein → Silberfischchen\n2. Mundwerkzeuge saugend?\n   - a) ja → Wanzen\n   - b) nein → Käfer')
    assert.equal(key.keyToCoupletsMarkdown({ root: 'a', nodes: [{ id: 'a', kind: 'leaf', text: 'Nur Käfer', branches: [] }] }), 'Nur Käfer')
    assert.equal(key.keyToCoupletsMarkdown(key.emptyKeyTree()).split('\n').length, 3, 'the starter key is one question with two branches')
  }

  // -- cards keep their schedule: ids do not change from read to read ----------------------------------------------------
  {
    const idless = JSON.stringify({ v: 1, terms: [{ term: 'Mimikry', definition: 'Nachahmung.' }, { term: 'Mimese', definition: 'Tarnung.' }, { term: 'Mimikry', definition: 'Nachahmung.' }] })
    const [first, second] = [cards.parseTermData(idless), cards.parseTermData(idless)]
    assert.deepEqual(first.terms.map((term) => term.id), second.terms.map((term) => term.id), 'terms without ids get the same ids on every read')
    assert.equal(new Set(first.terms.map((term) => term.id)).size, 3, 'also when two entries say the same')
    const sheet = JSON.stringify({ v: 1, title: 'T', items: [{ label: 'Admiral', img: 'data:image/jpeg;base64,AAAA' }, { label: 'Admiral', img: 'data:image/jpeg;base64,AAAA' }] })
    assert.deepEqual(cards.parsePlateData(sheet).items.map((item) => item.id), cards.parsePlateData(sheet).items.map((item) => item.id))
    const noteOf = (...bodies) => bodies.map((body) => `\`\`\`fanotes-term\n${body}\n\`\`\``).join('\n\n')
    const ids = (note) => cards.studyCardSources(note).map((card) => card.id)
    assert.deepEqual(ids(noteOf(idless)), ids(noteOf(idless)), 'the same note yields the same card ids twice, so a stored schedule is found again')
    assert.equal(new Set(ids(noteOf(idless))).size, 3, 'and an entry written twice in one block stays two cards')
    // A block copied within a note shares its ids: an exact copy adds nothing, an edited copy adds its own cards, and the first keeps its plain id.
    const original = JSON.stringify({ v: 1, terms: [{ id: 't1', term: 'Mimikry', definition: 'Nachahmung.' }] })
    const edited = JSON.stringify({ v: 1, terms: [{ id: 't1', term: 'Mimikry', definition: 'Nachahmung einer wehrhaften Art.' }] })
    assert.deepEqual(ids(noteOf(original, original)), ['term:t1'], 'an exact copy is not a second card')
    const both = ids(noteOf(original, edited))
    assert.equal(both.length, 2, 'an edited copy is its own card')
    assert.equal(both[0], 'term:t1', 'the first block keeps the id its schedule is stored under')
    assert.equal(ids(noteOf(edited, original))[0], 'term:t1', 'whichever block comes first keeps the plain id')
  }

  console.log('study tools checks passed')
} finally {
  await server.close()
}
