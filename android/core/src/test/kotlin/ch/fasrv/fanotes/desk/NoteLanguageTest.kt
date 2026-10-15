package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class NoteLanguageTest {
    @Test
    fun theStatusBarNamesTheDesktopLanguages() {
        assertEquals("de", detectNoteLanguage("Der Satz ist auf dem Papier und die Klasse schreibt mit."))
        assertEquals("Deutsch", statusLanguageLabel("de"))
        assertEquals("en", detectNoteLanguage("The cat is on the mat and we were there with you."))
        assertEquals("English", statusLanguageLabel("en"))
        assertEquals("fr", detectNoteLanguage("Le chat est dans la maison avec les amis et la famille."))
        assertEquals("Français", statusLanguageLabel("fr"))
        val mixed = detectNoteLanguage("The cat is on the mat and we were there.\nDer Satz ist auf dem Papier und die Klasse.")
        assertEquals("mixed", mixed)
        assertEquals("DE / EN", statusLanguageLabel(mixed))
        assertEquals("unknown", detectNoteLanguage("```\nDer Satz ist auf dem Papier\n```"))
        assertNull(statusLanguageLabel("unknown"))
        assertNull(statusLanguageLabel(""))
    }
}