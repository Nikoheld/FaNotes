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
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault).unwrap();
    let opened = host
        .dispatch(
            "fanotes:open-subject-book-popout",
            &[json!("Mathe/Buch.pdf")],
        )
        .unwrap();
    assert_eq!(opened["open"], true);
    assert_eq!(opened["bookPath"], "Mathe/Buch.pdf");
    assert!(host
        .dispatch(
            "fanotes:open-subject-book-popout",
            &[json!("Mathe/Seite.md")]
        )
        .is_err());
    assert_eq!(
        host.dispatch("fanotes:close-subject-book-popout", &[])
            .unwrap()["open"],
        false
    );
}
