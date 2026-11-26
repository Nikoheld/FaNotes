package ch.fasrv.fanotes.desk

/**
 * Language detection for the spellchecker and autocorrect, ported from
 * `fanotes/src/lib/languageDetect.ts` (desktop #1473). Pure logic: callers hand in the words of a
 * passage together with what the dictionaries know about each of them.
 *
 * Three levels of evidence decide the language of a passage (a sentence, list item, table cell, one
 * side of a vocabulary line "le chien – der Hund", or a quotation):
 *   1. the passage itself (stopwords, words only one dictionary knows, diacritics),
 *   2. its paragraph neighbours,
 *   3. the language profile of the whole note.
 * A passage with strong local evidence ignores the rest; a single word or a heading falls back to the
 * neighbours and the profile. Autocorrect only acts on a passage whose language is confident.
 */

data class LanguageEvidence(var de: Double = 0.0, var en: Double = 0.0, var fr: Double = 0.0) {
    operator fun get(language: String): Double = when (language) {
        "de" -> de
        "en" -> en
        else -> fr
    }

    operator fun set(language: String, value: Double) {
        when (language) {
            "de" -> de = value
            "en" -> en = value
            else -> fr = value
        }
    }

    fun copyOf() = LanguageEvidence(de, en, fr)
}

data class WordLanguages(val de: Boolean, val en: Boolean, val fr: Boolean) {
    operator fun get(language: String): Boolean = when (language) {
        "de" -> de
        "en" -> en
        else -> fr
    }
}

data class EvidenceToken(val word: String, val normalized: String, val membership: WordLanguages)

val TEXT_LANGUAGES = listOf("de", "en", "fr")

fun addEvidence(target: LanguageEvidence, source: LanguageEvidence, weight: Double = 1.0): LanguageEvidence {
    target.de += source.de * weight
    target.en += source.en * weight
    target.fr += source.fr * weight
    return target
}

fun evidenceTotal(evidence: LanguageEvidence) = evidence.de + evidence.en + evidence.fr

/** Java's `\s` is ASCII only; the desktop (JavaScript) `\s` also covers no-break and Unicode spaces. */
internal fun uregex(pattern: String, vararg options: RegexOption) = Regex("(?U)$pattern", options.toSet())

internal fun isJsSpace(char: Char) = char.isWhitespace() || char == ' ' || char == '﻿' || char == ' ' || char == ' '

/* ---------- stopwords ---------- */

private fun words(list: String) = list.split(Regex("\\s+")).filter { it.isNotEmpty() }

private val DE_STOPWORDS = words(
    """aber als auch auf aus bei das dem den der des die ein eine einer eines einem einen für hat haben hatte
  ich im in ist mit nicht oder sich sie sind und von war waren werden wird wie wir zu zum zur es er du ihr
  wenn dass weil was wer wo noch nur schon sehr mehr dann doch also man kein keine über unter nach vor bis
  mein dein sein unser euer mich dich uns euch mir dir ihm ihn hier dort heute morgen bin bist seid kann
  können muss müssen soll will wurde wurden gibt gab im am vom beim ins ans aufs""",
)
private val EN_STOPWORDS = words(
    """a an and are as at be by for from has have had he in is it not of on or she that the this to was we were
  will with you i they them their your my his her its our do does did if so than then there here what which who
  when where how can could would should been being am no yes but about into out up all some any more most
  very just also only over after before because while these those""",
)
private val FR_STOPWORDS = words(
    """le la les un une des de du et ou mais donc car ni que qui quoi dont où je tu il elle on nous vous ils
  elles me te se lui leur y en mon ton son ma ta sa mes tes ses notre votre nos vos leurs ce cet cette ces
  est suis es sommes êtes sont été était étaient ai as a avons avez ont pas ne plus jamais rien dans sur sous
  avec sans pour par chez entre vers au aux très bien aussi comme tout tous toute toutes si cela ça ceci
  quand pourquoi comment alors depuis pendant avant après non oui peu beaucoup déjà encore toujours""",
)

