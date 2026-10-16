package ch.fasrv.fanotes.desk

/** `ß` and `ss` are the same letters when a German word is looked up. */
fun foldSharpS(value: String) = value.replace("ß", "ss")

private fun sharpSPattern(lowered: String): String {
    val out = StringBuilder()
    var index = 0
    while (index < lowered.length) {
        val char = lowered[index]
        if (char == 'ß' || (char == 's' && index + 1 < lowered.length && lowered[index + 1] == 's')) {
            out.append("(?:ß|ss)")
            index += if (char == 's') 2 else 1
            continue
        }
        out.append(Regex.escape(char.toString()))
        index += 1
    }
    return out.toString()
}

/** The match range in [haystackLower], so an excerpt can quote the original letters. */
fun findSharpS(haystackLower: String, needleLower: String, from: Int = 0): IntRange? {
    if (needleLower.isEmpty() || from > haystackLower.length) return null
    return Regex(sharpSPattern(needleLower)).find(haystackLower, from)?.range
}

fun countSharpS(haystackLower: String, needleLower: String): Int {
    if (needleLower.isEmpty()) return 0
    return Regex(sharpSPattern(needleLower)).findAll(haystackLower).count()
}
