package ch.fasrv.fanotes

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.desk.TouchMetrics

/** Touch layer for the current window; provided once by the activity. */
val LocalTouch = staticCompositionLocalOf { TouchMetrics(false) }

/**
 * Vertical drag handle on the edge between a side panel and the note.
 * Draws [visibleDp] but reacts to a hit box of [hitDp] (centred on the edge).
 * [onResize] receives the live panel width in dp (absolute); [onCommit] runs once when the finger lifts.
 * [startDp] is the current panel width (read when a drag starts); [growsRight] is true for a left panel.
 */
@Composable
fun PanelResizeHandle(
    startDp: Int,
    growsRight: Boolean,
    description: String,
    hitDp: Int,
    onResize: (Float) -> Unit,
    onCommit: () -> Unit,
    modifier: Modifier = Modifier,
    visibleDp: Int = 2,
) {
    val density = LocalDensity.current
    val start = rememberUpdatedState(startDp)
    val resize = rememberUpdatedState(onResize)
    val commit = rememberUpdatedState(onCommit)
    var travelled by remember { mutableFloatStateOf(0f) }
    var base by remember { mutableFloatStateOf(0f) }
    Box(modifier.width(visibleDp.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
        Box(Modifier.width(visibleDp.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline.copy(alpha = 0.25f)))
        Box(
            Modifier
                .requiredWidth(hitDp.dp)
                .fillMaxHeight()
                .semantics { contentDescription = description }
                .pointerInput(growsRight) {
                    detectHorizontalDragGestures(
                        onDragStart = { travelled = 0f; base = start.value.toFloat() },
                        onDragEnd = { commit.value() },
                        onDragCancel = { commit.value() },
                    ) { change, amount ->
                        change.consume()
                        travelled += amount / density.density
                        resize.value(base + if (growsRight) travelled else -travelled)
                    }
                }
                .background(Color.Transparent),
        )
    }
}
