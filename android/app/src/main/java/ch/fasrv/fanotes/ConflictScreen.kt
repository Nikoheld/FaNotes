package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.sync.ConflictPreview
import ch.fasrv.fanotes.sync.SyncConflict
import ch.fasrv.fanotes.sync.changedLines
import ch.fasrv.fanotes.sync.conflictChoiceLabel
import ch.fasrv.fanotes.sync.conflictSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Smallest touch target of this screen (the app guideline is 48 dp). */
private val Target = 48.dp

/**
 * The conflict screen (destination `conflicts`): the list of conflicting files, and for the selected one the two
 * versions side by side with a preview of handwriting, text, PDF, image or story, and the three ways to settle it.
 * The server's version keeps the path; the tablet's version was saved next to it by the sync engine.
 */
@Composable
fun ConflictScreen(model: FaNotesViewModel, onClose: () -> Unit) {
    val sync by model.sync.collectAsStateWithLifecycle()
    val versions by model.conflictVersions.collectAsStateWithLifecycle()
    val conflicts = sync.conflicts.asReversed()
    var selectedCopy by remember { mutableStateOf<String?>(null) }
    val selected = conflicts.firstOrNull { it.copyPath == selectedCopy } ?: conflicts.firstOrNull()
    LaunchedEffect(selected?.copyPath) {
        if (selected != null) model.loadConflictVersions(selected) else model.conflictVersions.value = null
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        val wide = maxWidth >= 840.dp
        if (conflicts.isEmpty()) {
            EmptyConflicts(onClose)
            return@BoxWithConstraints
        }
        if (wide) {
            Row(Modifier.fillMaxSize()) {
                Column(Modifier.width(300.dp).fillMaxHeight()) {
                    ConflictListHeader(conflicts.size, onClear = { model.clearSyncConflicts() })
                    LazyColumn(Modifier.weight(1f)) {
                        items(conflicts, key = { it.copyPath }) { conflict ->
                            ConflictRow(conflict, conflict.copyPath == selected?.copyPath) { selectedCopy = conflict.copyPath }
                        }
                    }
                }
                Box1pxDivider()
                ConflictDetail(model, selected, versions, wide = true, modifier = Modifier.weight(1f).fillMaxHeight())
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                ConflictListHeader(conflicts.size, onClear = { model.clearSyncConflicts() })
                LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(conflicts, key = { it.copyPath }) { conflict ->
                        val on = conflict.copyPath == selected?.copyPath
                        Text(
                            conflict.path.substringAfterLast('/'),
                            maxLines = 1,
                            fontSize = 14.sp,
                            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier
                                .heightIn(min = Target)
                                .clip(RoundedCornerShape(24.dp))
                                .background(if (on) MaterialTheme.colorScheme.primary.copy(alpha = 0.16f) else LocalStatusInk.current.panelActive)
                                .clickable { selectedCopy = conflict.copyPath }
                                .padding(horizontal = 16.dp, vertical = 13.dp),
                        )
                    }
                }
                ConflictDetail(model, selected, versions, wide = false, modifier = Modifier.weight(1f).fillMaxWidth())
            }
        }
    }
}

@Composable
private fun Box1pxDivider() {
    androidx.compose.foundation.layout.Box(
        Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)),
    )
}

@Composable
private fun EmptyConflicts(onClose: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(ui("Keine Konflikte"), fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Text(
            ui("Alle Geräte haben dieselbe Fassung. Ein Konflikt entsteht, wenn dieselbe Datei auf zwei Geräten geändert wurde."),
            fontSize = 14.sp,
            color = LocalStatusInk.current.muted,
            modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
        )
        OutlinedButton(onClick = onClose, modifier = Modifier.heightIn(min = Target)) { Text(ui("Zu den Notizen")) }
    }
}

@Composable
private fun ConflictListHeader(count: Int, onClear: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(ui("Sync-Konflikte"), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, letterSpacing = 1.sp)
            Text(if (count == 1) "1 Datei" else "$count Dateien", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
        TextButton(onClick = onClear, modifier = Modifier.heightIn(min = Target)) { Text(ui("Liste leeren")) }
    }
}

@Composable
private fun ConflictRow(conflict: SyncConflict, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.12f) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(conflict.path.substringAfterLast('/'), fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        Text(
            conflict.path.substringBeforeLast('/', "").ifEmpty { "Hauptordner" } + " · " + conflict.at.take(16).replace('T', ' '),
            fontSize = 12.sp,
            color = LocalStatusInk.current.muted,
            maxLines = 1,
        )
    }
}

