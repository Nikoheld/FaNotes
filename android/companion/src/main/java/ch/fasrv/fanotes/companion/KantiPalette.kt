package ch.fasrv.fanotes.companion

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Pure colour resolution for every Kanti+ theme. No Android or Compose types, so the
 * contrast rules are unit-tested on the JVM.
 *
 * Stored theme ids stay the desktop ids (`system`, `light`, `dark`, `midnight`, `forest`,
 * `aurora`, `sepia`). `snow` is the phone-only winter theme. Unknown ids fall back to the
 * system light/dark pair, the same rule the shared core uses.
 */
const val SNOW_THEME_ID = "snow"
const val DEFAULT_ACCENT = "#2a6f97"

/** Theme ids offered in Erscheinungsbild, in display order. */
val KANTI_THEME_IDS = listOf("system", "light", "sepia", SNOW_THEME_ID, "dark", "midnight", "forest", "aurora")

data class KantiPalette(
    val id: String,
    val dark: Boolean,
    val background: Int,
    val surface: Int,
    val sunken: Int,
    val raised: Int,
    val text: Int,
    val muted: Int,
    val hairline: Int,
    val outline: Int,
    val accent: Int,
    val onAccent: Int,
    val accentSoft: Int,
    val success: Int,
    val successSoft: Int,
    val warning: Int,
    val warningSoft: Int,
    val danger: Int,
    val dangerSoft: Int,
    val onDanger: Int,
    val paper: Int,
    val paperInk: Int,
    /** True when the accent comes from the theme, not from the user's accent choice. */
    val fixedAccent: Boolean = false,
)

private data class Base(
    val dark: Boolean,
    val background: Int,
    val surface: Int,
    val sunken: Int,
    val raised: Int,
    val text: Int,
    val muted: Int,
    val hairline: Int,
    val outline: Int,
    val success: Int,
    val warning: Int,
    val danger: Int,
    val paper: Int = 0xFFFCFCFA.toInt(),
    val paperInk: Int = 0xFF26343B.toInt(),
    val accent: Int? = null,
)

private val LIGHT = Base(false, 0xFFF4F5F2.toInt(), 0xFFFFFFFF.toInt(), 0xFFE8EBE6.toInt(), 0xFFFFFFFF.toInt(),
    0xFF151C22.toInt(), 0xFF505B64.toInt(), 0xFFDCE0DA.toInt(), 0xFF7F8991.toInt(),
    0xFF1D6A46.toInt(), 0xFF875100.toInt(), 0xFFB3252E.toInt())
private val SEPIA = Base(false, 0xFFF6F1E7.toInt(), 0xFFFFFCF6.toInt(), 0xFFEBE3D3.toInt(), 0xFFFFFCF6.toInt(),
    0xFF2A251E.toInt(), 0xFF5D5447.toInt(), 0xFFE0D6C3.toInt(), 0xFF877B69.toInt(),
    0xFF2B693E.toInt(), 0xFF845008.toInt(), 0xFFAA2E2E.toInt(), paper = 0xFFFFFBF2.toInt(), paperInk = 0xFF3A3128.toInt())
private val SNOW = Base(false, 0xFFF0F5FA.toInt(), 0xFFFFFFFF.toInt(), 0xFFE2EBF3.toInt(), 0xFFFFFFFF.toInt(),
    0xFF11253A.toInt(), 0xFF445B70.toInt(), 0xFFD2DFEA.toInt(), 0xFF7A93A9.toInt(),
    0xFF1B6A49.toInt(), 0xFF83540B.toInt(), 0xFFAD2E39.toInt(), paper = 0xFFFBFDFF.toInt(), paperInk = 0xFF1C3347.toInt(),
    accent = 0xFF2766A0.toInt())
private val GRAPHITE = Base(true, 0xFF111315.toInt(), 0xFF1A1C1F.toInt(), 0xFF24272B.toInt(), 0xFF202327.toInt(),
    0xFFECEDEE.toInt(), 0xFFA8AEB4.toInt(), 0xFF2D3135.toInt(), 0xFF717980.toInt(),
    0xFF6FCB92.toInt(), 0xFFE7B552.toInt(), 0xFFFF8C8C.toInt(), paper = 0xFFEDEDE8.toInt())
private val MIDNIGHT = Base(true, 0xFF0F1219.toInt(), 0xFF171B24.toInt(), 0xFF212631.toInt(), 0xFF1C212B.toInt(),
    0xFFE7EAF0.toInt(), 0xFFA4ABB9.toInt(), 0xFF2A303C.toInt(), 0xFF6B7486.toInt(),
    0xFF6FCB92.toInt(), 0xFFE7B552.toInt(), 0xFFFF8C8C.toInt(), paper = 0xFFEDEEF0.toInt())
private val FOREST = Base(true, 0xFF101511.toInt(), 0xFF171E19.toInt(), 0xFF202923.toInt(), 0xFF1C241E.toInt(),
    0xFFE4EBE5.toInt(), 0xFFA2B1A6.toInt(), 0xFF28322B.toInt(), 0xFF68776C.toInt(),
    0xFF6FCB92.toInt(), 0xFFE7B552.toInt(), 0xFFFF8C8C.toInt(), paper = 0xFFECEFEA.toInt())
