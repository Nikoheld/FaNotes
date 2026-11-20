// Parity between the TypeScript spelling implementation and the Rust wasm (crates/fanotes-spell):
// lexicon validation, correction candidates (German, Swiss orthography, English; umlauts, ss/ß,
// capitalisation), the autocorrect decision and the n-gram word context index.
//
//   node scripts/check-spell-wasm-parity.mjs        (FANOTES_PARITY_WORDS=n scales the sample)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('../public/spell/manifest.json', import.meta.url), 'utf8'))
const bytesOf = async (name) => new Uint8Array(await readFile(new URL(`../public/spell/${name}`, import.meta.url)))
const files = { de: await bytesOf('de.bloom'), en: await bytesOf('en.bloom'), deWords: await bytesOf('de.words'), enWords: await bytesOf('en.words') }
globalThis.window = {
  fanotes: {
    loadSpellingResources: async () => ({ manifest, de: files.de, en: files.en }),
    loadSpellingWordCandidates: async (language) => ({
      language,
      descriptor: manifest.languages[language].candidates,
      bytes: language === 'de' ? files.deWords : files.enWords,
    }),
  },
}
const SAMPLE = Number(process.env.FANOTES_PARITY_WORDS || 300)

// Deterministic generator so a failure reproduces.
let seed = 20261119
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
const pick = (list) => list[Math.floor(random() * list.length)]
const ALPHA = 'abcdefghijklmnopqrstuvwxyzäöü'

const typo = (word) => {
  const letters = [...word]
  const at = Math.floor(random() * letters.length)
  switch (Math.floor(random() * 7)) {
    case 0: letters.splice(at, 1); break
    case 1: letters.splice(at, 0, letters[at]); break
    case 2: if (at + 1 < letters.length) [letters[at], letters[at + 1]] = [letters[at + 1], letters[at]]; break
    case 3: letters[at] = pick([...ALPHA]); break
    case 4: letters.splice(at, 0, pick([...ALPHA])); break
    case 5: letters[at] = { a: 'ä', o: 'ö', u: 'ü', ä: 'a', ö: 'o', ü: 'u' }[letters[at]] ?? letters[at]; break
    default: letters[at] = pick([...'qwertzuiopasdfghjklyxcvbnm']); break
  }
  return letters.join('')
}
const casing = (word) => {
  const roll = random()
  if (roll < 0.55) return word
  if (roll < 0.8) return word.charAt(0).toLocaleUpperCase('de-CH') + word.slice(1)
  if (roll < 0.9) return word.toLocaleUpperCase('de-CH')
  return word.charAt(0).toLocaleUpperCase('de-CH') + word.slice(1, -1) + word.slice(-1).toLocaleUpperCase('de-CH')
}
// Swiss orthography: the word lists carry "ss" where Standard German writes ß.
const withSharpS = (word) => (random() < 0.5 ? word.replace(/ss/u, 'ß') : word)

