package ch.fasrv.fanotes.study.crypto

/** Letter frequencies and the substitution grid of the frequency analysis (port of `freq.ts`). Nothing is assigned automatically. */

enum class FreqLang(val id: String) { DE("de"), EN("en") }

/** German reference from the school script (percent). */
val GERMAN_REFERENCE: Map<Char, Double> = linkedMapOf(
    'e' to 17.48, 'n' to 9.84, 'i' to 7.73, 'r' to 7.54, 's' to 6.83, 'a' to 6.47, 't' to 6.13, 'd' to 4.83, 'h' to 4.23, 'u' to 4.17,
    'l' to 3.49, 'g' to 3.06, 'o' to 2.98, 'c' to 2.68, 'm' to 2.58, 'b' to 1.93, 'f' to 1.65, 'w' to 1.48, 'k' to 1.46, 'z' to 1.14,
    'p' to 0.96, 'v' to 0.94, 'j' to 0.27, 'y' to 0.08, 'x' to 0.04, 'q' to 0.02,
)

/** Standard English letter frequencies (percent). */
val ENGLISH_REFERENCE: Map<Char, Double> = linkedMapOf(
    'e' to 12.70, 't' to 9.06, 'a' to 8.17, 'o' to 7.51, 'i' to 6.97, 'n' to 6.75, 's' to 6.33, 'h' to 6.09, 'r' to 5.99, 'd' to 4.25,
    'l' to 4.03, 'c' to 2.78, 'u' to 2.76, 'm' to 2.41, 'w' to 2.36, 'f' to 2.23, 'g' to 2.02, 'y' to 1.97, 'p' to 1.93, 'b' to 1.29,
    'v' to 0.98, 'k' to 0.77, 'j' to 0.15, 'x' to 0.15, 'q' to 0.10, 'z' to 0.07,
)

data class FreqRow(val letter: Char, val count: Int, val percent: Double)

fun countLetters(text: String): Pair<Map<Char, Int>, Int> {
    val counts = LinkedHashMap<Char, Int>().also { map -> ALPHABET.forEach { map[it] = 0 } }
    var total = 0
    for (ch in text) if (isLetter(ch)) {
        counts[ch.uppercaseChar()] = counts.getValue(ch.uppercaseChar()) + 1
        total += 1
    }
    return counts to total
}

/** All 26 letters of the text, most frequent first (ties alphabetical). */
fun frequencyRows(text: String): List<FreqRow> {
    val (counts, total) = countLetters(text)
    return ALPHABET.map { FreqRow(it, counts.getValue(it), if (total > 0) counts.getValue(it).toDouble() / total * 100 else 0.0) }
        .sortedWith(compareByDescending<FreqRow> { it.count }.thenBy { it.letter })
}

fun referenceRows(lang: FreqLang): List<FreqRow> {
    val table = if (lang == FreqLang.EN) ENGLISH_REFERENCE else GERMAN_REFERENCE
    return table.entries.sortedByDescending { it.value }.map { FreqRow(it.key.uppercaseChar(), 0, it.value) }
}

/** The assignment grid: cipher letter (A-Z) to plain letter (a-z). */
typealias FreqMap = Map<Char, Char>

data class FreqToken(val ch: Char, val plain: Char?)

/** The ciphertext with assigned letters replaced (`plain` set); unassigned letters and other characters stay as they are. */
fun applyMap(text: String, map: FreqMap): List<FreqToken> =
    text.map { ch -> FreqToken(ch, if (isLetter(ch)) map[ch.uppercaseChar()] else null) }

/** Plain letters assigned to more than one cipher letter. */
fun duplicateAssignments(map: FreqMap): Map<Char, List<Char>> {
    val byPlain = LinkedHashMap<Char, MutableList<Char>>()
    for ((cipher, plain) in map) byPlain.getOrPut(plain) { mutableListOf() }.add(cipher)
    return byPlain.filter { it.value.size > 1 }.mapValues { it.value.sorted() }
}
