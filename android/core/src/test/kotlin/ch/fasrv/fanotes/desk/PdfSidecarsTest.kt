package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The desktop's PDF text files as the tablet and Kanti+ read them. */
class PdfSidecarsTest {
    @Test
    fun theSidecarsAreNamedAfterThePdfPath() {
        assertEquals(".fanotes/pdf-ocr/1ba2c32d2214394416152a16830f6af5.json", desktopPdfOcrSidecar("Physik/Skript Wellen.pdf"))
        assertEquals(".fanotes/page-text/1ba2c32d2214394416152a16830f6af5.json", desktopPageTextSidecar("Physik/Skript Wellen.pdf"))
    }

    @Test
    fun theStampMatchesTheDesktopFunction() {
        val expected = mapOf(0 to "4b95f515", 1 to "184bc83a", 7 to "ddf7f6f1", 4095 to "6c04f744", 4096 to "af8811f1", 10000 to "54cb2ee2", 200003 to "16624a4c")
        for ((length, stamp) in expected) {
            val bytes = ByteArray(length) { ((it * 131 + 17) and 0xff).toByte() }
            assertEquals(stamp, pdfByteStamp(bytes), "stamp for $length bytes")
        }
    }

    @Test
    fun theOcrTranscriptIsReusedOnlyForTheSameFile() {
        val raw = """{"format":"fanotes-pdf-ocr-v1","path":"A.pdf","size":120,"mtimeMs":5,"stamp":"0a0b0c0d","pages":[{"page":2,"text":"Gescannte Seite über Zellatmung"}]}"""
        assertEquals("Gescannte Seite über Zellatmung", desktopPdfOcrPages(raw, "A.pdf", 120, "0a0b0c0d")[2])
        assertTrue(desktopPdfOcrPages(raw, "B.pdf", 120, "0a0b0c0d").isEmpty(), "another file")
        assertTrue(desktopPdfOcrPages(raw, "A.pdf", 121, "0a0b0c0d").isEmpty(), "edited file")
        assertTrue(desktopPdfOcrPages(raw, "A.pdf", 120, "ffffffff").isEmpty(), "changed content")
        assertTrue(desktopPdfOcrPages(raw.replace("v1", "v9"), "A.pdf", 120, "0a0b0c0d").isEmpty(), "wrong format")
        assertTrue(desktopPdfOcrPages(raw.replace("\"page\":2", "\"page\":2001"), "A.pdf", 120, "0a0b0c0d").isEmpty(), "over the desktop page limit")
        assertTrue(desktopPdfOcrPages(null, "A.pdf", 120, "0a0b0c0d").isEmpty())
        assertTrue(desktopPdfOcrPages("{broken", "A.pdf", 120, "0a0b0c0d").isEmpty())
    }

    // -- fanotes-page-text-v1 -----------------------------------------------------------------

    private val record = """
        {
          "format": "fanotes-page-text-v1",
          "path": "Biologie/Scan Blatt 3.pdf",
          "size": 130349,
          "stamp": "1f0c9a2e",
          "pageCount": 4,
          "producer": "fanotes-electron/2026.11.2 doc-search/1",
          "ocrEngine": "fanotes-trocr-v1",
          "createdAt": "2026-11-09T07:12:00.000Z",
          "unknownField": {"ignored": true},
          "pages": [
            { "page": 1, "source": "ocr", "status": "ok", "text": "Arbeitsblatt Fotosynthese\nAuftrag 1: Pflanzen brauchen Licht", "confidence": 0.95, "rotation": 90 },
            { "page": 2, "source": "ocr", "status": "empty", "text": "", "reason": "no letters" },
            { "page": 3, "source": "text-layer", "status": "ok", "text": "Seite drei" },
            { "page": 4, "source": "ocr", "status": "failed", "text": "kaputt" }
          ]
        }
    """.trimIndent()

    private fun pageText(raw: String?, path: String = "Biologie/Scan Blatt 3.pdf", size: Long = 130349, stamp: String = "1f0c9a2e") =
        desktopPageTextPages(raw, path, size, stamp)

    @Test
    fun thePageTextRecordGivesTheOkPagesOfTheMatchingPdf() {
        val pages = pageText(record)
        assertEquals(setOf(1, 3), pages.keys, "empty and failed pages are left out")
        assertEquals("Arbeitsblatt Fotosynthese\nAuftrag 1: Pflanzen brauchen Licht", pages[1])
        assertEquals("Seite drei", pages[3])
    }

