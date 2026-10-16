package ch.fasrv.fanotes.desk

import java.text.Collator
import java.util.Locale
import kotlin.math.abs

/**
 * Correction candidates from `fanotes/src/lib/spellingSuggest.ts`.
 * A candidate has to be in the exact word list. The bloom filter alone is
 * not enough: about 0.3% of random edits would look like words.
 */

data class SpellingSuggestion(
    val word: String,
    val distance: Int,
    val score: Int,
    val language: String,
)

fun interface SpellingLexicon {
    fun hasWord(language: String, normalizedWord: String): Boolean
    fun candidatePenalty(language: String, normalizedWord: String): Int = 0
}

private const val COMMON_WORD_BONUS = 25
private const val MAX_DISTANCE_TWO_PROBES = 60_000

private val ALPHABETS = mapOf(
    "de" to "abcdefghijklmnopqrstuvwxyzäöü",
    "en" to "abcdefghijklmnopqrstuvwxyz",
)
private val UMLAUT_PAIRS = mapOf(
    "a" to "ä", "ä" to "a", "o" to "ö", "ö" to "o", "u" to "ü", "ü" to "u",
)
private val EDIT_COST = mapOf(
    "transpose" to 0,
    "double" to 1,
    "near" to 1,
    "umlaut" to 1,
    "delete" to 2,
    "insert" to 2,
    "replace" to 3,
)

private val COMMON_WORDS = mapOf(
    "de" to ("der die das und ist in den von zu mit sich des auf für nicht ein eine einer eines einem einen als auch es an werden aus er hat dass sie nach wird bei noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei wenn ich wir ihr euch uns mir mich dir dich kann können muss müssen soll sollen will wollen darf dürfen mag mögen heute morgen gestern dann denn doch schon sehr viel viele wenig mal jetzt hier dort immer nie wieder alle alles etwas nichts keine kein was wer wo wann warum welche welcher welches dieser diese dieses jener seine ihre unser unsere ihrer seiner haus hause schule schüler lehrer aufgabe aufgaben stunde stunden woche wochen tag tage jahr jahre zeit mensch menschen leben arbeit text buch seite frage antwort beispiel wichtig gut schlecht neu alt gross klein lang kurz").split(" ").toSet(),
    "en" to ("the of and to in a is that for it as was with be by on not he i this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no she about their them than then some into only other could time these two may first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three").split(" ").toSet(),
)

private data class KeyPos(val row: Int, val column: Double)

private val keyNeighbours: Map<String, Set<String>> = run {
    val rows = listOf("qwertzuiopü", "asdfghjklöä", "yxcvbnm")
    val offsets = listOf(0.0, 0.5, 1.5)
    val positions = HashMap<String, KeyPos>()
    rows.forEachIndexed { rowIndex, row ->
        row.forEachIndexed { column, key ->
            positions[key.toString()] = KeyPos(rowIndex, column + offsets[rowIndex])
        }
    }
    positions.mapValues { (key, position) ->
        positions.filter { (other, otherPosition) ->
            other != key &&
                abs(position.row - otherPosition.row) <= 1 &&
                abs(position.column - otherPosition.column) <= 1.0
        }.keys.toMutableSet().also { near ->
            if (key == "y") near += "z"
            if (key == "z") near += "y"
        }
    }
}

private data class Edit(val word: String, val kind: String)

private fun codePoints(word: String): List<String> {
    val letters = ArrayList<String>(word.length)
    var index = 0
    while (index < word.length) {
        val point = word.codePointAt(index)
        letters += String(Character.toChars(point))
        index += Character.charCount(point)
    }
    return letters
}

private fun join(letters: List<String>, from: Int, to: Int = letters.size): String {
    val out = StringBuilder()
    for (index in from until to) out.append(letters[index])
    return out.toString()
}

/** One edit away from [word]. [likelyOnly] keeps slips a hand actually makes. */
fun editsAtDistanceOne(word: String, alphabet: String, likelyOnly: Boolean = false): List<Pair<String, String>> {
    val letters = codePoints(word)
    val alphabetSet = alphabet.toSet()
    val edits = ArrayList<Edit>()
    for (index in letters.indices) {
        val before = join(letters, 0, index)
        val after = join(letters, index + 1)
        val removed = letters[index]
        val doubled = (index > 0 && letters[index - 1] == removed) || (index + 1 < letters.size && letters[index + 1] == removed)
        edits += Edit(before + after, if (doubled) "double" else "delete")
        if (index + 1 < letters.size && letters[index] != letters[index + 1]) {
            edits += Edit(before + letters[index + 1] + letters[index] + join(letters, index + 2), "transpose")
        }
        edits += Edit(before + removed + removed + after, "double")
        val umlaut = UMLAUT_PAIRS[removed]
        if (umlaut != null && umlaut[0] in alphabetSet) edits += Edit(before + umlaut + after, "umlaut")
        for (near in keyNeighbours[removed].orEmpty()) {
            if (near[0] in alphabetSet && UMLAUT_PAIRS[removed] != near) edits += Edit(before + near + after, "near")
        }
        if (likelyOnly) continue
        for (letter in alphabet) {
            val text = letter.toString()
            if (text == removed || UMLAUT_PAIRS[removed] == text || keyNeighbours[removed]?.contains(text) == true) continue
            edits += Edit(before + text + after, "replace")
        }
    }
    if (!likelyOnly) {
        for (index in 0..letters.size) {
            val before = join(letters, 0, index)
            val after = join(letters, index)
            for (letter in alphabet) {
                val text = letter.toString()
                if ((index > 0 && letters[index - 1] == text) || (index < letters.size && letters[index] == text)) continue
                edits += Edit(before + text + after, "insert")
            }
        }
    }
    return edits.map { it.word to it.kind }
}

