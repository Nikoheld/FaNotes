package ch.fasrv.fanotes.study.crypto

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.study.asArray
import ch.fasrv.fanotes.study.asRecord
import ch.fasrv.fanotes.study.asText
import ch.fasrv.fanotes.study.num
import ch.fasrv.fanotes.study.parseJsonObjectOrNull
import ch.fasrv.fanotes.study.readStudyStrict
import ch.fasrv.fanotes.study.text

/**
 * Data of the `fanotes-crypto` block: one of six tools with its inputs and the student's own answers.
 * Port of `lib/study/crypto/model.ts`; the JSON has to round-trip identically with the desktop app.
 */

enum class CryptoTool(val id: String, val label: String, val defaultTitle: String) {
    CAESAR("caesar", "Caesar und Alphabetstreifen", "Caesar"),
    FREQ("freq", "Häufigkeitsanalyse", "Häufigkeitsanalyse"),
    VIGENERE("vigenere", "Vigenère-Quadrat", "Vigenère"),
    XOR("xor", "ASCII und XOR", "ASCII und XOR"),
    MOD("mod", "Rechnen mit Modulo", "Modulo"),
    DH("dh", "Diffie-Hellman", "Diffie-Hellman");

    companion object {
        fun of(id: String?): CryptoTool? = entries.firstOrNull { it.id == id }
    }
}

object CryptoLimits {
    const val TITLE = 120
    const val TEXT = 400
    const val ANSWER = 600
    const val FREQ_TEXT = 4000
    const val KEYWORD = 60
    const val ALPHABET = 80
    const val KEY = 60
    const val NUMBER = 12
    const val BITS = 7
    const val ROWS = 24
}

enum class CaesarMode(val id: String) { SHIFT("shift"), ALPHABET("alphabet"), KEYWORD("keyword") }

sealed interface CryptoData {
    val title: String
    val tool: CryptoTool
}

data class CaesarData(
    override val title: String,
    val mode: CaesarMode,
    val shift: Int,
    /** The given cipher alphabet as the student typed it. */
    val alphabet: String,
    val keyword: String,
    /** The cipher alphabet the student builds for the keyword: 26 cells, `_` for an empty one. */
    val built: String,
    val task: String,
    val answer: String,
) : CryptoData { override val tool get() = CryptoTool.CAESAR }

data class FreqData(override val title: String, val lang: FreqLang, val text: String, val map: Map<Char, Char>) : CryptoData {
    override val tool get() = CryptoTool.FREQ
}

data class VigenereData(override val title: String, val key: String, val plain: String, val answer: String) : CryptoData {
    override val tool get() = CryptoTool.VIGENERE
}

data class XorData(override val title: String, val plain: String, val key: String, val p: List<String>, val k: List<String>, val c: List<String>) : CryptoData {
    override val tool get() = CryptoTool.XOR
}

data class ModData(
    override val title: String, val op: ModOp, val a: String, val b: String, val m: String,
    val s1: String, val s2: String, val s3: String, val s4: String,
) : CryptoData { override val tool get() = CryptoTool.MOD }

data class DhData(
    override val title: String, val y: String, val p: String, val a: String, val b: String,
    val alpha: String, val beta: String, val sa: String, val sb: String,
) : CryptoData { override val tool get() = CryptoTool.DH }

fun defaultCryptoData(tool: CryptoTool = CryptoTool.CAESAR): CryptoData {
    val title = tool.defaultTitle
    return when (tool) {
        CryptoTool.CAESAR -> CaesarData(title, CaesarMode.SHIFT, 3, "", "", "_".repeat(26), "", "")
        CryptoTool.FREQ -> FreqData(title, FreqLang.DE, "", emptyMap())
        CryptoTool.VIGENERE -> VigenereData(title, "", "", "")
        CryptoTool.XOR -> XorData(title, "", "", emptyList(), emptyList(), emptyList())
        CryptoTool.MOD -> ModData(title, ModOp.TIMES, "", "", "", "", "", "", "")
        CryptoTool.DH -> DhData(title, "", "", "", "", "", "", "", "")
    }
}

