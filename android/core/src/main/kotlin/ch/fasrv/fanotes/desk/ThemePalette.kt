package ch.fasrv.fanotes.desk

/**
 * Desktop color schemes from `styles.css`. System follows the device theme.
 * Midnight, forest, and aurora inherit the dark danger color.
 */
data class ThemePalette(
    val id: String,
    val label: String,
    val detail: String,
    val dark: Boolean,
    val background: String,
    val surface: String,
    val surfaceVariant: String,
    val text: String,
    val danger: String,
)

val THEME_PALETTES = listOf(
    ThemePalette("dark", "Dunkel", "Graphit", true, "#191919", "#202020", "#333333", "#ededec", "#ff8d90"),
    ThemePalette("light", "Hell", "Papier", false, "#ffffff", "#f7f6f3", "#ebeae6", "#37352f", "#c03543"),
    ThemePalette("midnight", "Mitternacht", "Schiefer", true, "#17181b", "#1e1f23", "#32343a", "#e8e9ec", "#ff8d90"),
    ThemePalette("forest", "Wald", "Stein", true, "#171a18", "#1e221f", "#323833", "#e7ebe8", "#ff8d90"),
    ThemePalette("aurora", "Aurora", "Nebel", true, "#18181c", "#1f1f24", "#34343c", "#e8e8ed", "#ff8d90"),
    ThemePalette("sepia", "Studierzimmer", "Warm", false, "#fbfaf7", "#f4f1ea", "#ebe6dc", "#37352f", "#c03543"),
)

data class ThemeChoice(val id: String, val label: String, val detail: String)

val THEME_CHOICES = listOf(ThemeChoice("system", "System", "Automatisch")) +
    THEME_PALETTES.map { ThemeChoice(it.id, it.label, it.detail) }

fun themePalette(raw: String?, systemDark: Boolean): ThemePalette {
    val id = when (raw) {
        "dark", "light", "midnight", "forest", "aurora", "sepia" -> raw
        else -> if (systemDark) "dark" else "light"
    }
    return THEME_PALETTES.first { it.id == id }
}

fun themeChoiceSelected(stored: String?, choice: String): Boolean {
    val value = stored?.trim().orEmpty()
    return if (choice == "system") value.isEmpty() || value == "system" else value == choice
}
