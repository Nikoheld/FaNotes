package ch.fasrv.fanotes.study.crypto

/** 7-bit ASCII of upper case letters and bitwise XOR (port of `xor.ts`). */

const val XOR_MAX = 24
const val BITS = 7

fun asciiBits(letter: Char): String = letter.uppercaseChar().code.toString(2).padStart(BITS, '0')

fun xorBits(a: String, b: String): String = a.mapIndexed { index, bit -> if (bit == b.getOrNull(index)) '0' else '1' }.joinToString("")

data class XorLetters(val plain: String, val key: String)

fun xorLetters(plainText: String, keyText: String): XorLetters {
    val key = lettersOf(keyText)
    val plain = lettersOf(plainText).take(XOR_MAX)
    return XorLetters(plain, if (key.isNotEmpty()) String(CharArray(plain.length) { key[it % key.length] }) else "")
}

enum class XorRow { P, K, C }
data class XorCells(val p: List<String>, val k: List<String>, val c: List<String>) {
    operator fun get(row: XorRow): List<String> = when (row) { XorRow.P -> p; XorRow.K -> k; XorRow.C -> c }
    fun with(row: XorRow, list: List<String>): XorCells = when (row) { XorRow.P -> copy(p = list); XorRow.K -> copy(k = list); XorRow.C -> copy(c = list) }
}

/** The correct bits of one row at one letter (internal: used to check and for "Codes einsetzen" of the first two rows). */
fun expectedBits(letters: XorLetters, row: XorRow, index: Int): String {
    val p = letters.plain.getOrNull(index) ?: return ""
    val k = letters.key.getOrNull(index) ?: return ""
    return when (row) {
        XorRow.P -> asciiBits(p)
        XorRow.K -> asciiBits(k)
        XorRow.C -> xorBits(asciiBits(p), asciiBits(k))
    }
}

fun emptyBits(): String = EMPTY.toString().repeat(BITS)

/** Brings the stored rows to one entry per plaintext letter. */
fun fitCells(cells: XorCells, count: Int): XorCells {
    fun fit(list: List<String>) = List(count) { list.getOrNull(it) ?: emptyBits() }
    return XorCells(fit(cells.p), fit(cells.k), fit(cells.c))
}

/** Per bit: right, wrong or empty. */
fun checkBitsRow(letters: XorLetters, cells: XorCells, row: XorRow, index: Int): List<CellState> {
    val want = expectedBits(letters, row, index)
    val typed = cells[row].getOrNull(index).orEmpty()
    return List(BITS) { bit ->
        val value = cellText(typed.getOrNull(bit))
        when {
            value.isEmpty() -> CellState.OPEN
            want.isNotEmpty() && value == want[bit].toString() -> CellState.OK
            else -> CellState.BAD
        }
    }
}

/** Fills the first two rows (plaintext and key code) from the letters. The ciphertext row is never filled. */
fun insertCodes(letters: XorLetters, cells: XorCells): XorCells = cells.copy(
    p = List(letters.plain.length) { expectedBits(letters, XorRow.P, it) },
    k = List(letters.plain.length) { expectedBits(letters, XorRow.K, it) },
)
