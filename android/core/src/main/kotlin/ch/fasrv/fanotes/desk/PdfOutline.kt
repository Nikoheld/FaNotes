package ch.fasrv.fanotes.desk

import java.util.zip.Inflater

/**
 * The outline ("Gliederung", bookmarks) of a PDF, like `outlineFromPdf` in `fanotes/src/components/PdfNoteView.tsx`
 * reads it through pdf.js. Android's `PdfRenderer` has no outline API, so this reads the few objects it needs from
 * the file itself: the cross-reference table or stream (with its `/Prev` chain), object streams, Flate streams with
 * PNG predictors, the page tree, named destinations (`/Dests` dictionary and the `/Names /Dests` tree) and
 * `/GoTo` actions. A damaged cross-reference falls back to a scan for `n g obj`. Encrypted files have no readable
 * titles here and give an empty outline, as does anything unexpected.
 */
data class PdfOutlineItem(val title: String, val page: Int?, val items: List<PdfOutlineItem> = emptyList())

/** Up to this many entries per level, as on the desktop. */
const val PDF_OUTLINE_LEVEL_LIMIT = 200
private const val OUTLINE_TOTAL_LIMIT = 4_000
private const val OUTLINE_DEPTH_LIMIT = 24
private const val STREAM_LIMIT = 64 * 1024 * 1024

fun readPdfOutline(bytes: ByteArray): List<PdfOutlineItem> = try {
    PdfObjects(bytes).outline()
} catch (_: Exception) {
    emptyList()
} catch (_: StackOverflowError) {
    emptyList()
}

/** Entries flattened for a list view: depth and item, in reading order. */
fun flattenPdfOutline(items: List<PdfOutlineItem>, depth: Int = 0): List<Pair<Int, PdfOutlineItem>> =
    items.flatMap { item -> listOf(depth to item) + flattenPdfOutline(item.items, depth + 1) }

internal sealed class PdfValue {
    data class Num(val value: Double) : PdfValue()
    data class Name(val value: String) : PdfValue()
    class Str(val bytes: ByteArray) : PdfValue()
    data class Ref(val num: Int, val gen: Int) : PdfValue()
    class Arr(val items: List<PdfValue>) : PdfValue()
    class Dict(val map: Map<String, PdfValue>) : PdfValue() {
        operator fun get(key: String) = map[key]
    }
    class Stream(val dict: Dict, val start: Int, val length: Int) : PdfValue()
    data class Bool(val value: Boolean) : PdfValue()
    object Null : PdfValue()
}

private class PdfLexer(val data: ByteArray, var pos: Int, val end: Int = data.size) {
    fun isWhite(b: Int) = b == 0 || b == 9 || b == 10 || b == 12 || b == 13 || b == 32
    fun isDelim(b: Int) = b == '('.code || b == ')'.code || b == '<'.code || b == '>'.code || b == '['.code ||
        b == ']'.code || b == '{'.code || b == '}'.code || b == '/'.code || b == '%'.code

    fun peek(): Int = if (pos < end) data[pos].toInt() and 0xff else -1

    fun skipWhite() {
        while (pos < end) {
            val b = peek()
            if (isWhite(b)) {
                pos += 1
            } else if (b == '%'.code) {
                while (pos < end && peek() != 10 && peek() != 13) pos += 1
            } else {
                return
            }
        }
    }

    fun keyword(): String {
        val start = pos
        while (pos < end && !isWhite(peek()) && !isDelim(peek())) pos += 1
        return String(data, start, pos - start, Charsets.ISO_8859_1)
    }

