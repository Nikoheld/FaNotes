package ch.fasrv.fanotes.companion

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Pure zoom arithmetic of the read view. Everything here is unit-tested without a device. */
object ReaderZoomMath {
    const val MIN = 1f
    const val MAX = 5f
    const val DOUBLE_TAP = 2.5f
    const val TEXT_MIN = 0.8f
    const val TEXT_MAX = 3f
    const val STEP = 0.25f
    const val TEXT_PREF = "reader-text-zoom"

    /** Largest bitmap edge and byte size a rendered page may have. */
    const val MAX_RENDER_WIDTH = 3000
    const val MAX_RENDER_BYTES = 24L * 1024 * 1024

    fun clamp(zoom: Float): Float = if (zoom.isNaN()) MIN else zoom.coerceIn(MIN, MAX)
    fun clampText(zoom: Float): Float = if (zoom.isNaN()) 1f else zoom.coerceIn(TEXT_MIN, TEXT_MAX)

    /** Double-tap goes to 2.5x, and back to 1x from any zoomed state. */
    fun doubleTapTarget(current: Float): Float = if (current > 1.05f) MIN else DOUBLE_TAP

    /** The next step of the +/- buttons on a 0.25 grid, within [low]..[high]. */
    fun step(zoom: Float, up: Boolean, low: Float = MIN, high: Float = MAX): Float {
        val cells = zoom / STEP
        val next = if (up) floor(cells + 1e-3f) + 1f else kotlin.math.ceil(cells - 1e-3f) - 1f
        return (next * STEP).coerceIn(low, high)
    }

    fun percent(zoom: Float): Int = (zoom * 100f).roundToInt()

    /** Largest horizontal pan (pixels) of a column laid out at [zoom] times the viewport width. */
    fun maxPan(viewport: Float, zoom: Float): Float = max(0f, viewport * (zoom - 1f))

    /**
     * The scroll offset that keeps the content point that was under [focalStart] (viewport coordinates, at the old
     * zoom) under [focalEnd] after the content grew by [ratio] (new zoom / old zoom). Clamped to 0..[max].
     */
    fun refocus(offset: Float, focalStart: Float, focalEnd: Float, ratio: Float, max: Float): Float =
        ((offset + focalStart) * ratio - focalEnd).coerceIn(0f, max.coerceAtLeast(0f))

    /**
     * Size of one page of the stack. A document page fills the width ([fit] false); a single image is fitted
     * into the viewport at 1x ([fit] true) and centered. [slot] is the height of the list item holding the page:
     * the page plus a gap that grows with the zoom, so the whole stack scales uniformly.
     */
    data class PageBox(val width: Float, val height: Float, val slot: Float)

    fun pageBox(viewportW: Float, viewportH: Float, zoom: Float, aspect: Float, fit: Boolean, gap: Float): PageBox {
        val ratio = aspect.coerceIn(0.1f, 10f)
        if (!fit) {
            val width = viewportW * zoom
            val height = width * ratio
            return PageBox(width, height, height + gap * zoom)
        }
        val base = min(viewportW, viewportH / ratio)
        val width = base * zoom
        val height = width * ratio
        return PageBox(width, height, max(viewportH, height))
    }

    fun slots(viewportW: Float, viewportH: Float, zoom: Float, aspects: List<Float>, fit: Boolean, gap: Float): List<Int> =
        aspects.map { pageBox(viewportW, viewportH, zoom, it, fit, gap).slot.roundToInt().coerceAtLeast(1) }

    /** Distance from the top of the stack to [offset] pixels into item [index]. */
    fun absoluteOffset(slots: List<Int>, index: Int, offset: Int): Int {
        var total = 0
        for (i in 0 until index.coerceIn(0, slots.size)) total += slots[i]
        return total + offset
    }

