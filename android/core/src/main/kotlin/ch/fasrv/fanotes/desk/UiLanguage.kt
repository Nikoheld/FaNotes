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

fun translateChrome(source: String, language: String, catalog: Map<String, String>): String {
    if (language != "en") return source
    return catalog[source] ?: source
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