    /** One value; `n g R` references are joined here. [depth] guards nesting. */
    fun value(depth: Int = 0): PdfValue {
        if (depth > 64) throw IllegalStateException("PDF nesting too deep")
        skipWhite()
        val b = peek()
        return when {
            b < 0 -> throw IllegalStateException("PDF ended")
            b == '/'.code -> name()
            b == '('.code -> literal()
            b == '['.code -> {
                pos += 1
                val items = ArrayList<PdfValue>()
                while (true) {
                    skipWhite()
                    if (peek() == ']'.code) {
                        pos += 1
                        break
                    }
                    if (peek() < 0) throw IllegalStateException("PDF array open")
                    items += value(depth + 1)
                }
                PdfValue.Arr(joinRefs(items))
            }
            b == '<'.code && pos + 1 < end && data[pos + 1].toInt() == '<'.code -> dict(depth)
            b == '<'.code -> hex()
            (b in '0'.code..'9'.code) || b == '-'.code || b == '+'.code || b == '.'.code -> number()
            else -> when (val word = keyword()) {
                "true" -> PdfValue.Bool(true)
                "false" -> PdfValue.Bool(false)
                "null" -> PdfValue.Null
                "R" -> PdfValue.Name("\u0000R")
                "" -> {
                    pos += 1
                    PdfValue.Null
                }
                else -> PdfValue.Name("\u0000$word")
            }
        }
    }

    private fun joinRefs(items: List<PdfValue>): List<PdfValue> {
        val out = ArrayList<PdfValue>(items.size)
        var index = 0
        while (index < items.size) {
            val a = items[index]
            val b = items.getOrNull(index + 1)
            val c = items.getOrNull(index + 2)
            if (a is PdfValue.Num && b is PdfValue.Num && c is PdfValue.Name && c.value == "\u0000R") {
                out += PdfValue.Ref(a.value.toInt(), b.value.toInt())
                index += 3
            } else {
                out += a
                index += 1
            }
        }
        return out
    }

    fun dict(depth: Int): PdfValue.Dict {
        pos += 2
        val items = ArrayList<PdfValue>()
        while (true) {
            skipWhite()
            if (peek() == '>'.code && pos + 1 < end && data[pos + 1].toInt() == '>'.code) {
                pos += 2
                break
            }
            if (peek() < 0) throw IllegalStateException("PDF dictionary open")
            items += value(depth + 1)
        }
        val joined = joinRefs(items)
        val map = LinkedHashMap<String, PdfValue>()
        var index = 0
        while (index + 1 < joined.size) {
            val key = joined[index] as? PdfValue.Name
            if (key == null) {
                index += 1
                continue
            }
            map[key.value] = joined[index + 1]
            index += 2
        }
        return PdfValue.Dict(map)
    }

    private fun name(): PdfValue.Name {
        pos += 1
        val out = java.io.ByteArrayOutputStream()
        while (pos < end && !isWhite(peek()) && !isDelim(peek())) {
            val b = peek()
            if (b == '#'.code && pos + 2 < end) {
                val hex = String(data, pos + 1, 2, Charsets.ISO_8859_1).toIntOrNull(16)
                if (hex != null) {
                    out.write(hex)
                    pos += 3
                    continue
                }
            }
            out.write(b)
            pos += 1
        }
        return PdfValue.Name(String(out.toByteArray(), Charsets.ISO_8859_1))
    }

    private fun number(): PdfValue {
        val start = pos
        pos += 1
        while (pos < end && (peek() in '0'.code..'9'.code || peek() == '.'.code)) pos += 1
        val text = String(data, start, pos - start, Charsets.ISO_8859_1)
        return PdfValue.Num(text.toDoubleOrNull() ?: 0.0)
    }

    private fun literal(): PdfValue.Str {
        pos += 1
        val out = java.io.ByteArrayOutputStream()
        var depth = 1
        while (pos < end) {
            val b = peek()
            pos += 1
            when (b) {
                '\\'.code -> {
                    if (pos >= end) break
                    val next = peek()
                    pos += 1
                    when (next) {
                        'n'.code -> out.write(10)
                        'r'.code -> out.write(13)
                        't'.code -> out.write(9)
                        'b'.code -> out.write(8)
                        'f'.code -> out.write(12)
                        13 -> if (peek() == 10) pos += 1
                        10 -> Unit
                        in '0'.code..'7'.code -> {
                            var octal = next - '0'.code
                            repeat(2) {
                                if (peek() in '0'.code..'7'.code) {
                                    octal = octal * 8 + (peek() - '0'.code)
                                    pos += 1
                                }
                            }
                            out.write(octal and 0xff)
                        }
                        else -> out.write(next)
                    }
                }
                '('.code -> {
                    depth += 1
                    out.write(b)
                }
                ')'.code -> {
                    depth -= 1
                    if (depth == 0) return PdfValue.Str(out.toByteArray())
                    out.write(b)
                }
                else -> out.write(b)
            }
        }
        return PdfValue.Str(out.toByteArray())
    }

