package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.desk.FlashCard
import ch.fasrv.fanotes.desk.cardsFromMarkdown

/**
 * Deck-wide flashcard review: every note with `## Lernfragen`, definition cards or picture sheets feeds one
 * queue, due cards first. A card is identified by its note and its id (ids are only unique inside a note).
 */
data class DeckCard(val path: String, val card: FlashCard) {
    val key: String get() = "$path\u0000${card.id}"
}

/** Cheap pre-filter so a vault scan does not parse every note. */
fun noteMayHaveCards(markdown: String): Boolean =
    markdown.contains("Lernfragen") || markdown.contains("fanotes-term") || markdown.contains("fanotes-plate") || markdown.contains("fanotes-cards-v1")

fun deckCardsOf(notes: List<Pair<String, String>>, today: String): List<DeckCard> =
    notes.filter { noteMayHaveCards(it.second) }.flatMap { (path, markdown) -> cardsFromMarkdown(markdown, today).map { DeckCard(path, it) } }

/** Due cards, oldest due date first (then by note and card, so the order is stable between reviews). */
fun deckDue(cards: List<DeckCard>, today: String): List<DeckCard> =
    cards.filter { it.card.due <= today }.sortedWith(compareBy<DeckCard>({ it.card.due }, { it.path }, { it.card.id }))

data class DeckSummary(val due: Int, val total: Int, val notes: Int)

fun deckSummary(cards: List<DeckCard>, today: String) =
    DeckSummary(cards.count { it.card.due <= today }, cards.size, cards.map { it.path }.toSet().size)

/** The title shown under a deck card: the note's file name without folder and extension. */
fun deckNoteTitle(path: String): String = path.substringAfterLast('/').substringBeforeLast('.')
