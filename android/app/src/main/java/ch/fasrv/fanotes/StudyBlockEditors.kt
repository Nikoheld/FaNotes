package ch.fasrv.fanotes

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.fasrv.fanotes.study.KEY_MAX_BRANCHES
import ch.fasrv.fanotes.study.KEY_MAX_FEATURES
import ch.fasrv.fanotes.study.KEY_MAX_ITEMS
import ch.fasrv.fanotes.study.KEY_MAX_NODES
import ch.fasrv.fanotes.study.KeyData
import ch.fasrv.fanotes.study.KeyNode
import ch.fasrv.fanotes.study.MAP_MAX_EDGES
import ch.fasrv.fanotes.study.MAP_MAX_NODES
import ch.fasrv.fanotes.study.MapData
import ch.fasrv.fanotes.study.PLATE_MAX_ITEMS
import ch.fasrv.fanotes.study.PlateData
import ch.fasrv.fanotes.study.keyAddBranch
import ch.fasrv.fanotes.study.keyAddFeature
import ch.fasrv.fanotes.study.keyAddItem
import ch.fasrv.fanotes.study.keyRemoveFeature
import ch.fasrv.fanotes.study.keyRemoveItem
import ch.fasrv.fanotes.study.keyRemoveNode
import ch.fasrv.fanotes.study.keyRenameFeature
import ch.fasrv.fanotes.study.keySetBranchLabel
import ch.fasrv.fanotes.study.keySetItemName
import ch.fasrv.fanotes.study.keySetNodeLeaf
import ch.fasrv.fanotes.study.keySetNodeText
import ch.fasrv.fanotes.study.keySetTitle
import ch.fasrv.fanotes.study.keySetValue
import ch.fasrv.fanotes.study.mapAddEdge
import ch.fasrv.fanotes.study.mapAddNode
import ch.fasrv.fanotes.study.mapRemoveEdge
import ch.fasrv.fanotes.study.mapRemoveNode
import ch.fasrv.fanotes.study.mapSetDirection
import ch.fasrv.fanotes.study.mapSetEdgeEnds
import ch.fasrv.fanotes.study.mapSetEdgeLabel
import ch.fasrv.fanotes.study.mapSetNodeText
import ch.fasrv.fanotes.study.mapSetTitle
import ch.fasrv.fanotes.study.plateAddItem
import ch.fasrv.fanotes.study.plateRemoveItem
import ch.fasrv.fanotes.study.plateSetCols
import ch.fasrv.fanotes.study.plateSetItem
import ch.fasrv.fanotes.study.plateSetShowLabels
import ch.fasrv.fanotes.study.plateSetTitle

/**
 * Tablet editors of the key / table, concept map and picture plate blocks. [update] applies a function to the latest
 * model (never to a stale copy, so a picture that arrives late does not undo an edit made meanwhile).
 */

typealias Update<T> = ((T) -> T) -> Unit