// Languages the app has no dictionary for. Their stopwords only serve to recognise such a passage as
// "unsupported", so it is neither underlined nor autocorrected.
private val OTHER_STOPWORDS = words(
    """il lo gli di che è e al sul dal nei sono non per con una uno della delle dei degli nel nella questo questa
  molto anche come più ma mi ti ci vi sei siamo siete ho hai ha abbiamo hanno io lui lei noi voi loro cosa sì quando dove
  perché se bene grazie prego ciao buongiorno buonasera oggi domani ieri stai sto sta casa vicino grande piccolo
  el los las del y es por para muy pero más esta este está tiene tengo soy eres somos yo tú él ella
  nosotros también cuando donde porque hola gracias buenos días o os um uma não são você nós isso muito mas
  het een van dat niet zijn voor met ook maar naar dit wat ik je ze wij""",
)

private class StopwordWeights(var de: Double = 0.0, var en: Double = 0.0, var fr: Double = 0.0, var other: Double = 0.0)

private val STOPWORDS: Map<String, StopwordWeights> = run {
    val owners = LinkedHashMap<String, MutableList<String>>()
    for ((name, list) in listOf("de" to DE_STOPWORDS, "en" to EN_STOPWORDS, "fr" to FR_STOPWORDS, "other" to OTHER_STOPWORDS)) {
        for (word in list) owners.getOrPut(word) { ArrayList() }.add(name)
    }
    // A stopword two languages share ("in", "a", "des", "son") is split between them instead of counting fully for both.
    val table = HashMap<String, StopwordWeights>()
    for ((word, names) in owners) {
        val weights = StopwordWeights()
        for (name in names) {
            val share = 3.0 / names.size
            when (name) {
                "de" -> weights.de = share
                "en" -> weights.en = share
                "fr" -> weights.fr = share
                else -> weights.other = share
            }
        }
        table[word] = weights
    }
    table
}

private val FRENCH_ELISION = uregex("""^(?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu|quoiqu)['’]\p{L}""")

// "è" is left out on purpose: Italian uses it as much as French does.
private val FRENCH_LETTERS = Regex("[éêàçœâîôûùëï]")
private val GERMAN_LETTERS = Regex("[äöüß]")

/* ---------- scoring ---------- */

class StopwordTotals(var de: Double = 0.0, var en: Double = 0.0, var fr: Double = 0.0, var other: Double = 0.0)

class PassageScore(
    val evidence: LanguageEvidence = LanguageEvidence(),
    /** The stopword part of [evidence], plus the stopwords of unsupported languages. */
    val stopwords: StopwordTotals = StopwordTotals(),
    var words: Int = 0,
    /** Words no dictionary knows. */
    var unknown: Int = 0,
)

fun mergeScores(left: PassageScore, right: PassageScore): PassageScore = PassageScore(
    addEvidence(addEvidence(LanguageEvidence(), left.evidence), right.evidence),
    StopwordTotals(
        left.stopwords.de + right.stopwords.de,
        left.stopwords.en + right.stopwords.en,
        left.stopwords.fr + right.stopwords.fr,
        left.stopwords.other + right.stopwords.other,
    ),
    left.words + right.words,
    left.unknown + right.unknown,
)

fun scoreTokens(tokens: List<EvidenceToken>): PassageScore {
    val score = PassageScore()
    for (token in tokens) {
        score.words += 1
        val stop = STOPWORDS[token.normalized]
        if (stop != null) {
            score.evidence.de += stop.de
            score.evidence.en += stop.en
            score.evidence.fr += stop.fr
            score.stopwords.de += stop.de
            score.stopwords.en += stop.en
            score.stopwords.fr += stop.fr
            score.stopwords.other += stop.other
        }
        if (FRENCH_ELISION.containsMatchIn(token.normalized)) {
            score.evidence.fr += 3.0
            score.stopwords.fr += 3.0
        }
        val known = TEXT_LANGUAGES.filter { token.membership[it] }
        when (known.size) {
            1 -> score.evidence[known[0]] += 2.0
            2 -> for (language in known) score.evidence[language] += 0.6
            0 -> score.unknown += 1
        }
        // Typos keep their accents, so these cues also work for words no dictionary knows.
        if (FRENCH_LETTERS.containsMatchIn(token.word)) score.evidence.fr += 1.5
        if (GERMAN_LETTERS.containsMatchIn(token.word)) score.evidence.de += 1.5
    }
    return score
}

/* ---------- decisions ---------- */

