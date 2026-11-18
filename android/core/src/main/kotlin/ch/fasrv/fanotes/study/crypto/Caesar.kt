package ch.fasrv.fanotes.study.crypto

/** Caesar shift, given cipher alphabet and keyword alphabet (port of `caesar.ts`). Answers are checked, never revealed (except by an explicit hint). */

const val PLAIN_ROW = "abcdefghijklmnopqrstuvwxyz"

/** The cipher alphabet of a shift: plain `a` becomes the letter [shift] places on. */
fun shiftAlphabet(shift: Int): String {
    val by = ((shift % 26) + 26) % 26
    return ALPHABET.substring(by) + ALPHABET.substring(0, by)
}

data class AlphabetCheck(
    /** The 26 letters in order when valid, else whatever letters were typed (upper case). */
    val letters: String,
    val missing: List<Char>,
    val duplicates: List<Char>,
    /** Characters that are neither letters nor spaces. */
    val invalid: List<Char>,
    val ok: Boolean,
)

/** A given cipher alphabet must hold each of the 26 letters exactly once (spaces and commas between letters are fine). */
fun checkAlphabet(text: String): AlphabetCheck {
    val invalid = text.filter { !isLetter(it) && !it.isWhitespace() && it != ',' }.toList().distinct()
    val letters = lettersOf(text)
    val counts = LinkedHashMap<Char, Int>()
    for (ch in letters) counts[ch] = (counts[ch] ?: 0) + 1
    val duplicates = counts.filter { it.value > 1 }.keys.toList()
    val missing = ALPHABET.filter { it !in counts }.toList()
    return AlphabetCheck(letters, missing, duplicates, invalid, invalid.isEmpty() && duplicates.isEmpty() && missing.isEmpty() && letters.length == 26)
}

enum class KeywordPartKind { LETTER, REPEAT, SPACE }
data class KeywordPart(val ch: Char, val kind: KeywordPartKind)

/** The keyword as typed: repeated letters (and spaces) are marked so they can be struck through. */
fun keywordParts(keyword: String): List<KeywordPart> {
    val seen = HashSet<Char>()
    return keyword.map { ch ->
        if (!isLetter(ch)) return@map KeywordPart(ch, KeywordPartKind.SPACE)
        if (!seen.add(ch.uppercaseChar())) KeywordPart(ch, KeywordPartKind.REPEAT) else KeywordPart(ch, KeywordPartKind.LETTER)
    }
}

/**
 * The cipher alphabet of a keyword: keyword without spaces and repeated letters, then the unused letters in
 * alphabetical order starting after the last letter of the keyword and wrapping around. "" for an empty keyword.
 */
fun keywordAlphabet(keyword: String): String {
    val clean = lettersOf(keyword)
    if (clean.isEmpty()) return ""
    val unique = clean.toList().distinct()
    val used = unique.toSet()
    val start = letterIndex(clean.last())
    val fill = (1..26).map { ALPHABET[(start + it) % 26] }.filter { it !in used }
    return (unique + fill).joinToString("")
}

/** Letters of the keyword alphabet row that are not placed yet. */
fun unusedLetters(built: String): List<Char> {
    val placed = built.take(26).filter { isLetter(it) }.map { it.uppercaseChar() }.toSet()
    return ALPHABET.filter { it !in placed }.toList()
}

/** Per cell of the student's own keyword alphabet: right, wrong or still empty. Does not reveal the right letter. */
fun checkBuilt(keyword: String, built: String): List<CellState> {
    val target = keywordAlphabet(keyword)
    return List(26) { index ->
        val typed = cellText(built.getOrNull(index))
        when {
            typed.isEmpty() -> CellState.OPEN
            target.isNotEmpty() && typed.uppercase() == target[index].toString() -> CellState.OK
            else -> CellState.BAD
        }
    }
}

/** Encrypts with a 26-letter cipher alphabet (internal: used to check and to hint, never shown as a whole). */
fun encryptWith(text: String, alphabet: String): String =
    text.map { ch -> if (isLetter(ch)) alphabet.getOrNull(letterIndex(ch)) ?: ch else ch }.joinToString("")

enum class AnswerState { OK, BAD, KEEP, OPEN }
data class AnswerCell(val ch: Char, val state: AnswerState)

/** Position-wise verdict of an answer text against the task text; spaces and punctuation must be kept. */
fun checkAnswer(task: String, answer: String, alphabet: String): List<AnswerCell> {
    val expected = encryptWith(task, alphabet)
    return answer.mapIndexed { index, ch ->
        val want = expected.getOrNull(index) ?: return@mapIndexed AnswerCell(ch, AnswerState.BAD)
        when {
            !isLetter(task.getOrNull(index)) -> AnswerCell(ch, if (ch == task[index]) AnswerState.KEEP else AnswerState.BAD)
            ch == EMPTY || ch == ' ' -> AnswerCell(ch, AnswerState.OPEN)
            else -> AnswerCell(ch, if (ch.uppercaseChar() == want) AnswerState.OK else AnswerState.BAD)
        }
    }
}

data class AnswerSummary(val ok: Int, val bad: Int, val open: Int, val total: Int)

fun summariseAnswer(task: String, cells: List<AnswerCell>): AnswerSummary {
    val total = task.count { isLetter(it) }
    val ok = cells.count { it.state == AnswerState.OK }
    val bad = cells.count { it.state == AnswerState.BAD }
    return AnswerSummary(ok, bad, maxOf(0, total - ok - bad), total)
}

data class AnswerHint(val answer: String, val index: Int)

/** Reveals exactly one letter: the first letter position that is empty or wrong. Null when nothing is left to reveal. */
fun hintAnswer(task: String, answer: String, alphabet: String): AnswerHint? {
    val expected = encryptWith(task, alphabet)
    for (index in task.indices) {
        if (!isLetter(task[index]) || alphabet.isEmpty()) continue
        if (answer.getOrNull(index)?.uppercaseChar() == expected[index]) continue
        val cells = CharArray(maxOf(answer.length, index + 1)) { at ->
            answer.getOrNull(at) ?: if (isLetter(task.getOrNull(at))) EMPTY else task.getOrNull(at) ?: ' '
        }
        cells[index] = expected[index]
        return AnswerHint(String(cells), index)
    }
    return null
}
