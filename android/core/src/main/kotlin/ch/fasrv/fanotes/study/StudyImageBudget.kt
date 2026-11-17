package ch.fasrv.fanotes.study

import java.util.Locale

/**
 * Size caps for reference images inside a note's annotations. A data URL lives in the .famd, so
 * big images can push a note past the 16 MB sync limit. Same numbers as desktop
 * (`noteAnnotation.mjs` / `encodeImage` in `StudyAnnotationLayer.tsx`); images stored before the
 * caps (up to [ANNOTATION_IMAGE_MAX_CHARS]) are still read.
 */
const val ANNOTATION_IMAGE_TARGET_CHARS = 300_000
const val ANNOTATION_IMAGE_NEW_MAX_CHARS = 450_000
const val ANNOTATION_IMAGE_BUDGET_CHARS = 8_000_000

/** Longest edge of a newly stored image. */
const val STUDY_IMAGE_MAX_EDGE = 1200

private const val EDGE_STEP = 0.78
private const val ENCODE_ATTEMPTS = 6
private val JPEG_QUALITIES = listOf(82, 70, 58, 46)

/** One encoder try: scale to [edge] (long edge, may be fractional like desktop), then PNG or JPEG at [quality] percent. */
data class EncodeStep(val edge: Double, val png: Boolean, val quality: Int)

/**
 * Tries in desktop order: edge 1200, then x0.78 per round (6 rounds). PNG first for the first two
 * rounds when [png] (line art, crops), then JPEG at stepped-down quality. The first step whose
 * data URL is at most [ANNOTATION_IMAGE_TARGET_CHARS] wins; none fits -> the image is too large.
 */
fun studyEncodeSteps(png: Boolean): List<EncodeStep> {
    val steps = ArrayList<EncodeStep>()
    var edge = STUDY_IMAGE_MAX_EDGE.toDouble()
    for (attempt in 0 until ENCODE_ATTEMPTS) {
        if (png && attempt < 2) steps += EncodeStep(edge, true, 100)
        for (q in JPEG_QUALITIES) steps += EncodeStep(edge, false, q)
        edge *= EDGE_STEP
    }
    return steps
}

/** Characters of all image data URLs in [items]. */
fun annotationImageChars(items: List<StudyAnnotation>): Int = items.sumOf { (it as? StudyImage)?.src?.length ?: 0 }

/** True when adding a data URL of [add] characters to [used] stays inside the per-note budget and the single-image cap. */
fun imageFitsBudget(used: Int, add: Int): Boolean =
    add <= ANNOTATION_IMAGE_NEW_MAX_CHARS && used.toLong() + add <= ANNOTATION_IMAGE_BUDGET_CHARS

private fun megabytes(chars: Int) = String.format(Locale.ROOT, "%.1f", chars / 1_000_000.0).replace('.', ',')

/** German template (used size, budget size) so the app can run it through its UI translation first. */
const val IMAGE_BUDGET_TEMPLATE = "Der Bildspeicher dieser Notiz ist voll (%s von %s MB). Entferne zuerst ein Bild."

/** Message shown (and nothing added) when an insert would exceed the budget. */
fun imageBudgetMessage(used: Int, template: String = IMAGE_BUDGET_TEMPLATE): String =
    String.format(Locale.ROOT, template, megabytes(used), megabytes(ANNOTATION_IMAGE_BUDGET_CHARS))
