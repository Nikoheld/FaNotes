package ch.fasrv.fanotes.desk

data class WindowChromeColors(
    val window: String,
    val statusBar: String,
    val navigationBar: String,
    val text: String,
    val dark: Boolean,
)

private val LIGHT_LAUNCH = setOf("#E6E1D6", "#F4F1EA", "#FFFCF7")

/** Window and system bars follow the active palette, including System-dark. */
fun windowChrome(theme: String?, systemDark: Boolean): WindowChromeColors {
    val palette = themePalette(theme, systemDark)
    return WindowChromeColors(
        window = palette.background,
        statusBar = palette.background,
        navigationBar = palette.surface,
        text = palette.text,
        dark = palette.dark,
    )
}

fun windowChromeUsesLightLaunch(chrome: WindowChromeColors): Boolean {
    val colors = listOf(chrome.window, chrome.statusBar, chrome.navigationBar)
    return colors.any { color -> color.uppercase() in LIGHT_LAUNCH }
}

fun brandMarkColor(theme: String?, systemDark: Boolean): String =
    themePalette(theme, systemDark).text
