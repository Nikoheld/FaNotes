package ch.fasrv.fanotes.companion

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * Kanti+ design system ("Stundentakt").
 *
 * The school day is a measured line: times are set in condensed tabular figures, lessons hang
 * on a thin time rail, and the day band on Heute is the one memorable element. Everything else
 * stays quiet: paper surfaces, ink text, one accent, hairlines instead of boxes.
 */

private fun instrument(weight: Int, width: Float = 100f) = Font(
    R.font.instrument_sans,
    FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight), FontVariation.width(width)),
)

/** Text face: Instrument Sans with real 400–700 weights (no synthetic bold). */
val KantiSans = FontFamily(instrument(400), instrument(500), instrument(600), instrument(700))

/** Condensed cut for clock times, marks and counts. Always used with tabular figures. */
val KantiCondensed = FontFamily(instrument(500, 80f), instrument(600, 80f), instrument(700, 80f))

val CompanionMono = FontFamily(Font(R.font.jetbrains_mono_regular))

fun paletteColor(hex: String): Color = Color(parseHexColor(hex) ?: parseHexColor(DEFAULT_ACCENT)!!)

/** Extended tokens Material does not model. Read through [LocalCompanionSemantics]. */
@Immutable
data class CompanionSemantics(
    val success: Color = Color(0xFF1D6A46),
    val warning: Color = Color(0xFF875100),
    val paper: Color = Color(0xFFFCFCFA),
    val paperInk: Color = Color(0xFF26343B),
    val successSoft: Color = Color(0xFFE3F0E8),
    val warningSoft: Color = Color(0xFFF6EBDA),
    val dangerSoft: Color = Color(0xFFF8E3E3),
    val sunken: Color = Color(0xFFE8EBE6),
    val raised: Color = Color.White,
    val hairline: Color = Color(0xFFDCE0DA),
    val dark: Boolean = false,
    val snow: Boolean = false,
    val fixedAccent: Boolean = false,
)

val LocalCompanionSemantics = staticCompositionLocalOf { CompanionSemantics() }

object Space {
    val xs = 4.dp; val sm = 8.dp; val md = 12.dp; val lg = 16.dp; val page = 20.dp; val xl = 24.dp; val xxl = 32.dp; val xxxl = 40.dp
    /** Minimum height of a tappable row. */
    val row = 56.dp
    /** Height of primary buttons. */
    val button = 52.dp
}

/** Emphasised decelerate, used for everything that enters. */
val KantiEase = CubicBezierEasing(0.2f, 0f, 0f, 1f)

@Immutable
data class KantiMotion(val reduced: Boolean = false) {
    val short: Int get() = if (reduced) 0 else 140
    val medium: Int get() = if (reduced) 0 else 220
    fun <T> spec(durationMs: Int = 220): FiniteAnimationSpec<T> = if (reduced) snap() else tween(durationMs, easing = KantiEase)
}

val LocalKantiMotion = staticCompositionLocalOf { KantiMotion() }

/** False while the device reports no validated network. School data then shows its last stand. */
val LocalOnline = staticCompositionLocalOf { true }

private fun type(size: Int, line: Int, weight: Int, tracking: Float = 0f, family: FontFamily = KantiSans) = TextStyle(
    fontFamily = family, fontSize = size.sp, lineHeight = line.sp, fontWeight = FontWeight(weight), letterSpacing = tracking.sp,
)

