import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const load = (path) => server.ssrLoadModule(path)
  const caesar = await load('/src/lib/study/crypto/caesar.ts')
  const freq = await load('/src/lib/study/crypto/freq.ts')
  const vig = await load('/src/lib/study/crypto/vigenere.ts')
  const xor = await load('/src/lib/study/crypto/xor.ts')
  const mod = await load('/src/lib/study/crypto/modular.ts')
  const dh = await load('/src/lib/study/crypto/dh.ts')
  const model = await load('/src/lib/study/crypto/model.ts')
  const html = await load('/src/lib/study/crypto/html.ts')
  const blocks = await load('/src/lib/study/blocks.ts')
  const registry = await load('/src/lib/study/registry.ts')
  const states = (cells) => cells.map((cell) => cell.state)

  // -- Caesar, given alphabet, keyword ---------------------------------------------
  assert.equal(caesar.shiftAlphabet(3), 'DEFGHIJKLMNOPQRSTUVWXYZABC')
  assert.equal(caesar.shiftAlphabet(0), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  assert.equal(caesar.encryptWith('veni, vidi, vici', caesar.shiftAlphabet(3)), 'YHQL, YLGL, YLFL')
  assert.equal(caesar.encryptWith('dieser satz ist geheim', caesar.shiftAlphabet(3)).toLowerCase(), 'glhvhu vdwc lvw jhkhlp')
  const given = caesar.checkAlphabet('J L P A W I Q B C T R Z Y D S K E G F X H U O N V M')
  assert.ok(given.ok)
  assert.equal(caesar.encryptWith('et tu, brutus?', given.letters), 'WX XH, LGHXHF?')
  const broken = caesar.checkAlphabet('A B C A')
  assert.ok(!broken.ok && broken.duplicates.includes('A') && broken.missing.length === 23)
  assert.ok(!caesar.checkAlphabet('J L P A W I Q B C T R Z Y D S K E G F X H U O N V 1').ok, 'invalid character')
  assert.equal(caesar.keywordAlphabet('julius caesar'), 'JULISCAERTVWXYZBDFGHKMNOPQ')
  assert.equal(caesar.encryptWith('errare humanum est', caesar.keywordAlphabet('julius caesar')), 'SFFJFS EKXJYKX SGH')
  assert.equal(caesar.keywordAlphabet('kantonsschule'), 'KANTOSCHULEFGIJMPQRVWXYZBD')
  assert.equal(caesar.keywordAlphabet(''), '')
  assert.deepEqual(caesar.keywordParts('julius caesar').filter((part) => part.kind === 'repeat').map((part) => part.ch), ['u', 's', 'a'], 'repeated letters are struck')
  assert.ok(caesar.unusedLetters('JULI____________________').includes('A') && !caesar.unusedLetters('JULI').includes('J'))
  assert.deepEqual(caesar.checkBuilt('julius caesar', 'JUX_________________________').slice(0, 4), ['ok', 'ok', 'bad', 'open'])

  // checking marks wrong letters without revealing the right ones
  const task = 'veni, vidi'
  const alpha = caesar.shiftAlphabet(3)
  assert.deepEqual(states(caesar.checkAnswer(task, 'YHQL, YLGL', alpha)), ['ok', 'ok', 'ok', 'ok', 'keep', 'keep', 'ok', 'ok', 'ok', 'ok'])
  const wrong = caesar.checkAnswer(task, 'YXQL, Y', alpha)
  assert.deepEqual(states(wrong).slice(0, 3), ['ok', 'bad', 'ok'])
  assert.equal(JSON.stringify(wrong).includes('H'), false, 'the right letter is not part of the verdict')
  assert.deepEqual(wrong.map((cell) => cell.ch).join(''), 'YXQL, Y')
  assert.equal(caesar.checkAnswer(task, 'yhql, ylgl', alpha).every((cell) => cell.state !== 'bad'), true, 'case-insensitive')
  assert.equal(caesar.checkAnswer(task, 'YHQL; YLGL', alpha)[4].state, 'bad', 'punctuation must be kept')
  const summary = caesar.summariseAnswer(task, caesar.checkAnswer(task, 'YXQL, Y', alpha))
  assert.deepEqual([summary.ok, summary.bad, summary.open, summary.total], [4, 1, 3, 8])

  // the hint reveals exactly one letter
  const hint1 = caesar.hintAnswer(task, '', alpha)
  assert.equal(hint1.index, 0)
  assert.equal(hint1.answer, 'Y')
  const hint2 = caesar.hintAnswer(task, 'YXQL', alpha)
  assert.equal(hint2.answer, 'YHQL')
  assert.equal([...hint2.answer].filter((ch, index) => ch !== 'YXQL'[index]).length, 1)
  const hint3 = caesar.hintAnswer(task, 'YHQL, ', alpha)
  assert.equal(hint3.answer, 'YHQL, Y')
  const hint4 = caesar.hintAnswer('ab, cd', 'BC', caesar.shiftAlphabet(1))
  assert.equal(hint4.answer, 'BC, D', 'padding keeps punctuation of the task')
  assert.equal(caesar.hintAnswer(task, 'YHQL, YLGL', alpha), null, 'nothing left to reveal')
  assert.equal(caesar.hintAnswer(task, '', ''), null, 'no alphabet, no hint')

  // -- frequency analysis ----------------------------------------------------------
  const rows = freq.frequencyRows('AAB B? cA')
  assert.deepEqual(rows.slice(0, 3).map((row) => [row.letter, row.count]), [['A', 3], ['B', 2], ['C', 1]])
  assert.equal(rows.length, 26)
  assert.ok(Math.abs(rows[0].percent - 50) < 1e-9)
  assert.equal(freq.frequencyRows('').every((row) => row.count === 0 && row.percent === 0), true)
  assert.deepEqual(freq.referenceRows('de').slice(0, 3).map((row) => row.letter), ['E', 'N', 'I'])
  assert.equal(freq.referenceRows('en')[0].letter, 'E')
  assert.equal(freq.referenceRows('en').length, 26)
  assert.equal(freq.referenceRows('de').length, 26)
  const tokens = freq.applyMap('Ab, Cq', { A: 'e', C: 'n' })
  assert.deepEqual(tokens.map((token) => token.plain), ['e', '', '', '', 'n', ''])
  assert.equal(tokens[2].ch, ',')
  assert.deepEqual(freq.duplicateAssignments({ A: 'e', B: 'e', C: 'n' }), { e: ['A', 'B'] })
  assert.deepEqual(freq.duplicateAssignments({ A: 'e', B: 'n' }), {})

  // -- Vigenère --------------------------------------------------------------------
  const rowsV = vig.vigenereRows('SARNEN', 'informatik ist heute sehr wichtig')
  assert.equal(rowsV.plain, 'INFORMATIKISTHEUTESEHRWICHTIG')
  assert.equal(rowsV.key.slice(0, 8), 'SARNENSA')
  const cipherV = [...rowsV.plain].map((_, index) => vig.expectedLetter(rowsV, index)).join('')
  assert.equal(cipherV, 'ANWBVZSTZXMFLHVHXRKEYEAVUHKVK')
  assert.equal(vig.vigenereLetter('O', 'A'), 'O')
  const answerV = 'ANW_X'
  assert.deepEqual(vig.checkVigenere(rowsV, answerV).slice(0, 5), ['ok', 'ok', 'ok', 'open', 'bad'])
  const hv = vig.hintVigenere(rowsV, 'A_____', 3)
  assert.equal(hv, `A__B${'_'.repeat(25)}`)
  assert.equal(vig.nextOpenVigenere(rowsV, 'AN'), 2)
  assert.equal(vig.vigenereRows('', 'abc').key, '')

  // -- ASCII / XOR -----------------------------------------------------------------
  assert.equal(xor.asciiBits('A'), '1000001')
  assert.equal(xor.asciiBits('Z'), '1011010')
  assert.equal(xor.asciiBits('O'), '1001111')
  const codes = { O: '1001111', B: '1000010', W: '1010111', A: '1000001', L: '1001100', D: '1000100', E: '1000101', N: '1001110' }
  for (const [letter, bits] of Object.entries(codes)) assert.equal(xor.asciiBits(letter), bits, `OBWALDEN code ${letter}`)
  assert.equal(xor.xorBits('1001111', '1000001'), '0001110')
  const lettersX = xor.xorLetters('GEGNERGREIFTAN', 'DEZEMBERMORGEN')
  assert.equal(lettersX.plain, 'GEGNERGREIFTAN')
  assert.equal(lettersX.key, 'DEZEMBERMORGEN')
  assert.equal(xor.expectedBits(lettersX, 'c', 0), xor.xorBits(xor.asciiBits('G'), xor.asciiBits('D')))
  const blank = xor.fitCells({ p: [], k: [], c: [] }, 2)
  assert.deepEqual(blank.p, ['_______', '_______'])
  const typed = { ...blank, c: ['0000000', '_______'] }
  const wantC = xor.expectedBits(lettersX, 'c', 0)
  const checked = xor.checkBitsRow(lettersX, typed, 'c', 0)
  assert.deepEqual(checked, [...'0000000'].map((bit, index) => (bit === wantC[index] ? 'ok' : 'bad')))
  assert.deepEqual(xor.checkBitsRow(lettersX, typed, 'c', 1), Array(7).fill('open'))
  const filled = xor.insertCodes(lettersX, blank)
  assert.equal(filled.p[0], xor.asciiBits('G'))
  assert.equal(filled.k[0], xor.asciiBits('D'))
  assert.deepEqual(filled.c, blank.c, '"Codes einsetzen" never fills the ciphertext row')
  assert.equal(xor.xorLetters('A'.repeat(100), 'K').plain.length, xor.XOR_MAX)

  // -- modulo ----------------------------------------------------------------------
  assert.equal(mod.modExpected('*', '61', '89', '7').s4, '4')
  assert.deepEqual(mod.modExpected('*', '61', '89', '7'), { s1: '5', s2: '5', s3: '25', s4: '4' })
  assert.equal(mod.modExpected('^', '17', '6', '5').s4, '4')
  assert.equal(mod.modExpected('^', '24', '5', '11').s4, '10')
  assert.equal(mod.modExpected('*', '16', '81', '7').s4, '1')
  assert.equal(mod.modExpected('+', '16', '81', '7').s4, '6')
  assert.equal(mod.modExpected('*', '1', '2', '1'), null)
  assert.ok(mod.modProblem('^', '2', '9999', '7') !== '')
  assert.ok(mod.modProblem('*', 'x', '2', '7') !== '')
  assert.equal(mod.checkModField('*', '61', '89', '7', 's1', ''), 'open')
  assert.equal(mod.checkModField('*', '61', '89', '7', 's1', '5'), 'ok')
  assert.equal(mod.checkModField('*', '61', '89', '7', 's1', '4'), 'bad')
  assert.equal(mod.checkModField('^', '17', '6', '5', 's3', '64'), 'ok')
  assert.deepEqual(mod.modFields('^').map((field) => field.key), ['s1', 's3', 's4'])
  assert.equal(mod.modPow(5n, 117n, 19n), 1n)

  // -- Diffie-Hellman --------------------------------------------------------------
  const exp = dh.dhExpected('5', '23', '6', '15')
  assert.deepEqual(exp, { alpha: '8', beta: '19', sa: '2', sb: '2' })
  assert.equal(exp.sa, exp.sb, 's_a equals s_b')
  for (const [y, p, a, b] of [['7', '101', '12', '34'], ['3', '17', '54', '97'], ['2', '999983', '123456', '654321']]) {
    const got = dh.dhExpected(y, p, a, b)
    assert.equal(got.sa, got.sb)
  }
  assert.ok(dh.dhProblems('23', '23', '2', '3').length > 0, 'Y must be smaller than P')
  assert.ok(dh.dhProblems('5', '1', '2', '3').length > 0, 'P >= 2')
  assert.equal(dh.dhProblems('5', '23', '6', '15').length, 0)
  assert.equal(dh.dhExpected('30', '23', '6', '15'), null)
  assert.equal(dh.checkDhField('5', '23', '6', '15', 'alpha', '8'), 'ok')
  assert.equal(dh.checkDhField('5', '23', '6', '15', 'alpha', '9'), 'bad')
  assert.equal(dh.checkDhField('5', '23', '6', '15', 'beta', ''), 'open')
  assert.equal(dh.secretsAgree('2', '2'), true)
  assert.equal(dh.secretsAgree('2', '3'), false)
  assert.equal(dh.secretsAgree('2', ''), null)

  // -- model: parse / normalise / round trip ---------------------------------------
  for (const tool of model.CRYPTO_TOOLS) {
    const data = model.defaultCryptoData(tool)
    assert.equal(data.tool, tool)
    const text = blocks.serializeStudyBlock('crypto', data)
    const [ref] = blocks.findStudyBlocks(text)
    assert.equal(ref.kind, 'crypto')
    const read = registry.readStudyBlock('crypto', ref.body)
    assert.ok(read.ok, `default ${tool} reads back`)
    assert.deepEqual(read.data, data, `round trip ${tool}`)
    assert.ok(typeof registry.renderStudyBlockHtml('crypto', ref.body) === 'string')
  }
  assert.equal(model.parseCryptoData('{broken').tool, 'caesar', 'bad JSON gives a safe default')
  assert.equal(model.parseCryptoData('').title, 'Caesar')
  assert.equal(model.parseCryptoData('[1,2]').tool, 'caesar')
  assert.equal(model.normaliseCryptoData({ tool: 'nonsense', shift: 'x', mode: 5, task: 7 }).tool, 'caesar')
  assert.equal(model.normaliseCryptoData({ tool: 'caesar', shift: 99 }).shift, 25)
  assert.equal(model.normaliseCryptoData({ tool: 'mod', op: '%', a: 'x1y2' }).op, '*')
  assert.equal(model.normaliseCryptoData({ tool: 'mod', a: 'x1y2' }).a, '12')
  assert.deepEqual(model.normaliseCryptoData({ tool: 'freq', map: { a: 'e', B: 'EE', C: 'n', D: 5 } }).map, { C: 'n' })
  assert.equal(registry.readStudyBlock('crypto', '{broken').ok, false)
  assert.equal(registry.readStudyBlock('crypto', '[]').ok, false)
  assert.equal(registry.readStudyBlock('crypto', '').ok, true)

  // answers persist through normalise and a write/read cycle
  const persisted = {
    v: 1, tool: 'caesar', title: 'Aufgabe 1', mode: 'keyword', shift: 9, alphabet: '', keyword: 'kantonsschule', built: 'KANTO___________________',
    task: 'dies ist die erste uebung', answer: 'MRHB RBC',
  }
  const norm = model.normaliseCryptoData(persisted)
  assert.deepEqual(norm, persisted)
  const body = blocks.studyBlockBody(norm)
  const back = registry.readStudyBlock('crypto', body)
  assert.ok(back.ok)
  assert.deepEqual(back.data, persisted)
  const withExtra = registry.readStudyBlock('crypto', JSON.stringify({ ...persisted, note: 'mine' }))
  assert.ok(withExtra.ok && withExtra.extra.note === 'mine', 'unknown fields are kept')
  const state = {
    xor: { v: 1, tool: 'xor', title: 'X', plain: 'AB', key: 'K', p: ['1000001', '_______'], k: ['1001011', '1001011'], c: ['0001010', '_______'] },
    vigenere: { v: 1, tool: 'vigenere', title: 'V', key: 'OBWALDEN', plain: 'abc', answer: 'P_D' },
    freq: { v: 1, tool: 'freq', title: 'F', lang: 'en', text: 'Uryyb jbeyq', map: { U: 'h', Y: 'l' } },
    mod: { v: 1, tool: 'mod', title: 'M', op: '^', a: '17', b: '6', m: '5', s1: '2', s2: '', s3: '64', s4: '4' },
    dh: { v: 1, tool: 'dh', title: 'D', y: '5', p: '23', a: '6', b: '15', alpha: '8', beta: '19', sa: '2', sb: '2' },
  }
  for (const [tool, value] of Object.entries(state)) {
    const read = registry.readStudyBlock('crypto', JSON.stringify(value))
    assert.ok(read.ok, `${tool} with answers reads without loss`)
    assert.deepEqual(read.data, value, `${tool} answers persist`)
    assert.deepEqual(registry.normaliseStudyData('crypto', read.data), value)
  }
  // a block that would be cut is refused instead of rewritten
  const cut = registry.readStudyBlock('crypto', JSON.stringify({ ...persisted, title: 'x'.repeat(500) }))
  assert.equal(cut.ok, false)

  // -- read-only HTML ----------------------------------------------------------------
  const out = html.renderCryptoHtml(model.normaliseCryptoData({ ...persisted, title: '<b>x</b>', task: '<img src=x onerror=1>' }))
  assert.ok(!out.includes('<img') && !out.includes('<b>x'), 'user text is escaped')
  assert.ok(out.includes('lw-crypto-strip'))
  assert.ok(html.renderCryptoHtml(state.xor).includes('Geheimtext'))
  assert.ok(html.renderCryptoHtml(model.normaliseCryptoData(state.mod)).includes('64'))
  // the rendered block never contains an answer the student did not enter
  assert.ok(!html.renderCryptoHtml(model.normaliseCryptoData({ v: 1, tool: 'vigenere', key: 'SARNEN', plain: 'informatik' })).includes('ANWBV'))

  // -- the kind is registered everywhere -------------------------------------------
  assert.ok(blocks.STUDY_KINDS.includes('crypto'))
  assert.equal(blocks.findStudyBlocks('```fanotes-crypto\n{"v":1}\n```')[0].kind, 'crypto')
  assert.equal(blocks.insertStudyBlock('Hi', 'crypto', model.defaultCryptoData('dh')).includes('fanotes-crypto'), true)
  console.log('crypto tools: ok')
} finally {
  await server.close()
}
