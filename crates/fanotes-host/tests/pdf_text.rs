//! `fanotes:read-pdf-ocr`, `write-pdf-ocr`, `read-page-text`, `write-page-text`
//! against `electron/main.cjs`, `electron/pdf-ocr.cjs` and `electron/page-text.cjs`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use fanotes_host::Host;
use serde_json::{json, Value};

struct Fixture {
    dir: PathBuf,
    vault: PathBuf,
    host: Host,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-pdf-text-{}-{id}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("Mathe")).unwrap();
    fs::write(vault.join("Mathe/Buch.pdf"), b"%PDF-").unwrap();
    let mut host = Host::open_hermetic(dir.join("app"));
    host.trash_dir = Some(dir.join("trash"));
    host.set_vault(vault.clone()).unwrap();
    let vault = fs::canonicalize(vault).unwrap();
    Fixture { dir, vault, host }
}

// `sha256(path).hex.slice(0, 32)` from node for these paths.
const BUCH: &str = "d44b4c7ea3b2ffdcf1071a8689d9f40b.json";
const PHYSIK_BUCH: &str = "b832041c14a5010afa3f46170d968b15.json";

fn mtime_ms(path: &Path) -> i64 {
    let modified = fs::metadata(path).unwrap().modified().unwrap();
    let elapsed = modified.duration_since(std::time::UNIX_EPOCH).unwrap();
    (elapsed.as_secs() as i64) * 1000 + ((elapsed.subsec_nanos() as i64 + 500_000) / 1_000_000)
}

fn ocr_payload(path: &str, size: u64) -> Value {
    json!({
        "path": path,
        "size": size,
        "stamp": "0123abcd",
        "pages": [{ "page": 2, "text": "Zwei ü" }, { "page": 1, "text": "Eins", "extra": 1 }],
    })
}

fn page_text(path: &str, size: u64) -> Value {
    json!({
        "format": "fanotes-page-text-v1",
        "path": path,
        "size": size,
        "stamp": "deadbeef",
        "pageCount": 2,
        "producer": "pdfjs",
        "ocrEngine": "trocr",
        "createdAt": "2026-11-09T10:00:00.000Z",
        "pages": [
            { "page": 2, "source": "ocr", "status": "ok", "text": "b", "confidence": 1, "rotation": 180 },
            { "page": 1, "source": "text-layer", "status": "ok", "text": "a" },
        ],
    })
}

