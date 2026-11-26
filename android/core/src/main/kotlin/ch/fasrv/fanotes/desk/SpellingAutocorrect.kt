package ch.fasrv.fanotes.desk

/**
 * Autocorrect when a word is finished, and the Backspace that puts the typed
 * word back. Ported from `fanotes/src/lib/spellingCorrections.ts`.
 * The replacement is its own undo step: the boundary the user just typed stays.
 */

data class AutocorrectMark(
    val from: Int,
    val to: Int,
    val original: String,
    val replacement: String,
    val boundary: Int,
)

data class AutocorrectResult(
    val text: String,
    val cursor: Int,
    val mark: AutocorrectMark?,
    val declined: String? = null,
    /** True when the typed boundary and the correction are separate undo steps. */
    val splitHistory: Boolean = false,
)

private val BOUNDARY = Regex("""^[\s.,;:!?]${'$'}""")
private val LETTER = Regex("""[\p{L}\p{M}]""")
private val STUCK_BEFORE = Regex("""[\p{L}\p{M}\d'’\-_#@/\\.:&+]""")
private val SENTENCE_PREFIX = Regex("""^\s*(?:[-*+>]|\d+[.)]|#{1,6})?\s*""")
private val SENTENCE_END = Regex("""[.!?:]\s*$""")

/** On until the setting is turned off. Spellcheck must also be on. */
fun autocorrectEnabled(settings: Map<String, String>) =
    spellcheckEnabled(settings) && settings["autocorrect"] != "off"

fun isCanonicalProperName(normalizedWord: String): Boolean = properNames().contains(normalizedWord)

/**
 * The edit to apply after [before] became [next], or null when typing should
 * stay as the user entered it. A returned edit replaces the whole buffer.
 */
fun autocorrectTyping(
    before: String,
    next: String,
    changeStart: Int,
    changeDeleted: Int,
    lexicon: SpellingLexicon?,
    enabled: Boolean,
    mark: AutocorrectMark?,
    declined: (String) -> Boolean,
    /** The passage around a word start in [before]; see [paragraphPassageAt]. Null while the dictionaries load. */
    passageAt: (Int) -> PassageAt?,
    isProperName: (String) -> Boolean = ::isCanonicalProperName,
    /** Asked once when a French word is finished before the French list is in memory: start reading it. */
    onFrenchNeeded: () -> Unit = {},
): AutocorrectResult? {
    if (!enabled) return null
    revertAutocorrectBackspace(before, next, changeStart, changeDeleted, mark)?.let { return it }
    if (lexicon == null || changeDeleted != 0 || next.length != before.length + 1) return null
    if (changeStart < 0 || changeStart >= next.length) return null
    val boundary = next[changeStart].toString()
    if (!BOUNDARY.matches(boundary)) return null
    if (next.substring(0, changeStart) != before.substring(0, changeStart.coerceAtMost(before.length))) return null
    if (changeStart > before.length || next.substring(changeStart + 1) != before.substring(changeStart)) return null
    val planned = planAutocorrect(before, changeStart, lexicon, declined, passageAt, isProperName, onFrenchNeeded) ?: return null
    val text = next.substring(0, planned.from) + planned.replacement + next.substring(planned.to)
    val cursor = (planned.from + planned.replacement.length + boundary.length).coerceIn(0, text.length)
    return AutocorrectResult(
        text,
        cursor,
        AutocorrectMark(planned.from, planned.from + planned.replacement.length, planned.word, planned.replacement, boundary.length),
        splitHistory = true,
    )
}

private data class PlannedWord(val from: Int, val to: Int, val word: String, val replacement: String)

private fun planAutocorrect(
    before: String,
    wordEnd: Int,
    lexicon: SpellingLexicon,
    declined: (String) -> Boolean,
    passageAt: (Int) -> PassageAt?,
    isProperName: (String) -> Boolean,
    onFrenchNeeded: () -> Unit,
): PlannedWord? {
    if (wordEnd <= 0 || wordEnd > before.length) return null
    val lineStart = lineStartAt(before, wordEnd)
    var start = wordEnd
    while (start > lineStart && LETTER.matches(before[start - 1].toString())) start -= 1
    if (start == wordEnd) return null
    if (start > lineStart && STUCK_BEFORE.matches(before[start - 1].toString())) return null
    val word = before.substring(start, wordEnd)
    if (declined(word)) return null
    // Autocorrect only acts when the passage's language is certain and the word is unknown in every
    // dictionary (not only the languages seen so far); with any doubt the word stays underlined.
    val passage = passageAt(start)?.passage ?: return null
    val language = passage.language
    // Reading the French list takes a moment; start it as soon as a word is finished in a French passage.
    if (language == "fr" && !lexicon.frenchReady) onFrenchNeeded()
    if (language == null || !passage.confident || passage.foreign || passage.unsupported) return null
    if (!lexicon.isMisspelled(word, TEXT_LANGUAGES)) return null
    // Without the French list there is nothing to correct a French word with.
    if (language == "fr" && !lexicon.frenchReady) return null
    if (insideFence(before, start)) return null
    val lineEnd = before.indexOf('\n', lineStart).let { if (it < 0) before.length else it }
    val ignored = automaticIgnoredRanges(SpellingSegment(lineStart, before.substring(lineStart, lineEnd)))
    if (ignored.any { start < it.to && wordEnd > it.from }) return null
    val suggestions = suggestCorrections(word, listOf(language), lexicon, limit = 4, maxDistance = 1)
    val decision = decideAutocorrect(
        word,
        suggestions,
        AutocorrectContext(language, opensSentence(before, lineStart, start), isProperName),
    ) ?: return null
    return PlannedWord(start, wordEnd, word, decision.word)
}