    private fun hex(): PdfValue.Str {
        pos += 1
        val out = java.io.ByteArrayOutputStream()
        var high = -1
        while (pos < end) {
            val b = peek()
            pos += 1
            if (b == '>'.code) break
            val digit = Character.digit(b, 16)
            if (digit < 0) continue
            if (high < 0) high = digit else {
                out.write(high * 16 + digit)
                high = -1
            }
        }
        if (high >= 0) out.write(high * 16)
        return PdfValue.Str(out.toByteArray())
    }
}

private sealed class XrefEntry {
    data class Offset(val offset: Int) : XrefEntry()
    data class InStream(val stream: Int, val index: Int) : XrefEntry()
}

internal class PdfObjects(private val data: ByteArray) {
    private val xref = HashMap<Int, XrefEntry>()
    private var trailer: PdfValue.Dict? = null
    private val cache = HashMap<Int, PdfValue>()
    private val objectStreams = HashMap<Int, Map<Int, PdfValue>>()
    private var scanned = false

    init {
        try {
            readXrefChain()
        } catch (_: Exception) {
            xref.clear()
            trailer = null
        }
        if (trailer?.get("Root") == null) scan()
    }

    fun outline(): List<PdfOutlineItem> {
        val trailerDict = trailer ?: return emptyList()
        if (trailerDict["Encrypt"] != null) return emptyList()
        val root = resolve(trailerDict["Root"]) as? PdfValue.Dict ?: return emptyList()
        val outlines = resolve(root["Outlines"]) as? PdfValue.Dict ?: return emptyList()
        val pages = pageNumbers(root)
        val resolver = DestinationResolver(root, pages)
        val budget = intArrayOf(OUTLINE_TOTAL_LIMIT)
        return children(outlines, resolver, 0, HashSet(), budget)
    }

    private fun children(
        parent: PdfValue.Dict,
        resolver: DestinationResolver,
        depth: Int,
        visited: MutableSet<Int>,
        budget: IntArray,
    ): List<PdfOutlineItem> {
        if (depth > OUTLINE_DEPTH_LIMIT) return emptyList()
        val items = ArrayList<PdfOutlineItem>()
        var link = parent["First"]
        while (link != null && items.size < PDF_OUTLINE_LEVEL_LIMIT && budget[0] > 0) {
            if (link is PdfValue.Ref && !visited.add(link.num)) break
            val node = resolve(link) as? PdfValue.Dict ?: break
            budget[0] -= 1
            val title = (resolve(node["Title"]) as? PdfValue.Str)?.let { pdfTextString(it.bytes) }?.trim().orEmpty()
            val target = node["Dest"] ?: (resolve(node["A"]) as? PdfValue.Dict)?.takeIf {
                (it["S"] as? PdfValue.Name)?.value == "GoTo"
            }?.get("D")
            items += PdfOutlineItem(
                title = title.ifEmpty { "Abschnitt" },
                page = resolver.page(target),
                items = children(node, resolver, depth + 1, visited, budget),
            )
            link = node["Next"]
        }
        return items
    }

