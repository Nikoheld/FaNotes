use fanotes_host::Host;
use serde_json::json;
use std::fs;

#[test]
fn a_pdf_book_can_pop_out_and_another_file_cannot() {
    let dir = std::env::temp_dir().join(format!("fanotes-popout-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("Mathe")).unwrap();
    fs::write(vault.join("Mathe/Buch.pdf"), b"%PDF-1.4\n").unwrap();
    fs::write(vault.join("Mathe/Seite.md"), b"Hallo\n").unwrap();
    fs::write(vault.join("Mathe/.pdf"), b"%PDF-1.4\n").unwrap();
    fs::write(vault.join("Mathe/.famd"), b"companion\n").unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    let opened = host
        .dispatch(
            "fanotes:open-subject-book-popout",
            &[json!("Mathe/Buch.pdf")],
        )
        .unwrap();
    assert_eq!(opened["open"], true);
    assert_eq!(opened["bookPath"], "Mathe/Buch.pdf");
    let missing = host
        .dispatch(
            "fanotes:open-subject-book-popout",
            &[json!("Mathe/Fehlt.pdf")],
        )
        .unwrap();
    assert_eq!(missing["open"], true);
    assert_eq!(missing["bookPath"], "Mathe/Fehlt.pdf");
    fs::create_dir(vault.join("Mathe/Ordner.pdf")).unwrap();
    let folder = host
        .dispatch(
            "fanotes:open-subject-book-popout",
            &[json!("Mathe/Ordner.pdf")],
        )
        .unwrap();
    assert_eq!(folder["open"], true);
    assert_eq!(folder["bookPath"], "Mathe/Ordner.pdf");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            vault.join("Mathe/Buch.pdf"),
            vault.join("Mathe/Link.pdf"),
        )
        .unwrap();
        let link = host
            .dispatch(
                "fanotes:open-subject-book-popout",
                &[json!("Mathe/Link.pdf")],
            )
            .unwrap();
        assert_eq!(link["open"], true);
        assert_eq!(link["bookPath"], "Mathe/Link.pdf");
    }
    assert_eq!(
        host.dispatch(
            "fanotes:open-subject-book-popout",
            &[json!("../geheim.pdf")],
        )
        .unwrap_err(),
        "Pfad-Traversal ist nicht erlaubt."
    );
    let note = host
        .dispatch(
            "fanotes:open-subject-book-popout",
            &[json!("Mathe/Seite.md")],
        )
        .unwrap_err();
    assert!(note.contains("Nur ein PDF-Buch"), "{note}");

    let dotfile = host
        .dispatch("fanotes:open-subject-book-popout", &[json!("Mathe/.pdf")])
        .unwrap_err();
    assert!(dotfile.contains("PDF-Notizen"), "{dotfile}");
    let empty = host
        .dispatch("fanotes:open-subject-book-popout", &[json!("")])
        .unwrap_err();
    assert!(empty.contains("nicht erlaubt"), "{empty}");

    host.trash_dir = Some(dir.join("trash"));
    host.dispatch("fanotes:trash-entry", &[json!("Mathe/.pdf")])
        .unwrap();
    assert!(vault.join("Mathe/.famd").is_file());
    assert_eq!(
        host.dispatch("fanotes:close-subject-book-popout", &[])
            .unwrap()["open"],
        false
    );
}
