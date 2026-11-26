package ch.fasrv.fanotes.desk

import java.text.Collator
import java.util.Locale
import kotlin.math.abs

/**
 * Correction candidates for a misspelled word, checked against the exact word
 * list. Ported from `fanotes/src/lib/spellingSuggest.ts`.
 */

data class SpellingSuggestion(
    val word: String,
    val distance: Int,
    val score: Int,
    val language: String,
)

interface SuggestionLexicon {
    fun hasWord(language: String, normalizedWord: String): Boolean
    fun candidatePenalty(language: String, normalizedWord: String): Int = 0
}

private val ALPHABETS = mapOf(
    "de" to "abcdefghijklmnopqrstuvwxyzäöü",
    "en" to "abcdefghijklmnopqrstuvwxyz",
    "fr" to "abcdefghijklmnopqrstuvwxyzàâçéèêëîïôùûüÿœ",
)

/** Accent slips in French: a missing or wrong accent costs as little as a missing umlaut. */
private val FRENCH_ACCENTS = mapOf(
    'a' to "àâ", 'à' to "aâ", 'â' to "aà",
    'c' to "ç", 'ç' to "c",
    'e' to "éèêë", 'é' to "eèêë", 'è' to "eéêë", 'ê' to "eéèë", 'ë' to "eéèê",
    'i' to "îï", 'î' to "iï", 'ï' to "iî",
    'o' to "ôœ", 'ô' to "o", 'œ' to "o",
    'u' to "ùûü", 'ù' to "uûü", 'û' to "uùü", 'ü' to "uùû",
    'y' to "ÿ", 'ÿ' to "y",
)

/** The accent variants of a letter that count as one cheap slip: umlauts for German, accents for French. */
private fun accentVariants(letter: Char, language: String?): List<Char> {
    if (language == "fr") return FRENCH_ACCENTS[letter]?.toList().orEmpty()
    return UMLAUT_PAIRS[letter]?.let { listOf(it) }.orEmpty()
}

private val KEY_ROWS = listOf("qwertzuiopü", "asdfghjklöä", "yxcvbnm")
private val KEY_ROW_OFFSETS = listOf(0.0, 0.5, 1.5)

private val keyNeighbours: Map<Char, Set<Char>> = run {
    val positions = HashMap<Char, Pair<Int, Double>>()
    KEY_ROWS.forEachIndexed { rowIndex, row ->
        row.forEachIndexed { column, key ->
            positions[key] = rowIndex to (column + KEY_ROW_OFFSETS[rowIndex])
        }
    }
    val neighbours = HashMap<Char, Set<Char>>()
    for ((key, position) in positions) {
        val near = HashSet<Char>()
        for ((other, otherPosition) in positions) {
            if (other == key) continue
            if (abs(position.first - otherPosition.first) <= 1 && abs(position.second - otherPosition.second) <= 1.0) {
                near += other
            }
        }
        neighbours[key] = near
    }
    neighbours.getOrPut('y') { HashSet() }.let { (neighbours['y'] as? HashSet)?.add('z') }
    (neighbours['z'] as? HashSet)?.add('y')
    neighbours
}

private val UMLAUT_PAIRS = mapOf('a' to 'ä', 'ä' to 'a', 'o' to 'ö', 'ö' to 'o', 'u' to 'ü', 'ü' to 'u')

private val COMMON_WORDS = mapOf(
    "de" to ("der die das und ist in den von zu mit sich des auf für nicht ein eine einer eines einem einen als auch es an werden aus er hat dass sie nach wird bei noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei wenn ich wir ihr euch uns mir mich dir dich kann können muss müssen soll sollen will wollen darf dürfen mag mögen heute morgen gestern dann denn doch schon sehr viel viele wenig mal jetzt hier dort immer nie wieder alle alles etwas nichts keine kein was wer wo wann warum welche welcher welches dieser diese dieses jener seine ihre unser unsere ihrer seiner haus hause schule schüler lehrer aufgabe aufgaben stunde stunden woche wochen tag tage jahr jahre zeit mensch menschen leben arbeit text buch seite frage antwort beispiel wichtig gut schlecht neu alt gross klein lang kurz").split(' ').toSet(),
    "en" to ("the of and to in a is that for it as was with be by on not he i this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no she about their them than then some into only other could time these two may first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three").split(' ').toSet(),
    "fr" to ("le la les un une des de du et est en que qui dans pour pas sur au avec ce il elle je tu nous vous ils elles ne se son sa ses mais ou où donc car comme plus par être avoir fait faire dit très bien tout tous aussi cette ces mon ma mes ton ta tes leur leurs notre votre nos vos si y a été était sont ont suis es sommes êtes ai as avons avez peu peut sans sous entre chez vers avant après depuis pendant toujours jamais rien déjà encore alors maison école élève professeur livre cahier chien chat homme femme enfant ami ville pays monde jour nuit temps année semaine mois heure eau pain lait grand petit nouveau bon beau vieux jeune français allemand anglais").split(' ').toSet(),
)
private const val COMMON_WORD_BONUS = 25

