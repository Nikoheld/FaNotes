package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.Alignment
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
import androidx.compose.ui.unit.isSpecified
import ch.fasrv.fanotes.vault.fileKindOf
import ch.fasrv.fanotes.desk.DetailsReadingLine
import ch.fasrv.fanotes.desk.aiPreviewReading
import ch.fasrv.fanotes.famd.safeWorksheetSource
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.text.resolvePaperImagePaths
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** The banner above a search hit: where in the note or PDF the hit sits. */
@Composable
private fun HitBanner(editor: NoteEditorController, target: DocTarget) {
    val pdf = editor.note?.kind == ch.fasrv.fanotes.vault.NoteKind.PDF
    StatusLine(if (target.label.isNotBlank()) t(R.string.doc_hit_banner_label, docHitPlace(DocHit(editor.path, "", if (pdf) DOC_KIND_PDF else DOC_KIND_NOTE, target.page, target.label, Snippet("", emptyList()), PageSource.Markdown, 1.0, 0.0)))
        else if (pdf) t(R.string.doc_hit_banner, target.page) else t(R.string.doc_hit_banner_label, t(R.string.doc_note_text)), StateTone.Accent)
}

/** Uses the shared desktop reading parser rather than a second Markdown dialect. A PDF reads as a zoomable page column. */
@Composable
fun NoteReading(model: CompanionModel, editor: NoteEditorController, target: DocTarget? = null, onInk: () -> Unit) {
    if (editor.note?.kind == ch.fasrv.fanotes.vault.NoteKind.PDF) {
        Column(Modifier.fillMaxSize()) {
            if (target != null) Box(Modifier.padding(horizontal = Space.page, vertical = 4.dp)) { HitBanner(editor, target) }
            PdfReader(model.graph.root.resolve(editor.path), if (target?.label.isNullOrBlank()) target?.page ?: 0 else 0, target?.query.orEmpty(), editor.document, Modifier.weight(1f))
        }
        return
    }
    val context = LocalContext.current
    var textZoom by remember { mutableFloatStateOf(readerTextZoom(context)) }
    val terms = remember(target?.query) { parseDocQuery(target?.query.orEmpty()).terms }
    val lines by produceState<List<DetailsReadingLine>>(emptyList(), editor.markdown) {
        value = withContext(Dispatchers.Default) { aiPreviewReading(editor.markdown) }
    }
    val handwriting = editor.document?.takeIf { it.strokes.isNotEmpty() }
    Box(Modifier.fillMaxSize().textPinchZoom({ textZoom }, { textZoom = it }) { saveReaderTextZoom(context, textZoom) }) {
        SelectionContainer {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(Space.page), verticalArrangement = Arrangement.spacedBy(10.dp * textZoom)) {
            if (target != null) item(key = "hit") { HitBanner(editor, target) }
            if (plainPreview(editor.markdown).isBlank() && handwriting == null && editor.document?.strokes?.isEmpty() == true) item {
                EmptyState(androidx.compose.material.icons.Icons.Outlined.EditNote, t(R.string.a_blank_page_a_fresh_thought), t(R.string.switch_to_text_to_write_or_ink_to_draw))
            }
            itemsIndexed(lines, key = { index, line -> "line:$index:${line.kind}:${line.text.take(48)}" }) { _, line ->
                when (line.kind) {
                    "rule" -> FineDivider()
                    "image" -> {
                        val relative by produceState<String?>(null, editor.path, line.source) {
                            value = withContext(Dispatchers.IO) { resolvePaperImagePaths(editor.path, line.source).firstOrNull { model.graph.root.resolve(it).isFile } }
                        }
                        LocalNoteImage(relative?.let { model.graph.root.resolve(it) }, line.text.ifBlank { t(R.string.note_image) }, textZoom) { relative?.let(model::openFile) }
                    }
                    else -> ReadingLine(line, terms, textZoom)
                }
            }
            items(editor.note?.worksheets.orEmpty(), key = { "worksheet:$it" }) { id ->
                val relative by produceState<String?>(null, id) {
                    value = withContext(Dispatchers.IO) {
                        val record = model.graph.vault.read(".fanotes/worksheets/$id.json")?.decodeToString()
                        val data = record?.let { runCatching { parseJson(it) as? JsonValue.Obj }.getOrNull() }
                        safeWorksheetSource(id, data?.string("sourceRelativePath"))
                    }
                }
                LocalNoteImage(relative?.let { model.graph.root.resolve(it) }, t(R.string.worksheet), textZoom) { relative?.takeIf { fileKindOf(it) == ch.fasrv.fanotes.vault.NoteKind.IMAGE }?.let(model::openFile) }
            }
            handwriting?.let { ink -> item(key = "ink:${ink.updatedAt}") {
                SectionLabel(t(R.string.handwriting_preview))
                InkPreview(ink, Modifier.fillMaxWidth().aspectRatio((ink.sourceWidth / ink.sourceHeight).toFloat().coerceAtLeast(0.1f)).background(LocalCompanionSemantics.current.paper))
                if (!editor.readOnly) androidx.compose.material3.TextButton(onClick = onInk) { Text(t(R.string.open_handwriting_canvas)) }
            } }
        }
        }
        ZoomControls(textZoom,
            onMinus = { textZoom = ReaderZoomMath.step(textZoom, false, ReaderZoomMath.TEXT_MIN, ReaderZoomMath.TEXT_MAX).also { saveReaderTextZoom(context, it) } },
            onPlus = { textZoom = ReaderZoomMath.step(textZoom, true, ReaderZoomMath.TEXT_MIN, ReaderZoomMath.TEXT_MAX).also { saveReaderTextZoom(context, it) } },
            onReset = { textZoom = 1f; saveReaderTextZoom(context, 1f) },
            Modifier.align(Alignment.BottomEnd).padding(12.dp), low = ReaderZoomMath.TEXT_MIN, high = ReaderZoomMath.TEXT_MAX)
    }
}