    /** The item and the offset into it at [absolute] pixels from the top; clamped to the stack. */
    fun locate(slots: List<Int>, absolute: Int): Pair<Int, Int> {
        if (slots.isEmpty()) return 0 to 0
        var remaining = absolute.coerceAtLeast(0)
        for ((index, slot) in slots.withIndex()) {
            if (remaining < slot || index == slots.lastIndex) return index to remaining.coerceAtMost(slot - 1).coerceAtLeast(0)
            remaining -= slot
        }
        return slots.lastIndex to 0
    }

    /**
     * The width a page is rendered at: the on-screen pixel width, shrunk to [MAX_RENDER_WIDTH] and to
     * [MAX_RENDER_BYTES] of ARGB_8888 for a page of height/width [aspect].
     */
    fun renderWidth(onScreen: Float, aspect: Float): Int {
        val ratio = aspect.coerceIn(0.1f, 10f)
        val byBytes = kotlin.math.sqrt(MAX_RENDER_BYTES.toDouble() / (4.0 * ratio)).toInt()
        return min(min(onScreen.roundToInt(), MAX_RENDER_WIDTH), byBytes).coerceAtLeast(1)
    }
}

/** The reading text size, remembered per device. */
fun readerTextZoom(context: Context): Float =
    ReaderZoomMath.clampText(context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).getFloat(ReaderZoomMath.TEXT_PREF, 1f))

fun saveReaderTextZoom(context: Context, zoom: Float) {
    context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).edit().putFloat(ReaderZoomMath.TEXT_PREF, ReaderZoomMath.clampText(zoom)).apply()
}

/** Zoom of a page stack: the layout zoom, the horizontal pan, and the live (not yet committed) pinch. */
@Stable
class ReaderZoomState(initial: Float = 1f) {
    var zoom by mutableFloatStateOf(ReaderZoomMath.clamp(initial)); internal set
    var panX by mutableFloatStateOf(0f); internal set
    internal var liveScale by mutableFloatStateOf(1f)
    internal var pivot by mutableStateOf(Offset.Zero)
    internal var liveShift by mutableStateOf(Offset.Zero)
    internal var viewport by mutableStateOf(IntSize.Zero)
    internal var pinching by mutableStateOf(false)
    internal var slotsFor: (Float) -> List<Int> = { emptyList() }
}

@Composable
fun rememberReaderZoomState(initial: Float = 1f): ReaderZoomState = remember { ReaderZoomState(initial) }

/** Commits [target] as the layout zoom, keeping the content point under [from] under [to] (viewport pixels). */
internal fun ReaderZoomState.commit(target: Float, from: Offset, to: Offset, list: LazyListState) {
    val next = ReaderZoomMath.clamp(target)
    val ratio = next / zoom
    val width = viewport.width.toFloat(); val height = viewport.height.toFloat()
    val before = slotsFor(zoom)
    val absolute = ReaderZoomMath.absoluteOffset(before, list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset)
    val after = slotsFor(next)
    zoom = next
    panX = ReaderZoomMath.refocus(panX, from.x, to.x, ratio, ReaderZoomMath.maxPan(width, next))
    val total = after.sum()
    val wanted = ((absolute + from.y) * ratio - to.y).roundToInt().coerceIn(0, max(0, total - height.roundToInt()))
    val (index, offset) = ReaderZoomMath.locate(after, wanted)
    list.requestScrollToItem(index, offset)
    liveScale = 1f; liveShift = Offset.Zero; pinching = false
}

/**
 * Pinch recognizer in the initial pass: it only consumes while two fingers are down, so one-finger drags still reach
 * the list and the pan. [onUpdate] gets the scale since the start and the centroid; [onEnd] fires when the pinch stops.
 */
