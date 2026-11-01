package ch.fasrv.fanotes.companion

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import ch.fasrv.fanotes.desk.ThemePalette

private val Inter = FontFamily(Font(R.font.inter_regular))
private val Mono = FontFamily(Font(R.font.jetbrains_mono_regular))

fun paletteColor(hex: String): Color = Color(android.graphics.Color.parseColor(hex))

@Composable
fun CompanionTheme(palette: ThemePalette, accent: String = "#2a6f97", content: @Composable () -> Unit) {
    val accentColor = paletteColor(accent)
    val scheme = if (palette.dark) {
        darkColorScheme(
            primary = accentColor,
            onPrimary = paletteColor("#11131a"),
            background = paletteColor(palette.background),
            surface = paletteColor(palette.surface),
            surfaceVariant = paletteColor(palette.surfaceVariant),
            onBackground = paletteColor(palette.text),
            onSurface = paletteColor(palette.text),
            onSurfaceVariant = paletteColor(palette.muted),
            error = paletteColor(palette.danger),
            outline = paletteColor(palette.surfaceVariant),
        )
    } else {
        lightColorScheme(
            primary = accentColor,
            onPrimary = Color.White,
            background = paletteColor(palette.background),
            surface = paletteColor(palette.surface),
            surfaceVariant = paletteColor(palette.surfaceVariant),
            onBackground = paletteColor(palette.text),
            onSurface = paletteColor(palette.text),
            onSurfaceVariant = paletteColor(palette.muted),
            error = paletteColor(palette.danger),
            outline = paletteColor(palette.panelActive),
        )
    }
    val type = Typography(
        bodyLarge = TextStyle(fontFamily = Inter),
        bodyMedium = TextStyle(fontFamily = Inter),
        titleLarge = TextStyle(fontFamily = Inter),
        titleMedium = TextStyle(fontFamily = Inter),
        labelLarge = TextStyle(fontFamily = Inter),
        labelMedium = TextStyle(fontFamily = Mono),
    )
    MaterialTheme(colorScheme = scheme, typography = type, content = content)
}
