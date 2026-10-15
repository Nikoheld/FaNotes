package ch.fasrv.fanotes.desk

import java.util.Locale

/**
 * Status-bar language from the desktop spellcheck pass, using the same
 * stopword evidence. Dictionary membership is absent, so only the stopword
 * and French-lexicon scores decide Deutsch, English, Français, or DE / EN.
 */

private val WORD = Regex("""\p{L}[\p{L}\p{M}'’\-]*""")
private val CAMEL = Regex("""\p{Ll}\p{Lu}""")
private val FENCE = Regex("""^\s*(```|~~~)""")

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
private val FRENCH_LEXICON = """
le la les un une des de du et ou mais donc car ni que qui quoi dont
je tu il elle on nous vous ils elles me te se lui leur y en mon ton son
ma ta sa mes tes ses notre votre nos vos leurs ce cet cette ces
est suis es sommes etes sont ete etait ai as a avons avez ont
pas ne plus jamais rien personne
dans sur sous avec sans pour par chez entre vers pendant avant apres
etre avoir faire aller dire voir savoir pouvoir vouloir devoir prendre
bonjour merci oui non tres bien mal petit grand
ecole eleve professeur devoir examen lecon cahier stylo livre texte
francais anglais allemand mathematiques histoire
maison famille ami amie mere pere frere soeur enfant
aujourd hui demain hier matin soir
""".trim().split(Regex("""\s+""")).filter { it.length >= 2 }.toSet()

private data class Evidence(var de: Int = 0, var en: Int = 0, var fr: Int = 0)

fun detectNoteLanguage(markdown: String): String {
    val document = Evidence()
    val explicit = LinkedHashSet<String>()
    var fence = false
    for (raw in markdown.replace("\r\n", "\n").lineSequence()) {
        val marker = FENCE.containsMatchIn(raw)
        if (marker) {
            fence = !fence
            continue
        }
        if (fence || raw.isBlank()) continue
        val line = scoreLine(raw)
        document.de += line.de
        document.en += line.en
        document.fr += line.fr
        evidenceLanguage(line)?.let { explicit += it }
    }
    val documentLanguage = evidenceLanguage(document) ?: if (document.en > document.de) "en" else "de"
    val frenchLead = document.fr > document.de && document.fr > document.en
    return when {
        frenchLead -> "fr"
        explicit.size > 1 -> "mixed"
        explicit.size == 1 -> explicit.first()
        document.de > 0 || document.en > 0 -> documentLanguage
        else -> "unknown"
    }
}

fun statusLanguageLabel(code: String): String? = when (code) {
    "de" -> "Deutsch"
    "en" -> "English"
    "fr" -> "Français"
    "mixed" -> "DE / EN"
    else -> null
}

private fun evidenceLanguage(evidence: Evidence): String? {
    if (evidence.de == 0 && evidence.en == 0) return null
    if (evidence.de >= evidence.en * 1.35) return "de"
    if (evidence.en >= evidence.de * 1.35) return "en"
    return null
}

private fun scoreLine(text: String): Evidence {
    val evidence = Evidence()
    for (match in WORD.findAll(text)) {
        val word = match.value
        val from = match.range.first
        if (from > 0 && text[from - 1] == '#') continue
        if (word.length in 2..16 && word.all { it.isUpperCase() }) continue
        if (CAMEL.containsMatchIn(word)) continue
        val normalized = normalizeGerman(word)
        if (normalized.length < 2) continue
        val folded = foldFrench(word)
        if (normalized in DE_STOPWORDS) evidence.de += 3
        if (normalized in EN_STOPWORDS) evidence.en += 3
        if (folded in FRENCH_STOPWORDS || folded in FRENCH_LEXICON) evidence.fr += 3
    }
    return evidence
}

private fun normalizeGerman(word: String): String = word
    .lowercase(Locale.GERMAN)
    .trim('\'', '’', '-')
    .replace("ß", "ss")

private fun foldFrench(word: String): String = word
    .lowercase(Locale.FRENCH)
    .replace('à', 'a').replace('â', 'a').replace('ä', 'a')
    .replace('é', 'e').replace('è', 'e').replace('ê', 'e').replace('ë', 'e')
    .replace('î', 'i').replace('ï', 'i')
    .replace('ô', 'o').replace('ö', 'o')
    .replace('ù', 'u').replace('û', 'u').replace('ü', 'u')
    .replace('ç', 'c')
    .trim('\'', '’', '-')