val KantiTypography = Typography(
    displayLarge = type(56, 60, 600, -1.2f, KantiCondensed).copy(fontFeatureSettings = "tnum"),
    displayMedium = type(44, 48, 600, -0.8f, KantiCondensed).copy(fontFeatureSettings = "tnum"),
    displaySmall = type(34, 40, 600, -0.6f, KantiCondensed).copy(fontFeatureSettings = "tnum"),
    headlineLarge = type(30, 36, 600, -0.7f),
    headlineMedium = type(25, 31, 600, -0.5f),
    headlineSmall = type(21, 27, 600, -0.3f),
    titleLarge = type(19, 25, 600, -0.2f),
    titleMedium = type(16, 22, 600, -0.1f),
    titleSmall = type(14, 20, 600),
    bodyLarge = type(16, 24, 400),
    bodyMedium = type(15, 22, 400),
    bodySmall = type(13, 18, 400, 0.1f),
    labelLarge = type(15, 20, 600),
    labelMedium = type(13, 16, 500, 0.1f),
    labelSmall = type(12, 16, 600, 0.2f),
)

/** Clock times and marks: condensed, tabular, so columns of times line up. */
val TimeStyle = type(17, 22, 600, 0f, KantiCondensed).copy(fontFeatureSettings = "tnum")
val TimeSmallStyle = type(13, 16, 500, 0.1f, KantiCondensed).copy(fontFeatureSettings = "tnum")

val KantiShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

fun kantiColorScheme(p: KantiPalette): ColorScheme {
    fun c(value: Int) = Color(value)
    val base = if (p.dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c(p.accent), onPrimary = c(p.onAccent), primaryContainer = c(p.accentSoft), onPrimaryContainer = c(p.text),
        inversePrimary = c(p.accent),
        secondary = c(p.muted), onSecondary = c(p.surface), secondaryContainer = c(p.sunken), onSecondaryContainer = c(p.text),
        tertiary = c(p.accent), onTertiary = c(p.onAccent), tertiaryContainer = c(p.accentSoft), onTertiaryContainer = c(p.text),
        background = c(p.background), onBackground = c(p.text),
        surface = c(p.surface), onSurface = c(p.text), surfaceVariant = c(p.sunken), onSurfaceVariant = c(p.muted),
        surfaceTint = c(p.accent), inverseSurface = c(p.text), inverseOnSurface = c(p.background),
        error = c(p.danger), onError = c(p.onDanger), errorContainer = c(p.dangerSoft), onErrorContainer = c(p.text),
        outline = c(p.outline), outlineVariant = c(p.hairline), scrim = Color.Black,
        surfaceBright = c(p.raised), surfaceDim = c(p.background),
        surfaceContainerLowest = c(p.surface), surfaceContainerLow = c(p.raised), surfaceContainer = c(p.raised),
        surfaceContainerHigh = c(p.raised), surfaceContainerHighest = c(p.sunken),
    )
}

@Composable
fun CompanionTheme(
    themeId: String?,
    systemDark: Boolean,
    accent: String = DEFAULT_ACCENT,
    amoled: Boolean = false,
    reducedMotion: Boolean = false,
    online: Boolean = true,
    content: @Composable () -> Unit,
) {
    val palette = remember(themeId, systemDark, accent, amoled) { kantiPalette(themeId, systemDark, accent, amoled) }
    val scheme = remember(palette) { kantiColorScheme(palette) }
    val semantics = remember(palette) {
        CompanionSemantics(
            success = Color(palette.success), warning = Color(palette.warning),
            paper = Color(palette.paper), paperInk = Color(palette.paperInk),
            successSoft = Color(palette.successSoft), warningSoft = Color(palette.warningSoft), dangerSoft = Color(palette.dangerSoft),
            sunken = Color(palette.sunken), raised = Color(palette.raised), hairline = Color(palette.hairline),
            dark = palette.dark, snow = palette.id == SNOW_THEME_ID, fixedAccent = palette.fixedAccent,
        )
    }
    CompositionLocalProvider(
        LocalCompanionSemantics provides semantics,
        LocalKantiMotion provides KantiMotion(reducedMotion),
        // A network flap or the first callback after start must not flash "offline".
        LocalOnline provides !rememberDebouncedFlag(!online),
    ) {
        MaterialTheme(colorScheme = scheme, typography = KantiTypography, shapes = KantiShapes, content = content)
    }
}
