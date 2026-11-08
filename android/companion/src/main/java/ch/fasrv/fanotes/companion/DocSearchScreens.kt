package ch.fasrv.fanotes.companion

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

fun docHitPlace(hit: DocHit): String = when {
    hit.label.startsWith("worksheet:") -> t(R.string.doc_worksheet, hit.label.substringAfter(':').toIntOrNull() ?: 1)
    hit.label == "handwriting" -> t(R.string.doc_handwriting)
    hit.label == "annotations" -> t(R.string.doc_annotations)
    hit.kind == DOC_KIND_PDF -> t(R.string.doc_page, hit.page)
    else -> t(R.string.doc_note_text)
}

fun docProblemLabel(problem: DocProblem): String = when (problem) {
    DocProblem.Encrypted -> t(R.string.problem_encrypted)
    DocProblem.Unreadable -> t(R.string.problem_unreadable)
    DocProblem.TooLarge -> t(R.string.problem_too_large)
    DocProblem.OcrFailed -> t(R.string.problem_ocr_failed)
    DocProblem.OcrEmpty -> t(R.string.problem_ocr_empty)
    DocProblem.OcrLimit -> t(R.string.problem_ocr_limit)
    DocProblem.PageLimit -> t(R.string.problem_page_limit)
    DocProblem.NoOcrEngine -> t(R.string.problem_no_ocr)
    DocProblem.ImageUnreadable -> t(R.string.problem_image)
    DocProblem.None -> t(R.string.problem_pending)
}

