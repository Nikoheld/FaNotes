package ch.fasrv.fanotes

import ch.fasrv.fanotes.desk.ChromeText

/** An uppercased interface label: translated first, then upper-cased in the language's own rules. */
fun upperUi(text: String): String =
    ChromeText.ui(text).uppercase(if (ChromeText.language == "en") java.util.Locale.ENGLISH else java.util.Locale.GERMAN)