private fun revertAutocorrectBackspace(
    before: String,
    next: String,
    changeStart: Int,
    changeDeleted: Int,
    mark: AutocorrectMark?,
): AutocorrectResult? {
    if (mark == null || changeDeleted != mark.boundary || mark.boundary <= 0) return null
    if (changeStart != mark.to) return null
    if (mark.from < 0 || mark.to > before.length || mark.to + mark.boundary > before.length) return null
    if (before.substring(mark.from, mark.to) != mark.replacement) return null
    val text = before.substring(0, mark.from) + mark.original + before.substring(mark.to + mark.boundary)
    if (next != before.removeRange(changeStart, changeStart + mark.boundary)) return null
    return AutocorrectResult(
        text,
        (mark.from + mark.original.length).coerceIn(0, text.length),
        null,
        declined = mark.original,
    )
}

private fun opensSentence(text: String, lineStart: Int, wordStart: Int): Boolean {
    val stripped = SENTENCE_PREFIX.replace(text.substring(lineStart, wordStart), "")
    return stripped.isBlank() || SENTENCE_END.containsMatchIn(stripped)
}

private fun lineStartAt(text: String, index: Int): Int {
    val found = text.lastIndexOf('\n', (index - 1).coerceAtLeast(0))
    return if (found < 0) 0 else found + 1
}

private fun insideFence(text: String, index: Int): Boolean {
    var open = false
    val head = text.substring(0, index.coerceIn(0, text.length))
    for (line in head.split('\n')) {
        val trimmed = line.trimStart()
        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) open = !open
    }
    return open
}

private fun properNames(): Set<String> {
    names?.let { return it }
    val stream = AutocorrectMark::class.java.classLoader?.getResourceAsStream("spell/proper-names.txt")
        ?: return emptySet<String>().also { names = it }
    val loaded = stream.use { it.bufferedReader().readLines() }.filter { it.isNotEmpty() }.toSet()
    names = loaded
    return loaded
}

@Volatile
private var names: Set<String>? = null

private const val PARAGRAPH_LOOKBEHIND = 3
private const val PARAGRAPH_LOOKAHEAD = 2

/**
 * What is known about the passage around [offset] in [text], decided now from the text as it is: its
 * language, whether that is certain, and the languages a word there may be valid in. The paragraph
 * neighbours are up to three lines before and two after, ended by a blank line.
 */
fun paragraphPassageAt(
    text: String,
    offset: Int,
    profile: LanguageEvidence?,
    dictionaries: SpellingDictionaries,
    acceptedWords: Set<String> = emptySet(),
): PassageAt {
    val lineStart = lineStartAt(text, offset)
    val lineEnd = text.indexOf('\n', lineStart).let { if (it < 0) text.length else it }
    val previous = ArrayList<String>()
    var cursor = lineStart
    while (cursor > 0 && previous.size < PARAGRAPH_LOOKBEHIND) {
        val start = text.lastIndexOf('\n', cursor - 2).let { if (it < 0) 0 else it + 1 }
        val line = text.substring(start, cursor - 1)
        if (line.isBlank()) break
        previous += line
        cursor = start
    }
    val next = ArrayList<String>()
    cursor = lineEnd + 1
    while (cursor <= text.length && lineEnd < text.length && next.size < PARAGRAPH_LOOKAHEAD) {
        val end = text.indexOf('\n', cursor).let { if (it < 0) text.length else it }
        val line = text.substring(cursor, end)
        if (line.isBlank()) break
        next += line
        cursor = end + 1
    }
    return resolvePassageAt(text.substring(lineStart, lineEnd), offset - lineStart, previous, next, profile, dictionaries, acceptedWords)
}
