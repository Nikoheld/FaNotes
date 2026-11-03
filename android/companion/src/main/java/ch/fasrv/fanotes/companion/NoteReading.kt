package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.desk.DetailsReadingLine
import ch.fasrv.fanotes.desk.aiPreviewReading
import ch.fasrv.fanotes.famd.safeWorksheetSource
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.text.resolvePaperImagePaths
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Uses the shared desktop reading parser rather than a second Markdown dialect. */
@Composable
fun NoteReading(model: CompanionModel, editor: NoteEditorController, onInk: () -> Unit) {
    val lines by produceState<List<DetailsReadingLine>>(emptyList(), editor.markdown) {
        value = withContext(Dispatchers.Default) { aiPreviewReading(editor.markdown) }
    }
    SelectionContainer {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(Space.page), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (editor.note?.kind == ch.fasrv.fanotes.vault.NoteKind.PDF) item { PdfReader(model.graph.root.resolve(editor.path)) }
        if (plainPreview(editor.markdown).isBlank() && editor.document?.strokes?.isEmpty() == true && editor.note?.kind != ch.fasrv.fanotes.vault.NoteKind.PDF) item {
            EmptyState(androidx.compose.material.icons.Icons.Outlined.EditNote, "A blank page, a fresh thought", "Switch to Text to write, or Ink to draw.")
        }
        items(lines) { line ->
            when (line.kind) {
                "rule" -> FineDivider()
                "image" -> {
                    val file by produceState<File?>(null, editor.path, line.source) {
                        value = withContext(Dispatchers.IO) { resolvePaperImagePaths(editor.path, line.source).map { model.graph.root.resolve(it) }.firstOrNull { it.isFile } }
                    }
                    LocalNoteImage(file, line.text.ifBlank { "Note image" })
                }
                else -> ReadingLine(line)
            }
        }
        items(editor.note?.worksheets.orEmpty(), key = { "worksheet:$it" }) { id ->
            val file by produceState<File?>(null, id) {
                value = withContext(Dispatchers.IO) {
                    val record = model.graph.vault.read(".fanotes/worksheets/$id.json")?.decodeToString()
                    val data = record?.let { runCatching { parseJson(it) as? JsonValue.Obj }.getOrNull() }
                    safeWorksheetSource(id, data?.string("sourceRelativePath"))?.let { model.graph.root.resolve(it) }
                }
            }
            LocalNoteImage(file, "Worksheet")
        }
        editor.document?.takeIf { it.strokes.isNotEmpty() }?.let { ink -> item {
            SectionLabel("Handwriting preview")
            InkThumbnail(ink, Modifier.fillMaxWidth().aspectRatio((ink.sourceWidth / ink.sourceHeight).toFloat().coerceAtLeast(0.1f)).background(LocalCompanionSemantics.current.paper).padding(12.dp))
            androidx.compose.material3.TextButton(onClick = onInk) { Text("Open handwriting canvas") }
        } }
    }
    }
}

@Composable
private fun ReadingLine(line: DetailsReadingLine) {
    val colors = MaterialTheme.colorScheme
    val annotated = remember(line, colors) {
        buildAnnotatedString {
            append(line.text.replace('\u001f', '│'))
            line.inlines.forEach { mark ->
                val start = mark.start.coerceIn(0, length); val end = mark.end.coerceIn(start, length)
                if (end <= start) return@forEach
                val style = when (mark.kind) {
                    "strong" -> SpanStyle(fontWeight = FontWeight.Bold)
                    "emphasis" -> SpanStyle(fontStyle = FontStyle.Italic)
                    "strike" -> SpanStyle(textDecoration = TextDecoration.LineThrough)
                    "code", "kbd" -> SpanStyle(fontFamily = CompanionMono, background = colors.surfaceVariant)
                    "underline" -> SpanStyle(textDecoration = TextDecoration.Underline)
                    "mark" -> SpanStyle(background = colors.primaryContainer)
                    "sub" -> SpanStyle(baselineShift = BaselineShift.Subscript)
                    "sup" -> SpanStyle(baselineShift = BaselineShift.Superscript)
                    else -> SpanStyle()
                }
                addStyle(style, start, end)
                if (mark.kind == "link" && listOf("https://", "http://", "mailto:").any { mark.target.startsWith(it, true) }) {
                    addLink(LinkAnnotation.Url(mark.target, TextLinkStyles(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline))), start, end)
                }
            }
        }
    }
    Text(annotated, style = when {
        line.heading -> if (line.scale >= 1.4f) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.titleLarge
        line.kind in listOf("code", "table", "math") -> MaterialTheme.typography.bodyMedium.copy(fontFamily = CompanionMono)
        else -> MaterialTheme.typography.bodyLarge
    }, modifier = Modifier.fillMaxWidth().then(if (line.kind in listOf("code", "table")) Modifier.horizontalScroll(rememberScrollState()) else Modifier)
        .then(if (line.kind == "code") Modifier.background(colors.surfaceVariant, MaterialTheme.shapes.small).padding(12.dp) else Modifier)
        .padding(top = if (line.heading) 12.dp else 0.dp))
}

@Composable
private fun LocalNoteImage(file: File?, label: String) {
    val bitmap by produceState<Bitmap?>(null, file?.path) {
        value = withContext(Dispatchers.IO) {
            if (file == null) return@withContext null
            runCatching {
                val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.path, options)
                var sample = 1
                while (options.outWidth / sample > 1600 || options.outHeight / sample > 2400) sample *= 2
                BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
            }.getOrNull()
        }
    }
    if (bitmap != null) Image(bitmap!!.asImageBitmap(), label, Modifier.fillMaxWidth().heightIn(max = 500.dp))
    else Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