private val NON_DIGIT = Regex("[^0-9]")
private fun JsonValue.Obj.digits(key: String, max: Int = CryptoLimits.NUMBER) = this[key].asText(max).replace(NON_DIGIT, "")
private fun JsonValue?.list(max: Int, width: Int): List<String> = (this as? JsonValue.Arr)?.items?.take(max)?.map { it.asText(width) }.orEmpty()

/** JS `Number(value)` for the few JSON shapes that can occur; null stands for NaN. */
private fun jsNumberOf(value: JsonValue?): Double? = when (value) {
    is JsonValue.Num -> value.value
    is JsonValue.Str -> if (value.value.isBlank()) 0.0 else value.value.trim().toDoubleOrNull()
    is JsonValue.Bool -> if (value.value) 1.0 else 0.0
    is JsonValue.Null -> 0.0
    else -> null
}?.takeIf { it.isFinite() }

/** Every stored field of a tool, cut to its cap or replaced by a default when it has the wrong type. */
fun normaliseCryptoData(source: JsonValue.Obj): CryptoData {
    val tool = CryptoTool.of(source.string("tool")) ?: CryptoTool.CAESAR
    val title = source.text("title", CryptoLimits.TITLE)
    val limits = CryptoLimits
    return when (tool) {
        CryptoTool.CAESAR -> {
            val shift = jsNumberOf(source["shift"])
            CaesarData(
                title,
                CaesarMode.entries.firstOrNull { it.id == source.string("mode") && it != CaesarMode.SHIFT } ?: CaesarMode.SHIFT,
                if (shift != null) shift.toLong().coerceIn(0, 25).toInt() else 3,
                source.text("alphabet", limits.ALPHABET),
                source.text("keyword", limits.KEYWORD),
                source.text("built", 26).ifEmpty { "_".repeat(26) },
                source.text("task", limits.TEXT),
                source.text("answer", limits.ANSWER),
            )
        }
        CryptoTool.FREQ -> {
            val map = LinkedHashMap<Char, Char>()
            for ((cipher, plain) in source["map"].asRecord().fields) {
                val letter = (plain as? JsonValue.Str)?.value ?: continue
                if (cipher.length == 1 && cipher[0] in 'A'..'Z' && letter.length == 1 && letter[0] in 'a'..'z') map[cipher[0]] = letter[0]
            }
            FreqData(title, if (source.string("lang") == "en") FreqLang.EN else FreqLang.DE, source.text("text", limits.FREQ_TEXT), map)
        }
        CryptoTool.VIGENERE -> VigenereData(title, source.text("key", limits.KEY), source.text("plain", limits.TEXT), source.text("answer", limits.ANSWER))
        CryptoTool.XOR -> XorData(
            title, source.text("plain", limits.TEXT), source.text("key", limits.KEY),
            source["p"].list(limits.ROWS, limits.BITS), source["k"].list(limits.ROWS, limits.BITS), source["c"].list(limits.ROWS, limits.BITS),
        )
        CryptoTool.MOD -> ModData(
            title, ModOp.entries.firstOrNull { it.id == source.string("op") && it != ModOp.TIMES } ?: ModOp.TIMES,
            source.digits("a"), source.digits("b"), source.digits("m"), source.digits("s1"), source.digits("s2"),
            source["s3"].asText(400).replace(NON_DIGIT, ""), source.digits("s4"),
        )
        CryptoTool.DH -> DhData(
            title, source.digits("y"), source.digits("p"), source.digits("a"), source.digits("b"),
            source.digits("alpha"), source.digits("beta"), source.digits("sa"), source.digits("sb"),
        )
    }
}

/** Lenient reading (bad JSON gives the default tool); the strict reader for editing is [cryptoEditable]. */
fun parseCryptoData(body: String): CryptoData {
    val raw = parseJsonObjectOrNull(body)
    return if (raw == null || raw.fields.isEmpty()) defaultCryptoData() else normaliseCryptoData(raw)
}

