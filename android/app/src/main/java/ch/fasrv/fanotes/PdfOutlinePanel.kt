package ch.fasrv.fanotes

import androidx.compose.material3.Text
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.desk.flattenPdfOutline

/**
 * The PDF outline ("Gliederung", desktop `PdfNoteView` sidebar): chapters and sections with their page; a tap jumps
 * there. Rows are 48 dp high for a finger; nesting is shown by indent.
 */
@Composable
fun PdfOutlinePanel(model: FaNotesViewModel) {
    val outline by model.pdfOutline.collectAsStateWithLifecycle()
    val current by model.pdfThumbPage.collectAsStateWithLifecycle()
    val rows = remember(outline) { flattenPdfOutline(outline) }
    if (rows.isEmpty()) {
        Text(
            ChromeText.ui("Keine Gliederung vorhanden."),
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
            modifier = Modifier.padding(vertical = 12.dp),
        )
        return
    }
    // The entry whose page is the last one at or before the current page.
    val active = rows.indexOfLast { (_, item) -> (item.page ?: Int.MAX_VALUE) <= current }
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
        items(rows.size) { index ->
            val (depth, item) = rows[index]
            val page = item.page
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable(enabled = page != null) {
                        if (page != null) {
                            model.goToPdfPage(page)
                            model.openEditorMenu(null)
                        }
                    }
                    .padding(start = (12 + depth * 20).dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    item.title,
                    modifier = Modifier.weight(1f),
                    fontSize = if (depth == 0) 15.sp else 14.sp,
                    fontWeight = if (index == active) FontWeight.Bold else if (depth == 0) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = if (page == null) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f) else MaterialTheme.colorScheme.onSurface,
                )
                if (page != null) {
                    Text(
                        page.toString(),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
            }
        }
    }
}
