package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class AiAssistTest {
    @Test
    fun thePromptNamesEverySelectedActionAndKeepsTheNoteAsData() {
        val prompt = aiNotePrompt(
            markdown = "Hallo Welt",
            actions = listOf("spelling", "summary"),
            instruction = "",
            title = "Algebra",
            relativePath = "Schule/Algebra.md",
            notes = listOf("Mechanik" to "Schule/Mechanik.md"),
        )
        assertTrue(prompt.contains("Korrigiere Rechtschreibung, Grammatik und Zeichensetzung."))
        assertTrue(prompt.contains("## AI-Zusammenfassung"))
        assertTrue(prompt.contains("NOTIZ_START\nHallo Welt\nNOTIZ_ENDE"))
        assertTrue(prompt.contains("- Mechanik → Schule/Mechanik"))
        assertEquals("# Algebra", unwrapAiMarkdown("```markdown\n# Algebra\n```"))
        assertEquals("Fertig", unwrapAiMarkdown("<think>geheim</think>\nFertig"))
    }

    @Test
    fun localProvidersStayOnTheLanAndABlankActionIsRefused() {
        assertEquals("http://127.0.0.1:11434", localAiOrigin("http://127.0.0.1:11434", "ollama"))
        assertEquals("http://192.168.1.20:11434", localAiOrigin("http://192.168.1.20:11434/", "ollama"))
        assertEquals("http://127.0.0.1:1234", localAiOrigin("http://127.0.0.1:1234/v1", "lmstudio"))
        val publicHost = assertFailsWith<IllegalArgumentException> { localAiOrigin("https://api.openai.com", "ollama") }
        assertEquals("Ollama darf aus Datenschutzgründen nur auf localhost oder im privaten LAN liegen.", publicHost.message)
        val missing = assertFailsWith<IllegalArgumentException> {
            prepareAiJob("ollama", "http://127.0.0.1:11434", "llama", emptyList(), "", "A", "A.md", "Text", emptyList())
        }
        assertEquals("Die ausgewählten AI-Aktionen sind ungültig.", missing.message)
        val order = assertFailsWith<IllegalArgumentException> {
            prepareAiJob("lmstudio", "http://127.0.0.1:1234", "local", listOf("instruction"), "  ", "A", "A.md", "Text", emptyList())
        }
        assertEquals("Schreibe zuerst den freien Auftrag in das Textfeld.", order.message)
        val job = prepareAiJob("openai", "", "gpt-4o-mini", listOf("spelling"), "", "A", "A.md", "Text", emptyList())
        val call = aiTransformCall(job, "secret", "")
        assertEquals("https://api.openai.com/v1/responses", call.url)
        assertTrue(call.headers.any { it.first == "Authorization" && it.second == "Bearer secret" })
        assertEquals("# Algebra", aiReplyText("openai", """{"output_text":"```markdown\n# Algebra\n```"}"""))
        assertEquals("Hallo", aiReplyText("ollama", """{"message":{"content":"Hallo"}}"""))
    }
}