private val AURORA = Base(true, 0xFF141319.toInt(), 0xFF1C1A23.toInt(), 0xFF26232F.toInt(), 0xFF211F29.toInt(),
    0xFFEAE8F0.toInt(), 0xFFAEAABD.toInt(), 0xFF2F2C3A.toInt(), 0xFF716C83.toInt(),
    0xFF6FCB92.toInt(), 0xFFE7B552.toInt(), 0xFFFF8C8C.toInt(), paper = 0xFFEEEDF1.toInt())

/** The stored id that a theme choice resolves to, or null for system. */
fun resolvedThemeId(raw: String?, systemDark: Boolean): String = when (val id = raw?.trim().orEmpty()) {
    "light", "dark", "midnight", "forest", "aurora", "sepia", SNOW_THEME_ID -> id
    else -> if (systemDark) "dark" else "light"
}

fun kantiPalette(themeId: String?, systemDark: Boolean, accentHex: String? = DEFAULT_ACCENT, amoled: Boolean = false): KantiPalette {
    val id = resolvedThemeId(themeId, systemDark)
    val base = when (id) {
        "dark" -> GRAPHITE
        "midnight" -> MIDNIGHT
        "forest" -> FOREST
        "aurora" -> AURORA
        "sepia" -> SEPIA
        SNOW_THEME_ID -> SNOW
        else -> LIGHT
    }
    val black = amoled && base.dark
    val background = if (black) 0xFF000000.toInt() else base.background
    val surface = if (black) mixColor(base.surface, 0xFF000000.toInt(), 0.45) else base.surface
    val sunken = if (black) mixColor(base.sunken, 0xFF000000.toInt(), 0.35) else base.sunken
    val raised = if (black) mixColor(base.raised, 0xFF000000.toInt(), 0.35) else base.raised
    val hairline = if (black) mixColor(base.hairline, 0xFF000000.toInt(), 0.2) else base.hairline
    val surfaces = listOf(background, surface, raised)
    val raw = base.accent ?: parseHexColor(accentHex) ?: parseHexColor(DEFAULT_ACCENT)!!
    val softAmount = if (base.dark) 0.24 else 0.13
    val accentSoft = mixColor(surface, raw, softAmount)
    val accent = ensureContrast(raw, surfaces + accentSoft, 4.5, towardsLight = base.dark)
    val white = 0xFFFFFFFF.toInt()
    val ink = 0xFF0C1720.toInt()
    val onAccent = if (contrastRatio(white, accent) >= contrastRatio(ink, accent)) white else ink
    fun tone(color: Int): Pair<Int, Int> {
        val soft = mixColor(surface, color, if (base.dark) 0.2 else 0.12)
        return ensureContrast(color, surfaces + soft, 4.5, towardsLight = base.dark) to soft
    }
    val (success, successSoft) = tone(base.success)
    val (warning, warningSoft) = tone(base.warning)
    val (danger, dangerSoft) = tone(base.danger)
    val onDanger = if (contrastRatio(white, danger) >= contrastRatio(ink, danger)) white else ink
    return KantiPalette(
        id = id, dark = base.dark,
        background = background, surface = surface, sunken = sunken, raised = raised,
        text = ensureContrast(base.text, surfaces + sunken, 7.0, towardsLight = base.dark),
        muted = ensureContrast(base.muted, surfaces + sunken, 4.5, towardsLight = base.dark),
        hairline = hairline,
        outline = ensureContrast(base.outline, surfaces, 3.0, towardsLight = base.dark),
        accent = accent, onAccent = onAccent, accentSoft = accentSoft,
        success = success, successSoft = successSoft,
        warning = warning, warningSoft = warningSoft,
        danger = danger, dangerSoft = dangerSoft, onDanger = onDanger,
        paper = base.paper, paperInk = base.paperInk,
        fixedAccent = base.accent != null,
    )
}

fun parseHexColor(raw: String?): Int? {
    val value = raw?.trim()?.removePrefix("#") ?: return null
    if (!Regex("^[0-9A-Fa-f]{6}$").matches(value)) return null
    return (0xFF000000 or value.toLong(16)).toInt()
}

fun mixColor(from: Int, to: Int, amount: Double): Int {
    val t = amount.coerceIn(0.0, 1.0)
    fun channel(shift: Int): Int {
        val a = (from ushr shift) and 0xFF
        val b = (to ushr shift) and 0xFF
        return (a + (b - a) * t).toInt().coerceIn(0, 255)
    }
    return (0xFF shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
}

/** WCAG 2.x relative luminance. */
fun relativeLuminance(color: Int): Double {
    fun linear(shift: Int): Double {
        val c = ((color ushr shift) and 0xFF) / 255.0
        return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * linear(16) + 0.7152 * linear(8) + 0.0722 * linear(0)
}

fun contrastRatio(a: Int, b: Int): Double {
    val la = relativeLuminance(a)
    val lb = relativeLuminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
}

/** Moves [color] towards white or black until it reaches [minimum] against every background. */
fun ensureContrast(color: Int, backgrounds: List<Int>, minimum: Double, towardsLight: Boolean): Int {
    val target = if (towardsLight) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()
    var step = 0
    var current = color
    while (step <= 25 && backgrounds.any { contrastRatio(current, it) < minimum }) {
        step += 1
        current = mixColor(color, target, step * 0.04)
    }
    return current
}
