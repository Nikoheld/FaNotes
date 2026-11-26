package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale

/**
 * Local spellcheck shared with the desktop editor (`fanotes/src/lib/spelling.ts`).
 * German and English live in Bloom filters built from the same Hunspell
 * dictionaries. A word the cursor is inside, and words in code, math, links,
 * and HTML, stay unmarked. German, English and French live in Bloom filters. Each passage of a
 * note gets its own language (`LanguageDetect.kt`, desktop #1473) and a word is underlined only
 * when no language the passage may use knows it. French loads lazily.
 */

data class SpellingError(val from: Int, val to: Int, val word: String, val language: String)
/** The line's main language: its first confident passage, else the best guess, else the note's main language. */
data class SpellingLine(val from: Int, val to: Int, val language: String, val confident: Boolean = false)

/** One passage of a line (sentence, list item, table cell, side of a vocabulary pair, quotation) and its language. */
data class SpellingPassage(val from: Int, val to: Int, val kind: PassageKind, val language: PassageLanguage)

data class SpellingCheckResult(
    val errors: List<SpellingError>,
    val lines: List<SpellingLine>,
    val detectedLanguage: String,
    val passages: List<SpellingPassage> = emptyList(),
    /** Languages the note uses, most used first. */
    val languages: List<String> = emptyList(),
    /** The language evidence of the whole note (the profile). */
    val profile: LanguageEvidence = LanguageEvidence(),
)

data class SpellingSegment(val from: Int, val text: String)
data class SpellingRange(val from: Int, val to: Int)

private val WORD_PATTERN = Regex("""\p{L}[\p{L}\p{M}'’\-]*""")
private val CAMEL = Regex("""\p{Ll}\p{Lu}""")
private val INLINE_CODE = Regex("`[^`]*`")
private val MATH = Regex("""\$\$[^$]*\$\$|\$[^$\n]+\$""")
private val URLS = Regex(
    """https?://[^\s)>]+|www\.[^\s)>]+|[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}""",
    RegexOption.IGNORE_CASE,
)
private val TAGS = Regex("<[^>]+>")
private val LINK_DEST = Regex("""\]\([^)]*\)""")
private val DISPLAY_MATH = Regex("""\$\$[\s\S]*?\$\$""")
private val FENCE = Regex("""^\s*(```|~~~)""")

private val TECHNICAL_WORDS = setOf(
    "ai", "amat", "anthropic", "appimage", "arch", "browser", "chromium", "codemirror", "codex",
    "electron", "fanotes", "gemini", "glyphenwerk", "github", "google", "html", "hyprland",
    "javascript", "katex", "latex", "linux", "lm", "markdown", "nas", "ollama", "openai",
    "opencode", "pdf", "typescript", "url", "vulkan", "wayland", "web", "windows",
)
private val DE_LOCALE = Locale.forLanguageTag("de-CH")
private val EN_LOCALE = Locale.forLanguageTag("en-US")
private val FR_LOCALE = Locale.forLanguageTag("fr-FR")

private const val FRENCH_WORDS = """
le la les un une des de du et ou mais donc car ni que qui quoi dont ou
je tu il elle on nous vous ils elles me te se lui leur y en mon ton son
ma ta sa mes tes ses notre votre leur nos vos leurs ce cet cette ces
est suis es sommes etes sont ete etait ai as a avons avez ont
pas ne plus jamais rien personne
dans sur sous avec sans pour par chez entre vers pendant avant apres
etre avoir faire aller dire voir savoir pouvoir vouloir devoir prendre
mettre donner trouver parler aimer arriver rester passer penser
bonjour merci oui non tres bien mal petit grand nouveau nouveau
ecole eleve professeur devoir examen lecon cahier stylo livre texte
phrase mot lettre grammaire vocabulaire conjugaison exercice
francais anglais allemand mathematiques histoire geographie
physique chimie biologie informatique
aujourd aujourd'hui demain hier matin soir semaine mois annee
lundi mardi mercredi jeudi vendredi samedi dimanche
janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre
un deux trois quatre cinq six sept huit neuf dix vingt trente cent
rouge bleu vert jaune noir blanc
maison famille ami amie mere pere frere soeur enfant
eau pain fromage lait cafe the
lire ecrire ecouter parler comprendre repondre traduire
question reponse exemple phrase correct incorrect
"""