/** The tool's data when the block reads back without loss; null means "do not edit here" (bad JSON, text that would be cut). */
fun cryptoEditable(body: String): CryptoData? = readStudyStrict(body, { defaultCryptoData() }, ::normaliseCryptoData, ::cryptoDataJson)

private fun strings(list: List<String>): JsonValue = JsonValue.Arr(list.map { jsonString(it) as JsonValue }.toMutableList())

/** The JSON of a tool in the key order the desktop writes (`v`, `title`, `tool`, then the tool's fields). */
fun cryptoDataJson(data: CryptoData): JsonValue.Obj {
    val head = arrayOf("v" to num(1), "title" to jsonString(data.title), "tool" to jsonString(data.tool.id))
    val rest: Array<Pair<String, JsonValue?>> = when (data) {
        is CaesarData -> arrayOf(
            "mode" to jsonString(data.mode.id), "shift" to num(data.shift), "alphabet" to jsonString(data.alphabet),
            "keyword" to jsonString(data.keyword), "built" to jsonString(data.built), "task" to jsonString(data.task), "answer" to jsonString(data.answer),
        )
        is FreqData -> arrayOf(
            "lang" to jsonString(data.lang.id), "text" to jsonString(data.text),
            "map" to jsonObject(*data.map.entries.map { it.key.toString() to (jsonString(it.value.toString()) as JsonValue?) }.toTypedArray()),
        )
        is VigenereData -> arrayOf("key" to jsonString(data.key), "plain" to jsonString(data.plain), "answer" to jsonString(data.answer))
        is XorData -> arrayOf(
            "plain" to jsonString(data.plain), "key" to jsonString(data.key), "p" to strings(data.p), "k" to strings(data.k), "c" to strings(data.c),
        )
        is ModData -> arrayOf(
            "op" to jsonString(data.op.id), "a" to jsonString(data.a), "b" to jsonString(data.b), "m" to jsonString(data.m),
            "s1" to jsonString(data.s1), "s2" to jsonString(data.s2), "s3" to jsonString(data.s3), "s4" to jsonString(data.s4),
        )
        is DhData -> arrayOf(
            "y" to jsonString(data.y), "p" to jsonString(data.p), "a" to jsonString(data.a), "b" to jsonString(data.b),
            "alpha" to jsonString(data.alpha), "beta" to jsonString(data.beta), "sa" to jsonString(data.sa), "sb" to jsonString(data.sb),
        )
    }
    return jsonObject(*head, *rest)
}

/** Every key any tool may write; keys outside this list are unknown fields that an edit keeps. */
val CRYPTO_KEYS = setOf(
    "v", "tool", "title", "mode", "shift", "alphabet", "keyword", "built", "task", "answer", "lang", "text", "map", "key", "plain",
    "p", "k", "c", "op", "a", "b", "m", "s1", "s2", "s3", "s4", "y", "alpha", "beta", "sa", "sb",
)

/** [updated] as the block's JSON, followed by the unknown fields of [original] (desktop: `{ ...data, ...extra }`). */
fun mergeCryptoJson(original: JsonValue.Obj?, updated: JsonValue.Obj): JsonValue.Obj {
    val out = JsonValue.Obj(LinkedHashMap(updated.fields))
    original?.fields?.forEach { (key, value) -> if (key !in CRYPTO_KEYS && key !in out.fields) out.fields[key] = value }
    return out
}

/** The model for drawing: null when the block is not a JSON object (the caller shows the raw block). */
fun cryptoReadable(body: String): CryptoData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    return if (raw.fields.isEmpty()) defaultCryptoData() else normaliseCryptoData(raw)
}

/** Palette command ids of the insert menu (`study-crypto-<tool>`, as on the desktop) and the tool each one inserts. */
val CRYPTO_COMMANDS: Map<String, CryptoTool> = CryptoTool.entries.associateBy { "study-crypto-${it.id}" }