#[test]
fn an_ocr_transcript_round_trips_in_the_desktop_format() {
    let mut f = fixture();
    let pdf = f.vault.join("Mathe/Buch.pdf");
    let written = f
        .host
        .dispatch("fanotes:write-pdf-ocr", &[ocr_payload("Mathe/Buch.pdf", 5)])
        .unwrap();
    let mtime = mtime_ms(&pdf);
    let expected = format!(
        r#"{{"format":"fanotes-pdf-ocr-v1","path":"Mathe/Buch.pdf","size":5,"mtimeMs":{mtime},"stamp":"0123abcd","pages":[{{"page":2,"text":"Zwei ü"}},{{"page":1,"text":"Eins"}}]}}"#
    );
    assert_eq!(serde_json::to_string(&written).unwrap(), expected);
    let stored = f.vault.join(".fanotes/pdf-ocr").join(BUCH);
    assert_eq!(
        fs::read_to_string(&stored).unwrap(),
        format!("{expected}\n")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&stored).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let directory = fs::metadata(f.vault.join(".fanotes/pdf-ocr")).unwrap();
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
    }
    // No temporary file is left beside the record.
    assert_eq!(
        fs::read_dir(f.vault.join(".fanotes/pdf-ocr"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(
        f.host
            .dispatch("fanotes:read-pdf-ocr", &[json!("Mathe/Buch.pdf")])
            .unwrap(),
        written
    );
    // A changed PDF invalidates the transcript; the record stays on disk.
    fs::write(&pdf, b"%PDF-1.7").unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:read-pdf-ocr", &[json!("Mathe/Buch.pdf")])
            .unwrap(),
        Value::Null
    );
    assert!(stored.exists());
}

#[test]
fn ocr_reads_never_fail_and_writes_report_the_desktop_errors() {
    let mut f = fixture();
    for argument in [
        json!(7),
        json!("Mathe/Notiz.md"),
        json!("../x.pdf"),
        json!(".fanotes/a.pdf"),
        json!("Mathe/Fehlt.pdf"),
        json!("/etc/x.pdf"),
    ] {
        assert_eq!(
            f.host
                .dispatch("fanotes:read-pdf-ocr", std::slice::from_ref(&argument))
                .unwrap(),
            Value::Null,
            "{argument}"
        );
        assert_eq!(
            f.host
                .dispatch("fanotes:read-page-text", std::slice::from_ref(&argument))
                .unwrap(),
            Value::Null,
            "{argument}"
        );
    }
    let error = |host: &mut Host, payload: Value| {
        host.dispatch("fanotes:write-pdf-ocr", &[payload])
            .unwrap_err()
    };
    assert_eq!(
        error(&mut f.host, json!(null)),
        "Die lokale PDF-Texterkennung ist ungültig."
    );
    assert_eq!(
        error(&mut f.host, json!([])),
        "Die lokale PDF-Texterkennung ist ungültig."
    );
    assert_eq!(
        error(&mut f.host, json!({ "path": 3 })),
        "Die lokale PDF-Texterkennung ist ungültig."
    );
    assert_eq!(
        error(&mut f.host, ocr_payload("Mathe/Notiz.md", 5)),
        "Nur PDF-Notizen werden lokal gelesen."
    );
    assert_eq!(
        error(&mut f.host, ocr_payload("../Buch.pdf", 5)),
        "Pfad-Traversal ist nicht erlaubt."
    );
    assert_eq!(
        error(&mut f.host, ocr_payload(".fanotes/Buch.pdf", 5)),
        "Interne FaNotes-Dateien sind geschützt."
    );
    assert_eq!(
        error(&mut f.host, ocr_payload("/tmp/Buch.pdf", 5)),
        "Nur relative Vault-Pfade sind erlaubt."
    );
    assert!(error(&mut f.host, ocr_payload("Mathe/Fehlt.pdf", 5)).contains("ENOENT"));
    // A payload that does not fit the PDF is not stored.
    let null = |host: &mut Host, payload: Value| {
        host.dispatch("fanotes:write-pdf-ocr", &[payload]).unwrap()
    };
    assert_eq!(
        null(&mut f.host, ocr_payload("Mathe/Buch.pdf", 6)),
        Value::Null
    );
    let mut bad = ocr_payload("Mathe/Buch.pdf", 5);
    bad["stamp"] = json!("0123ABCD");
    assert_eq!(null(&mut f.host, bad), Value::Null);
    let mut many = ocr_payload("Mathe/Buch.pdf", 5);
    many["pages"] = Value::Array(
        (1..=61)
            .map(|page| json!({ "page": page, "text": "x" }))
            .collect(),
    );
    assert_eq!(null(&mut f.host, many), Value::Null);
    let mut long = ocr_payload("Mathe/Buch.pdf", 5);
    long["pages"] = json!([{ "page": 1, "text": "x".repeat(6001) }]);
    assert_eq!(null(&mut f.host, long), Value::Null);
    assert!(!f.vault.join(".fanotes/pdf-ocr").exists());
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_carry_a_sidecar_out_of_the_vault() {
    use std::os::unix::fs::symlink;
    let mut f = fixture();
    let outside = f.dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("Fremd.pdf"), b"%PDF-").unwrap();
    // A linked PDF and a linked folder are refused like every vault path.
    symlink(outside.join("Fremd.pdf"), f.vault.join("Link.pdf")).unwrap();
    symlink(&outside, f.vault.join("Draussen")).unwrap();
    for path in ["Link.pdf", "Draussen/Fremd.pdf"] {
        assert_eq!(
            f.host
                .dispatch("fanotes:write-pdf-ocr", &[ocr_payload(path, 5)])
                .unwrap_err(),
            "Symbolische Links sind innerhalb des Vaults nicht erlaubt.",
            "{path}"
        );
        assert_eq!(
            f.host
                .dispatch("fanotes:read-pdf-ocr", &[json!(path)])
                .unwrap(),
            Value::Null
        );
    }
    // The sidecar folder itself must not be a link.
    fs::create_dir_all(f.vault.join(".fanotes")).unwrap();
    symlink(&outside, f.vault.join(".fanotes/pdf-ocr")).unwrap();
    symlink(&outside, f.vault.join(".fanotes/page-text")).unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:write-pdf-ocr", &[ocr_payload("Mathe/Buch.pdf", 5)])
            .unwrap_err(),
        "Der interne PDF-Ordner ist unsicher."
    );
    assert_eq!(
        f.host
            .dispatch("fanotes:write-page-text", &[page_text("Mathe/Buch.pdf", 5)])
            .unwrap_err(),
        "Der interne Textordner ist unsicher."
    );
    assert_eq!(
        fs::read_dir(&outside).unwrap().count(),
        1,
        "nothing was written outside"
    );
    // A record placed behind the link is not read either.
    fs::write(outside.join(BUCH), "{}").unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:read-pdf-ocr", &[json!("Mathe/Buch.pdf")])
            .unwrap(),
        Value::Null
    );
    // A linked `.fanotes` is refused before anything is created.
    fs::remove_file(f.vault.join(".fanotes/pdf-ocr")).unwrap();
    fs::remove_file(f.vault.join(".fanotes/page-text")).unwrap();
    fs::remove_dir(f.vault.join(".fanotes")).unwrap();
    symlink(&outside, f.vault.join(".fanotes")).unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:write-pdf-ocr", &[ocr_payload("Mathe/Buch.pdf", 5)])
            .unwrap_err(),
        "Der interne FaNotes-Ordner ist unsicher."
    );
}