private val FRENCH_LEXICON = FRENCH_WORDS.trim().split(Regex("""\s+""")).map { foldFrench(it) }.filter { it.length >= 2 }.toSet()

/** Desktop default: spellcheck is on until the setting is turned off. */
fun spellcheckEnabled(settings: Map<String, String>) = settings["spellcheck"] != "off"

fun spellingHash(word: String, seed: Long): Long {
    var hash = seed and 0xFFFFFFFFL
    for (ch in word) {
        hash = hash xor ch.code.toLong()
        hash = imul(hash, 0x01000193L)
    }
    return hash
}

class BloomFilter(private val bytes: ByteArray, private val bitCount: Int, private val hashes: Int = 8) {
    fun has(rawWord: String, language: String): Boolean = hasNormalized(normalizeWord(rawWord, language))

    fun hasNormalized(word: String): Boolean {
        if (word.isEmpty()) return false
        val first = spellingHash(word, 0x811c9dc5L)
        val second = spellingHash(word, 0x9e3779b1L) or 1L
        for (index in 0 until hashes) {
            val mixed = imul(index.toLong(), second).toInt().toLong()
            val bit = ((first + mixed) and 0xFFFFFFFFL) % bitCount
            val bitInt = bit.toInt()
            val packed = bytes[bitInt ushr 3].toInt() and 0xFF
            if (packed and (1 shl (bitInt and 7)) == 0) return false
        }
        return true
    }
}

class SpellingDictionaries(
    val de: BloomFilter,
    val en: BloomFilter,
    val deWords: Set<String>?,
    val enWords: Set<String>?,
    /** The French filter, or null when this build ships none (then only the small school lexicon vouches for French). */
    val fr: BloomFilter? = null,
    /** Reads the exact French list (about 5 MB). Called at most once, and only when a French passage needs suggestions. */
    private val frenchLoader: (() -> Set<String>)? = null,
) {
    @Volatile
    private var frenchList: Set<String>? = null
    private var frenchFailed = false

    /** True once [frenchWords] has been read. */
    val frenchWordsLoaded: Boolean get() = frenchList != null

    val hasFrench: Boolean get() = fr != null && frenchLoader != null

    /** The exact French list. Reads it on first use; null when there is none. Blocks, so call it off the UI thread. */
    fun frenchWords(): Set<String>? {
        frenchList?.let { return it }
        val loader = frenchLoader ?: return null
        synchronized(this) {
            frenchList?.let { return it }
            if (frenchFailed) return null
            return try {
                loader().also { frenchList = it }
            } catch (_: Exception) {
                frenchFailed = true
                null
            }
        }
    }
}

fun loadBundledSpelling(includeCandidates: Boolean = false): SpellingDictionaries {
    val manifest = parseJson(resourceText("manifest.json")) as? JsonValue.Obj
        ?: throw IllegalStateException("Das lokale Rechtschreibwörterbuch ist beschädigt.")
    if (manifest.string("format") != "fanotes-spelling-bloom-v2" || manifest.double("hashes")?.toInt() != 8) {
        throw IllegalStateException("Unbekanntes Rechtschreibformat.")
    }
    val languages = manifest.obj("languages") ?: throw IllegalStateException("Das lokale Rechtschreibwörterbuch ist beschädigt.")
    val de = loadBloom(languages, "de")
    val en = loadBloom(languages, "en")
    val deWords = if (includeCandidates) loadCandidates(languages, "de") else null
    val enWords = if (includeCandidates) loadCandidates(languages, "en") else null
    // French is optional: a missing or unreadable file only switches French off.
    val french = manifest.obj("french")
    val fr = if (french != null) runCatching { loadBloom(frenchEntry(french), "fr") }.getOrNull() else null
    val loader: (() -> Set<String>)? = if (fr != null && french != null) ({ loadCandidates(frenchEntry(french), "fr") }) else null
    return SpellingDictionaries(de, en, deWords, enWords, fr, loader)
}

