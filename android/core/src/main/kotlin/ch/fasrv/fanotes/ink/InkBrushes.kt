package ch.fasrv.fanotes.ink

/** One stroked layer of a desktop brush, widest first. */
data class InkPaintPass(
    val widthFactor: Double,
    val alpha: Double,
    val jitter: Double = 0.0,
)

data class ArtBrush(
    val id: String,
    val label: String,
    val description: String,
    val defaultWidth: Double,
    val pressure: Boolean,
)

/** Same brushes, labels, and default widths as the desktop art panel. */
val ART_BRUSHES = listOf(
    ArtBrush("fineliner", "Fineliner", "klar & präzise", 3.0, false),
    ArtBrush("pencil", "Bleistift", "weich texturiert", 3.5, true),
    ArtBrush("marker", "Marker", "satt & gleichmässig", 9.0, false),
    ArtBrush("paintbrush", "Pinsel", "dynamischer Druck", 11.0, true),
    ArtBrush("calligraphy", "Kalligrafie", "schräge Breitfeder", 9.0, true),
    ArtBrush("highlighter", "Textmarker", "transparent", 22.0, false),
    ArtBrush("watercolor", "Aquarell", "lasierende Kanten", 20.0, true),
    ArtBrush("spray", "Spray", "feine Partikel", 26.0, false),
)

fun artBrush(id: String?): ArtBrush = ART_BRUSHES.firstOrNull { it.id == id } ?: ART_BRUSHES.first()

/** Passes from `brushPasses` in `inkStrokePaint.ts`. */
fun brushPasses(brush: String?): List<InkPaintPass> = when (brush) {
    "pencil" -> listOf(
        InkPaintPass(0.72, 0.58),
        InkPaintPass(0.22, 0.2, 1.4),
        InkPaintPass(0.18, 0.14, 1.8),
    )
    "paintbrush" -> listOf(InkPaintPass(1.4, 0.16), InkPaintPass(0.92, 0.82))
    "highlighter" -> listOf(InkPaintPass(1.0, 0.34))
    "watercolor" -> listOf(
        InkPaintPass(1.48, 0.11),
        InkPaintPass(1.14, 0.17),
        InkPaintPass(0.78, 0.27),
    )
    "marker" -> listOf(InkPaintPass(1.0, 0.9))
    else -> listOf(InkPaintPass(1.0, 1.0))
}