// -- key ----------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KeyEditor(model: FaNotesViewModel, data: KeyData, update: Update<KeyData>) {
    SyncField("ktitle", data.title, "Titel", Modifier.fillMaxWidth(), maxChars = 120) { update { d -> keySetTitle(d, it) } }
    SectionTitle("Vergleichstabelle")
    data.table.features.forEachIndexed { index, feature ->
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
            SyncField("kf$index", feature, "Merkmal ${index + 1}", Modifier.weight(1f), maxChars = 80) { update { d -> keyRenameFeature(d, index, it) } }
            Gap(6.dp)
            ActionButton("Entfernen") { update { d -> keyRemoveFeature(d, index) } }
        }
    }
    ActionButton("Merkmal hinzufügen", data.table.features.size < KEY_MAX_FEATURES) { update { d -> keyAddFeature(d, "") } }
    data.table.items.forEach { item ->
        Column(
            Modifier.fillMaxWidth().padding(top = 10.dp).border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), RoundedCornerShape(10.dp)).padding(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SyncField("ki-${item.id}", item.name, "Art", Modifier.weight(1f), maxChars = 120) { update { d -> keySetItemName(d, item.id, it) } }
                Gap(6.dp)
                ActionButton("Entfernen") { update { d -> keyRemoveItem(d, item.id) } }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 6.dp)) {
                data.table.features.forEachIndexed { column, feature ->
                    SyncField("kv-${item.id}-$column", item.values.getOrElse(column) { "" }, feature.ifEmpty { "Merkmal ${column + 1}" }, Modifier.width(200.dp), maxChars = 200) {
                        update { d -> keySetValue(d, item.id, column, it) }
                    }
                }
            }
        }
    }
    ActionButton("Art hinzufügen", data.table.items.size < KEY_MAX_ITEMS, Modifier.padding(top = 8.dp)) { update { d -> keyAddItem(d, "") } }

    SectionTitle("Bestimmungsschlüssel")
    Muted("Jede Frage hat Antworten (Äste). Eine Antwort führt zur nächsten Frage oder zu einer Art am Ende des Astes.")
    val byId = data.tree.nodes.associateBy { it.id }
    data.tree.nodes.firstOrNull { it.id == data.tree.root }?.let { KeyNodeEditor(data, it, byId, update, 0) }

    SectionTitle("Vergleichsbild")
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) model.importStudyPlateImage(uri) { ref, _ -> if (ref != null) update { d -> d.copy(compareImage = ref) } }
    }
    if (data.compareImage.isNotEmpty()) {
        StudyThumb(model, data.compareImage, 160)
        SyncField("kcl", data.compareLabel, "Beschriftung", Modifier.fillMaxWidth().padding(top = 6.dp), maxChars = 120) { update { d -> d.copy(compareLabel = it) } }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ActionButton(if (data.compareImage.isEmpty()) "Bild wählen" else "Bild ersetzen") { pick.launch("image/*") }
        if (data.compareImage.isNotEmpty()) ActionButton("Bild entfernen") { update { d -> d.copy(compareImage = "", compareLabel = "") } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KeyNodeEditor(data: KeyData, node: KeyNode, byId: Map<String, KeyNode>, update: Update<KeyData>, depth: Int) {
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp, start = if (depth == 0) 0.dp else 12.dp)
            .border(BorderStroke(1.dp, if (node.leaf) MaterialTheme.colorScheme.outlineVariant else MaterialTheme.colorScheme.primary.copy(alpha = 0.5f)), RoundedCornerShape(10.dp))
            .padding(8.dp),
    ) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            StudyChoice("Frage", !node.leaf, { update { d -> d.copy(tree = keySetNodeLeaf(d.tree, node.id, false)) } })
            StudyChoice("Art (Ende)", node.leaf, { update { d -> d.copy(tree = keySetNodeLeaf(d.tree, node.id, true)) } })
            if (node.id != data.tree.root) ActionButton("Ast löschen") { update { d -> d.copy(tree = keyRemoveNode(d.tree, node.id)) } }
        }
        SyncField("kn-${node.id}", node.text, if (node.leaf) "Art" else "Frage", Modifier.fillMaxWidth().padding(top = 6.dp), maxChars = 300) {
            update { d -> d.copy(tree = keySetNodeText(d.tree, node.id, it)) }
        }
        if (!node.leaf) {
            node.branches.forEachIndexed { index, branch ->
                SyncField("kb-${node.id}-$index", branch.label, "Antwort ${index + 1}", Modifier.fillMaxWidth().padding(top = 6.dp), maxChars = 80) {
                    update { d -> d.copy(tree = keySetBranchLabel(d.tree, node.id, index, it)) }
                }
                byId[branch.to]?.let { KeyNodeEditor(data, it, byId, update, depth + 1) }
            }
            ActionButton("Antwort hinzufügen", node.branches.size < KEY_MAX_BRANCHES && data.tree.nodes.size < KEY_MAX_NODES, Modifier.padding(top = 6.dp)) {
                update { d -> d.copy(tree = keyAddBranch(d.tree, node.id, "", "")) }
            }
        }
    }
}

// -- concept map --------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MapEditor(data: MapData, update: Update<MapData>) {
    SyncField("mtitle", data.title, "Titel", Modifier.fillMaxWidth(), maxChars = 120) { update { d -> mapSetTitle(d, it) } }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        StudyChoice("Oben nach unten", !data.leftToRight, { update { d -> mapSetDirection(d, false) } })
        StudyChoice("Links nach rechts", data.leftToRight, { update { d -> mapSetDirection(d, true) } })
    }
    SectionTitle("Begriffe")
    data.nodes.forEach { node ->
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
            SyncField("mn-${node.id}", node.text, "Begriff", Modifier.weight(1f), maxChars = 200) { update { d -> mapSetNodeText(d, node.id, it) } }
            Gap(6.dp)
            ActionButton("Entfernen") { update { d -> mapRemoveNode(d, node.id) } }
        }
    }
    ActionButton("Begriff hinzufügen", data.nodes.size < MAP_MAX_NODES) { update { d -> mapAddNode(d, "") } }
    SectionTitle("Pfeile")
    val names = data.nodes.associate { it.id to it.text.ifBlank { "(leer)" } }
    data.edges.forEach { edge ->
        Column(Modifier.fillMaxWidth().padding(top = 6.dp).border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), RoundedCornerShape(10.dp)).padding(8.dp)) {
            FlowRow(verticalArrangement = Arrangement.spacedBy(4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NodePicker(names, edge.from) { id -> update { d -> mapSetEdgeEnds(d, edge.id, id, edge.to) } }
                Text("→", fontSize = 20.sp)
                NodePicker(names, edge.to) { id -> update { d -> mapSetEdgeEnds(d, edge.id, edge.from, id) } }
                ActionButton("Entfernen") { update { d -> mapRemoveEdge(d, edge.id) } }
            }
            SyncField("me-${edge.id}", edge.label, "Beschriftung (z. B. führt zu)", Modifier.fillMaxWidth().padding(top = 6.dp), maxChars = 80) { update { d -> mapSetEdgeLabel(d, edge.id, it) } }
        }
    }
    if (data.nodes.size < 2) Muted("Lege zuerst mindestens zwei Begriffe an.")
    ActionButton("Pfeil hinzufügen", data.nodes.size >= 2 && data.edges.size < MAP_MAX_EDGES, Modifier.padding(top = 8.dp)) {
        update { d ->
            // The first two boxes that are not joined yet in this direction.
            val pairs = d.nodes.flatMap { a -> d.nodes.filter { it.id != a.id }.map { b -> a.id to b.id } }
            val free = pairs.firstOrNull { (a, b) -> d.edges.none { it.from == a && it.to == b } } ?: pairs.firstOrNull()
            if (free == null) d else mapAddEdge(d, free.first, free.second, "")
        }
    }
}

