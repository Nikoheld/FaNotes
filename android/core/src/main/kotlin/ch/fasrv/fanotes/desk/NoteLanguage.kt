package ch.fasrv.fanotes.desk

/**
 * Status-bar language of a note without dictionaries: the same stopword and diacritic evidence and the
 * same "present language" rule as the desktop note profile (`languageDetect.ts`, #1473), minus the
 * dictionary membership only the spellcheck pass has.
 */

private val WORD = Regex("""\p{L}[\p{L}\p{M}'’\-]*""")
private val CAMEL = Regex("""\p{Ll}\p{Lu}""")
private val NO_DICTIONARY = WordLanguages(de = false, en = false, fr = false)

/** "de", "en", "fr", "mixed" (two or more languages in use) or "unknown". */
fun detectNoteLanguage(markdown: String): String = detectNoteLanguages(markdown).let(::detectedLanguageOf)

/** The languages a note uses, most used first. */
fun detectNoteLanguages(markdown: String): List<String> {
    val profile = LanguageEvidence()
    val filter = ProseLineFilter()
    for (raw in markdown.replace("\r\n", "\n").split('\n')) {
        if (!filter.isProse(raw) || raw.isBlank()) continue
        val tokens = ArrayList<EvidenceToken>()
        for (match in WORD.findAll(raw)) {
            val word = match.value
            val from = match.range.first
            if (from > 0 && raw[from - 1] == '#') continue
            if (word.length in 2..16 && word.all { it in 'A'..'Z' || it == 'Ä' || it == 'Ö' || it == 'Ü' }) continue
            if (CAMEL.containsMatchIn(word)) continue
            val normalized = normalizeWord(word, "de")
            if (normalized.length < 2) continue
            tokens += EvidenceToken(word, normalized, NO_DICTIONARY)
        }
        addEvidence(profile, scoreTokens(tokens).evidence)
    }
    return presentLanguages(profile)
}

fun statusLanguageLabel(code: String, present: List<String> = emptyList()): String? = when (code) {
    "de" -> "Deutsch"
    "en" -> "English"
    "fr" -> "Français"
    "mixed" -> if (present.size >= 2) present.joinToString(" / ") { it.uppercase(java.util.Locale.US) } else "DE / EN"
    else -> null
}
