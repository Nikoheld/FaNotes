package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Measures what decoding a handwriting file costs, so [defaultNoteReadLimit] rests on a number.
 *
 * Measured (JVM, synthetic pen strokes, 1.x GB heap), peak heap above the baseline while [NoteStore.readNote] runs,
 * divided by the file size: the v1 JSON sidecar 17-19x (2 and 8 MB files), the compact v2 sidecar about 31x (it is small
 * on disk and unpacks to the same points). The retained [ch.fasrv.fanotes.ink.InkDocument] alone is 12x (v1) to 20x (v2).
 * [NOTE_DECODE_EXPANSION] is therefore 40, rounded up for noise. The measurement is printed by [measureExpansion] (run with
 * `-Dfanotes.measure=1`); the ordinary run only checks that the factor stays below the constant.
 */
class NoteReadMemoryTest {
    private fun syntheticPayload(targetChars: Int): JsonValue.Obj {
        val strokes = JsonValue.Arr()
        var chars = 0
        var seed = 7L
        var n = 0
        while (chars < targetChars) {
            val points = JsonValue.Arr()
            var x = 0.1 + (n % 7) * 0.1
            var y = 0.05 + (n % 40) * 0.02
            for (i in 0 until 60) {
                seed = seed * 6364136223846793005L + 1442695040888963407L
                x += ((seed shr 33) % 100) / 100000.0
                y += ((seed shr 40) % 100) / 100000.0
                points.items.add(JsonValue.Obj().also {
                    it.put("x", jsonNumber(x)); it.put("y", jsonNumber(y)); it.put("t", jsonNumber(1000.0 + n * 100 + i * 8))
                    it.put("pressure", jsonNumber(0.5 + (i % 5) / 20.0)); it.put("tiltX", jsonNumber(0.0)); it.put("tiltY", jsonNumber(0.0))
                    it.put("pointerType", jsonString("stylus"))
                })
            }
            val stroke = JsonValue.Obj()
            stroke.put("color", jsonString("#3478df")); stroke.put("baseWidth", jsonNumber(2.0)); stroke.put("brush", jsonString("fineliner"))
            stroke.put("points", points)
            strokes.items.add(stroke)
            chars += 60 * 120
            n++
        }
        val ink = JsonValue.Obj()
        ink.put("schemaVersion", jsonNumber(1.0)); ink.put("strokes", strokes)
        return emptyFamdPayload("2026-01-02T03:04:05.000Z").also { it.put("ink", ink) }
    }

    private fun used(): Long { System.gc(); System.gc(); val r = Runtime.getRuntime(); return r.totalMemory() - r.freeMemory() }

    private fun measureExpansion(encoding: String, targetBytes: Int): Pair<Long, Double> {
        val dir = Files.createTempDirectory("famd-mem")
        try {
            val vault = DirectoryVault(dir)
            val text = serializeFamd("# Synthetic", syntheticPayload(targetBytes), encoding)
            val bytes = text.encodeToByteArray()
            vault.write("Big.famd", bytes)
            val store = NoteStore(vault, noteReadLimit = { Long.MAX_VALUE })
            val before = used()
            var peak = 0L
            val sampler = Thread {
                while (!Thread.currentThread().isInterrupted) {
                    val r = Runtime.getRuntime(); peak = maxOf(peak, r.totalMemory() - r.freeMemory())
                    try { Thread.sleep(2) } catch (_: InterruptedException) { break }
                }
            }.also { it.isDaemon = true; it.start() }
            val note = store.readNote("Big.famd")
            sampler.interrupt(); sampler.join()
            val retained = used() - before
            assertTrue(note.document.strokes.isNotEmpty())
            if (System.getProperty("fanotes.measure") != null || System.getenv("FANOTES_MEASURE") != null) {
                println("MEASURE $encoding file=${bytes.size} peakFactor=${"%.1f".format((peak - before).toDouble() / bytes.size)} retainedFactor=${"%.1f".format(retained.toDouble() / bytes.size)}")
            }
            return bytes.size.toLong() to (peak - before).toDouble() / bytes.size
        } finally { dir.toFile().deleteRecursively() }
    }

    @Test
    fun decodeStaysBelowTheExpansionConstant() {
        // Larger files hit the parser's 1,000,000 node limit first and come back as too large without a full decode.
        for ((encoding, sizes) in listOf("v1" to listOf(2, 8), "v2" to listOf(2))) for (mb in sizes) {
            val (size, factor) = measureExpansion(encoding, mb * 1024 * 1024 * (if (encoding == "v2") 5 else 2) / 2)
            assertTrue(size > mb * 1024 * 1024 / 3, "file too small")
            assertTrue(factor < NOTE_DECODE_EXPANSION, "$encoding ${mb}MB expands ${factor}x")
        }
    }

    @Test
    fun readLimitIsAThirdOfTheFreeHeapOverTheExpansion() {
        val gib = 1024L * 1024 * 1024
        assertEquals(1024L * 1024, noteReadLimitFor(0))
        assertEquals(1024L * 1024, noteReadLimitFor(10L * 1024 * 1024))
        assertEquals(gib / (NOTE_DECODE_EXPANSION * 3), noteReadLimitFor(gib))
        // 512 MB free: about 7 MB, so a 65 MB or 16 MB note is refused instead of crashing.
        assertTrue(noteReadLimitFor(512L * 1024 * 1024) < 16L * 1024 * 1024)
    }
}