const server = await createServer({ root: new URL(root).pathname, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: 'custom', logLevel: 'error' })
try {
  const spelling = await server.ssrLoadModule('/src/lib/spelling.ts')
  const suggestModule = await server.ssrLoadModule('/src/lib/spellingSuggest.ts')
  const context = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const { createSpellWasm } = await server.ssrLoadModule('/src/lib/spellingWasmCore.ts')

  // ---- lexicon load and validation ------------------------------------------------------
  const wasm = createSpellWasm()
  const input = await spelling.loadSpellingWorkerInput()
  let started = performance.now()
  await wasm.install(input, [])
  const wasmLoadMs = performance.now() - started
  started = performance.now()
  const lexicon = await spelling.loadSpellingLexicon()
  const tsLoadMs = performance.now() - started
  assert.deepEqual(wasm.languages(), ['de', 'en'])
  console.log(`lexicon load + validation + n-gram index: TypeScript ${tsLoadMs.toFixed(0)} ms, wasm (validate + word sets) ${wasmLoadMs.toFixed(0)} ms`)

  const decode = (bytes) => new TextDecoder().decode(bytes).slice(0, -1).split('\n')
  const lists = { de: decode(files.deWords), en: decode(files.enWords) }
  const tsValidate = (language, { bytes, count }) => {
    const words = new TextDecoder().decode(bytes).slice(0, -1).split('\n')
    if (words.length !== count) return 'count'
    let previous = ''
    for (const word of words) {
      if (word <= previous || word !== wasm.normalizeWord(word, language) || !/^\p{L}{3,32}$/u.test(word)) return 'entry'
      previous = word
    }
    return 'ok'
  }
  const wasmValidate = async (language, list) => {
    const probe = createSpellWasm()
    const other = language === 'de' ? 'en' : 'de'
    const keep = { bytes: input.words[other].bytes, size: input.words[other].size, count: input.words[other].count, sha256: input.words[other].sha256 }
    try {
      await probe.install({ ...input, words: { [language]: { ...list, sha256: createHash('sha256').update(list.bytes).digest('hex') }, [other]: keep } }, [])
      return 'ok'
    } catch (error) {
      return /Anzahl/u.test(error.message) ? 'count' : /Eintrag/u.test(error.message) ? 'entry' : error.message
    }
  }
  const sample = (language) => lists[language].slice(1000, 1200)
  for (const [name, edit] of Object.entries({
    clean: (list) => list,
    unsorted: (list) => [list[1], list[0], ...list.slice(2)],
    duplicate: (list) => [list[0], list[0], ...list.slice(1)],
    uppercase: (list) => [list[0], list[1].toUpperCase(), ...list.slice(2)],
    sharpS: (list) => [list[0], 'groß', ...list.slice(2)],
    short: (list) => ['ab', ...list],
    digit: (list) => [...list, 'abc1'],
  })) {
    for (const language of ['de', 'en']) {
      const list = sample(language)
      const text = `${edit(list).join('\n')}\n`
      const bytes = new TextEncoder().encode(text)
      const candidate = { bytes, size: bytes.length, count: edit(list).length }
      // `short`/`clean` lists are not sorted relative to each other in a way both accept; only the
      // verdict has to match.
      assert.equal(await wasmValidate(language, candidate), tsValidate(language, candidate), `validation verdict differs for ${language}/${name}`)
    }
  }

  // The probes above replaced the wasm lexicon (it is one per module): install the real one again.
  await wasm.install(input, [])

  // ---- correction candidates -------------------------------------------------------------
  const typed = []
  const umlautWords = lists.de.filter((word) => /[äöü]/u.test(word))
  const sharpWords = lists.de.filter((word) => /ss/u.test(word))
  const compounds = lists.de.filter((word) => word.length >= 12)
  for (let index = 0; index < SAMPLE; index += 1) {
    const source = index % 5 === 0 ? pick(umlautWords) : index % 5 === 1 ? withSharpS(pick(sharpWords)) : index % 7 === 0 ? pick(compounds) : pick(lists[index % 2 ? 'en' : 'de'])
    typed.push(casing(random() < 0.85 ? typo(source) : source))
  }
  // Hand-picked Swiss/German cases: ss against ß, umlaut loss, missing space, capitals.
  typed.push('Strase', 'Strasse', 'Straße', 'Grosse', 'Große', 'grösste', 'groeßte', 'Fussball', 'Fußball', 'schliessen', 'schließen',
    'Mädchen', 'Madchen', 'Maedchen', 'ÄNDERUNG', 'Uebung', 'Übung', 'auchdas', 'Rechtschreibfehlrg', 'Rechtschreibfehlt',
    'nciht', 'Nciht', 'NCIHT', 'teh', 'recieve', 'Beleive', 'Zürcher', 'Zuercher', 'Hausaufgabe', 'Hausaufgaebn', 'ab', 'x', 'qq')
  const personal = ['fanotes', 'zürivorlage', 'kurzel']
  for (const word of personal) suggestModule.addPersonalWord(word, { getItem: () => null, setItem: () => undefined })
  wasm.setUserWords([...suggestModule.personalWords()])
  typed.push('Zürivorlge', 'kurzl', 'fanotse')

  let compared = 0
  let nonEmpty = 0
  const languageSets = [['de'], ['en'], ['de', 'en']]
  const tsTime = { suggest: 0 }
  const wasmTime = { suggest: 0 }
  const differences = []
  typed.forEach((word, index) => {
    const among = languageSets[index % 3]
    for (const options of [{ limit: 6, maxDistance: 2 }, { limit: 4, maxDistance: 1 }]) {
      let t = performance.now()
      const expected = suggestModule.suggestCorrections(word, among, lexicon, options)
      tsTime.suggest += performance.now() - t
      t = performance.now()
      const actual = wasm.suggest(word, among, options.limit, options.maxDistance)
      wasmTime.suggest += performance.now() - t
      if (JSON.stringify(expected) !== JSON.stringify(actual)) differences.push({ word, among, options, expected, actual })
      compared += 1
      if (expected.length) nonEmpty += 1
      if (options.maxDistance === 1) {
        for (const properName of [false, true]) for (const sentenceStart of [false, true]) for (const language of [null, 'de', 'en']) {
          const decision = suggestModule.decideAutocorrect(word, expected, { language, sentenceStart, isProperName: () => properName })
          const index = wasm.planAutocorrect(word, among, { language, sentenceStart, properName })
          if (JSON.stringify(decision) !== JSON.stringify(index)) differences.push({ word, among, decision, planned: index, language, sentenceStart, properName })
        }
      }
    }
  })
  if (differences.length) console.log(JSON.stringify(differences.slice(0, 6).map((d) => ({ ...d, expected: undefined, actual: undefined, e: JSON.stringify(d.expected), a: JSON.stringify(d.actual) })), null, 1))
  assert.equal(differences.length, 0, `${differences.length} of ${compared} suggestion comparisons differ`)
  assert.ok(nonEmpty > compared / 3, 'the sample must produce real suggestions')
  console.log(`suggestions: ${compared} comparisons on ${typed.length} typed words identical (${nonEmpty} with candidates); TS ${tsTime.suggest.toFixed(0)} ms, wasm ${wasmTime.suggest.toFixed(0)} ms`)

  // ---- n-gram word context index ---------------------------------------------------------
  for (const language of ['de', 'en']) {
    started = performance.now()
    const count = wasm.context.build(language)
    const buildMs = performance.now() - started
    assert.equal(count, lists[language].length)
    for (let length = 1; length <= 40; length += 1) {
      assert.deepEqual(wasm.context.wordsOfLength(language, length), [...context.neuralWordContextWordsOfLength(language, length)], `${language} bucket ${length}`)
    }
    const probes = []
    for (let index = 0; index < SAMPLE; index += 1) {
      const base = pick(lists[language])
      probes.push(index % 3 === 0 ? base : index % 3 === 1 ? typo(base) : casing(typo(base)))
    }
    probes.push('', 'x', 'Straße', 'GROSS', 'Zürich', 'ÄÖÜ', 'qxzv')
    for (const probe of probes) {
      const lower = probe.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
      assert.equal(wasm.context.isExtendedWord(language, lower), context.isExtendedNeuralContextWord(lower, language), `extended ${probe}`)
      assert.ok(Math.abs(wasm.context.sequenceScore(language, probe) - context.neuralCharacterSequenceScore(probe, language)) < 1e-9, `sequence ${probe}`)
      assert.equal(wasm.context.subwordScore(language, probe), context.neuralCharacterSubwordScore(probe, language), `subword ${probe}`)
    }
    for (const probe of probes.slice(0, 200)) {
      for (const [distance, same, max] of [[1, false, Infinity], [1, true, 5], [2, true, Infinity], [1, false, 3]]) {
        assert.deepEqual(
          wasm.context.nearest(language, probe, distance, same, max),
          context.nearestNeuralWordContextCandidates(probe, language, distance, same, max),
          `nearest ${language} ${probe} ${distance} ${same} ${max}`,
        )
      }
    }
    console.log(`context ${language}: ${count} words, index built in ${buildMs.toFixed(0)} ms, ${probes.length} probes identical`)

    // The snapshot the main thread adopts (handwriting recognition asks the worker for it): every
    // synchronous query must answer exactly as the index built by installNeuralWordContextCandidates.
    const combos = [[1, false, Infinity], [1, true, 5], [2, true, Infinity], [1, false, 3], [3, false, 4]]
    const reference = {
      buckets: Array.from({ length: 70 }, (_, length) => [...context.neuralWordContextWordsOfLength(language, length + 1)]),
      probes: probes.map((probe) => {
        const lower = probe.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
        return {
          extended: context.isExtendedNeuralContextWord(lower, language),
          sequence: context.neuralCharacterSequenceScore(probe, language),
          subword: context.neuralCharacterSubwordScore(probe, language),
        }
      }),
      nearest: probes.slice(0, 80).map((probe) => combos.map(([d, same, max]) => context.nearestNeuralWordContextCandidates(probe, language, d, same, max))),
      members: lists[language].filter((_, index) => index % 7 === 0).map((word) => context.isExtendedNeuralContextWord(word, language)),
    }
    assert.ok(reference.members.every(Boolean), 'the TS index must hold every sampled word')
    started = performance.now()
    const text = wasm.context.snapshot(language)
    const snapshotMs = performance.now() - started
    started = performance.now()
    context.installNeuralWordContextSnapshot(language, JSON.parse(text))
    const adoptMs = performance.now() - started
    for (let length = 1; length <= 70; length += 1) {
      assert.deepEqual([...context.neuralWordContextWordsOfLength(language, length)], reference.buckets[length - 1], `snapshot bucket ${language} ${length}`)
    }
    probes.forEach((probe, index) => {
      const lower = probe.toLocaleLowerCase(language === 'de' ? 'de-CH' : 'en-US')
      const expected = reference.probes[index]
      assert.equal(context.isExtendedNeuralContextWord(lower, language), expected.extended, `snapshot extended ${probe}`)
      assert.equal(context.neuralCharacterSequenceScore(probe, language), expected.sequence, `snapshot sequence ${probe}`)
      assert.equal(context.neuralCharacterSubwordScore(probe, language), expected.subword, `snapshot subword ${probe}`)
    })
    probes.slice(0, 80).forEach((probe, index) => combos.forEach(([d, same, max], at) => {
      assert.deepEqual(context.nearestNeuralWordContextCandidates(probe, language, d, same, max), reference.nearest[index][at], `snapshot nearest ${language} ${probe} ${d} ${same} ${max}`)
    }))
    lists[language].filter((_, index) => index % 7 === 0).forEach((word) => assert.ok(context.isExtendedNeuralContextWord(word, language), `snapshot member ${word}`))
    assert.ok(!context.isExtendedNeuralContextWord('qxzvqxzv', language))
    console.log(`context snapshot ${language}: worker side ${snapshotMs.toFixed(0)} ms (${(text.length / 1e6).toFixed(1)} MB), main-thread adopt ${adoptMs.toFixed(1)} ms, 70 buckets + ${probes.length} probes + ${reference.nearest.length * combos.length} nearest queries + ${reference.members.length} members identical`)
  }
  console.log('spell wasm parity ok')
} finally {
  await server.close()
}
