use std::path::PathBuf;

#[test]
fn webkit_writes_an_a4_pdf() {
    let path = PathBuf::from(format!("/tmp/fanotes-export-{}.pdf", std::process::id()));
    let _ = std::fs::remove_file(&path);
    fanotes_tauri::print_html_to_pdf(
        "<html><body><h1>FaNotes</h1><p>Notiz</p></body></html>",
        &path,
    )
    .unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert!(
        bytes.starts_with(b"%PDF-"),
        "pdf started with {:?}",
        &bytes[..bytes.len().min(16)]
    );
    assert!(bytes.len() > 64);
}