    @Test
    fun thePageTextRecordIsIgnoredForAnotherOrChangedPdf() {
        assertTrue(pageText(record, path = "Biologie/Anderes.pdf").isEmpty(), "another path")
        assertTrue(pageText(record, size = 130350).isEmpty(), "another size")
        assertTrue(pageText(record, stamp = "00000000").isEmpty(), "another stamp")
        assertTrue(pageText(null).isEmpty())
        assertTrue(pageText("").isEmpty())
        assertTrue(pageText("not json").isEmpty())
        assertTrue(pageText("[]").isEmpty())
    }

    @Test
    fun aPageTextRecordWithAnyInvalidFieldIsIgnoredAsAWhole() {
        val invalid = mapOf(
            "wrong format" to record.replace("fanotes-page-text-v1", "fanotes-page-text-v2"),
            "missing producer" to record.replace("\"producer\": \"fanotes-electron/2026.11.2 doc-search/1\",", ""),
            "missing createdAt" to record.replace("\"createdAt\": \"2026-11-09T07:12:00.000Z\",", ""),
            "page beyond pageCount" to record.replace("\"pageCount\": 4", "\"pageCount\": 3"),
            "duplicate page" to record.replace("\"page\": 3,", "\"page\": 1,"),
            "pages not ascending" to record.replace("\"page\": 2,", "\"page\": 9,").replace("\"pageCount\": 4", "\"pageCount\": 9"),
            "unknown source" to record.replace("\"source\": \"text-layer\"", "\"source\": \"magic\""),
            "unknown status" to record.replace("\"status\": \"failed\"", "\"status\": \"lost\""),
            "text not a string" to record.replace("\"text\": \"Seite drei\"", "\"text\": 3"),
            "text over the limit" to record.replace("\"text\": \"Seite drei\"", "\"text\": \"${"x".repeat(6001)}\""),
            "confidence above one" to record.replace("\"confidence\": 0.95", "\"confidence\": 1.5"),
            "rotation not a quarter turn" to record.replace("\"rotation\": 90", "\"rotation\": 45"),
            "reason over the limit" to record.replace("\"reason\": \"no letters\"", "\"reason\": \"${"r".repeat(121)}\""),
            "ocrEngine not a string" to record.replace("\"ocrEngine\": \"fanotes-trocr-v1\"", "\"ocrEngine\": 4"),
            "pageCount not a number" to record.replace("\"pageCount\": 4", "\"pageCount\": \"4\""),
        )
        for ((reason, raw) in invalid) {
            assertTrue(raw != record, "the test edit for \"$reason\" changed the record")
            assertTrue(pageText(raw).isEmpty(), reason)
        }
        assertEquals(2, pageText(record).size, "the unedited record is valid")
    }

    @Test
    fun thePageTextRecordHonoursItsSizeLimits() {
        val tooManyPages = buildString {
            append("""{"format":"fanotes-page-text-v1","path":"A.pdf","size":10,"stamp":"0a0b0c0d","pageCount":3000,"producer":"x","createdAt":"2026-11-09T07:12:00.000Z","pages":[""")
            append((1..2001).joinToString(",") { """{"page":$it,"source":"ocr","status":"ok","text":"t"}""" })
            append("]}")
        }
        assertTrue(desktopPageTextPages(tooManyPages, "A.pdf", 10, "0a0b0c0d").isEmpty(), "more than 2000 pages")
        val twoThousand = tooManyPages.replace(""",{"page":2001,"source":"ocr","status":"ok","text":"t"}""", "")
        assertEquals(2000, desktopPageTextPages(twoThousand, "A.pdf", 10, "0a0b0c0d").size)
        assertTrue(desktopPageTextPages(twoThousand + " ".repeat(4 * 1024 * 1024), "A.pdf", 10, "0a0b0c0d").isEmpty(), "file over 4 MiB")
    }

    @Test
    fun theSyncedTextPrefersThePageTextRecordAndFillsTheRestFromTheOcrTranscript() {
        val pageText = mapOf(1 to "page text 1", 3 to "page text 3")
        val ocr = mapOf(1 to "ocr 1", 2 to "ocr 2")
        assertEquals(mapOf(1 to "page text 1", 2 to "ocr 2", 3 to "page text 3"), syncedPdfPages(pageText, ocr))
        assertEquals(pageText, syncedPdfPages(pageText, emptyMap()))
        assertEquals(ocr, syncedPdfPages(emptyMap(), ocr))
        assertTrue(syncedPdfPages(emptyMap(), emptyMap()).isEmpty())
    }
}
