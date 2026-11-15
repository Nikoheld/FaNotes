package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString

/** Concept map (`fanotes-map`): boxes and labelled arrows, automatic layered layout. Ported from `lib/study/conceptMap.ts`. */

data class MapNode(val id: String, val text: String)
data class MapEdge(val id: String, val from: String, val to: String, val label: String)
data class MapData(val title: String, val leftToRight: Boolean, val nodes: List<MapNode>, val edges: List<MapEdge>)

private const val MAX_NODES = 80
private const val MAX_EDGES = 160

fun defaultMapData() = MapData(
    "Begriffsnetz",
    false,
    listOf(MapNode("a", "Ursache"), MapNode("b", "Wirkung")),
    listOf(MapEdge("e1", "a", "b", "führt zu")),
)

fun normaliseMapData(source: JsonValue.Obj): MapData {
    val ids = HashSet<String>()
    val nodes = ArrayList<MapNode>()
    for (entry in source["nodes"].asArray(MAX_NODES)) {
        val node = entry.asRecord()
        val id = node.text("id", 40)
        if (id.isEmpty() || id in ids) continue
        ids += id
        nodes += MapNode(id, node.text("text", 200))
    }
    val seen = HashSet<String>()
    val edges = ArrayList<MapEdge>()
    for (entry in source["edges"].asArray(MAX_EDGES)) {
        val edge = entry.asRecord()
        val from = edge.text("from", 40)
        val to = edge.text("to", 40)
        if (from !in ids || to !in ids || from == to) continue
        val key = "$from>$to>${edge.text("label", 80)}"
        if (!seen.add(key)) continue
        edges += MapEdge(edge.text("id", 40).ifEmpty { newStudyId("e") }, from, to, edge.text("label", 80))
    }
    return MapData(source.text("title", 120), source.text("dir", 8) == "LR", nodes, edges)
}

fun parseMapData(body: String): MapData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    return if (raw.fields.isEmpty()) defaultMapData() else normaliseMapData(raw)
}

fun mapDataJson(data: MapData): JsonValue = jsonObject(
    "v" to num(1),
    "title" to jsonString(data.title),
    "dir" to jsonString(if (data.leftToRight) "LR" else "TB"),
    "nodes" to JsonValue.Arr(data.nodes.map { jsonObject("id" to jsonString(it.id), "text" to jsonString(it.text)) as JsonValue }.toMutableList()),
    "edges" to JsonValue.Arr(
        data.edges.map {
            jsonObject("id" to jsonString(it.id), "from" to jsonString(it.from), "to" to jsonString(it.to), "label" to jsonString(it.label)) as JsonValue
        }.toMutableList(),
    ),
)

data class PlacedMapNode(val id: String, val lines: List<String>, val x: Double, val y: Double, val w: Double, val h: Double)
data class PlacedMapEdge(
    val id: String, val from: String, val to: String, val label: String,
    val x1: Double, val y1: Double, val c1x: Double, val c1y: Double, val c2x: Double, val c2y: Double, val x2: Double, val y2: Double,
    val lx: Double, val ly: Double,
)
data class MapLayout(val nodes: List<PlacedMapNode>, val edges: List<PlacedMapEdge>, val width: Double, val height: Double, val layers: List<List<String>>)

/** Layers by longest path after removing back edges (cycles), ordered by barycentre sweeps. */
fun layerMap(data: MapData): List<List<String>> {
    val ids = data.nodes.map { it.id }
    val out = HashMap<String, MutableList<String>>().also { map -> ids.forEach { map[it] = mutableListOf() } }
    for (edge in data.edges) out[edge.from]?.add(edge.to)
    val state = HashMap<String, Int>()
    val forward = HashMap<String, MutableList<String>>().also { map -> ids.forEach { map[it] = mutableListOf() } }
    fun visit(id: String) {
        state[id] = 1
        for (to in out[id].orEmpty()) {
            if (state[to] == 1) continue
            forward[id]?.add(to)
            if ((state[to] ?: 0) == 0) visit(to)
        }
        state[id] = 2
    }
    val incoming = data.edges.map { it.to }.toSet()
    for (id in ids.filter { it !in incoming }) if ((state[id] ?: 0) == 0) visit(id)
    for (id in ids) if ((state[id] ?: 0) == 0) visit(id)
    val depth = HashMap<String, Int>().also { map -> ids.forEach { map[it] = 0 } }
    val indegree = HashMap<String, Int>().also { map -> ids.forEach { map[it] = 0 } }
    for (targets in forward.values) for (to in targets.toSet()) indegree[to] = (indegree[to] ?: 0) + 1
    val queue = ArrayDeque(ids.filter { (indegree[it] ?: 0) == 0 })
    while (queue.isNotEmpty()) {
        val id = queue.removeFirst()
        for (to in forward[id].orEmpty().toSet()) {
            depth[to] = maxOf(depth[to] ?: 0, (depth[id] ?: 0) + 1)
            indegree[to] = (indegree[to] ?: 1) - 1
            if ((indegree[to] ?: 0) == 0) queue.addLast(to)
        }
    }
    val layers = ArrayList<MutableList<String>>()
    for (id in ids) {
        val level = depth[id] ?: 0
        while (layers.size <= level) layers.add(mutableListOf())
        layers[level].add(id)
    }
    val position = HashMap<String, Int>()
    fun refresh() = layers.forEach { layer -> layer.forEachIndexed { index, id -> position[id] = index } }
    refresh()
    fun neighbours(id: String, upward: Boolean) = data.edges
        .filter { if (upward) it.to == id else it.from == id }
        .map { if (upward) it.from else it.to }
    for (sweep in 0 until 4) {
        val upward = sweep % 2 == 0
        val order = if (upward) layers.indices.toList() else layers.indices.reversed().toList()
        for (index in order) {
            val layer = layers[index]
            val score = layer.associateWith { id ->
                val near = neighbours(id, upward).filter { it in position }
                if (near.isNotEmpty()) near.sumOf { (position[it] ?: 0).toDouble() } / near.size else (position[id] ?: 0).toDouble()
            }
            val sorted = layer.sortedWith(compareBy<String>({ score[it] ?: 0.0 }, { position[it] ?: 0 }))
            layer.clear()
            layer.addAll(sorted)
            layer.forEachIndexed { order2, id -> position[id] = order2 }
        }
    }
    return layers
}