    private inner class DestinationResolver(private val root: PdfValue.Dict, private val pages: Map<Int, Int>) {
        fun page(target: PdfValue?, depth: Int = 0): Int? {
            if (target == null || depth > 4) return null
            return when (val value = resolve(target)) {
                is PdfValue.Arr -> when (val first = value.items.firstOrNull()) {
                    is PdfValue.Ref -> pages[first.num]
                    is PdfValue.Num -> (first.value.toInt() + 1).takeIf { it >= 1 && it <= pages.size.coerceAtLeast(1) }
                    else -> null
                }
                is PdfValue.Dict -> page(value["D"], depth + 1)
                is PdfValue.Name -> page((resolve(root["Dests"]) as? PdfValue.Dict)?.get(value.value), depth + 1)
                is PdfValue.Str -> page(namedDestination(value.bytes), depth + 1)
                else -> null
            }
        }

        private fun namedDestination(name: ByteArray): PdfValue? {
            val names = resolve(root["Names"]) as? PdfValue.Dict
            val tree = resolve(names?.get("Dests")) as? PdfValue.Dict
            if (tree != null) findInNameTree(tree, name, 0, HashSet())?.let { return it }
            // PDF 1.1 style: a dictionary keyed by name.
            return (resolve(root["Dests"]) as? PdfValue.Dict)?.get(String(name, Charsets.ISO_8859_1))
        }

        private fun findInNameTree(node: PdfValue.Dict, name: ByteArray, depth: Int, visited: MutableSet<Int>): PdfValue? {
            if (depth > 32) return null
            (resolve(node["Names"]) as? PdfValue.Arr)?.items?.let { pairs ->
                var index = 0
                while (index + 1 < pairs.size) {
                    val key = resolve(pairs[index]) as? PdfValue.Str
                    if (key != null && key.bytes.contentEquals(name)) return pairs[index + 1]
                    index += 2
                }
            }
            for (kid in (resolve(node["Kids"]) as? PdfValue.Arr)?.items.orEmpty()) {
                if (kid is PdfValue.Ref && !visited.add(kid.num)) continue
                val child = resolve(kid) as? PdfValue.Dict ?: continue
                val limits = (resolve(child["Limits"]) as? PdfValue.Arr)?.items
                if (limits != null && limits.size == 2) {
                    val low = (resolve(limits[0]) as? PdfValue.Str)?.bytes
                    val high = (resolve(limits[1]) as? PdfValue.Str)?.bytes
                    if (low != null && high != null && (compareBytes(name, low) < 0 || compareBytes(name, high) > 0)) continue
                }
                findInNameTree(child, name, depth + 1, visited)?.let { return it }
            }
            return null
        }
    }

    /** Object number of every page, in order, to its 1-based page number. */
    private fun pageNumbers(root: PdfValue.Dict): Map<Int, Int> {
        val out = LinkedHashMap<Int, Int>()
        val visited = HashSet<Int>()
        fun walk(ref: PdfValue?, depth: Int) {
            if (depth > 64 || out.size > 100_000) return
            if (ref is PdfValue.Ref && !visited.add(ref.num)) return
            val node = resolve(ref) as? PdfValue.Dict ?: return
            val kids = resolve(node["Kids"]) as? PdfValue.Arr
            val type = (node["Type"] as? PdfValue.Name)?.value
            if (kids != null && type != "Page") {
                for (kid in kids.items) walk(kid, depth + 1)
            } else if (ref is PdfValue.Ref) {
                out[ref.num] = out.size + 1
            }
        }
        walk(root["Pages"], 0)
        return out
    }

    fun resolve(value: PdfValue?, depth: Int = 0): PdfValue? {
        if (value !is PdfValue.Ref) return value
        if (depth > 16) return null
        return resolve(objectAt(value.num), depth + 1)
    }

    private fun objectAt(num: Int): PdfValue? {
        cache[num]?.let { return it }
        val found = when (val entry = xref[num]) {
            is XrefEntry.Offset -> readIndirect(entry.offset, num)
            is XrefEntry.InStream -> objectStreams.getOrPut(entry.stream) { readObjectStream(entry.stream) }[num]
            null -> null
        } ?: if (!scanned) {
            scan()
            return objectAtAfterScan(num)
        } else {
            null
        }
        if (found != null) cache[num] = found
        return found
    }

    private fun objectAtAfterScan(num: Int): PdfValue? = when (val entry = xref[num]) {
        is XrefEntry.Offset -> readIndirect(entry.offset, num)
        is XrefEntry.InStream -> objectStreams.getOrPut(entry.stream) { readObjectStream(entry.stream) }[num]
        null -> null
    }?.also { cache[num] = it }

