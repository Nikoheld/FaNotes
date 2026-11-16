package ch.fasrv.fanotes.study

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Which PDF text API a device has, and where the text comes from when it has none. */
class PdfTextSourceTest {
    // -- gating -----------------------------------------------------------------------------

    @Test
    fun android15AndNewerAlwaysHaveThePlatformApi() {
        assertEquals(PdfTextApi.PLATFORM, pdfTextApi(35, 0))
        assertEquals(PdfTextApi.PLATFORM, pdfTextApi(35, 13))
        assertEquals(PdfTextApi.PLATFORM, pdfTextApi(36, 0))
        assertEquals(PdfTextApi.PLATFORM, pdfTextApi(37, 99))
    }

    @Test
    fun android12To14NeedExtension13ForThePreVApi() {
        for (sdk in 31..34) {
            assertEquals(PdfTextApi.PRE_V, pdfTextApi(sdk, 13), "API $sdk with extension 13")
            assertEquals(PdfTextApi.PRE_V, pdfTextApi(sdk, 14), "API $sdk with a newer extension")
            assertEquals(PdfTextApi.NONE, pdfTextApi(sdk, 12), "API $sdk with extension 12")
            assertEquals(PdfTextApi.NONE, pdfTextApi(sdk, 0), "API $sdk without extensions")
        }
    }

    @Test
    fun android11AndOlderHaveNoPdfTextApiEvenWithAHighExtensionNumber() {
        // framework-pdf is not part of the R extension chain, so the tablet falls back to the synced text.
        assertEquals(PdfTextApi.NONE, pdfTextApi(30, 13))
        assertEquals(PdfTextApi.NONE, pdfTextApi(30, 0))
        assertEquals(PdfTextApi.NONE, pdfTextApi(29, 13))
    }

    @Test
    fun theScanCanRunWhenTheDeviceOrTheDesktopSuppliesText() {
        assertTrue(taskDetectionPossible(PdfTextApi.PLATFORM, syncedFilesExist = false))
        assertTrue(taskDetectionPossible(PdfTextApi.PRE_V, syncedFilesExist = false))
        assertTrue(taskDetectionPossible(PdfTextApi.NONE, syncedFilesExist = true))
        assertFalse(taskDetectionPossible(PdfTextApi.NONE, syncedFilesExist = false))
    }

    // -- fallback ---------------------------------------------------------------------------

    private val worksheet = listOf(
        "Arbeitsblatt Zellatmung",
        "Auftrag 1 (10 Min.): Lies den Text zur Glykolyse.",
        "Auftrag 2: Zeichne den Ablauf der Atmungskette.",
    )

    private fun detected(snapshot: PdfTextSnapshot) = detectTasks(taskScanPages(snapshot)).map { it.id to it.page }

    @Test
    fun theDeviceTextLayerIsUsedWhenItHasText() {
        val snapshot = PdfTextSnapshot(PdfTextApi.PLATFORM, listOf(worksheet), mapOf(1 to "Auftrag 9: aus dem Computer"))
        assertEquals(listOf("auftrag-1" to 1, "auftrag-2" to 1), detected(snapshot))
        assertEquals(PdfTextProblem.NONE, pdfTextProblem(snapshot))
    }

    @Test
    fun aDeviceWithoutTheApiDetectsFromTheSyncedDesktopText() {
        val synced = mapOf(1 to worksheet.joinToString("\n"), 3 to "Seite drei\r\nAufgabe 3: Beschrifte die Abbildung.")
        val snapshot = PdfTextSnapshot(PdfTextApi.NONE, null, synced)
        assertEquals(listOf("auftrag-1" to 1, "auftrag-2" to 1, "auftrag-3" to 3), detected(snapshot))
        assertEquals(PdfTextProblem.NONE, pdfTextProblem(snapshot))
        assertEquals(3, taskScanPages(snapshot).size, "pages up to the last synced one, the gap stays empty")
        assertEquals(emptyList(), taskScanPages(snapshot)[1].lines)
    }