private const val GAP_ALONG = 70.0
private const val GAP_ACROSS = 26.0

fun layoutMap(data: MapData): MapLayout {
    val layers = layerMap(data)
    val boxes = data.nodes.associate { it.id to measureBox(it.text.ifEmpty { "…" }, 22) }
    val lr = data.leftToRight
    fun across(id: String) = if (lr) boxes[id]?.h ?: 0.0 else boxes[id]?.w ?: 0.0
    fun thick(id: String) = if (lr) boxes[id]?.w ?: 0.0 else boxes[id]?.h ?: 0.0
    val layerSize = layers.map { layer -> layer.sumOf { across(it) } + maxOf(0, layer.size - 1) * GAP_ACROSS }
    val widest = layerSize.maxOrNull()?.coerceAtLeast(0.0) ?: 0.0
    val placed = LinkedHashMap<String, PlacedMapNode>()
    var along = 12.0
    layers.forEachIndexed { index, layer ->
        val thickest = layer.maxOfOrNull { thick(it) }?.coerceAtLeast(0.0) ?: 0.0
        var cursor = 12 + (widest - layerSize[index]) / 2
        for (id in layer) {
            val box = boxes[id] ?: continue
            val size = across(id)
            val centreAlong = along + thickest / 2
            val x = if (lr) centreAlong - box.w / 2 else cursor
            val y = if (lr) cursor else centreAlong - box.h / 2
            placed[id] = PlacedMapNode(id, box.lines, jsRound(x), jsRound(y), box.w, box.h)
            cursor += size + GAP_ACROSS
        }
        along += thickest + GAP_ALONG
    }
    val nodes = placed.values.toList()
    fun f(value: Double) = jsRound(value * 10) / 10
    val edges = data.edges.mapNotNull { edge ->
        val a = placed[edge.from] ?: return@mapNotNull null
        val b = placed[edge.to] ?: return@mapNotNull null
        val acx = a.x + a.w / 2
        val acy = a.y + a.h / 2
        val bcx = b.x + b.w / 2
        val bcy = b.y + b.h / 2
        val forward = if (lr) bcx >= acx + 1 else bcy >= acy + 1
        val sx: Double
        val sy: Double
        val ex: Double
        val ey: Double
        if (lr) {
            sx = if (forward) a.x + a.w else a.x
            sy = acy
            ex = if (forward) b.x else b.x + b.w
            ey = bcy
        } else {
            sx = acx
            sy = if (forward) a.y + a.h else a.y
            ex = bcx
            ey = if (forward) b.y else b.y + b.h
        }
        val bend = if (lr) Math.abs(ex - sx) / 2 else Math.abs(ey - sy) / 2
        val sign = if (forward) 1.0 else -1.0
        val c1x = if (lr) sx + sign * bend else sx
        val c1y = if (lr) sy else sy + sign * bend
        val c2x = if (lr) ex - sign * bend else ex
        val c2y = if (lr) ey else ey - sign * bend
        val mx = (sx + 3 * c1x + 3 * c2x + ex) / 8
        val my = (sy + 3 * c1y + 3 * c2y + ey) / 8
        PlacedMapEdge(edge.id, edge.from, edge.to, edge.label, f(sx), f(sy), f(c1x), f(c1y), f(c2x), f(c2y), f(ex), f(ey), f(mx), f(my))
    }
    val width = maxOf(nodes.maxOfOrNull { it.x + it.w } ?: 100.0, 100.0) + 12
    val height = maxOf(nodes.maxOfOrNull { it.y + it.h } ?: 60.0, 60.0) + 12
    return MapLayout(nodes, edges, width, height, layers)
}