/** The manifest's `french` entry has the shape of a `languages` entry; wrap it so the loaders can share code. */
private fun frenchEntry(french: JsonValue.Obj): JsonValue.Obj = JsonValue.Obj().also { it.put("fr", french) }

fun normalizeWord(word: String, language: String): String {
    val locale = when (language) {
        "de" -> DE_LOCALE
        "fr" -> FR_LOCALE
        else -> EN_LOCALE
    }
    val normalized = Normalizer.normalize(word, Normalizer.Form.NFC)
        .lowercase(locale)
        .trim('\'', '’', '-')
    return when (language) {
        "de" -> normalized.replace("ß", "ss")
        // French typography uses the curly apostrophe; the filter holds the plain one.
        "fr" -> normalized.replace('’', '\'')
        else -> normalized
    }
}

fun normalizeForDictionary(word: String): String = normalizeWord(word.trim(), "de").trim('\'', '’', '-')

fun isFrenchWord(word: String): Boolean = foldFrench(word) in FRENCH_LEXICON

private data class SegmentToken(
    val word: String,
    val from: Int,
    val to: Int,
    val normalized: String,
    val membership: WordLanguages,
) {
    fun evidenceToken() = EvidenceToken(word, normalized, membership)
}

/**
 * The words of a segment that count for evidence and for underlining: no code, links, math, the word
 * under the caret, acronyms or camelCase.
 */
private fun collectTokens(
    segment: SpellingSegment,
    ignoredRanges: List<SpellingRange>,
    cursorPositions: List<Int>,
    dictionaries: SpellingDictionaries,
    acceptedWords: Set<String>,
): List<SegmentToken> {
    val localIgnored = ignoredRanges + automaticIgnoredRanges(segment)
    return WORD_PATTERN.findAll(segment.text).mapNotNull { match ->
        val word = match.value
        val from = segment.from + match.range.first
        val to = from + word.length
        val normalized = normalizeWord(word, "de")
        if (
            normalized.length < 2 ||
            intersects(from, to, localIgnored) ||
            cursorPositions.any { cursor -> cursor in from..to } ||
            (match.range.first > 0 && segment.text[match.range.first - 1] == '#') ||
            (word.length in 2..16 && word.all { it in 'A'..'Z' || it == 'Ä' || it == 'Ö' || it == 'Ü' }) ||
            CAMEL.containsMatchIn(word)
        ) {
            null
        } else {
            SegmentToken(word, from, to, normalized, wordMembership(word, dictionaries, acceptedWords))
        }
    }.toList()
}

/* ---------- evidence of lines and of the whole note ---------- */

private const val LINE_EVIDENCE_LIMIT = 60_000
private const val MAX_EVIDENCE_LINE_LENGTH = 800

/** The language evidence of lines already read, remembered by their text: an unchanged line is never read twice. */
private object LineEvidenceCache {
    private var owner: SpellingDictionaries? = null
    private var acceptedKey = 0
    private var map = HashMap<String, LanguageEvidence>()

    @Synchronized
    fun evidence(text: String, dictionaries: SpellingDictionaries, accepted: Set<String>): LanguageEvidence {
        val key = accepted.hashCode()
        if (owner !== dictionaries || acceptedKey != key) {
            owner = dictionaries
            acceptedKey = key
            map = HashMap()
        }
        map[text]?.let { return it }
        val clipped = if (text.length > MAX_EVIDENCE_LINE_LENGTH) text.substring(0, MAX_EVIDENCE_LINE_LENGTH) else text
        val evidence = if (LETTER.containsMatchIn(clipped)) {
            scoreTokens(collectTokens(SpellingSegment(0, clipped), emptyList(), emptyList(), dictionaries, accepted).map { it.evidenceToken() }).evidence
        } else {
            LanguageEvidence()
        }
        if (map.size >= LINE_EVIDENCE_LIMIT) map = HashMap()
        map[text] = evidence
        return evidence
    }
}

private val LETTER = Regex("""\p{L}""")