#[test]
fn an_oversized_ocr_record_is_not_read() {
    let mut f = fixture();
    fs::create_dir_all(f.vault.join(".fanotes/pdf-ocr")).unwrap();
    let pdf = f.vault.join("Mathe/Buch.pdf");
    let mtime = mtime_ms(&pdf);
    let record = json!({
        "format": "fanotes-pdf-ocr-v1", "path": "Mathe/Buch.pdf", "size": 5, "mtimeMs": mtime,
        "stamp": "0123abcd", "pages": [{ "page": 1, "text": "ok" }],
    });
    let mut text = record.to_string();
    fs::write(f.vault.join(".fanotes/pdf-ocr").join(BUCH), &text).unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:read-pdf-ocr", &[json!("Mathe/Buch.pdf")])
            .unwrap(),
        record
    );
    text.push_str(&" ".repeat(512 * 1024));
    fs::write(f.vault.join(".fanotes/pdf-ocr").join(BUCH), &text).unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:read-pdf-ocr", &[json!("Mathe/Buch.pdf")])
            .unwrap(),
        Value::Null
    );
}

#[test]
fn page_text_round_trips_and_ignores_the_mtime() {
    let mut f = fixture();
    let written = f
        .host
        .dispatch("fanotes:write-page-text", &[page_text("Mathe/Buch.pdf", 5)])
        .unwrap();
    // `buildForWrite(...).serialized` from node for the same record.
    let expected = r#"{"format":"fanotes-page-text-v1","path":"Mathe/Buch.pdf","size":5,"stamp":"deadbeef","pageCount":2,"producer":"pdfjs","ocrEngine":"trocr","createdAt":"2026-11-09T10:00:00.000Z","pages":[{"page":1,"source":"text-layer","status":"ok","text":"a"},{"page":2,"source":"ocr","status":"ok","text":"b","confidence":1,"rotation":180}]}"#;
    assert_eq!(serde_json::to_string(&written).unwrap(), expected);
    let stored = f.vault.join(".fanotes/page-text").join(BUCH);
    assert_eq!(
        fs::read_to_string(&stored).unwrap(),
        format!("{expected}\n")
    );
    // Touching the PDF keeps the record: only path and size identify it.
    let pdf = f.vault.join("Mathe/Buch.pdf");
    filetime::set_file_mtime(&pdf, filetime::FileTime::from_unix_time(1_000_000, 0)).unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:read-page-text", &[json!("Mathe/Buch.pdf")])
            .unwrap(),
        written
    );
    fs::write(&pdf, b"%PDF-2").unwrap();
    assert_eq!(
        f.host
            .dispatch("fanotes:read-page-text", &[json!("Mathe/Buch.pdf")])
            .unwrap(),
        Value::Null
    );
}

#[test]
fn page_text_writes_follow_page_text_cjs() {
    let mut f = fixture();
    let error = |host: &mut Host, payload: Value| {
        host.dispatch("fanotes:write-page-text", &[payload])
            .unwrap_err()
    };
    assert_eq!(
        error(&mut f.host, json!("x")),
        "Der Seitentext ist ungültig."
    );
    assert_eq!(
        error(&mut f.host, json!({ "format": "fanotes-page-text-v1" })),
        "Der Seitentext ist ungültig."
    );
    assert_eq!(
        error(&mut f.host, page_text("Mathe/Notiz.md", 5)),
        "Seitentext gibt es nur für PDF-Notizen."
    );
    assert_eq!(
        error(&mut f.host, page_text("Mathe/../Buch.pdf", 5)),
        "Pfad-Traversal ist nicht erlaubt."
    );
    let null = |host: &mut Host, payload: Value| {
        host.dispatch("fanotes:write-page-text", &[payload])
            .unwrap()
    };
    assert_eq!(
        null(&mut f.host, page_text("Mathe/Buch.pdf", 4)),
        Value::Null
    );
    let mut bad = page_text("Mathe/Buch.pdf", 5);
    bad["pages"][0]["page"] = json!(3);
    assert_eq!(null(&mut f.host, bad), Value::Null, "page past pageCount");
    let mut bad = page_text("Mathe/Buch.pdf", 5);
    bad["createdAt"] = json!("gestern");
    assert_eq!(null(&mut f.host, bad), Value::Null);
    // 800 pages of 6000 three-byte characters are past the 4 MiB record cap.
    let mut large = page_text("Mathe/Buch.pdf", 5);
    large["pageCount"] = json!(800);
    large["pages"] = Value::Array(
        (1..=800)
            .map(|page| json!({ "page": page, "source": "ocr", "status": "ok", "text": "€".repeat(6000) }))
            .collect(),
    );
    assert_eq!(null(&mut f.host, large), Value::Null);
    assert!(!f.vault.join(".fanotes/page-text").exists());
}