@Composable
private fun NodePicker(names: Map<String, String>, selected: String, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        ActionButton((names[selected] ?: "?").take(24)) { open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            names.forEach { (id, name) ->
                DropdownMenuItem(text = { Text(name, fontWeight = if (id == selected) FontWeight.Bold else FontWeight.Normal) }, onClick = { open = false; onPick(id) })
            }
        }
    }
}

// -- picture plate ------------------------------------------------------------------------

/** A small preview of a vault picture; decoded once at thumbnail size. */
@Composable
internal fun StudyThumb(model: FaNotesViewModel, ref: String, edgeDp: Int) {
    val density = androidx.compose.ui.platform.LocalDensity.current
    val edgePx = with(density) { edgeDp.dp.roundToPx() }
    val bitmap by produceState<ImageBitmap?>(null, ref) { value = model.readStudyThumb(ref, edgePx)?.asImageBitmap() }
    Box(Modifier.size(edgeDp.dp).clip(RoundedCornerShape(8.dp)).border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
        val shown = bitmap
        if (shown != null) Image(shown, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(edgeDp.dp))
        else Text("…", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PlateEditor(model: FaNotesViewModel, data: PlateData, update: Update<PlateData>) {
    SyncField("ptitle", data.title, "Titel", Modifier.fillMaxWidth(), maxChars = 120) { update { d -> plateSetTitle(d, it) } }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
        ActionButton("−", data.cols > 1) { update { d -> plateSetCols(d, d.cols - 1) } }
        Text(
            (if (ch.fasrv.fanotes.desk.ChromeText.language == "en") "${data.cols} columns" else "${data.cols} Spalten"),
            modifier = Modifier.padding(horizontal = 16.dp), fontWeight = FontWeight.SemiBold,
        )
        ActionButton("+", data.cols < 8) { update { d -> plateSetCols(d, d.cols + 1) } }
        Gap(12.dp)
        StudyChoice("Namen zeigen", data.showLabels, { update { d -> plateSetShowLabels(d, !d.showLabels) } })
    }
    val addMany = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        uris.forEach { uri ->
            model.importStudyPlateImage(uri) { ref, name -> if (ref != null) update { d -> plateAddItem(d, ref, name) } }
        }
    }
    data.items.forEach { item -> androidx.compose.runtime.key(item.id) {
        val replace = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null) model.importStudyPlateImage(uri) { ref, _ -> if (ref != null) update { d -> plateSetItem(d, item.id) { it.copy(img = ref) } } }
        }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp).border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), RoundedCornerShape(10.dp)).padding(8.dp)) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (item.img.isNotEmpty()) StudyThumb(model, item.img, 96)
                else Box(Modifier.size(96.dp).border(BorderStroke(1.dp, MaterialTheme.colorScheme.outline), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) { Text(ui("kein Bild"), fontSize = 12.sp) }
                ActionButton(if (item.img.isEmpty()) "Bild wählen" else "Ersetzen") { replace.launch("image/*") }
            }
            Gap(8.dp)
            Column(Modifier.weight(1f)) {
                SyncField("pl-${item.id}", item.label, "Name", Modifier.fillMaxWidth(), maxChars = 120) { update { d -> plateSetItem(d, item.id) { p -> p.copy(label = it) } } }
                SyncField("pn-${item.id}", item.note, "Notiz", Modifier.fillMaxWidth().padding(top = 4.dp), maxChars = 300) { update { d -> plateSetItem(d, item.id) { p -> p.copy(note = it) } } }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (item.img.isNotEmpty()) ActionButton("Bild entfernen") { update { d -> plateSetItem(d, item.id) { p -> p.copy(img = "") } } }
                    ActionButton("Tafel-Eintrag löschen") { update { d -> plateRemoveItem(d, item.id) } }
                }
            }
        }
    } }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 10.dp)) {
        ActionButton("Bilder hinzufügen", data.items.size < PLATE_MAX_ITEMS) { addMany.launch("image/*") }
        ActionButton("Eintrag ohne Bild", data.items.size < PLATE_MAX_ITEMS) { update { d -> plateAddItem(d, "", "") } }
    }
    Muted("Einträge mit Bild und Name erscheinen auch als Karteikarten („Wie heisst das?“).")
}
