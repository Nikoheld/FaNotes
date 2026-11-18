package ch.fasrv.fanotes.study.crypto

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.study.StudyKind
import ch.fasrv.fanotes.study.findStudyBlocks
import ch.fasrv.fanotes.study.insertStudyBlock
import ch.fasrv.fanotes.study.prettyJson
import ch.fasrv.fanotes.study.studyBlockReadable
import ch.fasrv.fanotes.study.writeStudyBlockMerged
import ch.fasrv.fanotes.study.buildStudyScene
import java.math.BigInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Mirrors `fanotes/scripts/check-crypto-tools.mjs`: the examples of the school script and the model round trip. */
class CryptoToolsTest {
    private fun states(cells: List<AnswerCell>) = cells.map { it.state }

    @Test
    fun caesarShiftsGivenAlphabetAndKeyword() {
        assertEquals("DEFGHIJKLMNOPQRSTUVWXYZABC", shiftAlphabet(3))
        assertEquals("ABCDEFGHIJKLMNOPQRSTUVWXYZ", shiftAlphabet(0))
        assertEquals("YHQL, YLGL, YLFL", encryptWith("veni, vidi, vici", shiftAlphabet(3)))
        assertEquals("glhvhu vdwc lvw jhkhlp", encryptWith("dieser satz ist geheim", shiftAlphabet(3)).lowercase())
        val given = checkAlphabet("J L P A W I Q B C T R Z Y D S K E G F X H U O N V M")
        assertTrue(given.ok)
        assertEquals("WX XH, LGHXHF?", encryptWith("et tu, brutus?", given.letters))
        val broken = checkAlphabet("A B C A")
        assertTrue(!broken.ok && 'A' in broken.duplicates && broken.missing.size == 23)
        assertFalse(checkAlphabet("J L P A W I Q B C T R Z Y D S K E G F X H U O N V 1").ok)
        assertEquals("JULISCAERTVWXYZBDFGHKMNOPQ", keywordAlphabet("julius caesar"))
        assertEquals("SFFJFS EKXJYKX SGH", encryptWith("errare humanum est", keywordAlphabet("julius caesar")))
        assertEquals("KANTOSCHULEFGIJMPQRVWXYZBD", keywordAlphabet("kantonsschule"))
        assertEquals("", keywordAlphabet(""))
        assertEquals(listOf('u', 's', 'a'), keywordParts("julius caesar").filter { it.kind == KeywordPartKind.REPEAT }.map { it.ch })
        assertTrue('A' in unusedLetters("JULI____________________") && 'J' !in unusedLetters("JULI"))
        assertEquals(listOf(CellState.OK, CellState.OK, CellState.BAD, CellState.OPEN), checkBuilt("julius caesar", "JUX_________________________").take(4))
    }

    @Test
    fun checkingMarksWrongLettersWithoutRevealingThem() {
        val task = "veni, vidi"
        val alpha = shiftAlphabet(3)
        val ok = AnswerState.OK
        val keep = AnswerState.KEEP
        assertEquals(listOf(ok, ok, ok, ok, keep, keep, ok, ok, ok, ok), states(checkAnswer(task, "YHQL, YLGL", alpha)))
        val wrong = checkAnswer(task, "YXQL, Y", alpha)
        assertEquals(listOf(ok, AnswerState.BAD, ok), states(wrong).take(3))
        assertEquals("YXQL, Y", wrong.map { it.ch }.joinToString(""))
        assertTrue(checkAnswer(task, "yhql, ylgl", alpha).none { it.state == AnswerState.BAD }, "case-insensitive")
        assertEquals(AnswerState.BAD, checkAnswer(task, "YHQL; YLGL", alpha)[4].state, "punctuation must be kept")
        val summary = summariseAnswer(task, wrong)
        assertEquals(listOf(4, 1, 3, 8), listOf(summary.ok, summary.bad, summary.open, summary.total))
    }

    @Test
    fun hintRevealsExactlyOneLetter() {
        val task = "veni, vidi"
        val alpha = shiftAlphabet(3)
        assertEquals(AnswerHint("Y", 0), hintAnswer(task, "", alpha))
        val second = hintAnswer(task, "YXQL", alpha)!!
        assertEquals("YHQL", second.answer)
        assertEquals(1, second.answer.indices.count { second.answer[it] != "YXQL"[it] })
        assertEquals("YHQL, Y", hintAnswer(task, "YHQL, ", alpha)!!.answer)
        assertEquals("BC, D", hintAnswer("ab, cd", "BC", shiftAlphabet(1))!!.answer, "padding keeps punctuation of the task")
        assertNull(hintAnswer(task, "YHQL, YLGL", alpha))
        assertNull(hintAnswer(task, "", ""))
    }

