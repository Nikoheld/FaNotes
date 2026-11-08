package ch.fasrv.fanotes.companion

import android.os.PowerManager
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.compose.material3.MaterialTheme
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlin.math.sin
import kotlin.random.Random

private class Flake(val x: Float, val y: Float, val radius: Float, val speed: Float, val sway: Float, val phase: Float, val accent: Boolean)

/** Seconds of snowfall each time Heute appears. Afterwards nothing runs. */
const val SNOWFALL_SECONDS = 14f

/** Pure position so the motion is testable: flakes wrap vertically and sway sideways. */
fun flakePosition(x: Float, y: Float, speed: Float, sway: Float, phase: Float, seconds: Float): Pair<Float, Float> {
    val travelled = (y + seconds * speed) % 1.15f
    return (x + sin(seconds * 0.9f + phase) * sway) to (travelled - 0.1f)
}

/**
 * Optional Snow-theme decoration over the Heute card. It never runs with reduced motion or
 * battery saver, stops after [SNOWFALL_SECONDS], pauses below RESUMED and is disposed when the
 * card scrolls away. Each frame only invalidates drawing: no recomposition, no layout.
 */
@Composable
fun Snowfall(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val saver = remember { context.getSystemService(PowerManager::class.java)?.isPowerSaveMode == true }
    if (saver) return
    val flakes = remember {
        val random = Random(46)
        List(26) { Flake(random.nextFloat(), random.nextFloat(), 1.4f + random.nextFloat() * 2.2f, 0.05f + random.nextFloat() * 0.07f, 0.01f + random.nextFloat() * 0.025f, random.nextFloat() * 6.28f, it % 3 == 0) }
    }
    var millis by remember { mutableLongStateOf(0L) }
    var fade by remember { mutableFloatStateOf(1f) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (millis < (SNOWFALL_SECONDS * 1000).toLong()) {
                delay(40)
                millis += 40
                val left = SNOWFALL_SECONDS - millis / 1000f
                fade = left.coerceIn(0f, 2f) / 2f
            }
            fade = 0f
        }
    }
    val accent = MaterialTheme.colorScheme.primary
    Canvas(modifier.clearAndSetSemantics { }) {
        val alpha = fade
        if (alpha <= 0f) return@Canvas
        val seconds = millis / 1000f
        val scale = 1.dp.toPx()
        flakes.forEach { flake ->
            val (fx, fy) = flakePosition(flake.x, flake.y, flake.speed, flake.sway, flake.phase, seconds)
            val color = if (flake.accent) accent.copy(alpha = 0.32f * alpha) else Color.White.copy(alpha = 0.92f * alpha)
            drawCircle(color, flake.radius * scale, Offset(fx * size.width, fy * size.height))
        }
    }
}
