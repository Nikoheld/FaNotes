package ch.fasrv.fanotes.companion

import android.content.Context
import android.os.Build
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import androidx.annotation.ColorRes
import androidx.annotation.DrawableRes

/** Semantic tone of a widget pill or line of text. Colours come from the widget_* resources, so light, dark and Material You follow the system. */
internal enum class WidgetTone(@DrawableRes val pill: Int, @ColorRes val ink: Int) {
    NEUTRAL(R.drawable.widget_pill_neutral, R.color.widget_muted),
    ACCENT(R.drawable.widget_pill_accent, R.color.widget_on_accent_container),
    WARNING(R.drawable.widget_pill_warning, R.color.widget_warning),
    DANGER(R.drawable.widget_pill_danger, R.color.widget_alert),
    SUCCESS(R.drawable.widget_pill_success, R.color.widget_success),
}

/** A rounded label: hidden when [text] is blank, otherwise shown in the container colour of [tone]. */
internal fun RemoteViews.setPill(context: Context, id: Int, text: CharSequence, tone: WidgetTone) {
    if (text.isBlank()) {
        setViewVisibility(id, View.GONE)
        return
    }
    setViewVisibility(id, View.VISIBLE)
    setTextViewText(id, text)
    setInt(id, "setBackgroundResource", tone.pill)
    setTextColor(id, context.getColor(tone.ink))
}

/** Text that is hidden entirely when blank, so an empty line does not keep its height. */
internal fun RemoteViews.setTextOrGone(id: Int, text: CharSequence) {
    setViewVisibility(id, if (text.isBlank()) View.GONE else View.VISIBLE)
    setTextViewText(id, text)
}

/**
 * One layout of a widget, meant for boxes of at least [min] dp. [rows] is how many whole rows it shows, so the
 * box never ends in the middle of a row: the heights in [min] are the sum of the header and exactly those rows.
 */
internal class WidgetVariant(val min: SizeF, val rows: Int, val make: () -> RemoteViews)

/** Dp heights of text for a font scale, so a variant's [WidgetVariant.min] holds the rows it claims. */
internal object WidgetMetrics {
    /** Height of one line of [sp] text at [scale], with room for the tallest font the platform may pick. */
    fun line(sp: Float, scale: Float): Float = sp * 1.32f * scale

    /** The font scale the widget is drawn with; never below 1 so a smaller setting only adds slack. */
    fun scale(context: Context): Float = context.resources.configuration.fontScale.coerceAtLeast(1f)

    /** Minimum width of a layout designed for [dp] at normal text: bigger text needs more room across, too. */
    fun width(dp: Float, scale: Float): Float = Math.ceil((dp * (1f + 0.6f * (scale - 1f))).toDouble()).toFloat()
}

/**
 * One RemoteViews for every size. On API 31+ the launcher swaps layouts while the user resizes, with no round
 * trip to the app. Before that only the variant that fits the last reported size is drawn. [forced] keeps a
 * single variant (the compact setting keeps the one-line header).
 */
internal fun responsiveViews(variants: List<WidgetVariant>, widthDp: Int, heightDp: Int, forced: WidgetVariant? = null): RemoteViews {
    if (forced != null) return forced.make()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return pickVariant(variants, widthDp.toFloat(), heightDp.toFloat()).make()
    val sized = LinkedHashMap<SizeF, RemoteViews>()
    variants.forEach { sized[it.min] = it.make() }
    return RemoteViews(sized)
}

/** The variant showing the most rows that fits [widthDp] x [heightDp]; the first (smallest) one when none does. */
internal fun pickVariant(variants: List<WidgetVariant>, widthDp: Float, heightDp: Float): WidgetVariant =
    variants.filter { it.min.width <= widthDp && it.min.height <= heightDp }
        .maxWithOrNull(compareBy<WidgetVariant>({ it.min.height }, { it.min.width }))
        ?: variants.first()
