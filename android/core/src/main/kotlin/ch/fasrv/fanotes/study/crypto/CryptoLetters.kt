package ch.fasrv.fanotes.study.crypto

/** Shared letter helpers for the cryptology tools (port of `lib/study/crypto/letters.ts`). Only the 26 ASCII letters count. */

const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** The marker of an empty cell in stored answers. */
const val EMPTY = '_'

fun isLetter(ch: Char?): Boolean = ch != null && (ch in 'A'..'Z' || ch in 'a'..'z')

/** Only the ASCII letters of [text], upper case. */
fun lettersOf(text: String): String = buildString { for (ch in text) if (isLetter(ch)) append(ch.uppercaseChar()) }

fun letterIndex(ch: Char): Int = ch.uppercaseChar().code - 65

/** Per-cell verdict. OPEN means nothing was entered yet. The right letter is never part of a verdict. */
enum class CellState { OK, BAD, OPEN }

fun cellText(value: Char?): String = if (value != null && value != EMPTY && value != ' ') value.toString() else ""

/** Replaces one character of a fixed-width stored string. */
fun setCharAt(value: String, index: Int, ch: Char?, width: Int): String {
    val cells = CharArray(width) { value.getOrNull(it) ?: EMPTY }
    cells[index] = ch ?: EMPTY
    return String(cells)
}
