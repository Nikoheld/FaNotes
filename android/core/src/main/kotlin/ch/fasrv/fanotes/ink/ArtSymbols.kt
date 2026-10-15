package ch.fasrv.fanotes.ink

/**
 * Path symbols from the desktop art panel. Coordinates are a 24×24 icon,
 * stroked at `baseWidth / 24` and rotated by `symbolRotation` degrees.
 */
data class ArtSymbol(val id: String, val label: String, val category: String, val paths: List<String>)

const val ART_SYMBOL_SIZE = 72.0
const val ART_SYMBOL_MIN = 20.0
const val ART_SYMBOL_MAX = 180.0

/** Desktop slider: 20–180 px in steps of 2. Invalid values fall back to 72. */
fun snapArtSymbolSize(value: Double): Double {
    if (!value.isFinite()) return ART_SYMBOL_SIZE
    val clamped = value.coerceIn(ART_SYMBOL_MIN, ART_SYMBOL_MAX)
    val steps = kotlin.math.floor((clamped - ART_SYMBOL_MIN) / 2.0 + 0.5)
    return (ART_SYMBOL_MIN + steps * 2.0).coerceIn(ART_SYMBOL_MIN, ART_SYMBOL_MAX)
}

fun artSymbolSizeSetting(raw: String?): Double = snapArtSymbolSize(raw?.toDoubleOrNull() ?: ART_SYMBOL_SIZE)

fun stepArtSymbolSize(current: Double, direction: Int): Double {
    if (direction == 0) return snapArtSymbolSize(current)
    val stepped = snapArtSymbolSize(current) + direction * 2.0
    return when {
        stepped > ART_SYMBOL_MAX -> ART_SYMBOL_MIN
        stepped < ART_SYMBOL_MIN -> ART_SYMBOL_MAX
        else -> stepped
    }
}

/** Desktop slider: −180° to 180° in steps of 5. */
fun snapArtSymbolRotation(value: Double): Double {
    if (!value.isFinite()) return 0.0
    val clamped = value.coerceIn(-180.0, 180.0)
    val steps = kotlin.math.floor(clamped / 5.0 + 0.5)
    return (steps * 5.0).coerceIn(-180.0, 180.0)
}

fun artSymbolRotationSetting(raw: String?): Double = snapArtSymbolRotation(raw?.toDoubleOrNull() ?: 0.0)

fun stepArtSymbolRotation(current: Double, direction: Int): Double {
    if (direction == 0) return snapArtSymbolRotation(current)
    val stepped = snapArtSymbolRotation(current) + direction * 5.0
    return when {
        stepped > 180.0 -> -180.0
        stepped < -180.0 -> 180.0
        else -> stepped
    }
}

