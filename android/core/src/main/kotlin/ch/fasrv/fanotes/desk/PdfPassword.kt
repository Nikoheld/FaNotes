package ch.fasrv.fanotes.desk

const val PDF_PASSWORD_TITLE = "Dieses PDF ist geschützt"
const val PDF_PASSWORD_ACTION = "Öffnen"
const val PDF_PASSWORD_WRONG = "Das Passwort ist falsch."
const val PDF_PASSWORD_NEEDS_ANDROID_15 = "Die PDF-Passwortöffnung braucht Android 15."

/** Android exposes [android.graphics.pdf.LoadParams] from API 35. */
fun pdfPasswordSupported(sdk: Int): Boolean = sdk >= 35

/** A locked or wrongly unlocked PDF, matching the desktop `PasswordException`. */
fun pdfNeedsPassword(exceptionName: String, message: String): Boolean {
    if (exceptionName == "SecurityException" || exceptionName == "PasswordException") return true
    return message.contains("password", ignoreCase = true)
}