/** The language profile of a whole note: the evidence of all its prose lines (no code fences, display math or front matter). */
fun documentProfile(lines: Iterable<String>, dictionaries: SpellingDictionaries, accepted: Set<String> = emptySet()): LanguageEvidence {
    val profile = LanguageEvidence()
    val filter = ProseLineFilter()
    for (line in lines) {
        if (!filter.isProse(line) || !LETTER.containsMatchIn(line)) continue
        addEvidence(profile, LineEvidenceCache.evidence(line, dictionaries, accepted))
    }
    return profile
}

/* ---------- passages ---------- */

private class PreparedPassage(val range: PassageRange, val score: PassageScore, val resolution: PassageLanguage, val tokens: List<SegmentToken>)

private fun passageIndexOf(passages: List<PassageRange>, offset: Int): Int {
    val inside = passages.indexOfFirst { offset >= it.from && offset < it.to }
    if (inside >= 0) return inside
    var before = -1
    passages.forEachIndexed { index, passage -> if (passage.from <= offset) before = index }
    return maxOf(0, before)
}

private val NEIGHBOUR_WEIGHTS_BEFORE = doubleArrayOf(0.5, 0.3, 0.15)
private val NEIGHBOUR_WEIGHTS_AFTER = doubleArrayOf(0.5, 0.25)

/**
 * Weighted evidence of the nearest lines of the same paragraph. Both lists start at the closest line;
 * a null entry (a blank or missing line) ends the paragraph in that direction.
 */
private fun neighbourEvidence(before: List<LanguageEvidence?>, after: List<LanguageEvidence?>): LanguageEvidence {
    val total = LanguageEvidence()
    for ((lines, weights) in listOf(before to NEIGHBOUR_WEIGHTS_BEFORE, after to NEIGHBOUR_WEIGHTS_AFTER)) {
        for (distance in weights.indices) {
            val line = lines.getOrNull(distance) ?: break
            addEvidence(total, line, weights[distance])
        }
    }
    return total
}

private fun preparePassages(
    segment: SpellingSegment,
    tokens: List<SegmentToken>,
    neighbours: LanguageEvidence,
    prior: LanguageEvidence,
): List<PreparedPassage> {
    val ranges = splitPassages(segment.text)
    if (ranges.isEmpty()) return emptyList()
    val bucket = ranges.map { ArrayList<SegmentToken>() }
    for (token in tokens) bucket[passageIndexOf(ranges, token.from - segment.from)].add(token)
    val scores = bucket.map { list -> scoreTokens(list.map { it.evidenceToken() }) }
    // Sentences of an Italian line are Italian even when one of them carries few telltale words.
    val lineScore = scores.fold(scoreTokens(emptyList())) { sum, score -> mergeScores(sum, score) }
    val wholeLineUnsupported = ranges.all { it.kind != PassageKind.VOCABULARY && it.kind != PassageKind.CELL && it.kind != PassageKind.COLUMN } && isUnsupported(lineScore)
    val sentenceLike = ranges.all { it.kind == PassageKind.SENTENCE || it.kind == PassageKind.QUOTE || it.kind == PassageKind.LINE }
    val first = ranges.mapIndexed { index, _ ->
        // Sentences of one line often share a language; the sides of a vocabulary pair never do.
        val siblings = LanguageEvidence()
        if (sentenceLike) scores.forEachIndexed { other, score -> if (other != index) addEvidence(siblings, score.evidence) }
        if (wholeLineUnsupported) {
            UNKNOWN_PASSAGE.copy(unsupported = true, foreign = true, source = PassageSource.LOCAL)
        } else {
            resolvePassage(scores[index], ResolveContext(neighbours = neighbours, prior = prior, siblings = siblings))
        }
    }
    return ranges.mapIndexed { index, range ->
        val own = first[index]
        val pair = !sentenceLike
        // A weak side of a pair is not the language of its confident partner.
        val partners = if (pair) {
            first.withIndex().filter { (otherIndex, other) -> otherIndex != index && other.confident && other.language != null }.map { it.value.language!! }
        } else {
            emptyList()
        }
        val resolution = if (pair && !own.confident && partners.isNotEmpty()) {
            resolvePassage(scores[index], ResolveContext(neighbours = neighbours, prior = prior, partnerLanguages = partners))
        } else {
            own
        }
        PreparedPassage(range, scores[index], resolution, bucket[index])
    }
}

