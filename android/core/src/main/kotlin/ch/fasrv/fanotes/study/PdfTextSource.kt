package ch.fasrv.fanotes.study

/**
 * Where the text of a PDF comes from for task detection and PDF search.
 *
 * 1. The device's own text layer, when Android has an API for it ([PdfTextApi]).
 * 2. The text the desktop already read and synced (`fanotes-page-text-v1`, `fanotes-pdf-ocr-v1`), which also
 *    covers scans and devices without the API.
 *
 * Nothing here touches Android; the app reads the PDF and the sidecars and passes both in a [PdfTextSnapshot].
 */

/** The Android API that reads the text of a PDF page. */
enum class PdfTextApi {
    /** `PdfRenderer.Page.getTextContents`, part of the platform from Android 15 (API 35). */
    PLATFORM,

    /** `PdfRendererPreV.Page.getTextContents`: Android 12 to 14 once SDK extension 13 is installed (Play system update). */
    PRE_V,

    /** Android 11 and older, or Android 12 to 14 without extension 13. The page text cannot be read on the device. */
    NONE,
}

/** First API level of the platform text API (Android 15). */
const val PDF_TEXT_PLATFORM_SDK = 35

/**
 * The pre-V renderer lives in `framework-pdf`, which the platform's API list ships for the S, T, U and V extension
 * chains at version 13 (`sdks="31:13,33:13,34:13,35:13"` in `api-versions.xml`) and not for R. Android 11 has no
 * PDF text API at all.
 */
const val PDF_TEXT_PRE_V_MIN_SDK = 31
const val PDF_TEXT_EXTENSION = 13

/**
 * Which API this device has. [sExtension] is `SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S)`, read only
 * on API 31 and later (pass 0 otherwise). Android 15 and newer always have the platform API.
 */
fun pdfTextApi(sdkInt: Int, sExtension: Int): PdfTextApi = when {
    sdkInt >= PDF_TEXT_PLATFORM_SDK -> PdfTextApi.PLATFORM
    sdkInt >= PDF_TEXT_PRE_V_MIN_SDK && sExtension >= PDF_TEXT_EXTENSION -> PdfTextApi.PRE_V
    else -> PdfTextApi.NONE
}

/** A page counts as having text of its own from this many characters, the threshold the desktop uses for scans. */
const val PDF_PAGE_MIN_TEXT = 20

/** What stopped a text read from giving the app anything to work with. */
enum class PdfTextProblem {
    NONE,

    /** No text API on this device and no synced text: the scan cannot run here. */
    NO_TEXT_SOURCE,

    /** The device has a text API, but it could not open the PDF, and no synced text exists. */
    UNREADABLE,

    /** The PDF opened, but no page has text (a scan) and the desktop has not synced any. */
    SCAN_WITHOUT_TEXT,
}

/**
 * Everything the device could read of one PDF.
 *
 * @property api the text API the device had when it read (NONE when it has none or it failed at run time)
 * @property layerLines lines per page from the device's text layer, index = page - 1; null when it was not
 *   read or the PDF did not open
 * @property synced the desktop's text by 1-based page number
 */
class PdfTextSnapshot(
    val api: PdfTextApi,
    val layerLines: List<List<String>>?,
    val synced: Map<Int, String>,
)

private val BREAKS = Regex("\r\n|\r|\n")

private fun syncedLines(text: String): List<String> = text.split(BREAKS).map { it.trim() }.filter { it.isNotEmpty() }

private fun pageCount(snapshot: PdfTextSnapshot, maxPages: Int): Int =
    minOf(maxPages, maxOf(snapshot.layerLines?.size ?: 0, snapshot.synced.keys.maxOrNull() ?: 0)).coerceAtLeast(0)

/** The device's own text when the page has enough of it, else the desktop's text when that has more. */
private fun pageLines(snapshot: PdfTextSnapshot, page: Int): List<String> {
    val layer = snapshot.layerLines?.getOrNull(page - 1).orEmpty()
    val layerChars = layer.sumOf { it.length }
    if (layerChars >= PDF_PAGE_MIN_TEXT) return layer
    val synced = snapshot.synced[page]?.let(::syncedLines).orEmpty()
    return if (synced.sumOf { it.length } > layerChars) synced else layer
}

/** Pages for task detection (at most [maxPages]). */
fun taskScanPages(snapshot: PdfTextSnapshot, maxPages: Int = MAX_TASK_SCAN_PAGES): List<PageLines> =
    (1..pageCount(snapshot, maxPages)).map { PageLines(it, pageLines(snapshot, it)) }

/** One string per page for the PDF search; page n is index n - 1. */
fun searchPageTexts(snapshot: PdfTextSnapshot, maxPages: Int): List<String> =
    (1..pageCount(snapshot, maxPages)).map { pageLines(snapshot, it).joinToString(" ") }

/** Why the snapshot has no usable text, or [PdfTextProblem.NONE] when at least one page has some. */
fun pdfTextProblem(snapshot: PdfTextSnapshot, maxPages: Int = MAX_TASK_SCAN_PAGES): PdfTextProblem {
    if (snapshot.layerLines == null && snapshot.synced.isEmpty()) {
        return if (snapshot.api == PdfTextApi.NONE) PdfTextProblem.NO_TEXT_SOURCE else PdfTextProblem.UNREADABLE
    }
    val hasText = (1..pageCount(snapshot, maxPages)).any { page -> pageLines(snapshot, page).any { it.isNotBlank() } }
    return if (hasText) PdfTextProblem.NONE else PdfTextProblem.SCAN_WITHOUT_TEXT
}

/**
 * Whether "Neu erkennen" can work at all: the device has a text API, or the desktop's text files exist next to the
 * PDF. Whether they match the PDF is only known after a read.
 */
fun taskDetectionPossible(api: PdfTextApi, syncedFilesExist: Boolean): Boolean = api != PdfTextApi.NONE || syncedFilesExist
