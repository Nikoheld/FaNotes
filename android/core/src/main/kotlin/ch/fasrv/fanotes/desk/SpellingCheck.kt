package ch.fasrv.fanotes.desk

/**
 * Underlines and finished-word autocorrect from the desktop spelling pass.
 * Code, maths, links, and the word under the cursor stay untouched.
 */

data class SpellingError(val from: Int, val to: Int, val word: String, val language: String)

data class SpellingLine(val from: Int, val to: Int, val language: String)

data class SpellingCheckResult(
    val errors: List<SpellingError>,
    val lines: List<SpellingLine>,
    val detectedLanguage: String,
)

private val WORD_PATTERN = Regex("""\p{L}[\p{L}\p{M}'’\-]*""")
private val DE_STOPWORDS = setOf(
    "aber", "als", "auch", "auf", "aus", "bei", "das", "dem", "den", "der", "des", "die",
    "ein", "eine", "einer", "eines", "für", "hat", "ich", "im", "in", "ist", "mit", "nicht",
    "oder", "sich", "sie", "sind", "und", "von", "war", "werden", "wie", "wir", "zu", "zum",
)
private val EN_STOPWORDS = setOf(
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he", "in", "is",
    "it", "not", "of", "on", "or", "she", "that", "the", "this", "to", "was", "we", "were",
    "will", "with", "you",
)
private val FRENCH_STOPWORDS = setOf(
    "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "mais", "dans", "sur", "avec",
    "pour", "par", "je", "tu", "il", "elle", "nous", "vous", "est", "sont", "pas", "que", "qui",
    "au", "aux", "ce", "cette", "ces", "mon", "ton", "son",
)
private val FRENCH_WORDS = """
le la les un une des de du et ou mais donc car ni que qui quoi dont
je tu il elle on nous vous ils elles me te se lui leur y en mon ton son
ma ta sa mes tes ses notre votre leur nos vos leurs ce cet cette ces
est suis es sommes etes sont ete etait ai as a avons avez ont
pas ne plus jamais rien personne
dans sur sous avec sans pour par chez entre vers pendant avant apres
etre avoir faire aller dire voir savoir pouvoir vouloir devoir prendre
mettre donner trouver parler aimer arriver rester passer penser
bonjour merci oui non tres bien mal petit grand nouveau
ecole eleve professeur devoir examen lecon cahier stylo livre texte
phrase mot lettre grammaire vocabulaire conjugaison exercice
francais anglais allemand mathematiques histoire geographie
physique chimie biologie informatique
aujourd demain hier matin soir semaine mois annee
lundi mardi mercredi jeudi vendredi samedi dimanche
janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre
un deux trois quatre cinq six sept huit neuf dix vingt trente cent
rouge bleu vert jaune noir blanc
maison famille ami amie mere pere frere soeur enfant
eau pain fromage lait cafe the
lire ecrire ecouter parler comprendre repondre traduire
question reponse exemple phrase correct incorrect
""".trim().split(Regex("""\s+""")).map { foldFrench(it) }.filter { it.length >= 2 }.toSet()

private fun foldFrench(word: String): String = word
    .lowercase(java.util.Locale.FRANCE)
    .replace(Regex("[àâä]"), "a")
    .replace(Regex("[éèêë]"), "e")
    .replace(Regex("[îï]"), "i")
    .replace(Regex("[ôö]"), "o")
    .replace(Regex("[ùûü]"), "u")
    .replace("ç", "c")
    .replace("œ", "oe")
    .trim('\'', '’', '-')

fun isFrenchWord(word: String) = foldFrench(word) in FRENCH_WORDS

private data class IgnoredRange(val from: Int, val to: Int)

private fun automaticIgnoredRanges(from: Int, text: String): List<IgnoredRange> {
    val ranges = ArrayList<IgnoredRange>()
    val patterns = listOf(
        Regex("`[^`]*`"),
        Regex("""\$\$[^$]*\$\$|\$[^$\n]+\$"""),
        Regex("""https?://[^\s)>]+|www\.[^\s)>]+|[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}""", RegexOption.IGNORE_CASE),
        Regex("<[^>]+>"),
        Regex("""\]\([^)]*\)"""),
    )
    for (pattern in patterns) {
        for (match in pattern.findAll(text)) {
            ranges += IgnoredRange(from + match.range.first, from + match.range.last + 1)
        }
    }
    return ranges
}

private fun intersects(from: Int, to: Int, ranges: List<IgnoredRange>) =
    ranges.any { from < it.to && to > it.from }

