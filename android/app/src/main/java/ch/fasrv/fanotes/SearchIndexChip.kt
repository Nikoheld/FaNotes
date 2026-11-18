package ch.fasrv.fanotes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.docIndexStatusLabel

/**
 * The state of the document index under the search field, like the desktop's `DocSearchStatus`. It says how many
 * files are covered, shows progress while the index builds in the background, and a tap starts an update. When a
 * build ends, the query that is typed is run again so late results appear without typing.
 */
@Composable
fun DocIndexStatusChip(model: FaNotesViewModel, query: String) {
    val status by model.docIndexStatus.collectAsStateWithLifecycle()
    LaunchedEffect(status.running) {
        if (!status.running && query.trim().length >= 2) model.searchVaultText(query)
    }
    Column(Modifier.fillMaxWidth().clickable(enabled = !status.running) { model.refreshDocIndex() }) {
        Text(
            docIndexStatusLabel(status),
            fontSize = 12.sp,
            color = LocalStatusInk.current.muted,
            modifier = Modifier.heightIn(min = 48.dp).padding(horizontal = 14.dp),
        )
        if (status.running && status.total > 0) {
            LinearProgressIndicator(progress = { status.indexed.toFloat() / status.total }, modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp))
        }
    }
}