/** The languages a word may be written in besides German and English: French once the note or the passage uses it. */
fun allowedLanguages(present: List<String>, passageLanguage: String?): List<String> {
    val allowed = arrayListOf("de", "en")
    if ("fr" in present || passageLanguage == "fr") allowed += "fr"
    return allowed
}

class PassageAt(val passage: PassageLanguage, val present: List<String>, val allowed: List<String>)

/**
 * The language of the passage around [offset] in the line [text], computed on the spot from what is
 * loaded. This is what autocorrect asks, so a line typed a moment ago is already understood.
 * [previous] and [next] are the lines of the same paragraph, nearest first.
 */
fun resolvePassageAt(
    text: String,
    offset: Int,
    previous: List<String>,
    next: List<String>,
    profile: LanguageEvidence?,
    dictionaries: SpellingDictionaries,
    acceptedWords: Set<String> = emptySet(),
): PassageAt {
    val tokens = collectTokens(SpellingSegment(0, text), emptyList(), emptyList(), dictionaries, acceptedWords)
    fun evidenceOf(line: String) = if (line.isBlank()) null else LineEvidenceCache.evidence(line, dictionaries, acceptedWords)
    val neighbours = neighbourEvidence(previous.map(::evidenceOf), next.map(::evidenceOf))
    val present = profile?.let(::presentLanguages).orEmpty()
    val prior = profile?.let(::profilePrior) ?: LanguageEvidence()
    val passages = preparePassages(SpellingSegment(0, text), tokens, neighbours, prior)
    if (passages.isEmpty()) return PassageAt(UNKNOWN_PASSAGE, present, allowedLanguages(present, null))
    val passage = passages[passageIndexOf(passages.map { it.range }, offset)]
    return PassageAt(passage.resolution, present, allowedLanguages(present, passage.resolution.language))
}

fun checkSpelling(
    segments: List<SpellingSegment>,
    dictionaries: SpellingDictionaries,
    ignoredRanges: List<SpellingRange> = emptyList(),
    cursorPositions: List<Int> = emptyList(),
    acceptedWords: Set<String> = emptySet(),
    /** The lines of the whole note, for its language profile. Without them the profile is read from [segments]. */
    documentLines: Iterable<String>? = null,
): SpellingCheckResult {
    if (segments.isEmpty()) return SpellingCheckResult(emptyList(), emptyList(), "unknown")
    val tokenLists = segments.map { collectTokens(it, ignoredRanges, cursorPositions, dictionaries, acceptedWords) }
    val ownEvidence: List<LanguageEvidence?> = segments.mapIndexed { index, segment ->
        if (segment.text.isBlank()) null else scoreTokens(tokenLists[index].map { it.evidenceToken() }).evidence
    }
    // The note's profile: the whole text when the caller hands it over, otherwise just these lines.
    val profile = if (documentLines != null) {
        documentProfile(documentLines, dictionaries, acceptedWords)
    } else {
        LanguageEvidence().also { total -> ownEvidence.forEach { line -> if (line != null) addEvidence(total, line) } }
    }
    val present = presentLanguages(profile)
    val prior = profilePrior(profile)

    // Neighbours only count across directly following lines of the same paragraph.
    fun follows(index: Int) = index > 0 && index < segments.size &&
        segments[index - 1].from + segments[index - 1].text.length + 1 == segments[index].from
    fun reach(index: Int, step: Int, count: Int): List<LanguageEvidence?> = (1..count).map { distance ->
        val at = index + step * distance
        val joined = if (step == -1) follows(at + 1) else follows(at)
        if (at >= 0 && at < segments.size && joined) ownEvidence[at] else null
    }
    val prepared = segments.mapIndexed { index, segment ->
        val passages = preparePassages(
            segment,
            tokenLists[index],
            neighbourEvidence(reach(index, -1, NEIGHBOUR_WEIGHTS_BEFORE.size), reach(index, 1, NEIGHBOUR_WEIGHTS_AFTER.size)),
            prior,
        )
        passages
    }

    val documentLanguage = present.firstOrNull() ?: decideLanguage(profile).language ?: "de"
    val errors = ArrayList<SpellingError>()
    val lines = ArrayList<SpellingLine>()
    val passages = ArrayList<SpellingPassage>()
    for ((index, segment) in segments.withIndex()) {
        if (segment.text.isBlank()) continue
        val item = prepared[index]
        val confident = item.firstOrNull { it.resolution.confident && it.resolution.language != null }
        val guess = item.firstOrNull { it.resolution.language != null }
        lines += SpellingLine(
            segment.from,
            segment.from + segment.text.length,
            (confident ?: guess)?.resolution?.language ?: documentLanguage,
            confident != null,
        )
        for (passage in item) {
            passages += SpellingPassage(segment.from + passage.range.from, segment.from + passage.range.to, passage.range.kind, passage.resolution)
            if (passage.resolution.unsupported) continue
            val allowed = allowedLanguages(present, passage.resolution.language)
            val language = passage.resolution.language ?: documentLanguage
            for (token in passage.tokens) {
                if (allowed.any { token.membership[it] }) continue
                errors += SpellingError(token.from, token.to, token.word, language)
            }
        }
        // Words that fell outside every passage (nothing to read around them) are still checked.
        if (item.isEmpty()) {
            for (token in tokenLists[index]) {
                if (allowedLanguages(present, null).any { token.membership[it] }) continue
                errors += SpellingError(token.from, token.to, token.word, documentLanguage)
            }
        }
    }
    return SpellingCheckResult(errors, lines, detectedLanguageOf(present), passages, present, profile)
}

