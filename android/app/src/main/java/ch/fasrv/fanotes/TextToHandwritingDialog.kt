package ch.fasrv.fanotes

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.fasrv.fanotes.ink.GlyphSample
import ch.fasrv.fanotes.ink.HandwritingPage
import ch.fasrv.fanotes.ink.HandwritingSynthesisOptions
import ch.fasrv.fanotes.ink.HandwritingSynthesisResult
import ch.fasrv.fanotes.ink.createHandwritingSeed
import ch.fasrv.fanotes.ink.glyphsForSynthesis
import ch.fasrv.fanotes.ink.synthesizeHandwriting
import ch.fasrv.fanotes.ink.synthesizeHandwritingToFit
import kotlin.math.max

@Composable
fun TextToHandwritingDialog(
    personal: List<GlyphSample>,
    pageWidth: Double,
    pageHeight: Double,
    startY: Double,
    color: String,
    baseWidth: Double,
    pressure: Boolean,
    onDismiss: () -> Unit,
    onImport: () -> Unit,
    onClear: () -> Unit,
    onInsert: (HandwritingSynthesisResult) -> Unit,
) {
    BackHandler(onBack = onDismiss)
    var text by remember { mutableStateOf("") }
    var fontSize by remember { mutableFloatStateOf(42f) }
    var lineSpacing by remember { mutableFloatStateOf(1.42f) }
    var variation by remember { mutableFloatStateOf(0.62f) }
    var connect by remember { mutableStateOf(true) }
    var fit by remember { mutableStateOf(true) }
    var atStart by remember { mutableStateOf(false) }
    var seed by remember { mutableIntStateOf(createHandwritingSeed()) }
    val samples = remember(personal) { glyphsForSynthesis(personal) }
    val options = HandwritingSynthesisOptions(
        fontSize = fontSize.toDouble(),
        lineSpacing = lineSpacing.toDouble(),
        variation = variation.toDouble(),
        connectLetters = connect,
        color = color,
        baseWidth = baseWidth,
        pressureEnabled = pressure,
        seed = seed,
        startY = if (atStart) null else startY,
    )
    val page = HandwritingPage(pageWidth, pageHeight)
    val result = remember(text, options, samples, page, fit) {
        if (text.isBlank()) synthesizeHandwriting("", samples, options, page)
        else if (fit) synthesizeHandwritingToFit(text, samples, options, page)
        else synthesizeHandwriting(text, samples, options, page)
    }
    val canInsert = result.strokes.isNotEmpty() && result.missingCharacters.isEmpty() && !result.overflow
    val wide = LocalConfiguration.current.screenWidthDp >= 800
    val context = LocalContext.current
    val scrim = remember { MutableInteractionSource() }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0x590F0F0F))
            .clickable(interactionSource = scrim, indication = null, onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .padding(16.dp)
                .widthIn(max = 1080.dp)
                .fillMaxWidth()
                .heightIn(max = (LocalConfiguration.current.screenHeightDp - 32).dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.background)
                .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.16f), RoundedCornerShape(12.dp))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = {})
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Text in deine Handschrift", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "FaNotes setzt jedes Zeichen aus deinen GlyphenWerk-Strichen. Fehlende Buchstaben kommen aus der Schulschrift.",
                        fontSize = 12.sp,
                        color = LocalStatusInk.current.muted,
                    )
                }
                Text("Schließen", modifier = Modifier.clickable(onClick = onDismiss), fontSize = 12.sp)
            }
            if (wide) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    HandwritingControls(
                        text, { text = it.take(8_000) }, fontSize, { fontSize = it }, lineSpacing, { lineSpacing = it },
                        variation, { variation = it }, connect, { connect = it }, fit, { fit = it }, atStart, { atStart = it },
                        personal.isEmpty(), result, { text = pasteInto(context, text) }, onImport, onClear,
                        Modifier.weight(1f),
                    )
                    HandwritingPreviewPane(result, fontSize, text.isNotBlank()) { seed = createHandwritingSeed() }
                }
            } else {
                HandwritingControls(
                    text, { text = it.take(8_000) }, fontSize, { fontSize = it }, lineSpacing, { lineSpacing = it },
                    variation, { variation = it }, connect, { connect = it }, fit, { fit = it }, atStart, { atStart = it },
                    personal.isEmpty(), result, { text = pasteInto(context, text) }, onImport, onClear,
                    Modifier.fillMaxWidth(),
                )
                HandwritingPreviewPane(result, fontSize, text.isNotBlank()) { seed = createHandwritingSeed() }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Jede Erzeugung variiert Form, Neigung, Grundlinie und Druck.",
                    fontSize = 12.sp,
                    color = LocalStatusInk.current.muted,
                    modifier = Modifier.weight(1f),
                )
                Text("Abbrechen", modifier = Modifier.clickable(onClick = onDismiss).padding(8.dp), fontSize = 13.sp)
                val insertColor = if (canInsert) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted
                Text(
                    "Als Handschrift einfügen",
                    color = MaterialTheme.colorScheme.background,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(insertColor)
                        .clickable(enabled = canInsert) { onInsert(result) }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun HandwritingControls(
    text: String,
    onText: (String) -> Unit,
    fontSize: Float,
    onFont: (Float) -> Unit,
    lineSpacing: Float,
    onSpacing: (Float) -> Unit,
    variation: Float,
    onVariation: (Float) -> Unit,
    connect: Boolean,
    onConnect: (Boolean) -> Unit,
    fit: Boolean,
    onFit: (Boolean) -> Unit,
    atStart: Boolean,
    onAtStart: (Boolean) -> Unit,
    schoolOnly: Boolean,
    result: HandwritingSynthesisResult,
    onPaste: () -> Unit,
    onImport: () -> Unit,
    onClear: () -> Unit,
    modifier: Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Text", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
        BasicTextField(
            value = text,
            onValueChange = onText,
            textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 120.dp)
                .clip(RoundedCornerShape(12.dp))
                .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.16f), RoundedCornerShape(12.dp))
                .padding(12.dp),
            decorationBox = { inner ->
                Box {
                    if (text.isEmpty()) Text("Schreibe oder füge hier deinen Text ein …", color = LocalStatusInk.current.muted, fontSize = 14.sp)
                    inner()
                }
            },
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Einfügen", fontSize = 12.sp, modifier = Modifier.clickable(onClick = onPaste))
            Text("${text.length} / 8 000", fontSize = 12.sp, color = LocalStatusInk.current.muted)
        }
        HandSlider("Schriftgröße", "${fontSize.toInt()} px", fontSize, 20f, 72f, onFont)
        HandSlider("Zeilenabstand", "%.2f×".format(lineSpacing), lineSpacing, 1.05f, 2f, onSpacing)
        HandSlider("Natürliche Variation", "${(variation * 100).toInt()}%", variation, 0f, 1f, onVariation)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Buchstaben verbinden", connect) { onConnect(!connect) }
            Choice("An Seite anpassen", fit) { onFit(!fit) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Nach der letzten Handschrift", !atStart) { onAtStart(false) }
            Choice("Am Seitenanfang", atStart) { onAtStart(true) }
        }
        if (schoolOnly) {
            Text(
                "Deine Schrift fehlt noch. Importiere ein GlyphenWerk-Training, sonst bleibt es die Schulschrift.",
                fontSize = 12.sp,
                color = Color(0xFFB8860B),
            )
        }
        if (result.missingCharacters.isNotEmpty()) {
            Text(
                "Noch nicht trainierte Zeichen: ${result.missingCharacters.joinToString(" · ")}",
                fontSize = 12.sp,
                color = Color(0xFFB8860B),
            )
        }
        if (result.overflow) {
            Text(
                "Der Text passt nicht auf diese Seite. ${result.overflowCharacters} Zeichen haben keinen Platz.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Training importieren", fontSize = 12.sp, modifier = Modifier.clickable(onClick = onImport))
            if (!schoolOnly) Text("Training entfernen", fontSize = 12.sp, modifier = Modifier.clickable(onClick = onClear))
        }
    }
}