    @Test
    fun aScannedPageTakesTheDesktopTranscriptWhileTextPagesKeepTheirOwnLayer() {
        val layer = listOf(worksheet, emptyList(), listOf("Nur ein Wort"))
        val synced = mapOf(2 to "Auftrag 3: Lies die Quelle.\nAuftrag 4: Fasse sie zusammen.", 3 to "Auftrag 8: dies ist die längere Fassung des Computers")
        val pages = taskScanPages(PdfTextSnapshot(PdfTextApi.PRE_V, layer, synced))
        assertEquals(worksheet, pages[0].lines)
        assertEquals(listOf("Auftrag 3: Lies die Quelle.", "Auftrag 4: Fasse sie zusammen."), pages[1].lines)
        assertEquals(listOf("Auftrag 8: dies ist die längere Fassung des Computers"), pages[2].lines, "a near-empty layer loses to longer synced text")
    }

    @Test
    fun aPageWithEnoughLayerTextIsNotReplacedByTheSyncedCopy() {
        val layer = listOf(listOf("Auftrag 1: Lies den Text zur Glykolyse."))
        val pages = taskScanPages(PdfTextSnapshot(PdfTextApi.PLATFORM, layer, mapOf(1 to "Auftrag 1: Lies den Text zur Glykolyse und mache dir Notizen dazu.")))
        assertEquals(layer[0], pages[0].lines)
    }

    @Test
    fun searchGetsOneStringPerPageFromTheSameSources() {
        val layer = listOf(listOf("Die Zellatmung", "findet im Mitochondrium statt."), emptyList())
        val snapshot = PdfTextSnapshot(PdfTextApi.PRE_V, layer, mapOf(2 to "Gescannte Seite über Photosynthese"))
        assertEquals(
            listOf("Die Zellatmung findet im Mitochondrium statt.", "Gescannte Seite über Photosynthese"),
            searchPageTexts(snapshot, maxPages = 40),
        )
        assertEquals(1, searchPageTexts(snapshot, maxPages = 1).size)
    }

    @Test
    fun theScanIsCappedAtTheMaximumPageCount() {
        val synced = (1..200).associateWith { "Auftrag $it: Seite $it" }
        val pages = taskScanPages(PdfTextSnapshot(PdfTextApi.NONE, null, synced))
        assertEquals(MAX_TASK_SCAN_PAGES, pages.size)
        assertEquals(10, taskScanPages(PdfTextSnapshot(PdfTextApi.NONE, null, synced), maxPages = 10).size)
    }

    // -- problems ---------------------------------------------------------------------------

    @Test
    fun withoutTheApiAndWithoutSyncedTextThereIsNoSourceAtAll() {
        val snapshot = PdfTextSnapshot(PdfTextApi.NONE, null, emptyMap())
        assertEquals(PdfTextProblem.NO_TEXT_SOURCE, pdfTextProblem(snapshot))
        assertEquals(emptyList(), taskScanPages(snapshot))
    }

    @Test
    fun aDocumentTheApiCouldNotOpenIsUnreadableUnlessTheDesktopSyncedItsText() {
        assertEquals(PdfTextProblem.UNREADABLE, pdfTextProblem(PdfTextSnapshot(PdfTextApi.PRE_V, null, emptyMap())))
        assertEquals(PdfTextProblem.NONE, pdfTextProblem(PdfTextSnapshot(PdfTextApi.PRE_V, null, mapOf(1 to "Auftrag 1: Lies den Text."))))
    }

    @Test
    fun aScanWithoutAnyTextIsNamedAsSuchAndNotAsNoTasks() {
        val blank = listOf(emptyList<String>(), emptyList(), listOf("  ", ""))
        assertEquals(PdfTextProblem.SCAN_WITHOUT_TEXT, pdfTextProblem(PdfTextSnapshot(PdfTextApi.PLATFORM, blank, emptyMap())))
        assertEquals(PdfTextProblem.SCAN_WITHOUT_TEXT, pdfTextProblem(PdfTextSnapshot(PdfTextApi.NONE, null, mapOf(1 to " \n "))))
        // With a transcript from the desktop the same scan has text.
        assertEquals(PdfTextProblem.NONE, pdfTextProblem(PdfTextSnapshot(PdfTextApi.PLATFORM, blank, mapOf(2 to "Auftrag 1: Beschrifte die Skizze."))))
    }

    @Test
    fun textWithoutAnyAssignmentIsNotAProblemOfTheSource() {
        val snapshot = PdfTextSnapshot(PdfTextApi.PLATFORM, listOf(listOf("Ein Lesetext ohne Arbeitsanweisung für die Klasse.")), emptyMap())
        assertEquals(PdfTextProblem.NONE, pdfTextProblem(snapshot))
        assertEquals(emptyList(), detected(snapshot))
    }
}