@Composable
private fun ConflictDetail(
    model: FaNotesViewModel,
    conflict: SyncConflict?,
    versions: FaNotesViewModel.ConflictVersions?,
    wide: Boolean,
    modifier: Modifier,
) {
    if (conflict == null) return
    val ready = versions?.takeIf { it.copyPath == conflict.copyPath }
    val markdown = ch.fasrv.fanotes.sync.isMarkdownConflictPath(conflict.path)
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column {
            Text(conflict.path, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Die Serverfassung hat den Pfad behalten. Die Fassung dieses Tablets liegt als „${conflict.copyPath.substringAfterLast('/')}“ daneben.",
                fontSize = 13.sp,
                color = LocalStatusInk.current.muted,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        if (ready == null) {
            Text(ui("Fassungen werden gelesen …"), fontSize = 14.sp, color = LocalStatusInk.current.muted)
        } else {
            val diff = if (ready.remote is ConflictPreview.Note && ready.local is ConflictPreview.Note) {
                changedLines(ready.remote.lines, ready.local.lines)
            } else {
                null
            }
            if (wide) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    VersionPanel("Serverfassung", "bleibt auf dem Pfad", ready.remote, diff?.original, conflict.path, model, Modifier.weight(1f))
                    VersionPanel("Dieses Tablet", "liegt in der Kopie", ready.local, diff?.copy, conflict.copyPath, model, Modifier.weight(1f))
                }
            } else {
                VersionPanel("Serverfassung", "bleibt auf dem Pfad", ready.remote, diff?.original, conflict.path, model, Modifier.fillMaxWidth())
                VersionPanel("Dieses Tablet", "liegt in der Kopie", ready.local, diff?.copy, conflict.copyPath, model, Modifier.fillMaxWidth())
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(ui("Welche Fassung soll gelten?"), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            val buttons = listOf(
                Triple("remote", conflictChoiceLabel("remote"), true),
                Triple("local", conflictChoiceLabel("local"), true),
                Triple("both", conflictChoiceLabel("both"), markdown),
            ).filter { it.third }
            if (wide) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    buttons.forEach { (id, label, _) -> ChoiceButton(id, label, Modifier.weight(1f)) { model.resolveConflict(conflict, id) } }
                }
            } else {
                buttons.forEach { (id, label, _) -> ChoiceButton(id, label, Modifier.fillMaxWidth()) { model.resolveConflict(conflict, id) } }
            }
            Text(
                ui(if (markdown) "„Zusammenführen“ hängt Absätze, die nur auf dem Tablet stehen, an die Serverfassung an." else "Die andere Fassung wird gelöscht, sobald du dich entschieden hast."),
                fontSize = 12.sp,
                color = LocalStatusInk.current.muted,
            )
        }
    }
}

@Composable
private fun ChoiceButton(id: String, label: String, modifier: Modifier, onClick: () -> Unit) {
    if (id == "both") {
        OutlinedButton(onClick = onClick, modifier = modifier.heightIn(min = 52.dp)) { Text(label, fontSize = 15.sp) }
    } else {
        Button(
            onClick = onClick,
            modifier = modifier.heightIn(min = 52.dp),
            colors = if (id == "remote") ButtonDefaults.buttonColors() else ButtonDefaults.filledTonalButtonColors(),
        ) { Text(label, fontSize = 15.sp) }
    }
}

@Composable
private fun VersionPanel(
    title: String,
    subtitle: String,
    preview: ConflictPreview,
    changed: Set<Int>?,
    path: String,
    model: FaNotesViewModel,
    modifier: Modifier,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.14f), RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(ui(title), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(ui(subtitle), fontSize = 12.sp, color = LocalStatusInk.current.muted)
        }
        Text(conflictSummary(preview), fontSize = 12.sp, color = LocalStatusInk.current.muted)
        when (preview) {
            ConflictPreview.Missing -> Text(ui("Diese Fassung gibt es nicht mehr."), fontSize = 13.sp)
            is ConflictPreview.Damaged -> Text(ui("Die Datei ist beschädigt und lässt sich nicht lesen."), fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
            is ConflictPreview.Note -> {
                preview.ink?.let { InkThumb(it) }
                TextLines(preview.lines, changed)
            }
            is ConflictPreview.Ink -> preview.ink?.let { InkThumb(it) } ?: Text(ui("Leere Seite"), fontSize = 13.sp)
            is ConflictPreview.Text -> TextLines(preview.lines, null)
            is ConflictPreview.Story -> TextLines(preview.lines, null)
            is ConflictPreview.Image -> BitmapPreview(preview.bytes)
            is ConflictPreview.Pdf -> PdfFirstPage(path, model)
            is ConflictPreview.Binary -> Text(ui("Für diesen Dateityp gibt es keine Vorschau."), fontSize = 13.sp)
        }
    }
}