/** One search hit: title, where in the document, and the matching words highlighted in the snippet. */
@Composable
fun DocHitRow(hit: DocHit, onOpen: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val snippet = remember(hit.snippet, scheme) {
        buildAnnotatedString {
            append(hit.snippet.text)
            hit.snippet.highlights.forEach { r ->
                val a = r.first.coerceIn(0, length); val b = (r.last + 1).coerceIn(a, length)
                if (b > a) addStyle(SpanStyle(background = scheme.primaryContainer, fontWeight = FontWeight.SemiBold, color = scheme.onSurface), a, b)
            }
        }
    }
    val place = docHitPlace(hit)
    val inset = if (LocalInGroup.current) 16.dp else 0.dp
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onOpen).padding(horizontal = inset, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        IconTile(if (hit.kind == DOC_KIND_PDF) Icons.Outlined.PictureAsPdf else if (hit.label.startsWith("worksheet")) Icons.Outlined.Image else Icons.AutoMirrored.Outlined.Article, StateTone.Neutral, 40.dp)
        Column(Modifier.weight(1f)) {
            Text(hit.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(listOf(hit.path.substringBeforeLast('/', "").ifBlank { t(R.string.my_notes) }, place).joinToString("  ·  "), style = MaterialTheme.typography.labelMedium, color = scheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(snippet, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            val notes = buildList {
                if (hit.source == PageSource.Ocr) add(t(R.string.doc_ocr_confidence, (hit.confidence * 100).toInt().coerceIn(0, 100)))
                if (hit.source == PageSource.DesktopOcr) add(t(R.string.doc_desktop_ocr))
                if (hit.duplicates > 0) add(tp(R.plurals.doc_duplicates, hit.duplicates, hit.duplicates))
            }
            if (notes.isNotEmpty()) Text(notes.joinToString("  ·  "), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

/** Index progress, pause or readiness in one quiet line. */
@Composable
fun DocIndexStatusLine(status: DocSearchStatus, modifier: Modifier = Modifier) {
    when {
        status.paused -> StatusLine(t(R.string.doc_index_paused), StateTone.Warning, modifier)
        status.running && status.progress.total > 0 -> Column(modifier) {
            StatusLine(t(R.string.doc_index_progress, status.progress.done, status.progress.total), StateTone.Accent)
            LinearProgressIndicator(progress = { status.progress.done.toFloat() / status.progress.total.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp), trackColor = LocalCompanionSemantics.current.sunken)
        }
        !status.ready && status.enabled -> StatusLine(t(R.string.docs_not_ready), StateTone.Neutral, modifier)
    }
}

/** Settings → Dokumentsuche: progress, pause, retry, rebuild, honest capabilities and failures. */
@Composable
fun DocSearchSettings(model: CompanionModel) {
    val status = model.docStatus
    var problems by remember { mutableStateOf<List<Pair<DocRecord, List<PageEntry>>>>(emptyList()) }
    var confirmRebuild by remember { mutableStateOf(false) }
    LaunchedEffect(status.running, status.stats) { problems = runCatching { model.graph.docSearch.problems() }.getOrDefault(emptyList()) }
    LaunchedEffect(Unit) { model.graph.docSearch.request() }
    ScreenList {
        item(key = "intro") {
            Text(t(R.string.doc_search_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
            Group {
                Column(Modifier.padding(16.dp)) {
                    Text(tp(R.plurals.doc_searchable, status.stats.documents, status.stats.documents), style = MaterialTheme.typography.titleMedium)
                    Text(t(R.string.doc_stats, status.stats.documents, status.stats.pages, status.stats.ocrPages), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
                    DocIndexStatusLine(status, Modifier.padding(top = 10.dp))
                }
                FineDivider()
                ToggleRow(t(R.string.doc_pause), t(R.string.doc_pause_body), status.paused) { model.graph.docSearch.setPaused(it) }
            }
            Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton(t(R.string.doc_retry), { model.graph.docSearch.retryFailed() }, Modifier.fillMaxWidth(), enabled = !status.paused, icon = Icons.Outlined.Refresh)
                SecondaryButton(t(R.string.doc_rebuild), { confirmRebuild = true }, Modifier.fillMaxWidth(), icon = Icons.Outlined.RestartAlt)
            }
        }
        item(key = "caps-head") { SectionLabel(t(R.string.doc_capabilities)) }
        item(key = "caps") {
            Group {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatusLine(if (status.textLayer) t(R.string.doc_cap_text_layer_yes) else t(R.string.doc_cap_text_layer_no), if (status.textLayer) StateTone.Accent else StateTone.Warning)
                    StatusLine(if (status.ocrAvailable) t(R.string.doc_cap_ocr) else t(R.string.doc_cap_ocr_missing), if (status.ocrAvailable) StateTone.Accent else StateTone.Error)
                    StatusLine(t(R.string.doc_cap_handwriting), StateTone.Neutral)
                }
            }
        }
        item(key = "problems-head") { SectionLabel(t(R.string.doc_problems), count = problems.size.takeIf { it > 0 }) }
        if (problems.isEmpty()) item(key = "no-problems") { StatusLine(t(R.string.doc_no_problems), StateTone.Accent) }
        itemsIndexed(problems, key = { _, it -> "problem:${it.first.path}" }) { index, (doc, pages) ->
            GroupItem(index, problems.size) {
                Column(Modifier.fillMaxWidth().clickable(role = Role.Button) { model.openNote(doc.path) }.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text(doc.title.ifBlank { doc.path }, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    val reasons = (listOfNotNull(doc.problem.takeIf { it != DocProblem.None }) + pages.map { it.problem }).distinct()
                        .ifEmpty { if (doc.status == DocStatus.Pending) listOf(DocProblem.None) else emptyList() }
                    Text(reasons.joinToString("  ·  ") { docProblemLabel(it) }, style = MaterialTheme.typography.bodySmall, color = if (doc.status == DocStatus.Pending) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
                    if (pages.isNotEmpty() && doc.kind == DOC_KIND_PDF) Text(t(R.string.doc_problem_pages, pages.filter { it.label.isBlank() }.joinToString(", ") { it.page.toString() }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    if (confirmRebuild) ConfirmDialog(t(R.string.doc_rebuild), t(R.string.doc_rebuild_body), t(R.string.doc_rebuild), { confirmRebuild = false }) {
        confirmRebuild = false; model.graph.docSearch.rebuild()
    }
}

