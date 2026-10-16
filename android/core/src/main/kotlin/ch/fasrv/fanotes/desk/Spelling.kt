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
 * and HTML, stay unmarked. French school words are recognised and not marked.
 */

data class SpellingError(val from: Int, val to: Int, val word: String, val language: String)
data class SpellingLine(val from: Int, val to: Int, val language: String)
data class SpellingCheckResult(
    val errors: List<SpellingError>,
    val lines: List<SpellingLine>,
    val detectedLanguage: String,
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
)

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
    return SpellingDictionaries(de, en, deWords, enWords)
}

fun normalizeWord(word: String, language: String): String {
    val locale = if (language == "de") DE_LOCALE else EN_LOCALE
    val normalized = Normalizer.normalize(word, Normalizer.Form.NFC)
        .lowercase(locale)
        .trim('\'', '’', '-')
    return if (language == "de") normalized.replace("ß", "ss") else normalized
}

fun normalizeForDictionary(word: String): String = normalizeWord(word.trim(), "de").trim('\'', '’', '-')

fun isFrenchWord(word: String): Boolean = foldFrench(word) in FRENCH_LEXICON

fun checkSpelling(
    segments: List<SpellingSegment>,
    dictionaries: SpellingDictionaries,
    ignoredRanges: List<SpellingRange> = emptyList(),
    cursorPositions: List<Int> = emptyList(),
    acceptedWords: Set<String> = emptySet(),
): SpellingCheckResult {
    if (segments.isEmpty()) return SpellingCheckResult(emptyList(), emptyList(), "unknown")
    val scored = segments.map { segment ->
        val localIgnored = ignoredRanges + automaticIgnoredRanges(segment)
        val words = WORD_PATTERN.findAll(segment.text).mapNotNull { match ->
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
                CheckedWord(word, from, to, normalized, wordMembership(word, dictionaries, acceptedWords))
            }
        }.toList()
        val evidence = SpellEvidence()
        for (token in words) {
            if (token.normalized in DE_STOPWORDS) evidence.de += 3
            if (token.normalized in EN_STOPWORDS) evidence.en += 3
            if (token.normalized in FRENCH_STOPWORDS || isFrenchWord(token.word)) evidence.fr += 3
            if (token.membership.de && !token.membership.en) evidence.de += 2
            if (token.membership.en && !token.membership.de) evidence.en += 2
        }
        ScoredSegment(segment, words, evidence, evidenceLanguage(evidence))
    }
    val document = SpellEvidence()
    for (segment in scored) {
        document.de += segment.evidence.de
        document.en += segment.evidence.en
        document.fr += segment.evidence.fr
    }
    val documentLanguage = evidenceLanguage(document) ?: if (document.en > document.de) "en" else "de"
    val explicit = LinkedHashSet<String>()
    for (segment in scored) segment.language?.let { explicit += it }
    val frenchLead = document.fr > document.de && document.fr > document.en
    val detected = when {
        frenchLead -> "fr"
        explicit.size > 1 -> "mixed"
        explicit.size == 1 -> explicit.first()
        document.de > 0 || document.en > 0 -> documentLanguage
        else -> "unknown"
    }
    val errors = ArrayList<SpellingError>()
    val lines = ArrayList<SpellingLine>()
    for (segment in scored) {
        val resolved = segment.language ?: documentLanguage
        if (segment.segment.text.isNotBlank()) {
            lines += SpellingLine(segment.segment.from, segment.segment.from + segment.segment.text.length, resolved)
        }
        for (token in segment.words) {
            if (token.membership.de || token.membership.en || isFrenchWord(token.word)) continue
            errors += SpellingError(token.from, token.to, token.word, resolved)
        }
    }
    return SpellingCheckResult(errors, lines, detected)
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
    return checkSpelling(segments, dictionaries, ignored, cursors, acceptedWords)
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

internal data class LanguageMembership(val de: Boolean, val en: Boolean)

internal fun wordMembership(
    word: String,
    dictionaries: SpellingDictionaries,
    acceptedWords: Set<String> = emptySet(),
): LanguageMembership {
    val normalized = normalizeWord(word, "de")
    if (normalized.isEmpty() || normalized in TECHNICAL_WORDS || normalized in acceptedWords) {
        return LanguageMembership(de = true, en = true)
    }
    if ('-' in normalized) {
        val parts = normalized.split('-').filter { it.isNotEmpty() }
        if (parts.size > 1) {
            val membership = parts.map { part ->
                LanguageMembership(
                    de = dictionaries.de.has(part, "de") || splitsIntoGermanParts(part) { dictionaries.de.hasNormalized(it) },
                    en = dictionaries.en.has(part, "en"),
                )
            }
            if (membership.all { it.de || it.en }) return LanguageMembership(de = true, en = true)
            return LanguageMembership(
                de = membership.all { it.de },
                en = membership.all { it.en },
            )
        }
    }
    return LanguageMembership(
        de = dictionaries.de.hasNormalized(normalized) || splitsIntoGermanParts(normalized) { dictionaries.de.hasNormalized(it) },
        en = dictionaries.en.has(normalized, "en"),
    )
}

private data class SpellEvidence(var de: Int = 0, var en: Int = 0, var fr: Int = 0)
private data class CheckedWord(
    val word: String,
    val from: Int,
    val to: Int,
    val normalized: String,
    val membership: LanguageMembership,
)
private data class ScoredSegment(
    val segment: SpellingSegment,
    val words: List<CheckedWord>,
    val evidence: SpellEvidence,
    val language: String?,
)

private fun evidenceLanguage(evidence: SpellEvidence): String? {
    if (evidence.de == 0 && evidence.en == 0) return null
    if (evidence.de >= evidence.en * 1.35) return "de"
    if (evidence.en >= evidence.de * 1.35) return "en"
    return null
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