#[test]
fn sidecars_follow_a_renamed_moved_and_trashed_pdf() {
    let mut f = fixture();
    fs::create_dir_all(f.vault.join("Physik")).unwrap();
    f.host
        .dispatch("fanotes:write-pdf-ocr", &[ocr_payload("Mathe/Buch.pdf", 5)])
        .unwrap();
    f.host
        .dispatch("fanotes:write-page-text", &[page_text("Mathe/Buch.pdf", 5)])
        .unwrap();
    // Moving the folder moves the nested records.
    let moved = f
        .host
        .dispatch("fanotes:move-entry", &[json!("Mathe"), json!("Physik")])
        .unwrap();
    assert_eq!(moved, "Physik/Mathe");
    let ocr = f
        .host
        .dispatch("fanotes:read-pdf-ocr", &[json!("Physik/Mathe/Buch.pdf")])
        .unwrap();
    assert_eq!(ocr["path"], "Physik/Mathe/Buch.pdf");
    assert_eq!(ocr["pages"][0]["text"], "Zwei ü");
    let text = f
        .host
        .dispatch("fanotes:read-page-text", &[json!("Physik/Mathe/Buch.pdf")])
        .unwrap();
    assert_eq!(text["path"], "Physik/Mathe/Buch.pdf");
    assert!(!f.vault.join(".fanotes/pdf-ocr").join(BUCH).exists());
    assert!(!f.vault.join(".fanotes/page-text").join(BUCH).exists());
    // Renaming the PDF itself.
    let renamed = f
        .host
        .dispatch(
            "fanotes:rename-entry",
            &[json!("Physik/Mathe/Buch.pdf"), json!("Neu")],
        )
        .unwrap();
    assert_eq!(renamed, "Physik/Mathe/Neu.pdf");
    assert_eq!(
        f.host
            .dispatch("fanotes:read-pdf-ocr", &[json!("Physik/Mathe/Neu.pdf")])
            .unwrap()["path"],
        "Physik/Mathe/Neu.pdf"
    );
    assert_eq!(
        fs::read_dir(f.vault.join(".fanotes/pdf-ocr"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(
        fs::read_dir(f.vault.join(".fanotes/page-text"))
            .unwrap()
            .count(),
        1
    );
    // A record of another PDF is left alone; trashing removes the PDF's own.
    fs::write(f.vault.join("Physik/Buch.pdf"), b"%PDF-").unwrap();
    f.host
        .dispatch(
            "fanotes:write-pdf-ocr",
            &[ocr_payload("Physik/Buch.pdf", 5)],
        )
        .unwrap();
    f.host
        .dispatch("fanotes:trash-entry", &[json!("Physik/Mathe/Neu.pdf")])
        .unwrap();
    let left: Vec<String> = fs::read_dir(f.vault.join(".fanotes/pdf-ocr"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, vec![PHYSIK_BUCH.to_owned()]);
    assert_eq!(
        fs::read_dir(f.vault.join(".fanotes/page-text"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn search_finds_a_scanned_pdf_by_its_ocr_transcript() {
    let mut f = fixture();
    let mut payload = ocr_payload("Mathe/Buch.pdf", 5);
    payload["pages"] = json!([{ "page": 1, "text": "Die Photosynthese braucht Licht." }]);
    f.host
        .dispatch("fanotes:write-pdf-ocr", &[payload])
        .unwrap();
    let hits = f
        .host
        .dispatch("fanotes:search", &[json!("photosynthese")])
        .unwrap();
    let hit = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["relativePath"] == "Mathe/Buch.pdf")
        .expect("the PDF is a hit");
    assert_eq!(hit["kind"], "note");
    assert_eq!(hit["title"], "Buch");
    assert!(hit["excerpt"].as_str().unwrap().contains("Photosynthese"));
    // A stale transcript is not searched.
    fs::write(f.vault.join("Mathe/Buch.pdf"), b"%PDF-1.7").unwrap();
    let hits = f
        .host
        .dispatch("fanotes:search", &[json!("photosynthese")])
        .unwrap();
    assert!(hits.as_array().unwrap().is_empty());
}
