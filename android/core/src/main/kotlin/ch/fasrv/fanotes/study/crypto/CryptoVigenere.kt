package ch.fasrv.fanotes.study.crypto

/** Vigenere: key row over the plaintext; the student looks the cipher letter up in the square (port of `vigenere.ts`). */

const val VIGENERE_MAX = 120

/** Row [key] of the Vigenere square at column [plain]. */
fun vigenereLetter(key: Char, plain: Char): Char = ALPHABET[(letterIndex(key) + letterIndex(plain)) % 26]

data class VigenereRows(val plain: String, val key: String)

/** Plaintext without spaces and the key repeated over it, both upper case. */
fun vigenereRows(keyText: String, plainText: String): VigenereRows {
    val key = lettersOf(keyText)
    val plain = lettersOf(plainText).take(VIGENERE_MAX)
    if (key.isEmpty()) return VigenereRows(plain, "")
    return VigenereRows(plain, String(CharArray(plain.length) { key[it % key.length] }))
}

fun expectedLetter(rows: VigenereRows, index: Int): Char? {
    val k = rows.key.getOrNull(index) ?: return null
    val p = rows.plain.getOrNull(index) ?: return null
    return vigenereLetter(k, p)
}

fun checkVigenere(rows: VigenereRows, answer: String): List<CellState> = List(rows.plain.length) { index ->
    val typed = cellText(answer.getOrNull(index))
    when {
        typed.isEmpty() -> CellState.OPEN
        typed.uppercase() == expectedLetter(rows, index)?.toString() -> CellState.OK
        else -> CellState.BAD
    }
}

/** The answer with exactly the letter at [index] filled in. */
fun hintVigenere(rows: VigenereRows, answer: String, index: Int): String {
    val want = expectedLetter(rows, index) ?: return answer
    val cells = CharArray(rows.plain.length) { answer.getOrNull(it) ?: EMPTY }
    cells[index] = want
    return String(cells)
}

/** First position that is empty or wrong, for the hint button when nothing is focused. */
fun nextOpenVigenere(rows: VigenereRows, answer: String): Int = checkVigenere(rows, answer).indexOfFirst { it != CellState.OK }