    /** The object at [offset]: `n g obj value [stream ... endstream] endobj`. */
    private fun readIndirect(offset: Int, expect: Int? = null): PdfValue? {
        if (offset < 0 || offset >= data.size) return null
        val lexer = PdfLexer(data, offset)
        val num = lexer.value() as? PdfValue.Num ?: return null
        if (expect != null && num.value.toInt() != expect) return null
        lexer.value() as? PdfValue.Num ?: return null
        lexer.skipWhite()
        if (lexer.keyword() != "obj") return null
        val value = lexer.value()
        lexer.skipWhite()
        val save = lexer.pos
        if (value is PdfValue.Dict && lexer.keyword() == "stream") {
            var start = lexer.pos
            if (start < data.size && data[start] == 13.toByte()) start += 1
            if (start < data.size && data[start] == 10.toByte()) start += 1
            val declared = (resolveLengthSafely(value["Length"]))
            val length = if (declared != null && declared >= 0 && start + declared <= data.size && endstreamNear(start + declared)) {
                declared
            } else {
                val stop = indexOf("endstream".toByteArray(Charsets.ISO_8859_1), start)
                if (stop < 0) return null
                var trimmed = stop
                if (trimmed > start && data[trimmed - 1] == 10.toByte()) trimmed -= 1
                if (trimmed > start && data[trimmed - 1] == 13.toByte()) trimmed -= 1
                trimmed - start
            }
            return PdfValue.Stream(value, start, length)
        }
        lexer.pos = save
        return value
    }

    private fun resolveLengthSafely(value: PdfValue?): Int? = when (value) {
        is PdfValue.Num -> value.value.toInt()
        is PdfValue.Ref -> {
            val entry = xref[value.num]
            if (entry is XrefEntry.Offset) (readIndirect(entry.offset, value.num) as? PdfValue.Num)?.value?.toInt() else null
        }
        else -> null
    }

    private fun endstreamNear(at: Int): Boolean {
        val lexer = PdfLexer(data, at)
        lexer.skipWhite()
        return lexer.keyword() == "endstream"
    }

    private fun indexOf(needle: ByteArray, from: Int): Int {
        var index = from.coerceAtLeast(0)
        outer@ while (index <= data.size - needle.size) {
            for (k in needle.indices) if (data[index + k] != needle[k]) {
                index += 1
                continue@outer
            }
            return index
        }
        return -1
    }

    private fun lastIndexOf(needle: ByteArray, before: Int): Int {
        var index = (before - needle.size).coerceAtMost(data.size - needle.size)
        outer@ while (index >= 0) {
            for (k in needle.indices) if (data[index + k] != needle[k]) {
                index -= 1
                continue@outer
            }
            return index
        }
        return -1
    }

    fun streamBytes(stream: PdfValue.Stream): ByteArray? {
        val raw = data.copyOfRange(stream.start, (stream.start + stream.length).coerceAtMost(data.size))
        val filter = resolve(stream.dict["Filter"])
        val filters = when (filter) {
            null -> emptyList()
            is PdfValue.Name -> listOf(filter.value)
            is PdfValue.Arr -> filter.items.mapNotNull { (resolve(it) as? PdfValue.Name)?.value }
            else -> return null
        }
        var bytes = raw
        val params = resolve(stream.dict["DecodeParms"]).let { if (it is PdfValue.Arr) resolve(it.items.firstOrNull()) else it } as? PdfValue.Dict
        for (name in filters) {
            bytes = when (name) {
                "FlateDecode", "Fl" -> unpredict(inflate(bytes) ?: return null, params) ?: return null
                else -> return null
            }
        }
        return bytes
    }

    private fun inflate(input: ByteArray): ByteArray? {
        val inflater = Inflater()
        return try {
            inflater.setInput(input)
            val out = java.io.ByteArrayOutputStream(input.size * 3)
            val buffer = ByteArray(64 * 1024)
            while (!inflater.finished()) {
                val count = inflater.inflate(buffer)
                if (count == 0) {
                    if (inflater.needsInput() || inflater.needsDictionary()) break
                }
                out.write(buffer, 0, count)
                if (out.size() > STREAM_LIMIT) return null
            }
            out.toByteArray()
        } catch (_: Exception) {
            null
        } finally {
            inflater.end()
        }
    }

