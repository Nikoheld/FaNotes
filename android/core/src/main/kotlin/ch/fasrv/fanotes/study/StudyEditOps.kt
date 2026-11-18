package ch.fasrv.fanotes.study

import java.util.Random

/**
 * Edit operations of the tablet editors for key tables / trees, concept maps and picture plates. Each is a pure
 * function on the model, so the dialogs only wire taps to them and the limits of the desktop models hold (the same
 * caps the normalisers apply).
 */

const val KEY_MAX_FEATURES = 24
const val KEY_MAX_ITEMS = 60
const val KEY_MAX_NODES = 200
const val KEY_MAX_BRANCHES = 8
const val MAP_MAX_NODES = 80
const val MAP_MAX_EDGES = 160
const val PLATE_MAX_ITEMS = 40

// -- key: table ---------------------------------------------------------------------

fun keySetTitle(data: KeyData, title: String) = data.copy(title = title.take(120))

fun keyAddFeature(data: KeyData, name: String = ""): KeyData {
    if (data.table.features.size >= KEY_MAX_FEATURES) return data
    return data.copy(table = KeyTable(data.table.features + name.take(80), data.table.items.map { it.copy(values = it.values + "") }))
}

fun keyRenameFeature(data: KeyData, column: Int, name: String): KeyData {
    if (column !in data.table.features.indices) return data
    return data.copy(table = data.table.copy(features = data.table.features.mapIndexed { index, old -> if (index == column) name.take(80) else old }))
}

fun keyRemoveFeature(data: KeyData, column: Int): KeyData {
    if (column !in data.table.features.indices) return data
    return data.copy(
        table = KeyTable(
            data.table.features.filterIndexed { index, _ -> index != column },
            data.table.items.map { it.copy(values = it.values.filterIndexed { index, _ -> index != column }) },
        ),
    )
}

fun keyAddItem(data: KeyData, name: String = "", random: Random = Random()): KeyData {
    if (data.table.items.size >= KEY_MAX_ITEMS) return data
    val used = data.table.items.map { it.id }.toSet()
    var id = newStudyId("i", random)
    while (id in used) id = newStudyId("i", random)
    return data.copy(table = data.table.copy(items = data.table.items + KeyItem(id, name.take(120), data.table.features.map { "" })))
}

fun keyRemoveItem(data: KeyData, id: String) = data.copy(table = data.table.copy(items = data.table.items.filter { it.id != id }))

fun keySetItemName(data: KeyData, id: String, name: String) =
    data.copy(table = data.table.copy(items = data.table.items.map { if (it.id == id) it.copy(name = name.take(120)) else it }))

fun keySetValue(data: KeyData, id: String, column: Int, value: String): KeyData {
    if (column !in data.table.features.indices) return data
    return data.copy(
        table = data.table.copy(
            items = data.table.items.map { item ->
                if (item.id != id) item else item.copy(values = item.values.mapIndexed { index, old -> if (index == column) value.take(200) else old })
            },
        ),
    )
}

// -- key: tree ----------------------------------------------------------------------

/** The nodes reachable from the root, once each; branches to missing or already used nodes are dropped. */
fun keyPrune(tree: KeyTree): KeyTree {
    val byId = tree.nodes.associateBy { it.id }
    val seen = LinkedHashSet<String>()
    val ordered = ArrayList<KeyNode>()
    fun walk(id: String) {
        val node = byId[id] ?: return
        if (!seen.add(id)) return
        ordered += node
        if (!node.leaf) node.branches.forEach { walk(it.to) }
    }
    walk(tree.root)
    val keep = ordered.map { it.id }.toSet()
    val claimed = HashSet<String>()
    return KeyTree(
        tree.root,
        ordered.map { node ->
            if (node.leaf) node.copy(branches = emptyList())
            else node.copy(branches = node.branches.filter { it.to in keep && it.to != tree.root && claimed.add(it.to) })
        },
    )
}

fun keySetNodeText(tree: KeyTree, id: String, text: String) =
    tree.copy(nodes = tree.nodes.map { if (it.id == id) it.copy(text = text.take(300)) else it })

/** Turns a question into a leaf (its sub-tree disappears) or a leaf into a question (without branches until one is added). */
fun keySetNodeLeaf(tree: KeyTree, id: String, leaf: Boolean): KeyTree =
    keyPrune(tree.copy(nodes = tree.nodes.map { if (it.id == id) it.copy(leaf = leaf, branches = if (leaf) emptyList() else it.branches) else it }))

/** A new leaf under [parentId] with the branch label [label]; refused beyond the node and branch caps or under a leaf. */
fun keyAddBranch(tree: KeyTree, parentId: String, label: String = "", text: String = "", random: Random = Random()): KeyTree {
    val parent = tree.nodes.firstOrNull { it.id == parentId } ?: return tree
    if (parent.leaf || parent.branches.size >= KEY_MAX_BRANCHES || tree.nodes.size >= KEY_MAX_NODES) return tree
    val used = tree.nodes.map { it.id }.toSet()
    var id = newStudyId("n", random)
    while (id in used) id = newStudyId("n", random)
    return tree.copy(
        nodes = tree.nodes.map { if (it.id == parentId) it.copy(branches = it.branches + KeyBranch(label.take(80), id)) else it } +
            KeyNode(id, true, text.take(300), emptyList()),
    )
}

fun keySetBranchLabel(tree: KeyTree, parentId: String, index: Int, label: String) = tree.copy(
    nodes = tree.nodes.map { node ->
        if (node.id != parentId) node
        else node.copy(branches = node.branches.mapIndexed { at, branch -> if (at == index) branch.copy(label = label.take(80)) else branch })
    },
)