@Composable
private fun HandSlider(label: String, value: String, current: Float, min: Float, max: Float, onChange: (Float) -> Unit) {
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, fontSize = 12.sp, color = LocalStatusInk.current.muted)
            Text(value, fontSize = 12.sp)
        }
        Slider(value = current, onValueChange = onChange, valueRange = min..max)
    }
}

@Composable
private fun Choice(label: String, active: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Text(
        label,
        fontSize = 12.sp,
        color = if (active) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
        modifier = Modifier
            .clip(shape)
            .background(if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = if (active) 0.28f else 0.1f), shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

@Composable
private fun HandwritingPreviewPane(
    result: HandwritingSynthesisResult,
    requested: Float,
    enabled: Boolean,
    onReseed: () -> Unit,
) {
    Column(Modifier.widthIn(min = 280.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text("Live-Vorschau", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                Text(
                    "${result.glyphCount} Zeichen · ${result.lineCount} Zeilen · ${result.connectionCount} Verbindungen",
                    fontSize = 12.sp,
                    color = LocalStatusInk.current.muted,
                )
            }
            Text(
                "Neu variieren",
                fontSize = 12.sp,
                color = if (enabled) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
                modifier = Modifier.clickable(enabled = enabled, onClick = onReseed),
            )
        }
        val ratio = (result.pageWidth / result.pageHeight.coerceAtLeast(1.0)).toFloat().coerceIn(0.2f, 1.2f)
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFFE7E2D8)),
        ) {
            Canvas(Modifier.fillMaxWidth().aspectRatio(ratio).background(Color(0xFFFBF8F2))) {
                for (stroke in result.strokes) {
                    val paint = runCatching { Color(android.graphics.Color.parseColor(stroke.color)) }.getOrDefault(Color(0xFF202333))
                    val widthScale = size.width / result.pageWidth.toFloat()
                    if (stroke.points.size <= 1) {
                        val point = stroke.points.firstOrNull() ?: continue
                        drawCircle(
                            paint,
                            radius = (stroke.baseWidth * widthScale / 2.0).toFloat().coerceAtLeast(1.2f),
                            center = Offset(point.x.toFloat() * size.width, point.y.toFloat() * size.height),
                        )
                    } else {
                        for (index in 1 until stroke.points.size) {
                            val previous = stroke.points[index - 1]
                            val point = stroke.points[index]
                            val pressure = (previous.pressure + point.pressure) / 2.0
                            val nib = if (stroke.pressureEnabled) stroke.baseWidth * (0.4 + max(0.08, pressure) * 1.12) else stroke.baseWidth
                            drawLine(
                                paint,
                                Offset(previous.x.toFloat() * size.width, previous.y.toFloat() * size.height),
                                Offset(point.x.toFloat() * size.width, point.y.toFloat() * size.height),
                                strokeWidth = (nib * widthScale).toFloat().coerceAtLeast(1.1f),
                                cap = StrokeCap.Round,
                            )
                        }
                    }
                }
            }
            if (result.strokes.isEmpty()) {
                Text(
                    "Deine Vorschau erscheint hier",
                    fontSize = 12.sp,
                    color = LocalStatusInk.current.muted,
                    modifier = Modifier.align(Alignment.Center),
                )
            }
        }
        if (result.fontSizeUsed < requested - 0.5) {
            Text("Für den verfügbaren Platz automatisch auf ${result.fontSizeUsed.toInt()} px angepasst.", fontSize = 12.sp, color = LocalStatusInk.current.muted)
        }
    }
}

private fun pasteInto(context: Context, current: String): String {
    val incoming = clipboardPlainText(context).orEmpty()
    if (incoming.isEmpty()) return current
    return (current + incoming).take(8_000)
}