    @Test
    fun frequencyAnalysis() {
        val rows = frequencyRows("AAB B? cA")
        assertEquals(listOf('A' to 3, 'B' to 2, 'C' to 1), rows.take(3).map { it.letter to it.count })
        assertEquals(26, rows.size)
        assertTrue(Math.abs(rows[0].percent - 50.0) < 1e-9)
        assertTrue(frequencyRows("").all { it.count == 0 && it.percent == 0.0 })
        assertEquals(listOf('E', 'N', 'I'), referenceRows(FreqLang.DE).take(3).map { it.letter })
        assertEquals('E', referenceRows(FreqLang.EN)[0].letter)
        assertEquals(26, referenceRows(FreqLang.EN).size)
        assertEquals(26, referenceRows(FreqLang.DE).size)
        val tokens = applyMap("Ab, Cq", mapOf('A' to 'e', 'C' to 'n'))
        assertEquals(listOf('e', null, null, null, 'n', null), tokens.map { it.plain })
        assertEquals(',', tokens[2].ch)
        assertEquals(mapOf('e' to listOf('A', 'B')), duplicateAssignments(mapOf('A' to 'e', 'B' to 'e', 'C' to 'n')))
        assertEquals(emptyMap(), duplicateAssignments(mapOf('A' to 'e', 'B' to 'n')))
    }

    @Test
    fun vigenereSarnenExample() {
        val rows = vigenereRows("SARNEN", "informatik ist heute sehr wichtig")
        assertEquals("INFORMATIKISTHEUTESEHRWICHTIG", rows.plain)
        assertEquals("SARNENSA", rows.key.take(8))
        val cipher = rows.plain.indices.map { expectedLetter(rows, it) }.joinToString("")
        assertEquals("ANWBVZSTZXMFLHVHXRKEYEAVUHKVK", cipher)
        assertEquals('O', vigenereLetter('O', 'A'))
        assertEquals(listOf(CellState.OK, CellState.OK, CellState.OK, CellState.OPEN, CellState.BAD), checkVigenere(rows, "ANW_X").take(5))
        assertEquals("A__B" + "_".repeat(25), hintVigenere(rows, "A_____", 3))
        assertEquals(2, nextOpenVigenere(rows, "AN"))
        assertEquals("", vigenereRows("", "abc").key)
    }

    @Test
    fun asciiAndXor() {
        assertEquals("1000001", asciiBits('A'))
        assertEquals("1011010", asciiBits('Z'))
        assertEquals("1001111", asciiBits('O'))
        val codes = mapOf('O' to "1001111", 'B' to "1000010", 'W' to "1010111", 'A' to "1000001", 'L' to "1001100", 'D' to "1000100", 'E' to "1000101", 'N' to "1001110")
        codes.forEach { (letter, bits) -> assertEquals(bits, asciiBits(letter), "OBWALDEN code $letter") }
        assertEquals("0001110", xorBits("1001111", "1000001"))
        val letters = xorLetters("GEGNERGREIFTAN", "DEZEMBERMORGEN")
        assertEquals("GEGNERGREIFTAN", letters.plain)
        assertEquals("DEZEMBERMORGEN", letters.key)
        assertEquals(xorBits(asciiBits('G'), asciiBits('D')), expectedBits(letters, XorRow.C, 0))
        val blank = fitCells(XorCells(emptyList(), emptyList(), emptyList()), 2)
        assertEquals(listOf("_______", "_______"), blank.p)
        val typed = blank.copy(c = listOf("0000000", "_______"))
        val want = expectedBits(letters, XorRow.C, 0)
        assertEquals("0000000".mapIndexed { i, bit -> if (bit == want[i]) CellState.OK else CellState.BAD }, checkBitsRow(letters, typed, XorRow.C, 0))
        assertEquals(List(7) { CellState.OPEN }, checkBitsRow(letters, typed, XorRow.C, 1))
        val filled = insertCodes(letters, blank)
        assertEquals(asciiBits('G'), filled.p[0])
        assertEquals(asciiBits('D'), filled.k[0])
        assertEquals(blank.c, filled.c, "Codes einsetzen never fills the ciphertext row")
        assertEquals(XOR_MAX, xorLetters("A".repeat(100), "K").plain.length)
    }