private const val STRONG_MINIMUM = 4.0
private const val STRONG_RATIO = 2.0
private const val TENTATIVE_MINIMUM = 1.5
private const val TENTATIVE_RATIO = 1.35

data class LanguageDecision(val language: String?, val confident: Boolean)

fun decideLanguage(evidence: LanguageEvidence): LanguageDecision {
    // Stable sort, like Array.prototype.sort: on a tie "de" stays ahead of "en" ahead of "fr".
    val ranked = TEXT_LANGUAGES.map { it to evidence[it] }.sortedByDescending { it.second }
    val (topLanguage, topValue) = ranked[0]
    val secondValue = ranked[1].second
    if (topValue >= STRONG_MINIMUM && topValue >= secondValue * STRONG_RATIO) return LanguageDecision(topLanguage, true)
    if (topValue >= TENTATIVE_MINIMUM && topValue >= secondValue * TENTATIVE_RATIO) return LanguageDecision(topLanguage, false)
    return LanguageDecision(null, false)
}

enum class PassageSource { LOCAL, CONTEXT, DOCUMENT, NONE }

data class PassageLanguage(
    /** The language the passage is written in; null when it cannot be told. */
    val language: String?,
    /** True only when autocorrect may rely on [language]. */
    val confident: Boolean,
    /** A language without dictionary (Italian, Spanish, ...): never underlined, never corrected. */
    val unsupported: Boolean,
    /** Mostly words no dictionary knows (a name list, a foreign quotation): never autocorrected. */
    val foreign: Boolean,
    val source: PassageSource,
)

val UNKNOWN_PASSAGE = PassageLanguage(null, false, false, false, PassageSource.NONE)

fun isUnsupported(score: PassageScore): Boolean {
    val stop = score.stopwords
    val known = maxOf(stop.de, stop.en, stop.fr)
    return score.words >= 2 && stop.other >= 4.5 && stop.other >= known * 2
}

/** Words two to three letters long are too ambiguous to call a passage "foreign". */
private fun isForeign(score: PassageScore) = score.words >= 2 && score.unknown.toDouble() / score.words >= 0.6

class ResolveContext(
    /** Evidence of neighbouring lines of the same paragraph, already weighted. */
    val neighbours: LanguageEvidence? = null,
    /** Evidence of sibling passages in the same line that probably share the language (sentences). */
    val siblings: LanguageEvidence? = null,
    /** The prior of the whole note ([profilePrior]). */
    val prior: LanguageEvidence? = null,
    /** Languages of strong sibling passages in a vocabulary line: the other side is not that one. */
    val partnerLanguages: List<String> = emptyList(),
)

/** Decides one passage: its own words first, then paragraph and note context. */
fun resolvePassage(score: PassageScore, context: ResolveContext = ResolveContext()): PassageLanguage {
    if (isUnsupported(score)) return PassageLanguage(null, false, unsupported = true, foreign = true, source = PassageSource.LOCAL)
    val foreign = isForeign(score)
    val local = decideLanguage(score.evidence)
    if (local.confident) return PassageLanguage(local.language, true, false, foreign, PassageSource.LOCAL)

    val combined = score.evidence.copyOf()
    context.neighbours?.let { addEvidence(combined, it) }
    context.siblings?.let { addEvidence(combined, it, 0.5) }
    context.prior?.let { addEvidence(combined, it) }
    val hasLocalOrContext = evidenceTotal(score.evidence) + (context.neighbours?.let(::evidenceTotal) ?: 0.0) > 0
    // "chat – die Katze": the two sides of a vocabulary pair are different languages, so what the confident
    // partner side speaks (and the neighbouring pairs echo) is no evidence for this side.
    for (language in context.partnerLanguages) combined[language] = combined[language] * 0.2
    val decision = decideLanguage(combined)
    return PassageLanguage(
        decision.language,
        decision.confident,
        false,
        foreign,
        if (decision.language != null) (if (hasLocalOrContext) PassageSource.CONTEXT else PassageSource.DOCUMENT) else PassageSource.NONE,
    )
}

/* ---------- the profile of a note ---------- */

private const val PRESENT_MINIMUM = 4.0
private const val PRESENT_SHARE = 0.04
private const val PRESENT_ABSOLUTE = 30.0
private const val PRIOR_POINTS = 5.0
private const val PRIOR_FULL_AT = 20.0