private val EDIT_COST = mapOf(
    "transpose" to 0,
    "double" to 1,
    "near" to 1,
    "umlaut" to 1,
    "delete" to 2,
    "insert" to 2,
    "replace" to 3,
)

data class SpellingEdit(val word: String, val kind: String)

private const val MAX_DISTANCE_TWO_PROBES = 60_000
private val GERMAN_COLLATOR: Collator = Collator.getInstance(Locale.GERMAN)

fun editsAtDistanceOne(word: String, alphabet: String, likelyOnly: Boolean = false, language: String? = null): List<SpellingEdit> {
    val letters = word.toList()
    val edits = ArrayList<SpellingEdit>()
    for (index in letters.indices) {
        val before = letters.subList(0, index).joinToString("")
        val after = letters.subList(index + 1, letters.size).joinToString("")
        val removed = letters[index]
        val doubled = (index > 0 && letters[index - 1] == removed) || (index + 1 < letters.size && letters[index + 1] == removed)
        edits += SpellingEdit(before + after, if (doubled) "double" else "delete")
        if (index + 1 < letters.size && letters[index] != letters[index + 1]) {
            val swapped = before + letters[index + 1] + letters[index] + letters.subList(index + 2, letters.size).joinToString("")
            edits += SpellingEdit(swapped, "transpose")
        }
        edits += SpellingEdit(before + removed + removed + after, "double")
        val variants = accentVariants(removed, language)
        for (variant in variants) {
            if (variant in alphabet) edits += SpellingEdit(before + variant + after, "umlaut")
        }
        for (near in keyNeighbours[removed].orEmpty()) {
            if (near in alphabet && near !in variants) edits += SpellingEdit(before + near + after, "near")
        }
        if (likelyOnly) continue
        for (letter in alphabet) {
            if (letter == removed || letter in variants || keyNeighbours[removed]?.contains(letter) == true) continue
            edits += SpellingEdit(before + letter + after, "replace")
        }
    }
    if (likelyOnly) return edits
    for (index in 0..letters.size) {
        val before = letters.subList(0, index).joinToString("")
        val after = letters.subList(index, letters.size).joinToString("")
        for (letter in alphabet) {
            val left = letters.getOrNull(index - 1)
            val right = letters.getOrNull(index)
            if (left == letter || right == letter) continue
            edits += SpellingEdit(before + letter + after, "insert")
        }
    }
    return edits
}

fun restoreWordCase(typed: String, replacement: String, language: String): String {
    val locale = Locale.forLanguageTag(when (language) { "de" -> "de-CH"; "fr" -> "fr-FR"; else -> "en-US" })
    val letters = typed.filter { it.isLetter() }
    if (letters.length > 1 && letters.all { it == it.uppercase(locale).singleOrNull() && it != it.lowercase(locale).singleOrNull() }) {
        return replacement.uppercase(locale)
    }
    val first = letters.firstOrNull()
    if (first != null && first == first.uppercase(locale).singleOrNull() && first != first.lowercase(locale).singleOrNull()) {
        return replacement.replaceFirstChar { it.uppercase(locale) }
    }
    return replacement
}

private fun normalizedForm(word: String, language: String) = normalizeWord(word, language)

