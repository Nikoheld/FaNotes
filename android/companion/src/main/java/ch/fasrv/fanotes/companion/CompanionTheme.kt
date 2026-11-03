package ch.fasrv.fanotes.companion

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.fasrv.fanotes.desk.ThemePalette

private val Inter = FontFamily(Font(R.font.inter_regular))
val CompanionMono = FontFamily(Font(R.font.jetbrains_mono_regular))
fun paletteColor(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color(0xFF2A6F97))
data class CompanionSemantics(val success: Color, val warning: Color, val paper: Color = Color(0xFFFCFBF7), val paperInk: Color = Color(0xFF26343B))
val LocalCompanionSemantics = staticCompositionLocalOf { CompanionSemantics(Color(0xFF246A4B), Color(0xFF875715)) }
object Space {
    val xs = 4.dp; val sm = 8.dp; val md = 12.dp; val lg = 16.dp; val page = 20.dp; val xl = 24.dp; val xxl = 32.dp
}

@Composable
fun CompanionTheme(palette: ThemePalette, accent: String = "#2a6f97", amoled: Boolean = false, content: @Composable () -> Unit) {
    val dark = palette.dark
    val standard = palette.id == "light" || palette.id == "dark"
    val background = if (amoled && dark) Color.Black else if (standard) Color(if (dark) 0xFF11191F else 0xFFF7F8FA) else paletteColor(palette.background)
    val surface = if (amoled && dark) Color(0xFF0B1014) else if (standard) Color(if (dark) 0xFF1A242C else 0xFFFFFFFF) else paletteColor(palette.surface)
    val text = if (standard) Color(if (dark) 0xFFE7EDF1 else 0xFF202F38) else paletteColor(palette.text)
    val muted = if (standard) Color(if (dark) 0xFFAFBEC8 else 0xFF586B77) else paletteColor(palette.muted)
    val rawAccent = paletteColor(accent)
    val primary = when {
        dark && rawAccent.luminance() < 0.45f -> lerp(rawAccent, Color.White, 0.45f)
        !dark && rawAccent.luminance() > 0.18f -> lerp(rawAccent, Color.Black, 0.32f)
        else -> rawAccent
    }
    val container = lerp(surface, primary, if (dark) 0.20f else 0.10f)
    val soft = lerp(surface, text, if (dark) 0.07f else 0.045f)
    val outline = lerp(surface, text, if (dark) 0.40f else 0.34f)
    val line = lerp(surface, text, if (dark) 0.14f else 0.12f)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(
        primary = primary, onPrimary = if (primary.luminance() > 0.36f) Color(0xFF10232C) else Color.White,
        primaryContainer = container, onPrimaryContainer = text,
        secondary = muted, onSecondary = surface, secondaryContainer = soft, onSecondaryContainer = text,
        tertiary = primary, onTertiary = surface, tertiaryContainer = container, onTertiaryContainer = text,
        background = background, onBackground = text, surface = surface, onSurface = text,
        surfaceVariant = soft, onSurfaceVariant = muted, outline = outline, outlineVariant = line,
        surfaceTint = primary, inverseSurface = text, inverseOnSurface = surface,
        inversePrimary = rawAccent, scrim = Color.Black,
        error = Color(if (dark) 0xFFFFB4AB else 0xFFB33435), onError = Color(if (dark) 0xFF5D1014 else 0xFFFFFFFF),
        errorContainer = Color(if (dark) 0xFF432125 else 0xFFFFEDEC), onErrorContainer = Color(if (dark) 0xFFFFDAD6 else 0xFF8C262A),
        surfaceBright = surface, surfaceDim = background, surfaceContainerLowest = background,
        surfaceContainerLow = surface, surfaceContainer = soft, surfaceContainerHigh = soft,
        surfaceContainerHighest = lerp(surface, text, if (dark) 0.12f else 0.075f),
    )
    fun type(size: Int, line: Int, weight: FontWeight = FontWeight.Normal, tracking: Float = 0f) = TextStyle(
        fontFamily = Inter, fontSize = size.sp, lineHeight = line.sp, fontWeight = weight, letterSpacing = tracking.sp,
    )
    val typography = Typography(
        displayLarge = type(36, 44, FontWeight.SemiBold, -1f), displayMedium = type(32, 40, FontWeight.SemiBold, -0.8f), displaySmall = type(28, 36, FontWeight.SemiBold, -0.6f),
        headlineLarge = type(28, 36, FontWeight.SemiBold, -0.6f), headlineMedium = type(24, 32, FontWeight.SemiBold, -0.5f), headlineSmall = type(22, 30, FontWeight.SemiBold, -0.4f),
        titleLarge = type(20, 28, FontWeight.SemiBold, -0.3f), titleMedium = type(16, 24, FontWeight.SemiBold, -0.15f), titleSmall = type(14, 20, FontWeight.SemiBold),
        bodyLarge = type(16, 25), bodyMedium = type(14, 22), bodySmall = type(12, 18),
        labelLarge = type(14, 20, FontWeight.SemiBold), labelMedium = type(12, 18, FontWeight.Medium), labelSmall = type(11, 16, FontWeight.Medium, 0.3f),
    )
    CompositionLocalProvider(LocalCompanionSemantics provides CompanionSemantics(paletteColor(palette.success), paletteColor(palette.warning))) {
        MaterialTheme(colorScheme = scheme, typography = typography, shapes = Shapes(
            extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(14.dp),
            large = RoundedCornerShape(18.dp), extraLarge = RoundedCornerShape(24.dp),
        ), content = content)
    }
}
