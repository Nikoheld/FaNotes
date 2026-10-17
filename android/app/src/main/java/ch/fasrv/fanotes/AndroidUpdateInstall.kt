package ch.fasrv.fanotes

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import ch.fasrv.fanotes.desk.AndroidUpdate
import ch.fasrv.fanotes.desk.androidApkDownloadUrl
import java.io.File

fun installedAppVersion(context: Context): String = runCatching {
    @Suppress("DEPRECATION")
    context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
}.getOrDefault("")

/** Saves the release APK under the app cache. The URL is the canonical GitHub asset, not the API link. */
fun downloadAndroidApk(context: Context, offer: AndroidUpdate): File {
    val url = androidApkDownloadUrl(offer.version)
    if (url != offer.url || offer.fileName != url.substringAfterLast('/')) {
        throw IllegalArgumentException("Die APK-Adresse ist ungültig.")
    }
    val directory = File(context.cacheDir, "updates").apply { mkdirs() }
    val file = File(directory, offer.fileName)
    if (file.parentFile != directory) throw IllegalArgumentException("Die APK-Adresse ist ungültig.")
    val request = okhttp3.Request.Builder()
        .url(url)
        .header("Accept", "application/vnd.android.package-archive")
        .header("User-Agent", "FaNotes-Android")
        .build()
    okhttp3.OkHttpClient().newCall(request).execute().use { response ->
        if (!response.isSuccessful) throw IllegalStateException("Die APK konnte nicht geladen werden.")
        val body = response.body ?: throw IllegalStateException("Die APK konnte nicht geladen werden.")
        file.outputStream().use { output -> body.byteStream().use { input -> input.copyTo(output) } }
    }
    if (!apkLooksValid(file)) {
        file.delete()
        throw IllegalStateException("Die geladene Datei ist kein APK.")
    }
    return file
}

/** A GitHub error page must not be handed to the package installer. */
private fun apkLooksValid(file: File): Boolean {
    if (file.length() < 1_000_000L) return false
    return file.inputStream().use { input ->
        val magic = ByteArray(2)
        input.read(magic) == 2 && magic[0] == 'P'.code.toByte() && magic[1] == 'K'.code.toByte()
    }
}

/** Opens the system installer, or the unknown-sources setting when Android blocks it. */
fun installAndroidApk(context: Context, file: File) {
    val directory = File(context.cacheDir, "updates")
    if (file.parentFile != directory || !file.isFile) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
        val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(settings)
        return
    }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
}