    /** PNG predictors (10..15), as cross-reference streams use them. TIFF predictor 2 is not needed here. */
    private fun unpredict(bytes: ByteArray, params: PdfValue.Dict?): ByteArray? {
        val predictor = (params?.get("Predictor") as? PdfValue.Num)?.value?.toInt() ?: 1
        if (predictor < 10) return if (predictor == 1) bytes else null
        val colors = (params?.get("Colors") as? PdfValue.Num)?.value?.toInt() ?: 1
        val bits = (params?.get("BitsPerComponent") as? PdfValue.Num)?.value?.toInt() ?: 8
        val columns = (params?.get("Columns") as? PdfValue.Num)?.value?.toInt() ?: 1
        val pixel = ((colors * bits) + 7) / 8
        val row = (colors * bits * columns + 7) / 8
        if (row <= 0) return null
        val out = java.io.ByteArrayOutputStream(bytes.size)
        var previous = ByteArray(row)
        var index = 0
        while (index + 1 + row <= bytes.size) {
            val type = bytes[index].toInt() and 0xff
            val line = bytes.copyOfRange(index + 1, index + 1 + row)
            for (i in 0 until row) {
                val left = if (i >= pixel) line[i - pixel].toInt() and 0xff else 0
                val up = previous[i].toInt() and 0xff
                val upLeft = if (i >= pixel) previous[i - pixel].toInt() and 0xff else 0
                val raw = line[i].toInt() and 0xff
                val value = when (type) {
                    0 -> raw
                    1 -> raw + left
                    2 -> raw + up
                    3 -> raw + (left + up) / 2
                    4 -> {
                        val p = left + up - upLeft
                        val pa = kotlin.math.abs(p - left)
                        val pb = kotlin.math.abs(p - up)
                        val pc = kotlin.math.abs(p - upLeft)
                        raw + if (pa <= pb && pa <= pc) left else if (pb <= pc) up else upLeft
                    }
                    else -> raw
                }
                line[i] = value.toByte()
            }
            out.write(line)
            previous = line
            index += 1 + row
        }
        return out.toByteArray()
    }

    private fun readObjectStream(num: Int): Map<Int, PdfValue> {
        val entry = xref[num] as? XrefEntry.Offset ?: return emptyMap()
        val stream = readIndirect(entry.offset, num) as? PdfValue.Stream ?: return emptyMap()
        return parseObjectStream(stream)
    }

    private fun parseObjectStream(stream: PdfValue.Stream): Map<Int, PdfValue> {
        val bytes = streamBytes(stream) ?: return emptyMap()
        val count = (stream.dict["N"] as? PdfValue.Num)?.value?.toInt() ?: return emptyMap()
        val first = (stream.dict["First"] as? PdfValue.Num)?.value?.toInt() ?: return emptyMap()
        val header = PdfLexer(bytes, 0, first.coerceAtMost(bytes.size))
        val pairs = ArrayList<Pair<Int, Int>>()
        repeat(count.coerceAtMost(100_000)) {
            val objNum = (runCatching { header.value() }.getOrNull() as? PdfValue.Num)?.value?.toInt() ?: return@repeat
            val offset = (runCatching { header.value() }.getOrNull() as? PdfValue.Num)?.value?.toInt() ?: return@repeat
            pairs += objNum to offset
        }
        val out = HashMap<Int, PdfValue>()
        for ((objNum, offset) in pairs) {
            val at = first + offset
            if (at < 0 || at >= bytes.size) continue
            runCatching { PdfLexer(bytes, at).value() }.getOrNull()?.let { out[objNum] = it }
        }
        return out
    }

    private fun readXrefChain() {
        val marker = "startxref".toByteArray(Charsets.ISO_8859_1)
        val at = lastIndexOf(marker, data.size)
        if (at < 0) return
        val lexer = PdfLexer(data, at + marker.size)
        var offset = (lexer.value() as? PdfValue.Num)?.value?.toInt() ?: return
        val seen = HashSet<Int>()
        while (offset > 0 && offset < data.size && seen.add(offset) && seen.size < 64) {
            val next = readXrefSection(offset) ?: break
            if (trailer == null) trailer = next
            val prev = (next["Prev"] as? PdfValue.Num)?.value?.toInt()
            // Hybrid files keep the newer objects in an /XRefStm next to the table.
            (next["XRefStm"] as? PdfValue.Num)?.value?.toInt()?.let { stm -> if (seen.add(stm)) readXrefSection(stm) }
            offset = prev ?: break
        }
    }

