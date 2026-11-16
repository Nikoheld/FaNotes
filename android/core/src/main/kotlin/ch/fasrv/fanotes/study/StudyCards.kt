package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString

/** Picture sheets (`fanotes-plate`) and definition cards (`fanotes-term`). Ported from `lib/study/cardsModels.ts`. */

data class PlateItem(val id: String, val label: String, val note: String, val img: String)
data class PlateData(val title: String, val cols: Int, val showLabels: Boolean, val items: List<PlateItem>)
data class TermEntry(val id: String, val term: String, val definition: String, val example: String, val source: String)
data class TermData(val terms: List<TermEntry>)

private const val MAX_ITEMS = 40
private const val MAX_TERMS = 30

fun defaultPlateData() = PlateData("Bildtafel", 4, true, emptyList())
fun defaultTermData() = TermData(listOf(TermEntry(newStudyId("t"), "", "", "", "")))

fun normalisePlateData(source: JsonValue.Obj, random: java.util.Random = java.util.Random()): PlateData {
    val ids = HashSet<String>()
    val items = source["items"].asArray(MAX_ITEMS).map { entry ->
        val item = entry.asRecord()
        var id = item.text("id", 40)
        if (id.isEmpty() || id in ids) id = newStudyId("p", random)
        ids += id
        PlateItem(id, item.text("label", 120), item.text("note", 300), asStudyImage(item["img"]))
    }
    val cols = (source["cols"] as? JsonValue.Num)?.value
    return PlateData(
        source.text("title", 120),
        if (cols != null && cols % 1.0 == 0.0 && cols >= 1 && cols <= 8) cols.toInt() else 4,
        (source["showLabels"] as? JsonValue.Bool)?.value != false,
        items,
    )
}

fun parsePlateData(body: String): PlateData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    return if (raw.fields.isEmpty()) defaultPlateData() else normalisePlateData(raw)
}

fun plateDataJson(data: PlateData): JsonValue = jsonObject(
    "v" to num(1),
    "title" to jsonString(data.title),
    "cols" to num(data.cols),
    "showLabels" to jsonBool(data.showLabels),
    "items" to JsonValue.Arr(
        data.items.map {
            jsonObject("id" to jsonString(it.id), "label" to jsonString(it.label), "note" to jsonString(it.note), "img" to jsonString(it.img)) as JsonValue
        }.toMutableList(),
    ),
)

fun normaliseTermData(source: JsonValue.Obj, random: java.util.Random = java.util.Random()): TermData {
    val ids = HashSet<String>()
    val terms = source["terms"].asArray(MAX_TERMS).map { entry ->
        val term = entry.asRecord()
        var id = term.text("id", 40)
        if (id.isEmpty() || id in ids) id = newStudyId("t", random)
        ids += id
        TermEntry(id, term.text("term", 160), term.text("definition", 2000), term.text("example", 1000), term.text("source", 300))
    }
    return TermData(terms)
}

fun parseTermData(body: String): TermData? {
    val raw = parseJsonObjectOrNull(body) ?: return null
    return if (raw.fields.isEmpty()) defaultTermData() else normaliseTermData(raw)
}

fun termDataJson(data: TermData): JsonValue = jsonObject(
    "v" to num(1),
    "terms" to JsonValue.Arr(
        data.terms.map {
            jsonObject(
                "id" to jsonString(it.id), "term" to jsonString(it.term), "definition" to jsonString(it.definition),
                "example" to jsonString(it.example), "source" to jsonString(it.source),
            ) as JsonValue
        }.toMutableList(),
    ),
)

/** A card derived from a study block. Not stored: the schedule is kept by id in the note's card store. */
data class StudyCardSource(val id: String, val front: String, val back: String, val frontImage: String? = null)

const val PLATE_PROMPT = "Wie heisst das?"

fun isStudyCardId(id: String) = id.startsWith("term:") || id.startsWith("plate:")

fun studyCardSources(markdown: String): List<StudyCardSource> {
    if (!markdown.contains("fanotes-")) return emptyList()
    val cards = ArrayList<StudyCardSource>()
    val ids = HashSet<String>()
    for (block in findStudyBlocks(markdown)) {
        if (block.kind == StudyKind.TERM) {
            for (entry in parseTermData(block.body)?.terms.orEmpty()) {
                val front = entry.term.trim()
                val definition = entry.definition.trim()
                if (front.isEmpty() || definition.isEmpty() || "term:${entry.id}" in ids) continue
                ids += "term:${entry.id}"
                val extra = listOfNotNull(
                    entry.example.trim().takeIf { it.isNotEmpty() }?.let { "Beispiel: $it" },
                    entry.source.trim().takeIf { it.isNotEmpty() }?.let { "Quelle: $it" },
                )
                cards += StudyCardSource("term:${entry.id}", front, (listOf(definition) + extra).joinToString("\n"))
            }
        } else if (block.kind == StudyKind.PLATE) {
            val plate = parsePlateData(block.body) ?: continue
            for (item in plate.items) {
                if (item.img.isEmpty() || item.label.trim().isEmpty() || "plate:${item.id}" in ids) continue
                ids += "plate:${item.id}"
                cards += StudyCardSource(
                    "plate:${item.id}",
                    if (plate.title.isNotEmpty()) "${plate.title}: $PLATE_PROMPT" else PLATE_PROMPT,
                    listOf(item.label.trim(), item.note.trim()).filter { it.isNotEmpty() }.joinToString("\n"),
                    item.img,
                )
            }
        }
    }
    return cards
}