    @Test
    fun modulo() {
        assertEquals("4", modExpected(ModOp.TIMES, "61", "89", "7")!![ModField.S4])
        assertEquals(mapOf(ModField.S1 to "5", ModField.S2 to "5", ModField.S3 to "25", ModField.S4 to "4"), modExpected(ModOp.TIMES, "61", "89", "7"))
        assertEquals("4", modExpected(ModOp.POWER, "17", "6", "5")!![ModField.S4])
        assertEquals("10", modExpected(ModOp.POWER, "24", "5", "11")!![ModField.S4])
        assertEquals("1", modExpected(ModOp.TIMES, "16", "81", "7")!![ModField.S4])
        assertEquals("6", modExpected(ModOp.PLUS, "16", "81", "7")!![ModField.S4])
        assertNull(modExpected(ModOp.TIMES, "1", "2", "1"))
        assertTrue(modProblem(ModOp.POWER, "2", "9999", "7").isNotEmpty())
        assertTrue(modProblem(ModOp.TIMES, "x", "2", "7").isNotEmpty())
        assertEquals(FieldState.OPEN, checkModField(ModOp.TIMES, "61", "89", "7", ModField.S1, ""))
        assertEquals(FieldState.OK, checkModField(ModOp.TIMES, "61", "89", "7", ModField.S1, "5"))
        assertEquals(FieldState.BAD, checkModField(ModOp.TIMES, "61", "89", "7", ModField.S1, "4"))
        assertEquals(FieldState.OK, checkModField(ModOp.POWER, "17", "6", "5", ModField.S3, "64"))
        assertEquals(listOf(ModField.S1, ModField.S3, ModField.S4), modFields(ModOp.POWER).map { it.key })
        assertEquals(BigInteger.ONE, modPow(BigInteger.valueOf(5), BigInteger.valueOf(117), BigInteger.valueOf(19)))
    }

    @Test
    fun diffieHellman() {
        val exp = dhExpected("5", "23", "6", "15")!!
        assertEquals(mapOf(DhField.ALPHA to "8", DhField.BETA to "19", DhField.SA to "2", DhField.SB to "2"), exp)
        for ((y, p, a, b) in listOf(listOf("7", "101", "12", "34"), listOf("3", "17", "54", "97"), listOf("2", "999983", "123456", "654321"))) {
            val got = dhExpected(y, p, a, b)!!
            assertEquals(got[DhField.SA], got[DhField.SB])
        }
        assertTrue(dhProblems("23", "23", "2", "3").isNotEmpty(), "Y must be smaller than P")
        assertTrue(dhProblems("5", "1", "2", "3").isNotEmpty(), "P >= 2")
        assertTrue(dhProblems("5", "23", "6", "15").isEmpty())
        assertNull(dhExpected("30", "23", "6", "15"))
        assertEquals(FieldState.OK, checkDhField("5", "23", "6", "15", DhField.ALPHA, "8"))
        assertEquals(FieldState.BAD, checkDhField("5", "23", "6", "15", DhField.ALPHA, "9"))
        assertEquals(FieldState.OPEN, checkDhField("5", "23", "6", "15", DhField.BETA, ""))
        assertEquals(true, secretsAgree("2", "2"))
        assertEquals(false, secretsAgree("2", "3"))
        assertEquals(null, secretsAgree("2", ""))
    }

    @Test
    fun defaultsReadBackAndRoundTrip() {
        for (tool in CryptoTool.entries) {
            val data = defaultCryptoData(tool)
            assertEquals(tool, data.tool)
            val text = insertStudyBlock("", StudyKind.CRYPTO, cryptoDataJson(data))
            val ref = findStudyBlocks(text).single()
            assertEquals(StudyKind.CRYPTO, ref.kind)
            assertEquals(data, cryptoEditable(ref.body), "round trip $tool")
            assertTrue(studyBlockReadable(ref))
            assertNotNull(buildStudyScene(StudyKind.CRYPTO, ref.body, 400.0))
        }
    }

    @Test
    fun badInputGivesSafeDefaults() {
        assertEquals(CryptoTool.CAESAR, parseCryptoData("{broken").tool)
        assertEquals("Caesar", parseCryptoData("").title)
        assertEquals(CryptoTool.CAESAR, parseCryptoData("[1,2]").tool)
        fun obj(json: String) = parseJson(json) as JsonValue.Obj
        assertEquals(CryptoTool.CAESAR, normaliseCryptoData(obj("""{"tool":"nonsense","shift":"x","mode":5,"task":7}""")).tool)
        assertEquals(25, (normaliseCryptoData(obj("""{"tool":"caesar","shift":99}""")) as CaesarData).shift)
        assertEquals(3, (normaliseCryptoData(obj("""{"tool":"caesar","shift":"x"}""")) as CaesarData).shift)
        assertEquals(ModOp.TIMES, (normaliseCryptoData(obj("""{"tool":"mod","op":"%","a":"x1y2"}""")) as ModData).op)
        assertEquals("12", (normaliseCryptoData(obj("""{"tool":"mod","a":"x1y2"}""")) as ModData).a)
        assertEquals(mapOf('C' to 'n'), (normaliseCryptoData(obj("""{"tool":"freq","map":{"a":"e","B":"EE","C":"n","D":5}}""")) as FreqData).map)
        assertNull(cryptoEditable("{broken"))
        assertNull(cryptoEditable("[]"))
        assertNotNull(cryptoEditable(""))
        // a block that would be cut is refused instead of rewritten
        assertNull(cryptoEditable("""{"v":1,"tool":"caesar","title":"${"x".repeat(500)}"}"""))
    }