private fun spellingLocale(language: String) = if (language == "de") Locale.forLanguageTag("de-CH") else Locale.US

fun restoreWordCase(typed: String, replacement: String, language: String): String {
    val locale = spellingLocale(language)
    val letters = codePoints(typed).filter { it.first().isLetter() }
    val upper: (String) -> Boolean = { character ->
        val up = character.uppercase(locale)
        val down = character.lowercase(locale)
        character == up && character != down
    }
    if (letters.size > 1 && letters.all(upper)) return replacement.uppercase(locale)
    val first = letters.firstOrNull()
    if (first != null && upper(first)) {
        val head = replacement.substring(0, replacement.offsetByCodePoints(0, 1))
        return head.uppercase(locale) + replacement.substring(head.length)
    }
    return replacement
}

fun suggestCorrections(
    typed: String,
    languages: List<String>,
    lexicon: SpellingLexicon,
    limit: Int = 6,
    maxDistance: Int = 2,
): List<SpellingSuggestion> {
    val results = LinkedHashMap<String, SpellingSuggestion>()
    fun consider(candidate: String, language: String, distance: Int, cost: Int, typedLower: String) {
        if (candidate.isEmpty() || candidate == typedLower || !lexicon.hasWord(language, candidate)) return
        val firstLetterPenalty = if (candidate[0] == typedLower[0]) 0 else 5
        val lengthPenalty = abs(candidate.length - typedLower.length)
        val commonBonus = if (COMMON_WORDS[language]?.contains(candidate) == true) COMMON_WORD_BONUS else 0
        val uncertainty = lexicon.candidatePenalty(language, candidate)
        val score = distance * 100 + cost * 10 + firstLetterPenalty + lengthPenalty - commonBonus + uncertainty
        val restored = restoreWordCase(typed, candidate, language)
        val existing = results[restored]
        if (existing == null || existing.score > score) {
            results[restored] = SpellingSuggestion(restored, distance, score, language)
        }
    }
    for (language in languages) {
        val lower = normalizeSpellingForm(typed, language)
        if (!lower.matches(Regex("""^\p{L}+$"""))) continue
        val alphabet = ALPHABETS[language] ?: continue
        val firstEdits = editsAtDistanceOne(lower, alphabet)
        for ((word, kind) in firstEdits) consider(word, language, 1, EDIT_COST[kind] ?: 3, lower)
        for (split in 2..(lower.length - 2).coerceAtLeast(1)) {
            if (split > lower.length - 2) break
            val head = lower.substring(0, split)
            val tail = lower.substring(split)
            fun listed(part: String) = lexicon.hasWord(language, part) && lexicon.candidatePenalty(language, part) == 0
            if (listed(head) && listed(tail)) {
                val restored = "${restoreWordCase(typed, head, language)} $tail"
                val common = (if (COMMON_WORDS[language]?.contains(head) == true) 1 else 0) +
                    (if (COMMON_WORDS[language]?.contains(tail) == true) 1 else 0)
                if (restored !in results) {
                    results[restored] = SpellingSuggestion(
                        restored,
                        1,
                        100 + (EDIT_COST["double"] ?: 1) * 10 + 2 - common * 4,
                        language,
                    )
                }
            }
        }
        val foundAtOne = results.values.count { it.language == language && it.distance == 1 }
        if (maxDistance >= 2 && lower.length >= 5 && foundAtOne < 2) {
            val seen = HashSet<String>()
            var probes = 0
            val ordered = firstEdits.sortedBy { EDIT_COST[it.second] ?: 3 }
            outer@ for ((word, kind) in ordered) {
                for ((second, secondKind) in editsAtDistanceOne(word, alphabet, likelyOnly = true)) {
                    if (!seen.add(second)) continue
                    probes += 1
                    if (probes > MAX_DISTANCE_TWO_PROBES) break@outer
                    consider(second, language, 2, (EDIT_COST[kind] ?: 3) + (EDIT_COST[secondKind] ?: 1), lower)
                }
            }
        }
    }
    val collator = Collator.getInstance(Locale.GERMAN)
    return results.values.sortedWith(compareBy<SpellingSuggestion> { it.score }.thenBy(collator) { it.word }).take(limit)
}

data class AutocorrectContext(
    val language: String?,
    val sentenceStart: Boolean,
    val isProperName: (String) -> Boolean,
)

/** The one replacement safe enough to apply while typing, or null. */
fun decideAutocorrect(typed: String, suggestions: List<SpellingSuggestion>, context: AutocorrectContext): SpellingSuggestion? {
    if (typed.length < 3 || typed.length > 24 || !typed.matches(Regex("""^\p{L}+$"""))) return null
    val letters = codePoints(typed)
    val upper = letters.filter { letter ->
        val locale = Locale.ROOT
        letter != letter.lowercase(locale) && letter == letter.uppercase(locale)
    }
    if (upper.size > 1) return null
    val capitalised = upper.size == 1 && letters.firstOrNull() == upper.first()
    if (upper.size == 1 && !capitalised) return null
    if (context.isProperName(normalizeSpellingForm(typed, "en"))) return null
    if (capitalised && context.language == "en" && !context.sentenceStart) return null
    val nearest = suggestions.filter { it.distance == 1 && !it.word.contains(' ') }
    if (nearest.isEmpty()) return null
    val best = nearest[0]
    val runnerUp = nearest.getOrNull(1)
    if (best.score >= 100 + (EDIT_COST["replace"] ?: 3) * 10) return null
    if (runnerUp != null && runnerUp.score - best.score < 20) return null
    return best
}

fun normalizeForDictionary(word: String): String =
    normalizeSpellingForm(word.trim(), "de").trim('\'', '’', '-')