internal suspend fun androidx.compose.ui.input.pointer.PointerInputScope.detectReaderPinch(
    onStart: (Offset) -> Unit,
    onUpdate: (scale: Float, centroid: Offset) -> Unit,
    onEnd: () -> Unit,
) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var active = false
        var startDistance = 1f
        do {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            val down = event.changes.filter { it.pressed }
            if (down.size >= 2) {
                val a = down[0].position; val b = down[1].position
                val distance = hypot(a.x - b.x, a.y - b.y).coerceAtLeast(1f)
                val centroid = Offset((a.x + b.x) / 2f, (a.y + b.y) / 2f)
                if (!active) { active = true; startDistance = distance; onStart(centroid) }
                onUpdate(distance / startDistance, centroid)
                event.changes.forEach { it.consume() }
            } else if (active) {
                active = false
                onEnd()
            }
        } while (event.changes.any { it.pressed })
        if (active) onEnd()
    }
}

/**
 * A vertical stack of pages (or one image) that zooms from 1x to 5x. Pages are laid out at viewport width times the
 * zoom, so they re-render sharp; a pinch only scales the layer live and commits the layout when the fingers lift.
 * One finger scrolls the list, and pans sideways when zoomed. [page] draws page `index` into a box of the given pixels.
 */
@Composable
fun ZoomablePages(
    aspects: List<Float>,
    modifier: Modifier = Modifier,
    state: ReaderZoomState = rememberReaderZoomState(),
    listState: LazyListState = rememberLazyListState(),
    fit: Boolean = false,
    controls: Boolean = true,
    page: @Composable (index: Int, widthPx: Int, heightPx: Int) -> Unit,
) {
    val density = LocalDensity.current
    val gap = with(density) { 12.dp.toPx() }
    val scope = rememberCoroutineScope()
    val aspectsNow by rememberUpdatedState(aspects)
    val total = aspects.size
    BoxWithConstraints(modifier.clipToBounds()) {
        val vw = constraints.maxWidth; val vh = constraints.maxHeight
        SideEffect {
            state.viewport = IntSize(vw, vh)
            state.slotsFor = { zoom -> ReaderZoomMath.slots(vw.toFloat(), vh.toFloat(), zoom, aspectsNow, fit, gap) }
            // A narrower viewport (rotation) may leave the pan outside the new range.
            val limit = ReaderZoomMath.maxPan(vw.toFloat(), state.zoom)
            if (state.panX > limit) state.panX = limit
        }
        val dragState = rememberDraggableState { delta ->
            state.panX = (state.panX - delta).coerceIn(0f, ReaderZoomMath.maxPan(vw.toFloat(), state.zoom))
        }
        val animation = remember { Animatable(1f) }
        Box(
            Modifier.fillMaxSize()
                .pointerInput(state, listState) {
                    detectReaderPinch(
                        onStart = { c -> state.pinching = true; state.pivot = c; state.liveShift = Offset.Zero },
                        onUpdate = { scale, c ->
                            val wanted = ReaderZoomMath.clamp(state.zoom * scale)
                            state.liveScale = wanted / state.zoom
                            state.liveShift = c - state.pivot
                        },
                        onEnd = { state.commit(state.zoom * state.liveScale, state.pivot, state.pivot + state.liveShift, listState) },
                    )
                }
                .pointerInput(state, listState) {
                    detectTapGestures(onDoubleTap = { tap ->
                        val target = ReaderZoomMath.doubleTapTarget(state.zoom)
                        scope.launch {
                            state.pivot = tap; state.liveShift = Offset.Zero; state.pinching = true
                            animation.snapTo(1f)
                            animation.animateTo(target / state.zoom, tween(180)) { state.liveScale = value }
                            state.commit(target, tap, tap, listState)
                        }
                    })
                }
                .draggable(dragState, Orientation.Horizontal, enabled = state.zoom > 1f && !state.pinching),
        ) {
            Box(
                Modifier.fillMaxSize()
                    .graphicsLayer {
                        scaleX = state.liveScale; scaleY = state.liveScale
                        transformOrigin = TransformOrigin(
                            if (vw > 0) state.pivot.x / vw else 0f,
                            if (vh > 0) state.pivot.y / vh else 0f,
                        )
                        translationX = state.liveShift.x; translationY = state.liveShift.y
                    }
                    .layout { measurable, incoming ->
                        val wide = (vw * state.zoom).roundToInt().coerceAtLeast(1)
                        val placeable = measurable.measure(Constraints.fixed(wide, incoming.maxHeight))
                        layout(incoming.maxWidth, incoming.maxHeight) { placeable.place(IntOffset(-state.panX.roundToInt(), 0)) }
                    },
            ) {
                LazyColumn(Modifier.fillMaxSize(), state = listState) {
                    itemsIndexed(aspects, key = { index, _ -> index }) { index, aspect ->
                        val box = ReaderZoomMath.pageBox(vw.toFloat(), vh.toFloat(), state.zoom, aspect, fit, gap)
                        val slot = with(density) { box.slot.roundToInt().toDp() }
                        Box(Modifier.fillMaxWidth().height(slot), contentAlignment = if (fit) Alignment.Center else Alignment.TopCenter) {
                            val w = box.width.roundToInt().coerceAtLeast(1); val h = box.height.roundToInt().coerceAtLeast(1)
                            Box(Modifier.size(with(density) { w.toDp() }, with(density) { h.toDp() })) { page(index, w, h) }
                        }
                    }
                }
            }
        }
        // The page chip shows while the list moves, then fades.
        var chipVisible by remember { mutableStateOf(false) }
        val moving = listState.isScrollInProgress || state.pinching
        LaunchedEffect(moving) { if (moving) chipVisible = true else { delay(1200); chipVisible = false } }
        val current by remember(total) {
            derivedStateOf {
                val info = listState.layoutInfo
                val middle = (info.viewportStartOffset + info.viewportEndOffset) / 2
                (info.visibleItemsInfo.firstOrNull { middle >= it.offset && middle < it.offset + it.size }?.index
                    ?: listState.firstVisibleItemIndex) + 1
            }
        }
        if (total > 1) AnimatedVisibility(chipVisible, Modifier.align(Alignment.TopCenter).padding(top = 12.dp), enter = fadeIn(tween(120)), exit = fadeOut(tween(300))) {
            Surface(color = MaterialTheme.colorScheme.inverseSurface.copy(alpha = 0.86f), contentColor = MaterialTheme.colorScheme.inverseOnSurface, shape = RoundedCornerShape(50)) {
                Text(t(R.string.page_of, current.coerceIn(1, total), total), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
            }
        }
        if (controls) ZoomControls(
            state.zoom,
            onMinus = { state.zoomBy(false, listState) },
            onPlus = { state.zoomBy(true, listState) },
            onReset = { state.centered(1f, listState) },
            Modifier.align(Alignment.BottomEnd).padding(12.dp),
        )
    }
}

private fun ReaderZoomState.centered(target: Float, list: LazyListState) {
    val middle = Offset(viewport.width / 2f, viewport.height / 2f)
    commit(target, middle, middle, list)
}

private fun ReaderZoomState.zoomBy(up: Boolean, list: LazyListState) = centered(ReaderZoomMath.step(zoom, up), list)

/** Small `-`, `NNN %` (tap to reset) and `+` controls, like the zoom buttons of the desktop. */
@Composable
fun ZoomControls(zoom: Float, onMinus: () -> Unit, onPlus: () -> Unit, onReset: () -> Unit, modifier: Modifier = Modifier, low: Float = ReaderZoomMath.MIN, high: Float = ReaderZoomMath.MAX) {
    Surface(modifier, color = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f), shape = RoundedCornerShape(50), shadowElevation = 3.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.Outlined.Remove, t(R.string.zoom_out), zoom > low + 0.001f, onMinus)
            TextButton(onClick = onReset, modifier = Modifier.semantics { contentDescription = t(R.string.zoom_reset) }) {
                Text("${ReaderZoomMath.percent(zoom)} %", style = MaterialTheme.typography.labelLarge)
            }
            ActionIcon(Icons.Outlined.Add, t(R.string.zoom_in), zoom < high - 0.001f, onPlus)
        }
    }
}