/** Pinching with two fingers changes the text size; one finger and a long press still scroll and select. */
internal fun Modifier.textPinchZoom(current: () -> Float, set: (Float) -> Unit, onEnd: () -> Unit): Modifier = pointerInput(Unit) {
    var start = 1f
    detectReaderPinch(
        onStart = { start = current() },
        onUpdate = { scale, _ -> set(ReaderZoomMath.clampText(start * scale)) },
        onEnd = onEnd,
    )
}

/** A text style at [zoom] times its size, with the line height following. */
internal fun androidx.compose.ui.text.TextStyle.zoomed(zoom: Float): androidx.compose.ui.text.TextStyle =
    if (zoom == 1f) this else copy(
        fontSize = if (fontSize.isSpecified) fontSize * zoom else fontSize,
        lineHeight = if (lineHeight.isSpecified) lineHeight * zoom else lineHeight,
    )

@Composable
private fun ReadingLine(line: DetailsReadingLine, terms: List<String> = emptyList(), zoom: Float = 1f) {
    val colors = MaterialTheme.colorScheme
    val annotated = remember(line, colors, terms) {
        buildAnnotatedString {
            append(line.text.replace('\u001f', '│'))
            highlightRanges(line.text, terms).forEach { r ->
                val a = r.first.coerceIn(0, length); val b = (r.last + 1).coerceIn(a, length)
                if (b > a) addStyle(SpanStyle(background = colors.primaryContainer, fontWeight = FontWeight.SemiBold), a, b)
            }
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
    }.zoomed(zoom), modifier = Modifier.fillMaxWidth().then(if (line.kind in listOf("code", "table")) Modifier.horizontalScroll(rememberScrollState()) else Modifier)
        .then(if (line.kind == "code") Modifier.background(colors.surfaceVariant, MaterialTheme.shapes.small).padding(12.dp) else Modifier)
        .padding(top = if (line.heading) 12.dp else 0.dp))
}

@Composable
private fun LocalNoteImage(file: File?, label: String, zoom: Float = 1f, onOpen: () -> Unit = {}) {
    val bitmap by produceState<Bitmap?>(null, file?.path, file?.lastModified()) {
        value = if (file == null) null else decodeNoteImage(file)
    }
    if (bitmap != null) Image(bitmap!!.asImageBitmap(), label, Modifier.fillMaxWidth().heightIn(max = 500.dp).clickable(role = Role.Button, onClickLabel = t(R.string.open_image), onClick = onOpen))
    else Text(label, style = MaterialTheme.typography.bodySmall.zoomed(zoom), color = MaterialTheme.colorScheme.onSurfaceVariant)
}
