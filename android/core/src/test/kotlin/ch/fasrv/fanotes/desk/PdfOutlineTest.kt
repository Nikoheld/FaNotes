package ch.fasrv.fanotes.desk

import java.io.ByteArrayOutputStream
import java.util.zip.Deflater
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PdfOutlineTest {
    private fun latin(text: String) = text.toByteArray(Charsets.ISO_8859_1)

    /** A classic PDF: objects, an xref table with real offsets and a trailer. */
    private fun classicPdf(objects: Map<Int, String>, root: Int = 1, brokenXref: Boolean = false): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(latin("%PDF-1.4\n%âãÏÓ\n"))
        val offsets = HashMap<Int, Int>()
        for ((num, body) in objects.toSortedMap()) {
            offsets[num] = out.size()
            out.write(latin("$num 0 obj\n$body\nendobj\n"))
        }
        val xrefAt = out.size()
        val size = (objects.keys.maxOrNull() ?: 0) + 1
        out.write(latin("xref\n0 $size\n0000000000 65535 f \n"))
        for (num in 1 until size) {
            val offset = if (brokenXref) 7 else offsets[num] ?: 0
            out.write(latin("%010d 00000 %s \n".format(offset, if (offsets.containsKey(num)) "n" else "f")))
        }
        out.write(latin("trailer\n<< /Size $size /Root $root 0 R >>\nstartxref\n$xrefAt\n%%EOF\n"))
        return out.toByteArray()
    }

    private fun utf16(text: String): String {
        val bytes = byteArrayOf(0xFE.toByte(), 0xFF.toByte()) + text.toByteArray(Charsets.UTF_16BE)
        return "<" + bytes.joinToString("") { "%02X".format(it.toInt() and 0xff) } + ">"
    }

    private fun bookObjects(): Map<Int, String> = mapOf(
        1 to "<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R /Names << /Dests 20 0 R >> /Dests 21 0 R >>",
        2 to "<< /Type /Pages /Kids [3 0 R 30 0 R] /Count 3 >>",
        3 to "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
        30 to "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 >>",
        4 to "<< /Type /Page /Parent 30 0 R /MediaBox [0 0 595 842] >>",
        5 to "<< /Type /Page /Parent 30 0 R /MediaBox [0 0 595 842] >>",
        10 to "<< /Type /Outlines /First 11 0 R /Last 13 0 R /Count 3 >>",
        11 to "<< /Title (Kapitel 1 \\(Einf\\374hrung\\)) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 842 0] >>",
        12 to "<< /Title ${utf16("Zellbiologie – Übersicht")} /Parent 10 0 R /Prev 11 0 R /Next 13 0 R /First 14 0 R /Last 15 0 R /A << /S /GoTo /D [4 0 R /Fit] >> >>",
        14 to "<< /Title (Named) /Parent 12 0 R /Next 15 0 R /Dest (kap2b) >>",
        15 to "<< /Title (Alt) /Parent 12 0 R /Prev 14 0 R /Dest /alt >>",
        13 to "<< /Title () /Parent 10 0 R /Prev 12 0 R /A << /S /URI /URI (https://example.org) >> >>",
        20 to "<< /Kids [22 0 R] >>",
        22 to "<< /Limits [(kap1) (kap9)] /Names [(kap1) [3 0 R /Fit] (kap2b) << /D [5 0 R /Fit] >>] >>",
        21 to "<< /alt [4 0 R /Fit] >>",
    )

    private val expected = listOf(
        PdfOutlineItem("Kapitel 1 (Einführung)", 1),
        PdfOutlineItem(
            "Zellbiologie – Übersicht",
            2,
            listOf(PdfOutlineItem("Named", 3), PdfOutlineItem("Alt", 2)),
        ),
        PdfOutlineItem("Abschnitt", null),
    )

    @Test
    fun aClassicFileGivesTitlesPagesAndNesting() {
        assertEquals(expected, readPdfOutline(classicPdf(bookObjects())))
        val flat = flattenPdfOutline(expected)
        assertEquals(listOf(0, 0, 1, 1, 0), flat.map { it.first })
    }

    @Test
    fun aBrokenCrossReferenceFallsBackToAScan() {
        assertEquals(expected, readPdfOutline(classicPdf(bookObjects(), brokenXref = true)))
    }

    @Test
    fun objectStreamsAndAPredictedXrefStreamAreRead() {
        val objects = bookObjects()
        val packed = objects.keys.filter { it != 1 }.sorted()
        // Object stream 40 holds everything but the catalog.
        val header = StringBuilder()
        val body = StringBuilder()
        for (num in packed) {
            header.append("$num ${body.length} ")
            body.append(objects.getValue(num)).append('\n')
        }
        val streamData = latin(header.toString() + body)
        val first = header.length
        val compressed = deflate(streamData)
        val out = ByteArrayOutputStream()
        out.write(latin("%PDF-1.5\n"))
        val catalogAt = out.size()
        out.write(latin("1 0 obj\n${objects.getValue(1)}\nendobj\n"))
        val objStmAt = out.size()
        out.write(latin("40 0 obj\n<< /Type /ObjStm /N ${packed.size} /First $first /Filter /FlateDecode /Length ${compressed.size} >>\nstream\n"))
        out.write(compressed)
        out.write(latin("\nendstream\nendobj\n"))
        val xrefAt = out.size()
        val size = 42
        // Rows of W [1 4 2], PNG Up predictor (12) with 7 columns.
        val rows = ArrayList<ByteArray>()
        for (num in 0 until size) {
            rows += when {
                num == 1 -> row(1, catalogAt, 0)
                num == 40 -> row(1, objStmAt, 0)
                num == 41 -> row(1, xrefAt, 0)
                num in packed -> row(2, 40, packed.indexOf(num))
                else -> row(0, 0, 0)
            }
        }
        val predicted = ByteArrayOutputStream()
        var previous = ByteArray(7)
        for (line in rows) {
            predicted.write(2)
            predicted.write(ByteArray(7) { ((line[it] - previous[it]) and 0xff).toByte() })
            previous = line
        }
        val xrefData = deflate(predicted.toByteArray())
        out.write(latin("41 0 obj\n<< /Type /XRef /Size $size /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Columns 7 /Predictor 12 >> /Length ${xrefData.size} >>\nstream\n"))
        out.write(xrefData)
        out.write(latin("\nendstream\nendobj\nstartxref\n$xrefAt\n%%EOF\n"))
        assertEquals(expected, readPdfOutline(out.toByteArray()))
    }

    @Test
    fun noOutlineEncryptionAndGarbageGiveNothing() {
        val plain = bookObjects().toMutableMap().apply { put(1, "<< /Type /Catalog /Pages 2 0 R >>") }
        assertEquals(emptyList(), readPdfOutline(classicPdf(plain)))
        assertEquals(emptyList(), readPdfOutline(latin("not a pdf at all")))
        assertEquals(emptyList(), readPdfOutline(ByteArray(0)))
        val encrypted = String(classicPdf(bookObjects()), Charsets.ISO_8859_1).replace("/Root 1 0 R >>", "/Root 1 0 R /Encrypt 99 0 R >>")
        assertEquals(emptyList(), readPdfOutline(latin(encrypted)))
    }

    @Test
    fun aCycleInTheOutlineStops() {
        val looped = bookObjects().toMutableMap().apply {
            put(13, "<< /Title (Loop) /Parent 10 0 R /Next 11 0 R /Dest [5 0 R /Fit] >>")
        }
        val outline = readPdfOutline(classicPdf(looped))
        assertEquals(listOf("Kapitel 1 (Einführung)", "Zellbiologie – Übersicht", "Loop"), outline.map { it.title })
        assertTrue(outline.size < 10)
    }

    private fun row(type: Int, second: Int, third: Int) = byteArrayOf(
        type.toByte(),
        (second ushr 24).toByte(), (second ushr 16).toByte(), (second ushr 8).toByte(), second.toByte(),
        (third ushr 8).toByte(), third.toByte(),
    )

    private fun deflate(input: ByteArray): ByteArray {
        val deflater = Deflater()
        deflater.setInput(input)
        deflater.finish()
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (!deflater.finished()) out.write(buffer, 0, deflater.deflate(buffer))
        deflater.end()
        return out.toByteArray()
    }
}
