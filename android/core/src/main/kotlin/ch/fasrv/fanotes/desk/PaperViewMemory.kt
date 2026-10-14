package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import kotlin.math.floor

/**
 * Per-note camera: zoom, rotation, and the page point under the viewport
 * centre. The store matches `paperViewMemory.ts`, including the text anchor
 * a typed note uses when the page height changes.
 */
const val PAPER_VIEW_MEMORY_KEY = "fanotes.paperView.v1"
const val PAPER_VIEW_MEMORY_MAX = 400
const val PAPER_VIEW_RESTORE_SETTLE_MS = 2200L
const val PAPER_VIEW_PROGRAMMATIC_SCROLL_TOLERANCE = 1.5
const val VIEW_ZOOM_MIN = 0.45
const val VIEW_ZOOM_MAX = 3.25

data class PaperTextAnchor(val pos: Int, val offset: Double)

data class PaperViewMemoryEntry(
    val zoom: Double,
    val rotation: Double,
    val centreX: Double,
    val centreY: Double,
    val at: Long,
    val pageWidth: Double? = null,
    val pageHeight: Double? = null,
    val anchor: PaperTextAnchor? = null,
)

data class PaperCentre(val centreX: Double, val centreY: Double)
data class PaperScroll(val scrollLeft: Double, val scrollTop: Double)
data class PaperViewSnapshot(val zoom: Double, val rotation: Double, val panX: Double, val panY: Double)

data class PaperRect(val left: Double, val top: Double, val width: Double, val height: Double)
data class PaperScroller(val clientWidth: Int, val clientHeight: Int, val scrollLeft: Double, val scrollTop: Double)

/** A line-block editor, enough for the desktop text-anchor math. */
class LineBlockView(
    val documentTop: Double,
    val scaleY: Double,
    val length: Int,
    private val froms: IntArray,
    private val tops: DoubleArray,
) {
    fun lineBlockAt(pos: Int): Pair<Int, Double> {
        val clamped = pos.coerceIn(0, length)
        var index = 0
        while (index + 1 < froms.size && froms[index + 1] <= clamped) index += 1
        return froms[index] to tops[index]
    }

    fun lineBlockAtHeight(height: Double): Pair<Int, Double> {
        var index = 0
        while (index + 1 < tops.size && tops[index + 1] <= height) index += 1
        return froms[index] to tops[index]
    }
}

private val MODIFIER_KEYS = setOf(
    "Alt", "AltGraph", "Control", "Meta", "Shift", "CapsLock", "NumLock", "ScrollLock", "Fn", "Hyper", "Super", "OS",
)

private fun jsRound(value: Double) = floor(value + 0.5)

private fun roundTo(value: Double, places: Int): Double {
    val scale = when (places) {
        2 -> 100.0
        3 -> 1000.0
        else -> 1.0
    }
    return jsRound(value * scale) / scale
}

fun clampViewZoom(value: Double): Double =
    minOf(VIEW_ZOOM_MAX, maxOf(VIEW_ZOOM_MIN, roundTo(value, 3)))

fun normalizeRotation(value: Double): Double {
    val wrapped = ((value % 360.0) + 360.0) % 360.0
    return if (wrapped > 180.0) wrapped - 360.0 else wrapped
}

fun defaultPaperView() = PaperViewSnapshot(1.0, 0.0, 0.0, 0.0)

fun normalizeTextAnchor(pos: Double?, offset: Double?): PaperTextAnchor? {
    if (pos == null || offset == null || !pos.isFinite() || pos < 0.0 || !offset.isFinite()) return null
    return PaperTextAnchor(jsRound(pos).toInt().coerceAtLeast(0), roundTo(offset, 2))
}

fun textAnchorFromView(view: LineBlockView, clientY: Double): PaperTextAnchor? {
    if (!clientY.isFinite() || !view.documentTop.isFinite()) return null
    val block = view.lineBlockAtHeight(clientY - view.documentTop)
    val lineTop = view.documentTop + block.second
    val scale = if (view.scaleY.isFinite() && view.scaleY > 0.0) view.scaleY else 1.0
    return PaperTextAnchor(
        jsRound(block.first.toDouble()).toInt().coerceAtLeast(0),
        roundTo((clientY - lineTop) / scale, 2),
    )
}

