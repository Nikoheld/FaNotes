package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.JsonValue

/**
 * The desktop bloom filters and exact word lists from `fanotes/public/spell`.
 * Membership for underlines uses the filter, including German compounds.
 * Suggestions use the exact lists so a bloom false positive cannot become a correction.
 */

private const val HASHES = 8

fun normalizeSpellingForm(word: String, language: String): String {
    val locale = if (language == "de") java.util.Locale.forLanguageTag("de-CH") else java.util.Locale.US
    val lower = java.text.Normalizer.normalize(word, java.text.Normalizer.Form.NFC).lowercase(locale)
    return if (language == "de") lower.replace("ß", "ss") else lower
}

internal class BloomFilter(private val bytes: ByteArray, private val bitCount: Int) {
    fun has(rawWord: String, language: String): Boolean {
        val word = normalizeSpellingForm(rawWord, language)
        if (word.isEmpty()) return false
        val first = hashWord(word, 0x811c9dc5.toInt())
        val second = hashWord(word, 0x9e3779b1.toInt()) or 1
        for (index in 0 until HASHES) {
            val mixed = (first.toLong() and 0xffffffffL) + (imul(index, second).toLong() and 0xffffffffL)
            val bit = (mixed and 0xffffffffL) % bitCount.toLong()
            val at = bit.toInt()
            if ((bytes[at ushr 3].toInt() and (1 shl (at and 7))) == 0) return false
        }
        return true
    }
}

private fun imul(left: Int, right: Int): Int = (left.toLong() * right.toLong()).toInt()

private fun hashWord(word: String, seed: Int): Int {
    var hash = seed
    var index = 0
    while (index < word.length) {
        hash = hash xor word[index].code
        hash = imul(hash, 0x01000193)
        index += 1
    }
    return hash
}

internal class LoadedSpelling(
    private val bloom: Map<String, BloomFilter>,
    private val words: Map<String, Set<String>>,
    private val properNames: Set<String>,
) : SpellingLexicon {
    val languages = listOf("de", "en")

    override fun hasWord(language: String, normalizedWord: String): Boolean =
        words[language]?.contains(normalizedWord) == true || compound(language, normalizedWord)

    override fun candidatePenalty(language: String, normalizedWord: String): Int {
        if (words[language]?.contains(normalizedWord) == true) return 0
        return if (bloom[language]?.has(normalizedWord, language) == true) 4 else 15
    }

    fun isMisspelled(word: String, accepted: Set<String> = emptySet()): Boolean {
        val membership = membership(word, accepted)
        return !membership.first && !membership.second
    }

    fun membership(word: String, accepted: Set<String> = emptySet()): Pair<Boolean, Boolean> {
        val normalized = normalizeSpellingForm(word, "de")
        if (normalized.isEmpty()) return true to true
        if (normalized in TECHNICAL_WORDS || normalized in accepted) return true to true
        if ('-' in normalized) {
            val parts = normalized.split('-').filter { it.isNotEmpty() }
            if (parts.size > 1) {
                val flags = parts.map { part ->
                    (bloom["de"]?.has(part, "de") == true || germanCompound(part, bloom = true)) to
                        (bloom["en"]?.has(part, "en") == true)
                }
                if (flags.all { it.first || it.second }) return true to true
                return flags.all { it.first } to flags.all { it.second }
            }
        }
        return (bloom["de"]?.has(normalized, "de") == true || germanCompound(normalized, bloom = true)) to
            (bloom["en"]?.has(normalized, "en") == true)
    }

    fun isProperName(normalizedWord: String) = normalizedWord in properNames

    private fun compound(language: String, normalized: String) =
        language == "de" && germanCompound(normalized, bloom = false)

    private fun germanCompound(rawWord: String, bloom: Boolean): Boolean {
        val word = normalizeSpellingForm(rawWord, "de")
        if (word.length < 8 || word.length > 64 || !word.matches(Regex("""^\p{L}+$"""))) return false
        val hasPart: (String) -> Boolean = if (bloom) {
            { part -> this.bloom["de"]?.has(part, "de") == true }
        } else {
            { part -> words["de"]?.contains(part) == true }
        }
        val memo = HashMap<String, Boolean>()
        fun find(offset: Int, parts: Int): Boolean {
            if (offset == word.length) return parts >= 2
            if (parts >= 6 || word.length - offset < 3) return false
            val key = "$offset:$parts"
            memo[key]?.let { return it }
            val maximum = minOf(word.length, offset + 24)
            var end = offset + 3
            while (end <= maximum) {
                if (end < word.length && word.length - end < 3) {
                    end += 1
                    continue
                }
                if (hasPart(word.substring(offset, end)) && find(end, parts + 1)) {
                    memo[key] = true
                    return true
                }
                end += 1
            }
            memo[key] = false
            return false
        }
        return find(0, 0)
    }
}