@Composable
private fun TextLines(lines: List<String>, changed: Set<Int>?) {
    if (lines.isEmpty()) {
        Text(ui("Kein Text"), fontSize = 13.sp, color = LocalStatusInk.current.muted)
        return
    }
    val highlight = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 360.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        lines.take(400).forEachIndexed { index, line ->
            Text(
                line.ifEmpty { " " },
                fontSize = 13.sp,
                fontFamily = FontFamily.Default,
                lineHeight = 19.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(if (changed != null && index in changed) highlight else Color.Transparent)
                    .padding(horizontal = 4.dp),
            )
        }
        if (lines.size > 400) Text("… ${lines.size - 400} weitere Zeilen", fontSize = 12.sp, color = LocalStatusInk.current.muted)
    }
}

/** The handwriting of a version as a small picture: every stroke scaled to fit, on white paper. */
@Composable
private fun InkThumb(document: InkDocument) {
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(240.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(Color.White)
            .border(1.dp, Color(0x22000000), RoundedCornerShape(6.dp)),
    ) {
        val width = document.sourceWidth.toFloat().coerceAtLeast(1f)
        val height = document.sourceHeight.toFloat().coerceAtLeast(1f)
        val scale = minOf(size.width / width, size.height / height)
        val left = (size.width - width * scale) / 2f
        for (stroke in document.strokes.take(2500)) {
            if (stroke.points.isEmpty() || stroke.symbolId != null) continue
            val color = runCatching { Color(android.graphics.Color.parseColor(stroke.color)) }.getOrDefault(Color(0xFF20222B))
            val line = (stroke.baseWidth.toFloat() * scale).coerceAtLeast(1.2f)
            if (stroke.points.size == 1) {
                val point = stroke.points[0]
                drawCircle(color, line / 2f, Offset(left + point.x.toFloat() * width * scale, point.y.toFloat() * height * scale))
                continue
            }
            val path = Path()
            stroke.points.forEachIndexed { index, point ->
                val x = left + point.x.toFloat() * width * scale
                val y = point.y.toFloat() * height * scale
                if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            drawPath(path, color.copy(alpha = (stroke.opacity ?: 1.0).toFloat().coerceIn(0.1f, 1f)), style = Stroke(line, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

@Composable
private fun BitmapPreview(bytes: ByteArray) {
    val bitmap by produceBitmap(bytes) { data -> decodeSampled(data, 1200) }
    ShowBitmap(bitmap)
}

@Composable
private fun PdfFirstPage(path: String, model: FaNotesViewModel) {
    val bitmap by produceBitmap(path) { key ->
        val bytes = model.conflictFileBytes(key) ?: return@produceBitmap null
        renderFirstPdfPage(bytes, 900)
    }
    ShowBitmap(bitmap, "Die erste Seite lässt sich nicht anzeigen.")
}

@Composable
private fun ShowBitmap(bitmap: Bitmap?, missing: String = "Vorschau wird geladen …") {
    if (bitmap == null) {
        Text(ui(missing), fontSize = 13.sp, color = LocalStatusInk.current.muted)
        return
    }
    Image(
        bitmap.asImageBitmap(),
        contentDescription = null,
        modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).clip(RoundedCornerShape(6.dp)).border(1.dp, Color(0x22000000), RoundedCornerShape(6.dp)),
    )
}

@Composable
private fun <K> produceBitmap(key: K, load: suspend (K) -> Bitmap?): androidx.compose.runtime.State<Bitmap?> =
    androidx.compose.runtime.produceState<Bitmap?>(null, key) {
        value = withContext(Dispatchers.IO) { runCatching { load(key) }.getOrNull() }
    }

private fun decodeSampled(bytes: ByteArray, maxSide: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / sample > maxSide * 2 || bounds.outHeight / sample > maxSide * 2) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}

/** Page one of a PDF as a bitmap, or null when it cannot be opened (a password, a damaged file). */
private fun renderFirstPdfPage(bytes: ByteArray, width: Int): Bitmap? {
    val file = File.createTempFile("fanotes-conflict", ".pdf")
    return try {
        file.writeBytes(bytes)
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
            PdfRenderer(descriptor).use { renderer ->
                if (renderer.pageCount == 0) return null
                renderer.openPage(0).use { page ->
                    val height = (width.toFloat() * page.height / page.width).toInt().coerceIn(1, 2400)
                    Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap ->
                        bitmap.eraseColor(android.graphics.Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    }
                }
            }
        }
    } catch (_: Exception) {
        null
    } finally {
        file.delete()
    }
}
