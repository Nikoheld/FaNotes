package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class PaperStylesTest {
    @Test
    fun theNotePickerUsesTheDesktopPaperNames() {
        assertEquals(listOf("blank", "dots", "squares", "grid", "lines", "millimeter"), PAPER_STYLES.map { it.id })
        assertEquals("Gepunktet", paperStyleLabel("dots"))
        assertEquals("Häuschen", paperStyleLabel("squares"))
        assertEquals("Kariert", paperStyleLabel("grid"))
        assertEquals("Liniert", paperStyleLabel("lines"))
        assertEquals("Millimeter", paperStyleLabel("millimeter"))
        assertEquals("Papier", paperStyleLabel("linen"))
        assertEquals("Ohne Muster", paperStyleById("blank").detail)
        assertEquals("Ruhiges Punktraster", paperStyleById(null).detail)
        assertEquals("Kleine Schulkästchen", paperStyleById("squares").detail)
        assertEquals("Grössere Karos", paperStyleById("grid").detail)
        assertEquals("Lineatur mit Rand", paperStyleById("lines").detail)
        assertEquals("Feinraster wie Millimeterpapier", paperStyleById("millimeter").detail)
        assertEquals("Millimeterpapier", paperStyleSettingsLabel("millimeter"))
        assertEquals("Gepunktet", paperStyleSettingsLabel("dots"))
        assertEquals("Gepunktet", paperStyleSettingsLabel("nope"))
        assertEquals("dots", normalizePaperStyle(null))
        assertEquals("lines", normalizePaperStyle("lines"))
        assertEquals("dots", normalizePaperStyle("linen"))
        assertEquals("Nur für diese Notiz", PAPER_PICKER_HINT)
    }
}