/** One note, split into lines the way the desktop checks the visible editor. */
fun checkNoteSpelling(
    markdown: String,
    cursors: List<Int>,
    dictionaries: SpellingDictionaries,
    acceptedWords: Set<String> = emptySet(),
): SpellingCheckResult {
    val segments = ArrayList<SpellingSegment>()
    val ignored = ArrayList<SpellingRange>()
    var fenceStart: Int? = null
    var offset = 0
    val parts = markdown.split('\n')
    for ((index, line) in parts.withIndex()) {
        if (FENCE.containsMatchIn(line)) {
            if (fenceStart == null) fenceStart = offset
            else {
                ignored += SpellingRange(fenceStart!!, offset + line.length)
                fenceStart = null
            }
        }
        segments += SpellingSegment(offset, line)
        offset += line.length + if (index == parts.lastIndex) 0 else 1
    }
    if (fenceStart != null) ignored += SpellingRange(fenceStart!!, markdown.length)
    for (match in DISPLAY_MATH.findAll(markdown)) {
        ignored += SpellingRange(match.range.first, match.range.last + 1)
    }
    return checkSpelling(segments, dictionaries, ignored, cursors, acceptedWords, documentLines = parts)
}

fun automaticIgnoredRanges(segment: SpellingSegment): List<SpellingRange> {
    val ranges = ArrayList<SpellingRange>()
    for (pattern in listOf(INLINE_CODE, MATH, URLS, TAGS, LINK_DEST)) {
        for (match in pattern.findAll(segment.text)) {
            val from = segment.from + match.range.first
            ranges += SpellingRange(from, from + match.value.length)
        }
    }
    return ranges
}

internal fun splitsIntoGermanParts(rawWord: String, hasPart: (String) -> Boolean): Boolean {
    val word = normalizeWord(rawWord, "de")
    if (word.length < 8 || word.length > 64 || !word.all { Character.isLetter(it) }) return false
    val memo = HashMap<String, Boolean>()
    fun findParts(start: Int, parts: Int): Boolean {
        if (start == word.length) return parts >= 2
        if (parts >= 6 || word.length - start < 3) return false
        val key = "$start:$parts"
        memo[key]?.let { return it }
        val maximum = minOf(word.length, start + 24)
        var end = start + 3
        while (end <= maximum) {
            if (end < word.length && word.length - end < 3) {
                end += 1
                continue
            }
            val part = word.substring(start, end)
            if (hasPart(part) && findParts(end, parts + 1)) {
                memo[key] = true
                return true
            }
            end += 1
        }
        memo[key] = false
        return false
    }
    return findParts(0, 0)
}

