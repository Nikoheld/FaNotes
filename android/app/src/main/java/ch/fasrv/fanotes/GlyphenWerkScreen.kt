package ch.fasrv.fanotes

import android.view.MotionEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInteropFilter
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.recognition.GLYPH_CATEGORIES
import ch.fasrv.fanotes.recognition.GLYPH_SAMPLES_PER_LABEL
import ch.fasrv.fanotes.recognition.GlyphCaptureException
import ch.fasrv.fanotes.recognition.GlyphLabel
import ch.fasrv.fanotes.recognition.PadPoint
import ch.fasrv.fanotes.recognition.captureGlyphSample
import ch.fasrv.fanotes.recognition.nextGlyphToCapture
import ch.fasrv.fanotes.recognition.recognitionUi

/**
 * GlyphenWerk on the tablet: write labelled characters with the pen. Each saved sample joins the
 * same glyph library as a desktop GlyphenWerk import, so text to handwriting and handwritten
 * solver results use it at once. A pen in use locks out finger and palm input on the pad.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GlyphenWerkScreen(model: FaNotesViewModel, onDismiss: () -> Unit) {
    BackHandler(onBack = onDismiss)
    val samples by model.glyphSamples.collectAsStateWithLifecycle()
    val style by model.style.collectAsStateWithLifecycle()
    var categoryIndex by remember { mutableIntStateOf(0) }
    val category = GLYPH_CATEGORIES[categoryIndex]
    var chosen by remember(categoryIndex) { mutableStateOf<GlyphLabel?>(null) }
    val label = chosen ?: nextGlyphToCapture(category, samples) ?: category.labels.first()
    val counts = remember(samples) { samples.groupingBy { it.labelId }.eachCount() }
    val strokes = remember { mutableStateListOf<List<PadPoint>>() }
    // The stroke under the pen: a plain buffer (pointer events arrive between recompositions), redrawn by [tick].
    val live = remember { ArrayList<PadPoint>() }
    var tick by remember { mutableIntStateOf(0) }
    var pad by remember { mutableStateOf(IntSize.Zero) }
    var penSeen by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val ink = MaterialTheme.colorScheme.onSurface
    val guide = ink.copy(alpha = 0.18f)

    fun save() {
        try {
            val sample = captureGlyphSample(
                label,
                strokes.toList(),
                pad.width.toDouble().coerceAtLeast(1.0),
                pad.height.toDouble().coerceAtLeast(1.0),
                style.baseWidth,
                style.pressureEnabled,
                id = "tablet-${System.currentTimeMillis().toString(36)}-${(0..0xffff).random().toString(16)}",
                sessionId = "glyphenwerk-tablet-${java.time.LocalDate.now()}",
            )
            model.recognition.saveGlyph(sample)
            strokes.clear()
            error = null
            if ((counts[label.id] ?: 0) + 1 >= GLYPH_SAMPLES_PER_LABEL) chosen = null
        } catch (failure: GlyphCaptureException) {
            error = recognitionUi(failure.message ?: "Das Zeichen konnte nicht gespeichert werden.")
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val wide = maxWidth > maxHeight && maxWidth > 760.dp
                val padSide = if (wide) minOf(maxHeight - 120.dp, maxWidth * 0.5f) else minOf(maxWidth - 32.dp, maxHeight * 0.48f)
                val padView: @Composable () -> Unit = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(label.char, fontSize = 44.sp, fontWeight = FontWeight.SemiBold)
                            Column {
                                Text(recognitionUi(label.name), fontSize = 14.sp)
                                Text(recognitionUi("${counts[label.id] ?: 0} von $GLYPH_SAMPLES_PER_LABEL Beispielen"), fontSize = 12.sp, color = LocalStatusInk.current.muted)
                            }
                        }
                        Box(
                            Modifier
                                .size(padSide)
                                .clip(RoundedCornerShape(16.dp))
                                .border(1.dp, ink.copy(alpha = 0.2f), RoundedCornerShape(16.dp))
                                .background(LocalStatusInk.current.panelStrong)
                                .onSizeChanged { pad = it }
                                .pointerInteropFilter { event -> handlePad(event, penSeen, { penSeen = true }, live, { tick += 1 }) { finished -> strokes.add(finished); error = null } },
                        ) {
                            Canvas(Modifier.fillMaxSize()) {
                                @Suppress("UNUSED_EXPRESSION") tick
                                val dash = PathEffect.dashPathEffect(floatArrayOf(12f, 10f))
                                // Ascender, x-height and baseline guides, as on a school line.
                                listOf(0.22f, 0.45f, 0.72f).forEach { y ->
                                    drawLine(guide, Offset(0f, size.height * y), Offset(size.width, size.height * y), strokeWidth = 2f, pathEffect = if (y == 0.72f) null else dash)
                                }
                                val width = (style.baseWidth * density * 1.2).toFloat().coerceIn(2f, 14f)
                                (strokes + listOf(live.toList())).filter { it.isNotEmpty() }.forEach { points ->
                                    val path = Path()
                                    path.moveTo(points.first().x.toFloat(), points.first().y.toFloat())
                                    points.drop(1).forEach { path.lineTo(it.x.toFloat(), it.y.toFloat()) }
                                    if (points.size == 1) path.lineTo(points.first().x.toFloat() + 0.5f, points.first().y.toFloat())
                                    drawPath(path, ink, style = Stroke(width = width, cap = StrokeCap.Round, join = StrokeJoin.Round))
                                }
                            }
                        }
                        error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { if (strokes.isNotEmpty()) strokes.removeAt(strokes.lastIndex) }, enabled = strokes.isNotEmpty()) { Text(recognitionUi("Rückgängig")) }
                            TextButton(onClick = { strokes.clear() }, enabled = strokes.isNotEmpty()) { Text(recognitionUi("Leeren")) }
                            TextButton(onClick = {
                                strokes.clear()
                                val index = category.labels.indexOf(label)
                                chosen = category.labels[(index + 1) % category.labels.size]
                            }) { Text(recognitionUi("Überspringen")) }
                            Button(onClick = ::save, enabled = strokes.isNotEmpty(), modifier = Modifier.heightIn(min = 48.dp)) { Text(recognitionUi("Speichern")) }
                        }
                    }
                }
                val libraryView: @Composable () -> Unit = {
                    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            GLYPH_CATEGORIES.forEachIndexed { index, entry ->
                                val on = index == categoryIndex
                                Box(
                                    Modifier
                                        .heightIn(min = 48.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(if (on) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f) else ink.copy(alpha = 0.05f))
                                        .clickable { categoryIndex = index; strokes.clear() }
                                        .padding(horizontal = 12.dp),
                                    contentAlignment = Alignment.Center,
                                ) { Text(recognitionUi(entry.label), fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal) }
                            }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            category.labels.forEach { entry ->
                                val count = counts[entry.id] ?: 0
                                val on = entry.id == label.id
                                Box(
                                    Modifier
                                        .size(48.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(
                                            when {
                                                on -> MaterialTheme.colorScheme.primary.copy(alpha = 0.22f)
                                                count >= GLYPH_SAMPLES_PER_LABEL -> LocalStatusInk.current.success.copy(alpha = 0.16f)
                                                count > 0 -> LocalStatusInk.current.warning.copy(alpha = 0.14f)
                                                else -> ink.copy(alpha = 0.05f)
                                            },
                                        )
                                        .clickable { chosen = entry; strokes.clear() },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(entry.char, fontSize = 18.sp)
                                    if (count > 0) Text("$count", fontSize = 10.sp, color = LocalStatusInk.current.muted, modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp))
                                }
                            }
                        }
                        Text(recognitionUi("${samples.size} eigene Zeichen gespeichert. Sie bleiben auf diesem Gerät und fliessen in Text zu Handschrift ein."), fontSize = 12.sp, color = LocalStatusInk.current.muted)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { model.requestGlyphImport() }) { Text(recognitionUi("Training importieren")) }
                            val own = samples.lastOrNull { it.labelId == label.id && it.sessionId.startsWith("glyphenwerk-tablet") }
                            if (own != null) TextButton(onClick = { model.recognition.removeGlyph(own.id) }) { Text(recognitionUi("Letztes „${label.char}“ entfernen")) }
                        }
                    }
                }
                Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("GlyphenWerk", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text(recognitionUi("Schliessen")) }
                    }
                    if (wide) {
                        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                            Box(Modifier.weight(1f), contentAlignment = Alignment.TopCenter) { padView() }
                            Box(Modifier.widthIn(max = 420.dp).weight(1f)) { libraryView() }
                        }
                    } else {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) { padView() }
                        libraryView()
                    }
                }
            }
        }
    }
}

/**
 * Pen and finger input on the pad. After the first pen sample, fingers and palms are ignored
 * (the same pen-first rule as the page). Historical samples keep fast strokes smooth.
 */
