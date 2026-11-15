package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString

/** Comparison table and dichotomous key (`fanotes-key`). Ported from `lib/study/keyTree.ts`. */

data class KeyItem(val id: String, val name: String, val values: List<String>)
data class KeyTable(val features: List<String>, val items: List<KeyItem>)
data class KeyBranch(val label: String, val to: String)
data class KeyNode(val id: String, val leaf: Boolean, val text: String, val branches: List<KeyBranch>)
data class KeyTree(val root: String, val nodes: List<KeyNode>)
data class KeyData(
    val title: String,
    val table: KeyTable,
    val tree: KeyTree,
    /** Another tree, e.g. a figure from the book, shown next to the key. */
    val compareImage: String,
    val compareLabel: String,
)

private const val MAX_ITEMS = 60
private const val MAX_FEATURES = 24
private const val MAX_NODES = 200

fun emptyKeyTree() = KeyTree(
    "n1",
    listOf(
        KeyNode("n1", false, "Erste Frage?", listOf(KeyBranch("ja", "n2"), KeyBranch("nein", "n3"))),
        KeyNode("n2", true, "Art A", emptyList()),
        KeyNode("n3", true, "Art B", emptyList()),
    ),
)

/** Keeps only nodes reachable from the root, once each, with branches that point at real nodes. */
fun normaliseKeyTree(raw: JsonValue?): KeyTree {
    val source = raw.asRecord()
    val byId = LinkedHashMap<String, KeyNode>()
    for (entry in source["nodes"].asArray(MAX_NODES * 2)) {
        val node = entry.asRecord()
        val id = node.text("id", 40)
        if (id.isEmpty() || id in byId) continue
        val leaf = node.text("kind", 20) == "leaf"
        byId[id] = KeyNode(
            id,
            leaf,
            node.text("text", 300),
            if (leaf) emptyList() else node["branches"].asArray(8).map { KeyBranch(it.asRecord().text("label", 80), it.asRecord().text("to", 40)) },
        )
    }
    val rootId = source.text("root", 40)
    val root = if (rootId in byId) rootId else byId.keys.firstOrNull() ?: return emptyKeyTree()
    val seen = HashSet<String>()
    val ordered = ArrayList<KeyNode>()
    fun walk(id: String) {
        val node = byId[id] ?: return
        if (id in seen || ordered.size >= MAX_NODES) return
        seen += id
        ordered += node
        for (branch in node.branches) walk(branch.to)
    }
    walk(root)
    val keep = ordered.map { it.id }.toSet()
    // A branch to an already used node would make a cycle or a shared leaf: drop it.
    val parents = HashMap<String, Int>()
    val cleaned = ordered.map { node ->
        node.copy(
            branches = node.branches.filter { branch ->
                if (branch.to !in keep || branch.to == root) return@filter false
                val count = (parents[branch.to] ?: 0) + 1
                parents[branch.to] = count
                count == 1
            },
        )
    }
    return KeyTree(root, cleaned)
}

fun defaultKeyData() = KeyData(
    "Vergleichstabelle",
    KeyTable(
        listOf("Merkmal 1", "Merkmal 2"),
        listOf(KeyItem("i1", "Art A", listOf("ja", "nein")), KeyItem("i2", "Art B", listOf("nein", "ja"))),
    ),
    emptyKeyTree(),
    "",
    "",
)

fun normaliseKeyData(source: JsonValue.Obj): KeyData {
    val table = source["table"].asRecord()
    val features = table["features"].asArray(MAX_FEATURES).map { it.asText(80) }
    val items = table["items"].asArray(MAX_ITEMS).mapIndexed { index, entry ->
        val item = entry.asRecord()
        val values = item["values"].asArray(MAX_FEATURES).map { it.asText(200) }.toMutableList()
        while (values.size < features.size) values += ""
        KeyItem(item.text("id", 40).ifEmpty { "i${index + 1}" }, item.text("name", 120), values.take(features.size))
    }
    val hasTree = source["tree"].asRecord().fields.isNotEmpty()
    return KeyData(
        source.text("title", 120),
        KeyTable(features, items),
        if (hasTree) normaliseKeyTree(source["tree"]) else emptyKeyTree(),
        asStudyImage(source["compareImage"]),
        source.text("compareLabel", 120),
    )
}

/** Null when [body] is not a JSON object (the caller then keeps the raw block); `{}` yields the starter key. */
fun parseKeyData(body: String): KeyData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    return if (raw.fields.isEmpty()) defaultKeyData() else normaliseKeyData(raw)
}

fun keyDataJson(data: KeyData): JsonValue = jsonObject(
    "v" to num(1),
    "title" to jsonString(data.title),
    "table" to jsonObject(
        "features" to JsonValue.Arr(data.table.features.map { jsonString(it) as JsonValue }.toMutableList()),
        "items" to JsonValue.Arr(
            data.table.items.map { item ->
                jsonObject(
                    "id" to jsonString(item.id),
                    "name" to jsonString(item.name),
                    "values" to JsonValue.Arr(item.values.map { jsonString(it) as JsonValue }.toMutableList()),
                ) as JsonValue
            }.toMutableList(),
        ),
    ),
    "tree" to jsonObject(
        "root" to jsonString(data.tree.root),
        "nodes" to JsonValue.Arr(
            data.tree.nodes.map { node ->
                jsonObject(
                    "id" to jsonString(node.id),
                    "kind" to jsonString(if (node.leaf) "leaf" else "question"),
                    "text" to jsonString(node.text),
                    "branches" to JsonValue.Arr(
                        node.branches.map { jsonObject("label" to jsonString(it.label), "to" to jsonString(it.to)) as JsonValue }.toMutableList(),
                    ),
                ) as JsonValue
            }.toMutableList(),
        ),
    ),
    "compareImage" to jsonString(data.compareImage),
    "compareLabel" to jsonString(data.compareLabel),
)