private val FRENCH_ELISION_PREFIX = Regex("""^(?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu|quoiqu)'(.+)$""")

/**
 * A French word the filter knows: whole, or after an elision prefix ("l'homme", "qu'il"). The filter
 * holds no elided or inverted forms, only the dictionary's own stems.
 */
private fun frenchKnown(normalized: String, filter: BloomFilter?): Boolean {
    if (filter == null || normalized.isEmpty()) return false
    if (filter.has(normalized, "fr")) return true
    val rest = FRENCH_ELISION_PREFIX.find(normalized)?.groupValues?.get(1)
    return rest != null && filter.has(rest, "fr")
}

/** Which of German, English and French know [word]. Words of the user, technical terms and empty words belong to all. */
internal fun wordMembership(
    word: String,
    dictionaries: SpellingDictionaries,
    acceptedWords: Set<String> = emptySet(),
): WordLanguages {
    val normalized = normalizeWord(word, "de")
    val all = WordLanguages(de = true, en = true, fr = true)
    if (normalized.isEmpty() || normalized in TECHNICAL_WORDS || normalized in acceptedWords) return all
    val french = normalizeWord(word, "fr")
    // Without the French dictionary only the small school lexicon can vouch for a French word.
    fun frenchWord(part: String) = if (dictionaries.fr != null) frenchKnown(part, dictionaries.fr) else isFrenchWord(part)
    if ('-' in normalized) {
        val parts = normalized.split('-').filter { it.isNotEmpty() }
        if (parts.size > 1) {
            val membership = parts.map { part ->
                WordLanguages(
                    de = dictionaries.de.has(part, "de") || splitsIntoGermanParts(part) { dictionaries.de.hasNormalized(it) },
                    en = dictionaries.en.has(part, "en"),
                    // The "-t-" of "a-t-il" is no word of its own.
                    fr = part == "t" || frenchWord(normalizeWord(part, "fr")),
                )
            }
            val common = WordLanguages(
                de = membership.all { it.de },
                en = membership.all { it.en },
                fr = frenchWord(french) || membership.all { it.fr },
            )
            if (common.de || common.en || common.fr) return common
            // Mixed school vocabulary such as "Inline-Mathematik" is valid when every hyphen part exists in some language.
            if (membership.all { it.de || it.en || it.fr }) return all
            return common
        }
    }
    return WordLanguages(
        de = dictionaries.de.hasNormalized(normalized) || splitsIntoGermanParts(normalized) { dictionaries.de.hasNormalized(it) },
        en = dictionaries.en.has(normalized, "en"),
        fr = frenchWord(french),
    )
}

private fun intersects(from: Int, to: Int, ranges: List<SpellingRange>): Boolean =
    ranges.any { from < it.to && to > it.from }

private fun foldFrench(word: String): String = Normalizer.normalize(word, Normalizer.Form.NFC)
    .lowercase(FR_LOCALE)
    .replace('à', 'a').replace('â', 'a').replace('ä', 'a')
    .replace('é', 'e').replace('è', 'e').replace('ê', 'e').replace('ë', 'e')
    .replace('î', 'i').replace('ï', 'i')
    .replace('ô', 'o').replace('ö', 'o')
    .replace('ù', 'u').replace('û', 'u').replace('ü', 'u')
    .replace('ç', 'c')
    .replace("œ", "oe")
    .trim('\'', '’', '-')

private fun imul(a: Long, b: Long): Long {
    val product = a.toInt().toLong() * b.toInt().toLong()
    return product.toInt().toLong() and 0xFFFFFFFFL
}

