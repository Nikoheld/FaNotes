use base64::Engine;
use fanotes_famd::parse_famd;
use fanotes_host::Host;
use serde_json::json;

fn host() -> (Host, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("fanotes-imports-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    std::fs::create_dir_all(vault.join("Mathe")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(vault.clone()).unwrap();
    (host, vault)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn a_dropped_image_and_a_pdf_note_land_in_the_vault() {
    let (mut host, vault) = host();
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    let document = host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({
                "name": "Tafel.png",
                "mimeType": "image/png",
                "bytesBase64": b64(&png),
            })],
        )
        .unwrap();
    let id = document["id"].as_str().unwrap();
    assert_eq!(document["kind"], "image");
    assert_eq!(document["title"], "Tafel");
    assert_eq!(
        std::fs::read(vault.join(format!(".fanotes/worksheets/{id}.png"))).unwrap(),
        png
    );
    assert_eq!(
        host.dispatch("fanotes:read-worksheet", &[json!(id)])
            .unwrap()["id"],
        id
    );
    assert!(host
        .dispatch(
            "fanotes:import-worksheet-from-data",
            &[json!({ "name": "notes.txt", "bytesBase64": b64(b"hello") })],
        )
        .is_err());

    let pdf = b"%PDF-1.4\n";
    let first = host
        .dispatch(
            "fanotes:import-pdf-note",
            &[
                json!("Mathe"),
                json!({ "name": "Skript.pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(first["relativePath"], "Mathe/Skript.pdf");
    let imported = vault.join("Mathe/Skript.pdf");
    assert_eq!(std::fs::read(&imported).unwrap(), pdf);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&imported).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let famd = std::fs::read_to_string(vault.join("Mathe/Skript.famd")).unwrap();
    assert!(parse_famd(&famd).payload.is_some());

    let second = host
        .dispatch(
            "fanotes:import-subject-book",
            &[
                json!("Mathe"),
                json!({ "name": "Skript.pdf", "bytesBase64": b64(pdf) }),
            ],
        )
        .unwrap();
    assert_eq!(second["relativePath"], "Mathe/Skript 2.pdf");
    assert!(host
        .dispatch("fanotes:import-subject-book", &[json!("")])
        .is_err());
}