// -- layout --------------------------------------------------------------------

data class PlacedNode(val id: String, val leaf: Boolean, val lines: List<String>, val x: Double, val y: Double, val w: Double, val h: Double)
data class PlacedEdge(val from: String, val to: String, val label: String, val x1: Double, val y1: Double, val x2: Double, val y2: Double)
data class TreeLayout(val nodes: List<PlacedNode>, val edges: List<PlacedEdge>, val width: Double, val height: Double)

private const val CHAR = 7.3
private const val LINE_H = 16.0
private const val PAD = 20.0

/** Breaks text into lines of at most [max] characters, splitting only at spaces. */
fun wrapText(value: String, max: Int): List<String> {
    val words = value.replace(Regex("(?U)\\s+"), " ").trim().split(' ').filter { it.isNotEmpty() }
    val lines = ArrayList<String>()
    var line = ""
    for (word in words) {
        if (line.isEmpty()) line = word
        else if (line.length + 1 + word.length <= max) line += " $word"
        else {
            lines += line
            line = word
        }
        while (line.length > max + 6) {
            lines += line.substring(0, max) + "-"
            line = line.substring(max)
        }
    }
    if (line.isNotEmpty()) lines += line
    return if (lines.isEmpty()) listOf("") else lines
}

data class BoxSize(val lines: List<String>, val w: Double, val h: Double)

fun measureBox(text: String, max: Int = 20): BoxSize {
    val lines = wrapText(text, max)
    val w = maxOf(56.0, jsRound((lines.maxOf { it.length }) * CHAR + PAD))
    return BoxSize(lines, w, lines.size * LINE_H + 12)
}

private const val H_GAP = 18.0
private const val V_GAP = 54.0

/** Top-down tidy tree: each subtree owns a horizontal span, the parent centres above its children. */
fun layoutKeyTree(tree: KeyTree): TreeLayout {
    val byId = tree.nodes.associateBy { it.id }
    val boxes = tree.nodes.associate { it.id to measureBox(it.text.ifEmpty { if (it.leaf) "?" else "…" }) }
    val span = HashMap<String, Double>()
    fun measure(id: String): Double {
        val node = byId[id] ?: return 0.0
        val box = boxes[id] ?: return 0.0
        val kids = node.branches.map { it.to }.filter { it in byId }
        val children = kids.sumOf { measure(it) } + maxOf(0, kids.size - 1) * H_GAP
        val own = maxOf(box.w, node.branches.maxOfOrNull { it.label.length * 5.6 + 8 } ?: 0.0)
        val total = maxOf(own, children)
        span[id] = total
        return total
    }
    measure(tree.root)
    val placed = ArrayList<PlacedNode>()
    val edges = ArrayList<PlacedEdge>()
    val rowHeights = ArrayList<Double>()
    val depthOf = HashMap<String, Int>()
    fun assignDepth(id: String, depth: Int) {
        depthOf[id] = depth
        val box = boxes[id]
        while (rowHeights.size <= depth) rowHeights += 0.0
        rowHeights[depth] = maxOf(rowHeights[depth], box?.h ?: 0.0)
        for (branch in byId[id]?.branches.orEmpty()) if (branch.to in byId) assignDepth(branch.to, depth + 1)
    }
    if (tree.root in byId) assignDepth(tree.root, 0)
    val rowTop = ArrayList<Double>()
    var top = 8.0
    rowHeights.forEach { height ->
        rowTop += top
        top += height + V_GAP
    }
    fun place(id: String, left: Double): Double {
        val node = byId[id] ?: return left
        val box = boxes[id] ?: return left
        val width = span[id] ?: box.w
        val kids = node.branches.filter { it.to in byId }
        val childrenWidth = kids.sumOf { span[it.to] ?: 0.0 } + maxOf(0, kids.size - 1) * H_GAP
        val depth = depthOf[id] ?: 0
        val y = rowTop.getOrElse(depth) { 8.0 }
        var cursor = left + (width - childrenWidth) / 2
        val centres = ArrayList<Double>()
        for (branch in kids) {
            centres += place(branch.to, cursor)
            cursor += (span[branch.to] ?: 0.0) + H_GAP
        }
        val wanted = if (centres.isNotEmpty()) (centres.first() + centres.last()) / 2 else left + width / 2
        val x = jsRound(maxOf(left, minOf(left + width - box.w, wanted - box.w / 2)))
        val centre = x + box.w / 2
        placed += PlacedNode(id, node.leaf, box.lines, x, y, box.w, box.h)
        kids.forEachIndexed { index, branch ->
            edges += PlacedEdge(id, branch.to, branch.label, centre, y + box.h, centres[index], rowTop.getOrElse(depth + 1) { y + V_GAP })
        }
        return centre
    }
    place(tree.root, 8.0)
    val width = (span[tree.root] ?: 0.0) + 16
    return TreeLayout(placed, edges, maxOf(width, 120.0), top - V_GAP + 8)
}