val ART_SYMBOLS = listOf(
    ArtSymbol("book", "Buch", "school", listOf("M2 4.5A2.5 2.5 0 0 1 4.5 2H9a3 3 0 0 1 3 3v17a3 3 0 0 0-3-3H2Z", "M22 4.5A2.5 2.5 0 0 0 19.5 2H15a3 3 0 0 0-3 3v17a3 3 0 0 1 3-3h7Z")),
    ArtSymbol("calculator", "Rechner", "school", listOf("M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M7 6h10v4H7Z", "M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01")),
    ArtSymbol("flask", "Labor", "school", listOf("M9 3h6", "M10 3v6l-6.8 10.2A1.8 1.8 0 0 0 4.7 22h14.6a1.8 1.8 0 0 0 1.5-2.8L14 9V3", "M6.5 17h11")),
    ArtSymbol("atom", "Atom", "school", listOf("M12 12h.01", "M19.1 4.9c2.8 2.8-1.1 11.1-6.2 16.2S1.5 18.3 4.9 14.9 16.3 1.5 19.1 4.9Z", "M4.9 4.9c-2.8 2.8 1.1 11.1 6.2 16.2s11.4-2.8 8-6.2S7.7 1.5 4.9 4.9Z")),
    ArtSymbol("globe", "Globus", "school", listOf("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M2 12h20", "M12 2a15.3 15.3 0 0 1 0 20", "M12 2a15.3 15.3 0 0 0 0 20")),
    ArtSymbol("lightbulb", "Idee", "school", listOf("M9 18h6", "M10 22h4", "M8.5 15.5A7 7 0 1 1 15.5 15.5C14.5 16.3 14 17 14 18h-4c0-1-.5-1.7-1.5-2.5Z")),
    ArtSymbol("pencil", "Stift", "school", listOf("M4 20l4.2-1 11-11a2.1 2.1 0 0 0-3-3l-11 11Z", "M14.8 6.2l3 3", "M4 20l3-3")),
    ArtSymbol("laptop", "Computer", "school", listOf("M4 4h16v12H4Z", "M2 20h20", "M8 20l1-4h6l1 4")),
    ArtSymbol("star", "Stern", "symbols", listOf("M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z")),
    ArtSymbol("heart", "Herz", "symbols", listOf("M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.5a5.5 5.5 0 0 0 0-7.8Z")),
    ArtSymbol("check", "Haken", "symbols", listOf("M20 6 9 17l-5-5")),
    ArtSymbol("warning", "Warnung", "symbols", listOf("M10.3 3.7 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z", "M12 9v4", "M12 17h.01")),
    ArtSymbol("info", "Information", "symbols", listOf("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 10v6", "M12 7h.01")),
    ArtSymbol("question", "Frage", "symbols", listOf("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M9.5 9a2.7 2.7 0 1 1 4.5 2c-1.3 1-2 1.4-2 3", "M12 17h.01")),
    ArtSymbol("flag", "Markierung", "symbols", listOf("M5 22V3", "M5 4h12l-2 4 2 4H5")),
    ArtSymbol("arrow", "Pfeil", "symbols", listOf("M5 12h14", "m13 6 6 6-6 6")),
    ArtSymbol("home", "Haus", "everyday", listOf("m3 11 9-8 9 8", "M5 10v11h14V10", "M9 21v-7h6v7")),
    ArtSymbol("user", "Person", "everyday", listOf("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 21a8 8 0 0 1 16 0")),
    ArtSymbol("users", "Gruppe", "everyday", listOf("M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M2 21a7 7 0 0 1 14 0", "M16 4a4 4 0 0 1 0 7", "M18 21a6 6 0 0 0-4-5.6")),
    ArtSymbol("clock", "Uhr", "everyday", listOf("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 6v6l4 2")),
    ArtSymbol("calendar", "Kalender", "everyday", listOf("M5 3v4M19 3v4", "M3 6h18v15H3Z", "M3 10h18")),
    ArtSymbol("camera", "Kamera", "everyday", listOf("M14.5 5 13 3h-2L9.5 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z", "M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z")),
    ArtSymbol("music", "Musik", "everyday", listOf("M9 18V5l11-2v13", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z")),
    ArtSymbol("smile", "Smiley", "everyday", listOf("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M8 9h.01M16 9h.01", "M8 14a5 5 0 0 0 8 0")),
    ArtSymbol("chat", "Sprechblase", "everyday", listOf("M21 15a4 4 0 0 1-4 4H8l-5 3 1.5-5A7.7 7.7 0 0 1 3 12a7 7 0 0 1 7-7h7a4 4 0 0 1 4 4Z")),
)

fun artSymbol(id: String?): ArtSymbol? = ART_SYMBOLS.firstOrNull { it.id == id }

/** Null turns placement off after the last symbol. */
fun nextArtSymbol(current: String?): String? {
    if (current == null) return ART_SYMBOLS.first().id
    val index = ART_SYMBOLS.indexOfFirst { it.id == current }
    if (index < 0 || index == ART_SYMBOLS.lastIndex) return null
    return ART_SYMBOLS[index + 1].id
}

data class SprayDot(val x: Double, val y: Double, val radius: Double, val alpha: Double)

fun seededUnit(seed: Int): Double {
    val value = kotlin.math.sin(seed * 12.9898 + 78.233) * 43758.5453
    return value - kotlin.math.floor(value)
}

/** Particles for one spray segment. Matches the desktop `spraySegment` loop. */
fun sprayDots(
    previousX: Double,
    previousY: Double,
    pointX: Double,
    pointY: Double,
    radius: Double,
    baseWidth: Double,
    seed: Int,
    index: Int,
    opacity: Double,
    scale: Double = 1.0,
): List<SprayDot> {
    val particles = kotlin.math.round((baseWidth * 0.68).coerceIn(6.0, 24.0)).toInt()
    return List(particles) { particle ->
        val key = seed + index * 1_009 + particle * 37
        val progress = seededUnit(key + 1)
        val angle = seededUnit(key + 2) * Math.PI * 2
        val spread = kotlin.math.sqrt(seededUnit(key + 3)) * radius
        SprayDot(
            x = previousX + (pointX - previousX) * progress + kotlin.math.cos(angle) * spread,
            y = previousY + (pointY - previousY) * progress + kotlin.math.sin(angle) * spread,
            radius = 0.35.coerceAtLeast(scale * (0.28 + seededUnit(key + 4) * 0.62)),
            alpha = opacity * (0.2 + seededUnit(key + 5) * 0.5),
        )
    }
}
