package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson

/**
 * Desktop UI language. System follows the device: German only when a language
 * tag matches `de` or `de-*`, otherwise English. The English strings are the
 * desktop catalog, looked up by the exact German source.
 */

private val GERMAN_TAG = Regex("^de(?:-|$)", RegexOption.IGNORE_CASE)

fun resolveUiLanguage(preference: String?, deviceLanguages: List<String>): String {
    return when (preference?.trim()?.lowercase()) {
        "de" -> "de"
        "en" -> "en"
        else -> if (deviceLanguages.any { GERMAN_TAG.containsMatchIn(it.trim()) }) "de" else "en"
    }
}

/** Swiss spelling: UI text never shows "ß". */
fun swissSpelling(text: String): String = if (text.indexOf('ß') < 0) text else text.replace("ß", "ss")

/**
 * The catalog keyed by Swiss spelling too, so a source written with "ss" finds the desktop's "ß" key.
 * One index is kept for the catalog map in use.
 */
private class SwissIndex(val catalog: Map<String, String>) {
    val byNormalized: Map<String, String> = HashMap<String, String>().also { map ->
        for ((key, value) in catalog) if (key.indexOf('ß') >= 0) map.putIfAbsent(swissSpelling(key), value)
    }
}

@Volatile private var swissIndex: SwissIndex? = null

private fun swissLookup(catalog: Map<String, String>, source: String): String? {
    var index = swissIndex
    if (index == null || index.catalog !== catalog) {
        index = SwissIndex(catalog)
        swissIndex = index
    }
    return index.byNormalized[source]
}

/**
 * German keeps the source (in Swiss spelling); English is the desktop catalog, looked up by the exact
 * German source, or by its "ss" form for a key the desktop spells with "ß".
 */
fun translateChrome(source: String, language: String, catalog: Map<String, String>): String {
    if (language != "en") return swissSpelling(source)
    return catalog[source] ?: swissLookup(catalog, source) ?: translateFallback(source, catalog) ?: swissSpelling(source)
}

private val SENTENCE_BREAK = Regex("(?<=[^+][.!?]) ")

/** A sentence with variable parts, or a message that joins several catalog or pattern sentences. */
private fun translateFallback(source: String, catalog: Map<String, String>): String? {
    val swiss = swissSpelling(source)
    translateChromePattern(swiss)?.let { return it }
    val parts = swiss.split(SENTENCE_BREAK)
    if (parts.size < 2) return null
    val out = ArrayList<String>(parts.size)
    for (part in parts) out += catalog[part] ?: swissLookup(catalog, part) ?: translateChromePattern(part) ?: return null
    return out.joinToString(" ")
}

/** Note bodies, file names, and other user text stay as written. */
fun presentNoteText(text: String): String = text

/**
 * The status-bar note language. An English note stays "English" even when the
 * UI catalog would translate a matching chrome string.
 */
fun statusBarLanguage(noteCode: String, uiLanguage: String, catalog: Map<String, String>): String? {
    val label = statusLanguageLabel(noteCode) ?: return null
    if (noteCode == "en") return "English"
    if (uiLanguage != "en") return label
    return label
}

fun loadEnglishCatalog(json: String): Map<String, String> {
    val root = parseJson(json) as? JsonValue.Obj ?: return emptyMap()
    val catalog = LinkedHashMap<String, String>(root.fields.size)
    for ((key, value) in root.fields) {
        val text = (value as? JsonValue.Str)?.value ?: continue
        catalog[key] = text
    }
    return catalog
}

fun loadEnglishCatalogResource(loader: ClassLoader? = ChromeText::class.java.classLoader): Map<String, String> {
    val stream = loader?.getResourceAsStream("en.json") ?: return emptyMap()
    return stream.bufferedReader(Charsets.UTF_8).use { loadEnglishCatalog(it.readText()) }
}

object ChromeText {
    @Volatile var language: String = "de"
    @Volatile var catalog: Map<String, String> = emptyMap()

    fun ui(source: String): String = translateChrome(source, language, catalog)
}