fun checkSpelling(text: String, cursor: Int = -1, accepted: Set<String> = emptySet()): SpellingCheckResult {
    if (text.isEmpty()) return SpellingCheckResult(emptyList(), emptyList(), "unknown")
    val dictionary = SpellingDictionary.get()
    val ignored = automaticIgnoredRanges(0, text)
    data class Token(val word: String, val from: Int, val to: Int, val normalized: String, val de: Boolean, val en: Boolean)
    val words = WORD_PATTERN.findAll(text).mapNotNull { match ->
        val word = match.value
        val from = match.range.first
        val to = match.range.last + 1
        val normalized = normalizeSpellingForm(word, "de")
        val previous = text.getOrNull(from - 1)
        if (
            normalized.length < 2 ||
            intersects(from, to, ignored) ||
            (cursor in from..to) ||
            previous == '#' ||
            (word.length <= 16 && word.matches(Regex("""^[A-ZÄÖÜ]{2,}$"""))) ||
            word.contains(Regex("""\p{Ll}\p{Lu}"""))
        ) {
            null
        } else {
            val membership = dictionary.membership(word, accepted)
            Token(word, from, to, normalized, membership.first, membership.second)
        }
    }.toList()
    var de = 0
    var en = 0
    var fr = 0
    for (token in words) {
        if (token.normalized in DE_STOPWORDS) de += 3
        if (token.normalized in EN_STOPWORDS) en += 3
        if (token.normalized in FRENCH_STOPWORDS || isFrenchWord(token.word)) fr += 3
        if (token.de && !token.en) de += 2
        if (token.en && !token.de) en += 2
    }
    val documentLanguage = when {
        de == 0 && en == 0 -> if (fr > 0) "fr" else "unknown"
        de >= en * 1.35 -> "de"
        en >= de * 1.35 -> "en"
        en > de -> "en"
        else -> "de"
    }
    val detected = when {
        fr > de && fr > en -> "fr"
        documentLanguage == "unknown" -> "unknown"
        else -> documentLanguage
    }
    val errors = words.mapNotNull { token ->
        if (token.de || token.en || isFrenchWord(token.word)) null
        else SpellingError(token.from, token.to, token.word, if (detected == "unknown") "de" else detected)
    }
    val lines = if (text.isNotBlank() && detected != "unknown") listOf(SpellingLine(0, text.length, detected)) else emptyList()
    return SpellingCheckResult(errors, lines, detected)
}

private val BOUNDARY = Regex("""^[\s.,;:!?]$""")

data class AutocorrectMark(
    val from: Int,
    val to: Int,
    val original: String,
    val replacement: String,
    val boundary: Int,
)

data class AutocorrectEdit(val text: String, val cursor: Int, val mark: AutocorrectMark)

/**
 * The desktop input handler: a single boundary character after a misspelled
 * word is already in [next]. The fix keeps that boundary and is its own edit.
 */
fun autocorrectBoundaryEdit(
    previous: String,
    next: String,
    insertionAt: Int,
    deleted: Int,
    accepted: Set<String> = emptySet(),
    declined: Set<String> = emptySet(),
): AutocorrectEdit? {
    if (deleted != 0 || next.length != previous.length + 1) return null
    if (insertionAt < 0 || insertionAt >= next.length) return null
    val boundary = next.substring(insertionAt, insertionAt + 1)
    if (!BOUNDARY.matches(boundary)) return null
    if (previous != next.removeRange(insertionAt, insertionAt + 1)) return null
    val dictionary = SpellingDictionary.get()
    var start = insertionAt
    while (start > 0 && next[start - 1].isLetter()) start -= 1
    if (start == insertionAt) return null
    if (start > 0 && next[start - 1].toString().matches(Regex("""[\p{L}\p{M}\d'’\-_#@/\\.:&+]"""))) return null
    val word = next.substring(start, insertionAt)
    if (normalizeForDictionary(word) in declined) return null
    if (!dictionary.isMisspelled(word, accepted)) return null
    if (automaticIgnoredRanges(0, next).any { start < it.to && insertionAt > it.from }) return null
    val lineStart = next.lastIndexOf('\n', (start - 1).coerceAtLeast(0)).let { if (it < 0 || start == 0) 0 else it + 1 }
    val lineLanguage = checkSpelling(next.substring(lineStart, insertionAt), accepted = accepted).detectedLanguage
    val language = lineLanguage.takeIf { it == "de" || it == "en" }
    val suggestions = suggestCorrections(
        word,
        if (language != null) listOf(language) else listOf("de", "en"),
        dictionary,
        limit = 4,
        maxDistance = 1,
    )
    val beforeWord = next.substring(lineStart, start).replace(Regex("""^\s*(?:[-*+>]|\d+[.)]|#{1,6})?\s*"""), "")
    val sentenceStart = beforeWord.isBlank() || Regex("""[.!?:]\s*$""").containsMatchIn(beforeWord)
    val decision = decideAutocorrect(
        word,
        suggestions,
        AutocorrectContext(language, sentenceStart, dictionary::isProperName),
    ) ?: return null
    val text = next.replaceRange(start, insertionAt, decision.word)
    val delta = decision.word.length - word.length
    val cursor = insertionAt + 1 + delta
    return AutocorrectEdit(
        text,
        cursor,
        AutocorrectMark(start, start + decision.word.length, word, decision.word, 1),
    )
}

/** Backspace directly after an autocorrect restores the typed word and drops the boundary. */
fun revertAutocorrectEdit(text: String, cursor: Int, mark: AutocorrectMark): Pair<String, Int>? {
    if (mark.boundary == 0 || cursor != mark.to + mark.boundary) return null
    val end = mark.to + mark.boundary
    if (mark.from < 0 || end > text.length || mark.to > text.length) return null
    if (text.substring(mark.from, mark.to) != mark.replacement) return null
    val next = text.substring(0, mark.from) + mark.original + text.substring(end)
    return next to (mark.from + mark.original.length)
}