private fun loadBloom(languages: JsonValue.Obj, language: String): BloomFilter {
    val entry = languages.obj(language) ?: throw IllegalStateException("Das lokale Rechtschreibwörterbuch ist beschädigt.")
    val file = entry.string("file") ?: throw IllegalStateException("Das lokale Rechtschreibwörterbuch ist beschädigt.")
    val bitCount = entry.double("bitCount")?.toInt() ?: throw IllegalStateException("Das lokale Rechtschreibwörterbuch ist beschädigt.")
    val bytes = resourceBytes(file)
    val digest = sha256(bytes)
    if (digest != entry.string("sha256")) throw IllegalStateException("Die lokalen Rechtschreibdaten sind beschädigt.")
    if (bytes.size * 8 != bitCount) throw IllegalStateException("Die lokalen Rechtschreibdaten besitzen eine ungültige Länge.")
    return BloomFilter(bytes, bitCount)
}

private fun loadCandidates(languages: JsonValue.Obj, language: String): Set<String> {
    val entry = languages.obj(language)?.obj("candidates")
        ?: throw IllegalStateException("Die OCR-Wortliste ist beschädigt.")
    val file = entry.string("file") ?: throw IllegalStateException("Die OCR-Wortliste ist beschädigt.")
    val bytes = resourceBytes(file)
    if (bytes.size != entry.double("size")?.toInt() || bytes.size > 8 * 1024 * 1024) {
        throw IllegalStateException("Die OCR-Wortliste besitzt eine ungültige Länge.")
    }
    if (sha256(bytes) != entry.string("sha256")) throw IllegalStateException("Die OCR-Wortliste ist beschädigt.")
    val decoded = bytes.toString(Charsets.UTF_8)
    if (!decoded.endsWith("\n")) throw IllegalStateException("Die OCR-Wortliste ist unvollständig.")
    val words = decoded.substring(0, decoded.length - 1).split('\n')
    val expected = entry.double("wordCount")?.toInt()
    if (words.size != expected) throw IllegalStateException("Die OCR-Wortlistenanzahl ist ungültig.")
    val pattern = Regex("""^\p{L}{3,32}$""")
    val listed = HashSet<String>(words.size)
    var previous = ""
    for (word in words) {
        if (word <= previous || word != normalizeWord(word, language) || !pattern.matches(word)) {
            throw IllegalStateException("Die OCR-Wortliste enthält einen ungültigen Eintrag.")
        }
        listed += word
        previous = word
    }
    return listed
}

private fun resourceBytes(name: String): ByteArray {
    val stream = SpellingDictionaries::class.java.classLoader?.getResourceAsStream("spell/$name")
        ?: throw IllegalStateException("Rechtschreibressource fehlt: $name")
    return stream.use { it.readBytes() }
}

private fun resourceText(name: String) = resourceBytes(name).toString(Charsets.UTF_8)

private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private const val PERSONAL_DICTIONARY_LIMIT = 5_000

fun personalSpellWords(stored: String?): LinkedHashSet<String> {
    val words = LinkedHashSet<String>()
    if (stored.isNullOrBlank()) return words
    for (line in stored.lineSequence()) {
        val normalized = normalizeForDictionary(line)
        if (normalized.isNotEmpty()) words += normalized
    }
    return words
}

/** Stored personal dictionary with [word] added. Null when [word] has no letters. */
fun addPersonalSpellWord(stored: String?, word: String): String? {
    val normalized = normalizeForDictionary(word)
    if (normalized.isEmpty()) return null
    val words = personalSpellWords(stored)
    words += normalized
    while (words.size > PERSONAL_DICTIONARY_LIMIT) {
        val oldest = words.first()
        words.remove(oldest)
    }
    return words.joinToString("\n")
}

/** Words ignored until the app process ends, plus the saved personal dictionary. */
class SpellingSession {
    private val ignored = HashSet<String>()
    private val declined = HashSet<String>()

    fun ignore(word: String): Boolean {
        val normalized = normalizeForDictionary(word)
        if (normalized.isEmpty()) return false
        return ignored.add(normalized)
    }

    fun decline(word: String) {
        val normalized = normalizeForDictionary(word)
        if (normalized.isNotEmpty()) declined += normalized
    }

    fun isDeclined(word: String): Boolean = normalizeForDictionary(word) in declined

    fun accepts(word: String, personal: Set<String>): Boolean {
        val normalized = normalizeForDictionary(word)
        return normalized.isNotEmpty() && (normalized in ignored || normalized in personal)
    }

    fun snapshot(): Set<String> = ignored.toSet()
}