/** Languages the note uses, most used first. A language counts once it has real evidence and a few percent of the whole. */
fun presentLanguages(profile: LanguageEvidence): List<String> {
    val total = evidenceTotal(profile)
    return TEXT_LANGUAGES
        .filter { profile[it] >= PRESENT_MINIMUM && (profile[it] >= total * PRESENT_SHARE || profile[it] >= PRESENT_ABSOLUTE) }
        .sortedByDescending { profile[it] }
}

/**
 * The weight the note's language mix gets when a passage has little evidence of its own. A note with
 * little text so far carries less weight than a long one, and a mixed note gives no strong prior.
 */
fun profilePrior(profile: LanguageEvidence): LanguageEvidence {
    val total = evidenceTotal(profile)
    if (total <= 0) return LanguageEvidence()
    val scale = minOf(1.0, total / PRIOR_FULL_AT) * PRIOR_POINTS
    return LanguageEvidence(profile.de / total * scale, profile.en / total * scale, profile.fr / total * scale)
}

/** "de", "en", "fr", "mixed" or "unknown", the code the status bar and the note profile use. */
fun detectedLanguageOf(present: List<String>): String = when (present.size) {
    0 -> "unknown"
    1 -> present[0]
    else -> "mixed"
}

/** Status label of a note's language mix, e.g. "DE · FR". */
fun languageProfileLabel(present: List<String>) = present.joinToString(" · ") { it.uppercase(java.util.Locale.US) }

/** The BCP 47 tag for hints to the keyboard and to accessibility services. */
fun languageTag(language: String?) = when (language) {
    "en" -> "en"
    "fr" -> "fr-CH"
    else -> "de-CH"
}

/* ---------- splitting a line into passages ---------- */

enum class PassageKind { LINE, CELL, COLUMN, VOCABULARY, SENTENCE, QUOTE }

data class PassageRange(val from: Int, val to: Int, val kind: PassageKind)