fun clientYFromTextAnchor(view: LineBlockView, anchor: PaperTextAnchor): Double? {
    if (!view.documentTop.isFinite()) return null
    val scale = if (view.scaleY.isFinite() && view.scaleY > 0.0) view.scaleY else 1.0
    val pos = anchor.pos.coerceIn(0, view.length)
    val block = view.lineBlockAt(pos)
    return view.documentTop + block.second + anchor.offset * scale
}

private fun entryFromJson(raw: JsonValue.Obj): PaperViewMemoryEntry? {
    val zoom = raw.double("zoom") ?: return null
    if (!zoom.isFinite() || zoom <= 0.0) return null
    val anchorObj = raw.obj("anchor")
    val anchor = if (anchorObj == null) {
        null
    } else {
        normalizeTextAnchor(anchorObj.double("pos"), anchorObj.double("offset"))
    }
    val pageWidth = raw.double("pageWidth") ?: 0.0
    val pageHeight = raw.double("pageHeight") ?: 0.0
    return PaperViewMemoryEntry(
        zoom = clampViewZoom(zoom),
        rotation = normalizeRotation(raw.double("rotation") ?: 0.0),
        centreX = maxOf(0.0, raw.double("centreX") ?: 0.0),
        centreY = maxOf(0.0, raw.double("centreY") ?: 0.0),
        at = maxOf(0L, (raw.double("at") ?: 0.0).toLong()),
        pageWidth = if (pageWidth > 0.0) roundTo(pageWidth, 2) else null,
        pageHeight = if (pageHeight > 0.0) roundTo(pageHeight, 2) else null,
        anchor = anchor,
    )
}

fun parsePaperViewMemory(raw: String?): Map<String, PaperViewMemoryEntry> {
    if (raw.isNullOrBlank()) return emptyMap()
    val parsed = try {
        parseJson(raw)
    } catch (_: Exception) {
        return emptyMap()
    }
    val obj = parsed as? JsonValue.Obj ?: return emptyMap()
    val store = linkedMapOf<String, PaperViewMemoryEntry>()
    for ((key, value) in obj.fields) {
        if (key.isEmpty()) continue
        val entry = (value as? JsonValue.Obj)?.let(::entryFromJson) ?: continue
        store[key] = entry
    }
    return store
}

fun prunePaperViewMemory(store: Map<String, PaperViewMemoryEntry>, max: Int = PAPER_VIEW_MEMORY_MAX): Map<String, PaperViewMemoryEntry> {
    if (store.size <= max) return store
    return store.entries.sortedByDescending { it.value.at }.take(max.coerceAtLeast(1)).associate { it.key to it.value }
}

fun serializePaperViewMemory(store: Map<String, PaperViewMemoryEntry>, max: Int = PAPER_VIEW_MEMORY_MAX): String {
    val pruned = prunePaperViewMemory(store, max)
    val root = JsonValue.Obj()
    for ((key, entry) in pruned) {
        root.put(key, jsonObject(
            "zoom" to jsonNumber(entry.zoom),
            "rotation" to jsonNumber(entry.rotation),
            "centreX" to jsonNumber(entry.centreX),
            "centreY" to jsonNumber(entry.centreY),
            "at" to jsonNumber(entry.at.toDouble()),
            "pageWidth" to entry.pageWidth?.let(::jsonNumber),
            "pageHeight" to entry.pageHeight?.let(::jsonNumber),
            "anchor" to entry.anchor?.let {
                jsonObject("pos" to jsonNumber(it.pos.toDouble()), "offset" to jsonNumber(it.offset))
            },
        ))
    }
    return root.stringify()
}

fun rememberPaperView(
    store: Map<String, PaperViewMemoryEntry>,
    key: String,
    zoom: Double,
    rotation: Double = 0.0,
    centreX: Double,
    centreY: Double,
    pageWidth: Double? = null,
    pageHeight: Double? = null,
    anchor: PaperTextAnchor? = null,
    at: Long = System.currentTimeMillis(),
    max: Int = PAPER_VIEW_MEMORY_MAX,
): Map<String, PaperViewMemoryEntry> {
    if (key.isEmpty() || !zoom.isFinite() || zoom <= 0.0) return store
    val entry = PaperViewMemoryEntry(
        zoom = clampViewZoom(zoom),
        rotation = normalizeRotation(rotation),
        centreX = maxOf(0.0, centreX),
        centreY = maxOf(0.0, centreY),
        at = maxOf(0L, at),
        pageWidth = pageWidth?.takeIf { it > 0.0 }?.let { roundTo(it, 2) },
        pageHeight = pageHeight?.takeIf { it > 0.0 }?.let { roundTo(it, 2) },
        anchor = anchor,
    )
    return prunePaperViewMemory(store + (key to entry), max)
}