    /** One table or stream section; entries already known (newer) win. Returns its trailer dictionary. */
    private fun readXrefSection(offset: Int): PdfValue.Dict? {
        val lexer = PdfLexer(data, offset)
        lexer.skipWhite()
        val save = lexer.pos
        if (lexer.keyword() == "xref") {
            while (true) {
                lexer.skipWhite()
                val mark = lexer.pos
                if (lexer.keyword() == "trailer") return lexer.value() as? PdfValue.Dict
                lexer.pos = mark
                val start = (lexer.value() as? PdfValue.Num)?.value?.toInt() ?: return null
                val count = (lexer.value() as? PdfValue.Num)?.value?.toInt() ?: return null
                for (k in 0 until count) {
                    val entryOffset = (lexer.value() as? PdfValue.Num)?.value?.toInt() ?: return null
                    lexer.value()
                    lexer.skipWhite()
                    val kind = lexer.keyword()
                    if (kind == "n" && !xref.containsKey(start + k)) xref[start + k] = XrefEntry.Offset(entryOffset)
                }
            }
        }
        lexer.pos = save
        val stream = readIndirect(offset) as? PdfValue.Stream ?: return null
        if ((stream.dict["Type"] as? PdfValue.Name)?.value != "XRef") return null
        val bytes = streamBytes(stream) ?: return null
        val widths = (stream.dict["W"] as? PdfValue.Arr)?.items?.map { (it as? PdfValue.Num)?.value?.toInt() ?: 0 } ?: return null
        if (widths.size < 3) return null
        val size = (stream.dict["Size"] as? PdfValue.Num)?.value?.toInt() ?: 0
        val index = (stream.dict["Index"] as? PdfValue.Arr)?.items?.map { (it as? PdfValue.Num)?.value?.toInt() ?: 0 } ?: listOf(0, size)
        val rowWidth = widths.sum()
        var cursor = 0
        fun field(width: Int, default: Int): Int {
            if (width == 0) return default
            var value = 0
            repeat(width) {
                value = (value shl 8) or (bytes[cursor].toInt() and 0xff)
                cursor += 1
            }
            return value
        }
        var pair = 0
        while (pair + 1 < index.size) {
            val start = index[pair]
            val count = index[pair + 1]
            for (k in 0 until count) {
                if (cursor + rowWidth > bytes.size) return stream.dict
                val type = field(widths[0], 1)
                val second = field(widths[1], 0)
                val third = field(widths[2], 0)
                val num = start + k
                if (xref.containsKey(num)) continue
                when (type) {
                    1 -> xref[num] = XrefEntry.Offset(second)
                    2 -> xref[num] = XrefEntry.InStream(second, third)
                }
            }
            pair += 2
        }
        return stream.dict
    }

