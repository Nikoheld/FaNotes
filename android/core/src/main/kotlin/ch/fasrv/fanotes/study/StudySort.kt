package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString

/** Sorting board (`fanotes-sort`): cards in groups or one sequence. Ported from `lib/study/sortBoard.ts`. */

data class SortCard(val id: String, val text: String)
data class SortGroup(val id: String, val title: String, val cards: List<String>)
data class SortData(val title: String, val sequence: Boolean, val cards: List<SortCard>, val groups: List<SortGroup>)

private const val MAX_CARDS = 120
private const val MAX_GROUPS = 12

fun defaultSortData() = SortData(
    "Sortieren",
    false,
    emptyList(),
    listOf(SortGroup("g1", "Gruppe 1", emptyList()), SortGroup("g2", "Gruppe 2", emptyList())),
)

fun normaliseSortData(source: JsonValue.Obj, random: java.util.Random = java.util.Random()): SortData {
    val cards = ArrayList<SortCard>()
    val ids = HashSet<String>()
    for (entry in source["cards"].asArray(MAX_CARDS)) {
        val card = entry.asRecord()
        val text = card.text("text", 200).trim()
        var id = card.text("id", 40)
        if (text.isEmpty()) continue
        if (id.isEmpty() || id in ids) id = newStudyId("c", random)
        ids += id
        cards += SortCard(id, text)
    }
    val placed = HashSet<String>()
    val groups = source["groups"].asArray(MAX_GROUPS).mapIndexed { index, entry ->
        val group = entry.asRecord()
        val list = group["cards"].asArray(MAX_CARDS).mapNotNull { (it as? JsonValue.Str)?.value }.filter { it in ids && it !in placed }
        list.forEach { placed += it }
        SortGroup(group.text("id", 40).ifEmpty { "g${index + 1}" }, group.text("title", 80), list)
    }.toMutableList()
    val sequence = source.text("mode", 20) == "sequence"
    if (groups.isEmpty()) groups += SortGroup("g1", if (sequence) "Reihenfolge" else "Gruppe 1", emptyList())
    return SortData(source.text("title", 120), sequence, cards, if (sequence) groups.take(1) else groups)
}

/** Null when [body] is not a JSON object; `{}` yields the starter board. */
fun parseSortData(body: String): SortData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    return if (raw.fields.isEmpty()) defaultSortData() else normaliseSortData(raw)
}

fun sortDataJson(data: SortData): JsonValue = jsonObject(
    "v" to num(1),
    "title" to jsonString(data.title),
    "mode" to jsonString(if (data.sequence) "sequence" else "groups"),
    "cards" to JsonValue.Arr(data.cards.map { jsonObject("id" to jsonString(it.id), "text" to jsonString(it.text)) as JsonValue }.toMutableList()),
    "groups" to JsonValue.Arr(
        data.groups.map { group ->
            jsonObject(
                "id" to jsonString(group.id),
                "title" to jsonString(group.title),
                "cards" to JsonValue.Arr(group.cards.map { jsonString(it) as JsonValue }.toMutableList()),
            ) as JsonValue
        }.toMutableList(),
    ),
)

fun unsortedCards(data: SortData): List<SortCard> {
    val placed = data.groups.flatMap { it.cards }.toSet()
    return data.cards.filter { it.id !in placed }
}

/** Moves a card to [groupId] at [index]; a null group puts it back into the unsorted pool. */
fun moveCard(data: SortData, cardId: String, groupId: String?, index: Int? = null): SortData {
    if (data.cards.none { it.id == cardId }) return data
    val groups = data.groups.map { it.copy(cards = it.cards.filter { id -> id != cardId }) }.toMutableList()
    if (groupId != null) {
        val position = groups.indexOfFirst { it.id == groupId }
        if (position < 0) return data
        val target = groups[position]
        val at = if (index == null) target.cards.size else index.coerceIn(0, target.cards.size)
        groups[position] = target.copy(cards = target.cards.toMutableList().also { it.add(at, cardId) })
    }
    return data.copy(groups = groups)
}

fun addSortCards(data: SortData, texts: List<String>, random: java.util.Random = java.util.Random()): SortData {
    val room = MAX_CARDS - data.cards.size
    val added = texts.take(maxOf(0, room)).map { SortCard(newStudyId("c", random), it.take(200)) }
    return data.copy(cards = data.cards + added)
}

fun removeSortCard(data: SortData, cardId: String): SortData = data.copy(
    cards = data.cards.filter { it.id != cardId },
    groups = data.groups.map { it.copy(cards = it.cards.filter { id -> id != cardId }) },
)

fun renameSortGroup(data: SortData, groupId: String, title: String): SortData =
    data.copy(groups = data.groups.map { if (it.id == groupId) it.copy(title = title.take(80)) else it })

fun renameSortCard(data: SortData, cardId: String, text: String): SortData =
    data.copy(cards = data.cards.map { if (it.id == cardId) it.copy(text = text.take(200)) else it })
