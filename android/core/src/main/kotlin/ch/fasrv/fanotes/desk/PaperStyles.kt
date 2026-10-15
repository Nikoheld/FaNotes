package ch.fasrv.fanotes.desk

/**
 * Per-note paper catalog from `paperStyles.ts` and the settings select in
 * `SettingsModal.tsx`. The picker on the note uses [label]; settings uses
 * [settingsLabel], which names millimeter paper the longer way.
 */
data class PaperStyleOption(val id: String, val label: String, val detail: String, val settingsLabel: String = label)

val PAPER_STYLES = listOf(
    PaperStyleOption("blank", "Leer", "Ohne Muster"),
    PaperStyleOption("dots", "Gepunktet", "Ruhiges Punktraster"),
    PaperStyleOption("squares", "Häuschen", "Kleine Schulkästchen"),
    PaperStyleOption("grid", "Kariert", "Grössere Karos"),
    PaperStyleOption("lines", "Liniert", "Lineatur mit Rand"),
    PaperStyleOption("millimeter", "Millimeter", "Feinraster wie Millimeterpapier", "Millimeterpapier"),
)

const val PAPER_PICKER_HINT = "Nur für diese Notiz"

fun normalizePaperStyle(value: String?, fallback: String = "dots"): String =
    if (PAPER_STYLES.any { it.id == value }) value!! else fallback

fun paperStyleById(value: String?): PaperStyleOption =
    PAPER_STYLES.firstOrNull { it.id == normalizePaperStyle(value, "") } ?: PAPER_STYLES.first { it.id == "dots" }

fun paperStyleLabel(value: String?): String =
    PAPER_STYLES.firstOrNull { it.id == value }?.label ?: "Papier"

fun paperStyleSettingsLabel(value: String?): String =
    PAPER_STYLES.firstOrNull { it.id == value }?.settingsLabel ?: "Gepunktet"