    /** Rebuilds the table from `n g obj` headers when the cross-reference data is unusable. */
    private fun scan() {
        if (scanned) return
        scanned = true
        val marker = "obj".toByteArray(Charsets.ISO_8859_1)
        var at = indexOf(marker, 0)
        val found = HashMap<Int, Int>()
        while (at >= 0) {
            // Walk back over "<num> <gen> ".
            var cursor = at - 1
            while (cursor >= 0 && (data[cursor] == 32.toByte() || data[cursor] == 13.toByte() || data[cursor] == 10.toByte())) cursor -= 1
            val genEnd = cursor + 1
            while (cursor >= 0 && data[cursor] in '0'.code.toByte()..'9'.code.toByte()) cursor -= 1
            val genStart = cursor + 1
            while (cursor >= 0 && (data[cursor] == 32.toByte() || data[cursor] == 13.toByte() || data[cursor] == 10.toByte())) cursor -= 1
            val numEnd = cursor + 1
            while (cursor >= 0 && data[cursor] in '0'.code.toByte()..'9'.code.toByte()) cursor -= 1
            val numStart = cursor + 1
            val after = if (at + 3 < data.size) data[at + 3].toInt() else 32
            if (genEnd > genStart && numEnd > numStart && genStart > numEnd && !Character.isLetterOrDigit(after)) {
                String(data, numStart, numEnd - numStart, Charsets.ISO_8859_1).toIntOrNull()?.let { found[it] = numStart }
            }
            at = indexOf(marker, at + 3)
        }
        // Headers found in the file beat a table that pointed elsewhere; the last definition is the newest.
        for ((num, offset) in found) xref[num] = XrefEntry.Offset(offset)
        // Objects inside object streams, and the catalog when no trailer was read.
        for ((num, offset) in found) {
            val value = runCatching { readIndirect(offset, num) }.getOrNull() ?: continue
            if (value is PdfValue.Stream && (value.dict["Type"] as? PdfValue.Name)?.value == "ObjStm") {
                val inner = parseObjectStream(value)
                objectStreams[num] = inner
                for (innerNum in inner.keys) if (!xref.containsKey(innerNum)) xref[innerNum] = XrefEntry.InStream(num, 0)
            }
            if (trailer?.get("Root") == null) {
                val dict = (value as? PdfValue.Dict) ?: (value as? PdfValue.Stream)?.dict
                if (dict != null && (dict["Type"] as? PdfValue.Name)?.value == "XRef" && dict["Root"] != null) trailer = dict
            }
        }
        if (trailer?.get("Root") == null) {
            val trailerAt = lastIndexOf("trailer".toByteArray(Charsets.ISO_8859_1), data.size)
            val fromTrailer = if (trailerAt >= 0) runCatching { PdfLexer(data, trailerAt + 7).value() as? PdfValue.Dict }.getOrNull() else null
            trailer = fromTrailer?.takeIf { it["Root"] != null } ?: findCatalog(found)
        }
        cache.clear()
    }

    private fun findCatalog(found: Map<Int, Int>): PdfValue.Dict? {
        for (num in found.keys.sorted()) {
            val value = xref[num]?.let { objectAtAfterScan(num) } as? PdfValue.Dict ?: continue
            if ((value["Type"] as? PdfValue.Name)?.value == "Catalog") return PdfValue.Dict(mapOf("Root" to PdfValue.Ref(num, 0)))
        }
        for (inner in objectStreams.values) {
            for ((num, value) in inner) {
                if (value is PdfValue.Dict && (value["Type"] as? PdfValue.Name)?.value == "Catalog") {
                    return PdfValue.Dict(mapOf("Root" to PdfValue.Ref(num, 0)))
                }
            }
        }
        return null
    }
}

private fun compareBytes(left: ByteArray, right: ByteArray): Int {
    for (index in 0 until minOf(left.size, right.size)) {
        val diff = (left[index].toInt() and 0xff) - (right[index].toInt() and 0xff)
        if (diff != 0) return diff
    }
    return left.size - right.size
}

/** PDFDocEncoding differs from Latin-1 in 0x18..0x1F and 0x80..0xA0. */
private val PDF_DOC_HIGH = charArrayOf(
    '•', '†', '‡', '…', '—', '–', 'ƒ', '⁄',
    '‹', '›', '−', '‰', '„', '“', '”', '‘',
    '’', '‚', '™', 'ﬁ', 'ﬂ', 'Ł', 'Œ', 'Š',
    'Ÿ', 'Ž', 'ı', 'ł', 'œ', 'š', 'ž', '�',
    '€',
)

/** A PDF text string: UTF-16BE or UTF-8 with a byte-order mark, else PDFDocEncoding. */
internal fun pdfTextString(bytes: ByteArray): String {
    if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
        return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE).replace("\u0000", "")
    }
    if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
        return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE).replace("\u0000", "")
    }
    if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
        return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
    }
    return buildString(bytes.size) {
        for (byte in bytes) {
            val code = byte.toInt() and 0xff
            when {
                code in 0x80..0xA0 -> append(PDF_DOC_HIGH[code - 0x80])
                code < 0x20 && code != 9 && code != 10 && code != 13 -> append(' ')
                else -> append(code.toChar())
            }
        }
    }
}
