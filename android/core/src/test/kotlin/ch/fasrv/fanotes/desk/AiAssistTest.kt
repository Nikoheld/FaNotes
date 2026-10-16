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

    @Test
    fun modelListsKeepTheDesktopKeys() {
        val ollama = parseAiModels(
            "ollama",
            """{"models":[{"model":"llama3","name":"Llama 3","details":{"family":"llama","parameter_size":"8B","quantization_level":"Q4"}}]}""",
        )
        assertEquals("llama3", ollama.single().key)
        assertEquals("Llama 3", ollama.single().title)
        assertEquals("llama · 8B · Q4", ollama.single().detail)
        val gemini = parseAiModels(
            "gemini",
            """{"models":[{"name":"models/gemini-flash","displayName":"Flash","supportedGenerationMethods":["generateContent"]},{"name":"models/embed","displayName":"Embed","supportedGenerationMethods":["embedContent"]}]}""",
        )
        assertEquals(listOf("gemini-flash"), gemini.map { it.key })
        val openai = parseAiModels("openai", """{"data":[{"id":"gpt-4o-mini","owned_by":"openai"}]}""")
        assertEquals("gpt-4o-mini", openai.single().key)
        val opencode = parseAiModels(
            "opencode",
            """{"all":[{"id":"local","name":"Local","models":{"small":{"name":"Small"}}}]}""",
        )
        assertEquals("local/small", opencode.single().key)
        assertEquals("Local · Small", opencode.single().title)
        val missing = assertFailsWith<IllegalArgumentException> { parseAiModels("ollama", """{}""") }
        assertEquals("Ollama hat keine Modellliste geliefert.", missing.message)
        assertEquals("http://127.0.0.1:11434/api/tags", aiModelsGet("ollama", "http://127.0.0.1:11434", "", "").url)
        assertEquals("Lokal", aiProviderKind(true))
        assertEquals("Cloud", aiProviderKind(false))
        assertEquals("2 ausgewählt · Mehrfachauswahl möglich", aiActionCountLabel(2))
        assertEquals(listOf("expand", "summary", "study"), AI_ACTIONS.filter { it.additive }.map { it.id })
        assertEquals(67, AI_PROVIDER_MIN_DP)
        assertEquals(76, AI_ACTION_MIN_DP)
        assertEquals(12, AI_STEP_RADIUS_DP)
        assertEquals("Vorschau erzeugen", AI_RUN)
        assertEquals("Ergebnis übernehmen", AI_APPLY)
    }

    @Test
    fun thePanelUsesTheDesktopColumns() {
        assertEquals(true, aiPanelStacks(760))
        assertEquals(false, aiPanelStacks(761))
        assertEquals(400, aiConfigWidthDp(400))
        assertEquals(360, aiConfigWidthDp(800))
        assertEquals(510, aiConfigWidthDp(1200))
        assertEquals(2, aiProviderColumns(980))
        assertEquals(3, aiProviderColumns(981))
        assertEquals(2, aiActionColumns(700))
        assertEquals(1, aiActionColumns(900))
        assertEquals(2, aiActionColumns(1100))
        assertEquals(12, AI_PANEL_RADIUS_DP)
        assertEquals(33, AI_FIELD_HEIGHT_DP)
        assertEquals(8, AI_FIELD_RADIUS_DP)
        assertEquals("AI-Menü schließen", AI_CLOSE)
        assertEquals("3 · Prüfen", AI_PREVIEW_EYEBROW)
    }
}