fun recallPaperView(store: Map<String, PaperViewMemoryEntry>, key: String?): PaperViewMemoryEntry? =
    if (key.isNullOrEmpty()) null else store[key]

fun forgetPaperView(store: Map<String, PaperViewMemoryEntry>, key: String): Map<String, PaperViewMemoryEntry> =
    if (key !in store) store else store - key

fun paperViewFromMemory(entry: PaperViewMemoryEntry?): PaperViewSnapshot =
    if (entry == null) defaultPaperView()
    else PaperViewSnapshot(clampViewZoom(entry.zoom), normalizeRotation(entry.rotation), 0.0, 0.0)

fun paperViewMemoryKey(viewKey: String?): String {
    if (viewKey.isNullOrEmpty()) return ""
    return if (viewKey.startsWith("split:")) viewKey.removePrefix("split:") else viewKey
}

fun paperCentreFromCamera(scroller: PaperScroller, scrollerRect: PaperRect, pageRect: PaperRect, zoom: Double): PaperCentre {
    val used = if (zoom.isFinite() && zoom > 0.0) maxOf(0.01, zoom) else 1.0
    val viewCentreX = scrollerRect.left + scroller.clientWidth / 2.0
    val viewCentreY = scrollerRect.top + scroller.clientHeight / 2.0
    return PaperCentre(
        centreX = maxOf(0.0, roundTo((viewCentreX - pageRect.left) / used, 2)),
        centreY = maxOf(0.0, roundTo((viewCentreY - pageRect.top) / used, 2)),
    )
}

fun cameraForPaperCentre(
    scroller: PaperScroller,
    scrollerRect: PaperRect,
    pageRect: PaperRect,
    zoom: Double,
    centre: PaperCentre,
): PaperScroll {
    val used = if (zoom.isFinite() && zoom > 0.0) maxOf(0.01, zoom) else 1.0
    val pointX = pageRect.left + centre.centreX * used
    val pointY = pageRect.top + centre.centreY * used
    val viewCentreX = scrollerRect.left + scroller.clientWidth / 2.0
    val viewCentreY = scrollerRect.top + scroller.clientHeight / 2.0
    return PaperScroll(
        scrollLeft = maxOf(0.0, roundTo(scroller.scrollLeft + pointX - viewCentreX, 2)),
        scrollTop = maxOf(0.0, roundTo(scroller.scrollTop + pointY - viewCentreY, 2)),
    )
}

fun scaledPaperCentre(centreX: Double, centreY: Double, pageWidth: Double?, pageWidthNow: Double, proportional: Boolean): PaperCentre {
    val saved = pageWidth ?: 0.0
    if (saved <= 0.0 || pageWidthNow <= 0.0 || kotlin.math.abs(saved - pageWidthNow) <= 0.5) {
        return PaperCentre(centreX, centreY)
    }
    val ratio = pageWidthNow / saved
    return PaperCentre(
        centreX = roundTo(centreX * ratio, 2),
        centreY = if (proportional) roundTo(centreY * ratio, 2) else centreY,
    )
}

fun scrollTopForAnchorClientY(scrollTop: Double, scrollerTop: Double, anchorClientY: Double): Double =
    maxOf(0.0, roundTo(scrollTop + anchorClientY - scrollerTop, 2))

fun isProgrammaticScroll(scrollLeft: Double, scrollTop: Double, requestedLeft: Double?, requestedTop: Double?, tolerance: Double = PAPER_VIEW_PROGRAMMATIC_SCROLL_TOLERANCE): Boolean {
    if (requestedLeft == null || requestedTop == null) return false
    return kotlin.math.abs(scrollLeft - requestedLeft) <= tolerance && kotlin.math.abs(scrollTop - requestedTop) <= tolerance
}

fun shouldKeepRestoringPaperView(startedAt: Long, now: Long, userInteracted: Boolean, settleMs: Long = PAPER_VIEW_RESTORE_SETTLE_MS): Boolean =
    !userInteracted && now - startedAt <= settleMs

fun isPaperViewTakeoverKey(key: String, repeat: Boolean = false): Boolean =
    !repeat && key !in MODIFIER_KEYS