/** Deletes a node with everything below it; the root stays. */
fun keyRemoveNode(tree: KeyTree, id: String): KeyTree {
    if (id == tree.root) return tree
    return keyPrune(
        tree.copy(
            nodes = tree.nodes.filter { it.id != id }.map { node -> node.copy(branches = node.branches.filter { it.to != id }) },
        ),
    )
}

/** Parent node and branch index of [id], for the editor's "Ast löschen" and label field. */
fun keyParentOf(tree: KeyTree, id: String): Pair<KeyNode, Int>? {
    for (node in tree.nodes) {
        val index = node.branches.indexOfFirst { it.to == id }
        if (index >= 0) return node to index
    }
    return null
}

// -- map ----------------------------------------------------------------------------

fun mapSetTitle(data: MapData, title: String) = data.copy(title = title.take(120))

fun mapSetDirection(data: MapData, leftToRight: Boolean) = data.copy(leftToRight = leftToRight)

fun mapAddNode(data: MapData, text: String = "", random: Random = Random()): MapData {
    if (data.nodes.size >= MAP_MAX_NODES) return data
    val used = data.nodes.map { it.id }.toSet()
    var id = newStudyId("n", random)
    while (id in used) id = newStudyId("n", random)
    return data.copy(nodes = data.nodes + MapNode(id, text.take(200)))
}

fun mapSetNodeText(data: MapData, id: String, text: String) =
    data.copy(nodes = data.nodes.map { if (it.id == id) it.copy(text = text.take(200)) else it })

fun mapRemoveNode(data: MapData, id: String) = data.copy(
    nodes = data.nodes.filter { it.id != id },
    edges = data.edges.filter { it.from != id && it.to != id },
)

/** Adds an arrow; refused for a missing node, a self loop, a repeated arrow or beyond the cap. */
fun mapAddEdge(data: MapData, from: String, to: String, label: String = "", random: Random = Random()): MapData {
    if (data.edges.size >= MAP_MAX_EDGES || from == to) return data
    if (data.nodes.none { it.id == from } || data.nodes.none { it.id == to }) return data
    val text = label.take(80)
    if (data.edges.any { it.from == from && it.to == to && it.label == text }) return data
    val used = data.edges.map { it.id }.toSet()
    var id = newStudyId("e", random)
    while (id in used) id = newStudyId("e", random)
    return data.copy(edges = data.edges + MapEdge(id, from, to, text))
}

fun mapSetEdgeLabel(data: MapData, id: String, label: String) =
    data.copy(edges = data.edges.map { if (it.id == id) it.copy(label = label.take(80)) else it })

/** Re-attaches an arrow to other boxes; refused for a self loop, a missing box or an arrow that already exists. */
fun mapSetEdgeEnds(data: MapData, id: String, from: String, to: String): MapData {
    val edge = data.edges.firstOrNull { it.id == id } ?: return data
    if (from == to || data.nodes.none { it.id == from } || data.nodes.none { it.id == to }) return data
    if (data.edges.any { it.id != id && it.from == from && it.to == to && it.label == edge.label }) return data
    return data.copy(edges = data.edges.map { if (it.id == id) it.copy(from = from, to = to) else it })
}

fun mapRemoveEdge(data: MapData, id: String) = data.copy(edges = data.edges.filter { it.id != id })

// -- plate --------------------------------------------------------------------------

fun plateSetTitle(data: PlateData, title: String) = data.copy(title = title.take(120))

fun plateSetCols(data: PlateData, cols: Int) = data.copy(cols = cols.coerceIn(1, 8))

fun plateSetShowLabels(data: PlateData, show: Boolean) = data.copy(showLabels = show)

fun plateAddItem(data: PlateData, img: String = "", label: String = "", random: Random = Random()): PlateData {
    if (data.items.size >= PLATE_MAX_ITEMS) return data
    val used = data.items.map { it.id }.toSet()
    var id = newStudyId("p", random)
    while (id in used) id = newStudyId("p", random)
    return data.copy(items = data.items + PlateItem(id, label.take(120), "", img))
}

fun plateSetItem(data: PlateData, id: String, edit: (PlateItem) -> PlateItem) =
    data.copy(items = data.items.map { if (it.id == id) edit(it).let { next -> next.copy(label = next.label.take(120), note = next.note.take(300)) } else it })

fun plateRemoveItem(data: PlateData, id: String) = data.copy(items = data.items.filter { it.id != id })

// -- strict readers for the editors --------------------------------------------------

/** The model when the block reads back without loss (see [findStudyLoss]); null means "do not edit here". */
fun keyEditable(body: String): KeyData? = readStudyStrict(body, ::defaultKeyData, ::normaliseKeyData, ::keyDataJson)
fun mapEditable(body: String): MapData? = readStudyStrict(body, ::defaultMapData, ::normaliseMapData, ::mapDataJson)
fun plateEditable(body: String): PlateData? = readStudyStrict(body, ::defaultPlateData, { normalisePlateData(it) }, ::plateDataJson)

/** A starter block for each kind the insert menu offers. */
fun starterBlockJson(kind: StudyKind, cryptoTool: ch.fasrv.fanotes.study.crypto.CryptoTool? = null): ch.fasrv.fanotes.json.JsonValue = when (kind) {
    StudyKind.KEY -> keyDataJson(defaultKeyData())
    StudyKind.SORT -> sortDataJson(defaultSortData())
    StudyKind.MAP -> mapDataJson(defaultMapData())
    StudyKind.PLATE -> plateDataJson(defaultPlateData())
    StudyKind.TERM -> termDataJson(defaultTermData())
    StudyKind.CRYPTO -> ch.fasrv.fanotes.study.crypto.cryptoDataJson(ch.fasrv.fanotes.study.crypto.defaultCryptoData(cryptoTool ?: ch.fasrv.fanotes.study.crypto.CryptoTool.CAESAR))
}