    @Test
    fun answersRoundTripIdenticallyWithDesktopOutput() {
        for ((tool, text) in desktopFixtures) {
            val data = cryptoEditable(text)
            assertNotNull(data, "$tool reads without loss")
            assertEquals(text, prettyJson(cryptoDataJson(data)), "$tool is written back byte for byte")
        }
        val caesar = cryptoEditable(desktopFixtures.getValue("caesar")) as CaesarData
        assertEquals("MRHB RBC", caesar.answer)
        assertEquals(CaesarMode.KEYWORD, caesar.mode)
        val freq = cryptoEditable(desktopFixtures.getValue("freq")) as FreqData
        assertEquals(mapOf('U' to 'h', 'Y' to 'l'), freq.map)
    }

    @Test
    fun unknownFieldsSurviveAnEditAndRemovedAnswersStayRemoved() {
        val body = """{"v":1,"title":"F","tool":"freq","lang":"en","text":"Uryyb","map":{"U":"h","Y":"l"},"note":"mine"}"""
        val markdown = "```fanotes-crypto\n$body\n```"
        val ref = findStudyBlocks(markdown).single()
        val data = cryptoEditable(body) as FreqData
        val edited = data.copy(map = data.map - 'Y')
        val written = writeStudyBlockMerged(markdown, ref, cryptoDataJson(edited))
        val back = findStudyBlocks(written).single()
        val reread = parseJson(back.body) as JsonValue.Obj
        assertEquals("mine", reread.string("note"))
        assertEquals(setOf("U"), reread.obj("map")!!.fields.keys)
        assertEquals(listOf("v", "title", "tool", "lang", "text", "map", "note"), reread.fields.keys.toList())
    }

    @Test
    fun sceneShowsOnlyWhatTheStudentEntered() {
        val scene = cryptoScene(VigenereData("V", "SARNEN", "informatik", ""), 400.0)
        val texts = scene.ops.filterIsInstance<ch.fasrv.fanotes.study.TextOp>().map { it.text }
        assertTrue(texts.none { it.contains("ANWBV") })
        val xor = cryptoScene(XorData("X", "AB", "K", emptyList(), emptyList(), emptyList()), 400.0)
        assertTrue(xor.ops.filterIsInstance<ch.fasrv.fanotes.study.TextOp>().none { it.text.contains("1000001") })
        val caesar = cryptoScene(defaultCryptoData(CryptoTool.CAESAR), 120.0)
        assertTrue(caesar.height > 20)
    }

    private val desktopFixtures: Map<String, String> = mapOf(
        "caesar" to """{
 "v": 1,
 "title": "Aufgabe 1",
 "tool": "caesar",
 "mode": "keyword",
 "shift": 9,
 "alphabet": "",
 "keyword": "kantonsschule",
 "built": "KANTO___________________",
 "task": "dies ist die erste uebung",
 "answer": "MRHB RBC"
}""",
        "xor" to """{
 "v": 1,
 "title": "X",
 "tool": "xor",
 "plain": "AB",
 "key": "K",
 "p": [
  "1000001",
  "_______"
 ],
 "k": [
  "1001011",
  "1001011"
 ],
 "c": [
  "0001010",
  "_______"
 ]
}""",
        "vigenere" to """{
 "v": 1,
 "title": "V",
 "tool": "vigenere",
 "key": "OBWALDEN",
 "plain": "abc",
 "answer": "P_D"
}""",
        "freq" to """{
 "v": 1,
 "title": "F",
 "tool": "freq",
 "lang": "en",
 "text": "Uryyb jbeyq äö",
 "map": {
  "U": "h",
  "Y": "l"
 }
}""",
        "mod" to """{
 "v": 1,
 "title": "M",
 "tool": "mod",
 "op": "^",
 "a": "17",
 "b": "6",
 "m": "5",
 "s1": "2",
 "s2": "",
 "s3": "64",
 "s4": "4"
}""",
        "dh" to """{
 "v": 1,
 "title": "D",
 "tool": "dh",
 "y": "5",
 "p": "23",
 "a": "6",
 "b": "15",
 "alpha": "8",
 "beta": "19",
 "sa": "2",
 "sb": "2"
}""",
    )
}
