//! Native file-dialog titles and filters.
//!
//! Electron passes these strings through `localizeDialogOptions`. The accept
//! button label is not available on the GTK file chooser wrapper, so only the
//! title and filter names follow that catalog.

pub type DialogFilter = (&'static str, &'static [&'static str]);

const PDF_AND_IMAGES: &[&str] = &["pdf", "png", "jpg", "jpeg", "webp", "gif"];
const PDF_ONLY: &[&str] = &["pdf"];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const ONENOTE_ALL: &[&str] = &["one", "onetoc2", "onepkg", "zip"];
const ONENOTE_BOOKS: &[&str] = &["onetoc2", "onepkg", "zip"];
const ONENOTE_SECTIONS: &[&str] = &["one"];

pub fn native_label(language: &str, source: &'static str) -> &'static str {
    if language != "en" {
        return source;
    }
    // Exact catalog hits, plus the substring result `localizeText` produces
    // for `OneNote-Abschnitte` (`Abschnitte` -> `Sections`).
    match source {
        "Notiz als PDF speichern" => "Save note as PDF",
        "FaNotes-Vault auswählen" => "Select FaNotes Vault",
        "Ordnerpfad für FaNotes wählen" => "Choose a FaNotes folder path",
        "Ordner verwenden" => "Use folder",
        "PDF-Buch zum Fach hinzufügen" => "Add a PDF book to the subject",
        "PDF-Dokumente" => "PDF documents",
        "Bild oder PDF als Arbeitsblatt importieren" => "Import image or PDF as a worksheet",
        "Arbeitsblätter" => "Worksheets",
        "Bilder" => "Images",
        "PDF als Notiz importieren" => "Import PDF as a note",
        "Microsoft OneNote in FaNotes importieren" => "Import Microsoft OneNote into FaNotes",
        "OneNote-Notizbücher" => "OneNote notebooks",
        "OneNote-Abschnitte" => "OneNote-Sections",
        "Buch" => "Book",
        _ => source,
    }
}

pub fn worksheet_import_dialog(language: &str) -> (&'static str, Vec<DialogFilter>) {
    (
        native_label(language, "Bild oder PDF als Arbeitsblatt importieren"),
        vec![
            (native_label(language, "Arbeitsblätter"), PDF_AND_IMAGES),
            (native_label(language, "PDF-Dokumente"), PDF_ONLY),
            (native_label(language, "Bilder"), IMAGES),
        ],
    )
}

pub fn pdf_note_import_dialog(language: &str) -> (&'static str, Vec<DialogFilter>) {
    (
        native_label(language, "PDF als Notiz importieren"),
        vec![(native_label(language, "PDF-Dokumente"), PDF_ONLY)],
    )
}

pub fn subject_book_import_dialog(language: &str) -> (&'static str, Vec<DialogFilter>) {
    (
        native_label(language, "PDF-Buch zum Fach hinzufügen"),
        vec![(native_label(language, "PDF-Dokumente"), PDF_ONLY)],
    )
}

pub fn onenote_import_dialog(language: &str) -> (&'static str, Vec<DialogFilter>) {
    (
        native_label(language, "Microsoft OneNote in FaNotes importieren"),
        vec![
            (native_label(language, "Microsoft OneNote"), ONENOTE_ALL),
            (native_label(language, "OneNote-Notizbücher"), ONENOTE_BOOKS),
            (
                native_label(language, "OneNote-Abschnitte"),
                ONENOTE_SECTIONS,
            ),
        ],
    )
}

pub fn vault_picker_title(language: &str) -> &'static str {
    native_label(language, "FaNotes-Vault auswählen")
}

pub fn folder_location_picker_title(language: &str) -> &'static str {
    native_label(language, "Ordnerpfad für FaNotes wählen")
}

pub fn pdf_export_dialog(language: &str) -> (&'static str, DialogFilter) {
    (
        native_label(language, "Notiz als PDF speichern"),
        ("PDF", PDF_ONLY),
    )
}

pub fn subject_book_window_title(language: &str) -> &'static str {
    native_label(language, "Buch")
}

#[cfg(test)]
mod tests {
    use super::{
        native_label, onenote_import_dialog, pdf_export_dialog, pdf_note_import_dialog,
        subject_book_import_dialog, subject_book_window_title, vault_picker_title,
        worksheet_import_dialog,
    };

    #[test]
    fn import_dialogs_use_the_desktop_filter_names() {
        let (title, filters) = worksheet_import_dialog("de");
        assert_eq!(title, "Bild oder PDF als Arbeitsblatt importieren");
        assert_eq!(
            filters,
            vec![
                (
                    "Arbeitsblätter",
                    &["pdf", "png", "jpg", "jpeg", "webp", "gif"][..]
                ),
                ("PDF-Dokumente", &["pdf"][..]),
                ("Bilder", &["png", "jpg", "jpeg", "webp", "gif"][..]),
            ]
        );
        assert_eq!(
            pdf_note_import_dialog("de").1,
            vec![("PDF-Dokumente", &["pdf"][..])]
        );
        assert_eq!(
            subject_book_import_dialog("de").1,
            vec![("PDF-Dokumente", &["pdf"][..])]
        );
        assert_eq!(
            onenote_import_dialog("de").1,
            vec![
                (
                    "Microsoft OneNote",
                    &["one", "onetoc2", "onepkg", "zip"][..]
                ),
                ("OneNote-Notizbücher", &["onetoc2", "onepkg", "zip"][..]),
                ("OneNote-Abschnitte", &["one"][..]),
            ]
        );
    }

    #[test]
    fn english_file_dialogs_use_the_catalog() {
        assert_eq!(
            worksheet_import_dialog("en").0,
            "Import image or PDF as a worksheet"
        );
        assert_eq!(worksheet_import_dialog("en").1[0].0, "Worksheets");
        assert_eq!(worksheet_import_dialog("en").1[1].0, "PDF documents");
        assert_eq!(worksheet_import_dialog("en").1[2].0, "Images");
        assert_eq!(pdf_note_import_dialog("en").0, "Import PDF as a note");
        assert_eq!(
            subject_book_import_dialog("en").0,
            "Add a PDF book to the subject"
        );
        assert_eq!(
            onenote_import_dialog("en").0,
            "Import Microsoft OneNote into FaNotes"
        );
        assert_eq!(onenote_import_dialog("en").1[1].0, "OneNote notebooks");
        assert_eq!(onenote_import_dialog("en").1[2].0, "OneNote-Sections");
        assert_eq!(vault_picker_title("en"), "Select FaNotes Vault");
        assert_eq!(pdf_export_dialog("en").0, "Save note as PDF");
        assert_eq!(pdf_export_dialog("en").1 .0, "PDF");
        assert_eq!(subject_book_window_title("en"), "Book");
        assert_eq!(native_label("de", "Buch"), "Buch");
        assert_eq!(native_label("system", "Buch"), "Buch");
        assert_eq!(vault_picker_title("de"), "FaNotes-Vault auswählen");
    }
}