fun suggestCorrections(
    typed: String,
    languages: List<String>,
    lexicon: SuggestionLexicon,
    limit: Int = 6,
    maxDistance: Int = 2,
): List<SpellingSuggestion> {
    val results = LinkedHashMap<String, SpellingSuggestion>()
    fun consider(candidate: String, language: String, distance: Int, cost: Int, typedLower: String) {
        if (candidate.isEmpty() || candidate == typedLower || !lexicon.hasWord(language, candidate)) return
        val firstLetterPenalty = if (candidate.first() == typedLower.first()) 0 else 5
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
    val lettersOnly = Regex("""^\p{L}+$""")
    for (language in languages) {
        val lower = normalizedForm(typed, language)
        if (!lettersOnly.matches(lower)) continue
        val alphabet = ALPHABETS[language] ?: continue
        val firstEdits = editsAtDistanceOne(lower, alphabet, false, language)
        for (edit in firstEdits) consider(edit.word, language, 1, EDIT_COST[edit.kind] ?: 3, lower)
        var split = 2
        while (split <= lower.length - 2) {
            val head = lower.substring(0, split)
            val tail = lower.substring(split)
            val listed = { part: String ->
                lexicon.hasWord(language, part) && lexicon.candidatePenalty(language, part) == 0
            }
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
            split += 1
        }
        val foundAtOne = results.values.count { it.language == language && it.distance == 1 }
        if (maxDistance >= 2 && lower.length >= 5 && foundAtOne < 2) {
            val seen = HashSet<String>()
            var probes = 0
            val ordered = firstEdits.sortedBy { EDIT_COST[it.kind] ?: 3 }
            outer@ for (first in ordered) {
                for (second in editsAtDistanceOne(first.word, alphabet, likelyOnly = true, language = language)) {
                    if (!seen.add(second.word)) continue
                    probes += 1
                    if (probes > MAX_DISTANCE_TWO_PROBES) break@outer
                    consider(second.word, language, 2, (EDIT_COST[first.kind] ?: 3) + (EDIT_COST[second.kind] ?: 3), lower)
                }
            }
        }
    }
    return results.values.sortedWith(compareBy<SpellingSuggestion> { it.score }.thenBy(GERMAN_COLLATOR) { it.word }).take(limit)
}

data class AutocorrectContext(
    val language: String?,
    val sentenceStart: Boolean,
    val isProperName: (String) -> Boolean,
)

fun decideAutocorrect(
    typed: String,
    suggestions: List<SpellingSuggestion>,
    context: AutocorrectContext,
): SpellingSuggestion? {
    if (typed.length < 3 || typed.length > 24 || !Regex("""^\p{L}+$""").matches(typed)) return null
    val letters = typed.toList()
    val upper = letters.filter { it != it.lowercaseChar() && it == it.uppercaseChar() }
    if (upper.size > 1) return null
    val capitalised = upper.size == 1 && letters.first() == upper.first()
    if (upper.size == 1 && !capitalised) return null
    if (context.isProperName(normalizedForm(typed, "en"))) return null
    if (capitalised && (context.language == "en" || context.language == "fr") && !context.sentenceStart) return null
    val nearest = suggestions.filter { it.distance == 1 && ' ' !in it.word }
    if (nearest.isEmpty()) return null
    val best = nearest[0]
    val runnerUp = nearest.getOrNull(1)
    if (best.score >= 100 + (EDIT_COST["replace"] ?: 3) * 10) return null
    if (runnerUp != null && runnerUp.score - best.score < 20) return null
    return best
}

/** Exact lists plus German compounds of listed parts, matching the desktop lexicon. French is read lazily. */
class SpellingLexicon(
    private val dictionaries: SpellingDictionaries,
    private val personal: Set<String> = emptySet(),
) : SuggestionLexicon {
    val languages = listOf("de", "en")

    /** True once the exact French list is in memory; until then French suggestions and autocorrect stay off. */
    val frenchReady: Boolean get() = dictionaries.frenchWordsLoaded

    /** Reads the exact French list (about 5 MB). Blocks: call it off the UI thread. */
    fun loadFrench(): Boolean = dictionaries.frenchWords() != null

    override fun hasWord(language: String, normalizedWord: String): Boolean {
        if (normalizedWord in personal) return true
        if (listed(language, normalizedWord)) return true
        return language == "de" && dictionaries.deWords != null &&
            splitsIntoGermanParts(normalizedWord) { part -> dictionaries.deWords.contains(part) }
    }

    override fun candidatePenalty(language: String, normalizedWord: String): Int {
        if (listed(language, normalizedWord) || normalizedWord in personal) return 0
        val bloom = when (language) {
            "de" -> dictionaries.de
            "fr" -> dictionaries.fr
            else -> dictionaries.en
        }
        return if (bloom?.hasNormalized(normalizedWord) == true) 4 else 15
    }

    /** True when the word would be underlined: unknown to [among] (German and English by default) and to the user. */
    fun isMisspelled(word: String, among: List<String> = languages): Boolean {
        val membership = wordMembership(word, dictionaries, personal)
        return among.none { membership[it] }
    }

    private fun listed(language: String, normalized: String): Boolean = when (language) {
        "de" -> dictionaries.deWords?.contains(normalized) == true
        "en" -> dictionaries.enWords?.contains(normalized) == true
        "fr" -> dictionaries.frenchWordsLoaded && dictionaries.frenchWords()?.contains(normalized) == true
        else -> false
    }
}