private val LINE_MARKER = uregex("""^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+)?""")
private val VOCABULARY_SEPARATOR = uregex("""\s+(?:[–—−=→⇒↔⟷/]|-)\s+""")
private val QUOTE = uregex("""„[^„“”\n]{10,}?[“”]|«[^«»\n]{10,}?»|“[^“”\n]{10,}?”|"[^"\n]{10,}?"""")
private val WORD_RUN = Regex("""\p{L}[\p{L}\p{M}'’-]*""")
private val HAS_LETTER = Regex("""\p{L}""")
private val SENTENCE_BOUNDARY = uregex("""[.!?…]+["“”»)]*\s+(?=[\p{Lu}„«"“])""")
private val COLON_PAIR = uregex("""(?<=\p{L}):\s+""")

private fun passageWordCount(text: String) = WORD_RUN.findAll(text).count()

private fun trimmed(text: String, from: Int, to: Int): Pair<Int, Int> {
    var start = from
    var end = to
    while (start < end && isJsSpace(text[start])) start += 1
    while (end > start && isJsSpace(text[end - 1])) end -= 1
    return start to end
}

private fun rangesBetween(text: String, base: Int, cuts: List<Pair<Int, Int>>, kind: PassageKind): List<PassageRange> {
    val result = ArrayList<PassageRange>()
    var cursor = base
    for ((cutFrom, cutTo) in cuts + (text.length to text.length)) {
        val (from, to) = trimmed(text, cursor, cutFrom)
        if (to > from && HAS_LETTER.containsMatchIn(text.substring(from, to))) result += PassageRange(from, to, kind)
        cursor = cutTo
    }
    return result
}

/**
 * The passages of a line, as offsets into [text]: table cells, tab columns, the sides of a vocabulary
 * pair ("le chien – der Hund", "to run = laufen"), quotations and sentences. A line that is none of
 * these is one passage.
 */
fun splitPassages(text: String): List<PassageRange> {
    val base = LINE_MARKER.find(text)?.value?.length ?: 0
    val body = text.substring(base)
    val whole = listOf(PassageRange(base, text.length, PassageKind.LINE))
    if (!HAS_LETTER.containsMatchIn(body)) return emptyList()

    // Table row: every cell is its own passage.
    if (body.count { it == '|' } >= 2 || body.trimStart().startsWith("|")) {
        val cuts = ArrayList<Pair<Int, Int>>()
        for (index in base until text.length) if (text[index] == '|') cuts += index to index + 1
        val cells = rangesBetween(text, base, cuts, PassageKind.CELL)
        if (cells.size >= 2) return cells
        if (cells.size == 1) return cells.map { it.copy(kind = PassageKind.LINE) }
    }
    // Tab separated columns.
    if (body.contains('\t')) {
        val cuts = ArrayList<Pair<Int, Int>>()
        for (index in base until text.length) if (text[index] == '\t') cuts += index to index + 1
        val columns = rangesBetween(text, base, cuts, PassageKind.COLUMN)
        if (columns.size >= 2) return columns
    }
    // Vocabulary pairs: two to four short parts around a dash, equals sign, arrow or slash.
    val separators = VOCABULARY_SEPARATOR.findAll(text.substring(base)).map { base + it.range.first to base + it.range.last + 1 }.toList()
    if (separators.size in 1..3) {
        val parts = rangesBetween(text, base, separators, PassageKind.VOCABULARY)
        if (parts.size == separators.size + 1 && parts.all { passageWordCount(text.substring(it.from, it.to)) <= 6 }) return parts
    }
    // "le chien: der Hund" is only a pair when both sides are short; otherwise the colon is ordinary punctuation.
    val colon = COLON_PAIR.find(body)
    if (colon != null) {
        val at = base + colon.range.first
        val parts = rangesBetween(text, base, listOf(at to at + colon.value.length), PassageKind.SENTENCE)
        if (parts.size == 2 && passageWordCount(text.substring(parts[0].from, parts[0].to)) <= 3 && passageWordCount(text.substring(parts[1].from, parts[1].to)) <= 4) {
            return parts
        }
    }
    // A quotation of its own: the words around it and the quotation are decided separately.
    val quotes = QUOTE.findAll(body).filter { passageWordCount(it.value) >= 3 }.toList()
    if (quotes.isNotEmpty()) {
        val cuts = ArrayList<Pair<Int, Int>>()
        val quoted = ArrayList<PassageRange>()
        for (match in quotes) {
            val from = base + match.range.first
            cuts += from to from + match.value.length
            val (start, end) = trimmed(text, from + 1, from + match.value.length - 1)
            quoted += PassageRange(start, end, PassageKind.QUOTE)
        }
        val outside = rangesBetween(text, base, cuts, PassageKind.SENTENCE).filter { passageWordCount(text.substring(it.from, it.to)) >= 1 }
        return (outside + quoted).sortedBy { it.from }
    }
    // Several sentences in one line, each long enough to carry a language.
    val boundaries = SENTENCE_BOUNDARY.findAll(body).map {
        val trimmedLength = it.value.trimEnd { char -> isJsSpace(char) }.length
        base + it.range.first + trimmedLength to base + it.range.first + it.value.length
    }.toList()
    if (boundaries.isNotEmpty()) {
        val sentences = rangesBetween(text, base, boundaries, PassageKind.SENTENCE)
        if (sentences.size >= 2 && sentences.all { passageWordCount(text.substring(it.from, it.to)) >= 3 }) return sentences
    }
    return whole
}

/* ---------- lines the profile skips ---------- */

/** A tiny state machine over the lines of a note: code fences, display math and front matter are not prose. */
class ProseLineFilter {
    private var fence: String? = null
    private var math = false
    private var lineNumber = 0
    private var frontMatter = false

    fun isProse(line: String): Boolean {
        lineNumber += 1
        if (lineNumber == 1 && line.trim() == "---") {
            frontMatter = true
            return false
        }
        if (frontMatter) {
            if (line.trim() == "---" || line.trim() == "...") frontMatter = false
            return false
        }
        val fenceMatch = FENCE_LINE.find(line)?.groupValues?.get(1)
        val open = fence
        if (open != null) {
            if (fenceMatch != null && fenceMatch[0] == open[0] && fenceMatch.length >= open.length) fence = null
            return false
        }
        if (fenceMatch != null) {
            fence = fenceMatch
            return false
        }
        if (line.trim() == "$$") {
            math = !math
            return false
        }
        return !math
    }

    private companion object {
        val FENCE_LINE = Regex("""^\s{0,3}(`{3,}|~{3,})""")
    }
}
