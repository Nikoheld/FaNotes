package ch.fasrv.fanotes

import android.graphics.RectF
import android.graphics.pdf.PdfRenderer
import android.graphics.pdf.PdfRendererPreV
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.ext.SdkExtensions
import androidx.annotation.RequiresApi
import androidx.annotation.RequiresExtension
import ch.fasrv.fanotes.study.PdfTextApi
import ch.fasrv.fanotes.study.PdfTextRun
import ch.fasrv.fanotes.study.PDF_TEXT_EXTENSION
import ch.fasrv.fanotes.study.pdfTextApi

/**
 * Reads the text layer of a PDF with the API this device has (the choice itself is `pdfTextApi` in `:core`):
 *
 * - Android 15 and newer: `PdfRenderer.Page.getTextContents`.
 * - Android 12 to 14 with SDK extension 13: `PdfRendererPreV.Page.getTextContents`. `PdfRenderer.Page` does not
 *   have the text methods there (the platform's API list gives `getTextContents` since 35 without an extension),
 *   so calling it would throw `NoSuchMethodError`.
 * - Anything else: no text layer; the caller falls back to the text the desktop synced.
 */
internal object PdfTextLayer {
    @Volatile private var missing = false

    private val offered: PdfTextApi by lazy {
        val sdk = Build.VERSION.SDK_INT
        val extension = if (sdk >= Build.VERSION_CODES.S) {
            runCatching { SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S) }.getOrDefault(0)
        } else {
            0
        }
        pdfTextApi(sdk, extension)
    }

    /** What the device can read: the API it offers, unless a call has shown the system does not have it. */
    fun api(): PdfTextApi = if (missing) PdfTextApi.NONE else offered

    /** The class or method was not there at run time. Stop trying in this process. */
    fun markMissing() {
        missing = true
    }

    /**
     * The text runs of the first [maxPages] pages, index = page - 1. A page that fails to read has no runs.
     * Null when [api] is NONE. Throws when the PDF does not open; a `LinkageError` means the API is missing.
     */
    fun read(
        api: PdfTextApi,
        descriptor: ParcelFileDescriptor,
        maxPages: Int,
        openPlatform: (ParcelFileDescriptor) -> PdfRenderer,
    ): List<List<PdfTextRun>>? = when (api) {
        PdfTextApi.PLATFORM -> if (Build.VERSION.SDK_INT >= 35) readPlatform(openPlatform(descriptor), maxPages) else null
        PdfTextApi.PRE_V ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S) >= PDF_TEXT_EXTENSION) {
                readPreV(descriptor, maxPages)
            } else {
                null
            }
        PdfTextApi.NONE -> null
    }

    @RequiresApi(35)
    private fun readPlatform(renderer: PdfRenderer, maxPages: Int): List<List<PdfTextRun>> = renderer.use {
        (0 until renderer.pageCount.coerceAtMost(maxPages)).map { index ->
            try {
                renderer.openPage(index).use { page -> page.textContents.map { runOf(it.text, it.bounds) } }
            } catch (_: Exception) {
                emptyList()
            }
        }
    }

    @RequiresExtension(extension = Build.VERSION_CODES.S, version = 13)
    private fun readPreV(descriptor: ParcelFileDescriptor, maxPages: Int): List<List<PdfTextRun>> =
        PdfRendererPreV(descriptor).use { renderer ->
            (0 until renderer.pageCount.coerceAtMost(maxPages)).map { index ->
                try {
                    renderer.openPage(index).use { page -> page.textContents.map { runOf(it.text, it.bounds) } }
                } catch (_: Exception) {
                    emptyList()
                }
            }
        }

    private fun runOf(text: String, bounds: List<RectF>): PdfTextRun =
        if (bounds.isEmpty()) PdfTextRun(text) else PdfTextRun(text, bounds.minOf { it.top }, bounds.maxOf { it.bottom })
}