private fun handlePad(
    event: MotionEvent,
    penSeen: Boolean,
    markPen: () -> Unit,
    live: ArrayList<PadPoint>,
    redraw: () -> Unit,
    finish: (List<PadPoint>) -> Unit,
): Boolean {
    val tool = event.getToolType(0)
    val pen = tool == MotionEvent.TOOL_TYPE_STYLUS
    if (pen && !penSeen) markPen()
    if (!pen && (penSeen || tool == MotionEvent.TOOL_TYPE_ERASER)) return true
    if (event.pointerCount > 1) return true
    fun point(x: Float, y: Float, t: Long, pressure: Float, tilt: Float, orientation: Float) = PadPoint(
        x.toDouble(), y.toDouble(), t.toDouble(),
        if (pen) pressure.toDouble() else 0.5,
        Math.toDegrees(tilt.toDouble() * kotlin.math.sin(orientation.toDouble())),
        Math.toDegrees(tilt.toDouble() * kotlin.math.cos(orientation.toDouble())),
        if (pen) "pen" else "touch",
    )
    when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
            live.clear()
            live += point(event.x, event.y, event.eventTime, event.pressure, event.getAxisValue(MotionEvent.AXIS_TILT), event.orientation)
        }
        MotionEvent.ACTION_MOVE -> {
            if (live.isEmpty()) return true
            for (index in 0 until event.historySize) {
                live += point(event.getHistoricalX(index), event.getHistoricalY(index), event.getHistoricalEventTime(index), event.getHistoricalPressure(index), event.getHistoricalAxisValue(MotionEvent.AXIS_TILT, index), event.getHistoricalOrientation(index))
            }
            live += point(event.x, event.y, event.eventTime, event.pressure, event.getAxisValue(MotionEvent.AXIS_TILT), event.orientation)
        }
        MotionEvent.ACTION_UP -> {
            if (live.isEmpty()) return true
            live += point(event.x, event.y, event.eventTime, event.pressure, event.getAxisValue(MotionEvent.AXIS_TILT), event.orientation)
            val start = live.first().t
            finish(live.map { it.copy(t = it.t - start) })
            live.clear()
        }
        MotionEvent.ACTION_CANCEL -> live.clear()
    }
    redraw()
    return true
}
