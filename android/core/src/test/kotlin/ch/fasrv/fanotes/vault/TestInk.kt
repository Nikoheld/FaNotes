package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.newInkDocument

/** A new note that is stored with one ink stroke, so it has a `.famd` sidecar from the start (no earlier save). */
fun NoteStore.createInkNote(directory: String, title: String): String {
    val name = safeNoteName(title)
    val folder = directory.trim('/')
    val path = if (folder.isEmpty()) "$name.md" else "$folder/$name.md"
    val now = "2026-04-01T00:00:00.000Z"
    val body = "# $name\n"
    val document = newInkDocument(name, "dots", now)
    val note = OpenNote(path, NoteKind.MARKDOWN, name, body, document, emptyFamdPayload(now), emptyList(), java.util.UUID.randomUUID().toString())
    val session = InkSession(document)
    session.beginStroke()
    session.addSample(StrokePoint(0.2, 0.3, 1.0, 0.8, 1.0, 2.0, "pen"))
    session.addSample(StrokePoint(0.4, 0.35, 20.0, 0.4, 0.0, 0.0, "pen"))
    session.endStroke(StrokeStyle(color = "#2457d6"), now)
    save(note, session.document, body, now)
    return path
}
