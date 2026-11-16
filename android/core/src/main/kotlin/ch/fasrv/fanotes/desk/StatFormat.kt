package ch.fasrv.fanotes.desk

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Whole number for the Statistik page in the UI language: 1’234 for German (Swiss grouping), 1,234 for English. */
fun statCount(value: Int, language: String): String =
    if (language == "en") String.format(Locale.US, "%,d", value)
    else String.format(Locale.GERMAN, "%,d", value).replace('.', '’')

/**
 * Date of an upcoming appointment in the UI language: "Mo. 16. Nov." for German, "Mon, Nov 16" for English.
 * Text that is not an ISO date (yyyy-MM-dd) comes back unchanged.
 */
fun statDateLabel(iso: String, language: String): String = runCatching {
    val date = LocalDate.parse(iso)
    if (language == "en") date.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.ENGLISH))
    else date.format(DateTimeFormatter.ofPattern("EEE d. MMM", Locale.GERMAN))
}.getOrDefault(iso)