object SpellingDictionary {
    @Volatile private var loaded: LoadedSpelling? = null
    @Volatile private var loading = false

    fun ready(): Boolean = loaded != null

    fun suggestions(word: String, language: String): List<String> {
        if (!ready()) return emptyList()
        val languages = if (language == "en") listOf("en") else listOf("de", "en")
        return suggestCorrections(word, languages, get(), limit = 5, maxDistance = 1).map { it.word }
    }

    fun warm() {
        if (loaded != null || loading) return
        loading = true
        Thread {
            try {
                get()
            } finally {
                loading = false
            }
        }.start()
    }

    internal fun get(): LoadedSpelling = loaded ?: synchronized(this) {
        loaded ?: read().also { loaded = it }
    }

    private fun read(): LoadedSpelling {
        val manifest = parseJson(text("manifest.json")) as JsonValue.Obj
        if (manifest.string("format") != "fanotes-spelling-bloom-v2") {
            error("Unbekanntes Rechtschreibformat.")
        }
        val languages = manifest.obj("languages") ?: error("Rechtschreibdaten ohne Sprachen.")
        fun bloom(language: String): BloomFilter {
            val descriptor = languages.obj(language) ?: error("Rechtschreibdaten ohne $language.")
            val bits = descriptor.double("bitCount")?.toInt() ?: error("Rechtschreibdaten ohne Länge.")
            val bytes = bytes(descriptor.string("file") ?: "$language.bloom")
            if (bytes.size * 8 != bits) error("Die lokalen Rechtschreibdaten besitzen eine ungültige Länge.")
            return BloomFilter(bytes, bits)
        }
        fun words(language: String): Set<String> {
            val file = languages.obj(language)?.obj("candidates")?.string("file") ?: "$language.words"
            val set = HashSet<String>()
            text(file).lineSequence().forEach { line -> if (line.isNotEmpty()) set += line }
            return set
        }
        val names = HashSet<String>()
        text("proper-names.txt").lineSequence().forEach { line -> if (line.isNotEmpty()) names += line }
        return LoadedSpelling(
            bloom = mapOf("de" to bloom("de"), "en" to bloom("en")),
            words = mapOf("de" to words("de"), "en" to words("en")),
            properNames = names,
        )
    }

    private fun text(name: String) = bytes(name).toString(Charsets.UTF_8)

    private fun bytes(name: String): ByteArray {
        val stream = SpellingDictionary::class.java.getResourceAsStream("/spell/$name")
            ?: error("Rechtschreibressource $name fehlt.")
        return stream.use { it.readBytes() }
    }
}

private val TECHNICAL_WORDS = setOf(
    "ai", "amat", "anthropic", "appimage", "arch", "browser", "chromium", "codemirror", "codex",
    "electron", "fanotes", "gemini", "glyphenwerk", "github", "google", "html", "hyprland",
    "javascript", "katex", "latex", "linux", "lm", "markdown", "nas", "ollama", "openai",
    "opencode", "pdf", "typescript", "url", "vulkan", "wayland", "web", "windows",
)
