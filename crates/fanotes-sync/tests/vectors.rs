//! Golden vectors written by the TypeScript code (`fanotes/scripts/sync-parity/vectors.mjs`).

use base64::Engine as _;
use fanotes_sync::{conflicts, crypto, famd, homework, jsjson};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fanotes/scripts/sync-parity/expected/vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors.json")).expect("json")
}

fn bytes(value: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(value.as_str().unwrap())
        .unwrap()
}

fn sha(bytes: &[u8]) -> String {
    crypto::sha256_hex(bytes)
}

#[test]
fn note_identity_matches_typescript() {
    let all = vectors();
    let notes = all["notes"].as_array().unwrap();
    let local = jsjson::text_decode(&bytes(&notes[7]["b64"]));
    let mut failures = Vec::new();
    for note in notes {
        let path = note["path"].as_str().unwrap();
        let raw = bytes(&note["b64"]);
        let kind = famd::note_sync_kind(path, &raw).as_str();
        let canonical = match famd::canonical_sync_bytes(path, &raw) {
            Ok(value) => sha(&value),
            Err(error) => format!("throws {}", error.0),
        };
        let identity = famd::identity_sync_bytes(path, &raw)
            .unwrap()
            .map(|value| sha(&value));
        let spliced = (famd::is_famd_sync_path(path) && kind != "unreadable").then(|| {
            match famd::with_local_page_stats(&jsjson::text_decode(&raw), &local) {
                Ok(text) => sha(text.as_bytes()),
                Err(error) => format!("throws {}", error.0),
            }
        });
        let fingerprint = conflicts::conflict_fingerprint(path, Some(&raw));
        let got = serde_json::json!({ "kind": kind, "canonical": canonical, "identity": identity, "spliced": spliced, "fingerprint": fingerprint });
        let want = serde_json::json!({ "kind": note["kind"], "canonical": note["canonical"], "identity": note["identity"], "spliced": note["spliced"], "fingerprint": note["fingerprint"] });
        if got != want {
            failures.push(format!("{path}: got {got} want {want}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn homework_merge_matches_typescript() {
    for pair in vectors()["homework"].as_array().unwrap() {
        let merged = homework::merge_homework_markdown_bytes(
            &bytes(&pair["local"]),
            &bytes(&pair["remote"]),
        )
        .map(|value| sha(&value));
        assert_eq!(merged.as_deref(), pair["merged"].as_str());
    }
}

#[test]
fn numbers_print_like_javascript() {
    for item in vectors()["numbers"].as_array().unwrap() {
        let raw: [u8; 8] = bytes(&item[0]).try_into().unwrap();
        let value = f64::from_be_bytes(raw);
        assert_eq!(
            jsjson::number_to_string(value),
            item[1].as_str().unwrap(),
            "{value:e}"
        );
    }
}

#[test]
fn crypto_is_byte_identical() {
    let all = vectors();
    let vector = &all["crypto"];
    let pattern: Vec<u8> = (0..256u32)
        .map(|index| ((index * 37 + 11) & 0xff) as u8)
        .collect();
    crypto::set_fixed_random_for_tests(Some(pattern));
    let secret = crypto::new_vault_secret();
    assert_eq!(
        crypto::to_base64(&secret),
        vector["secret"].as_str().unwrap()
    );
    let keys = crypto::derive_sync_keys(&secret);
    let path = vector["path"].as_str().unwrap();
    let id = crypto::file_id_for(&keys, path);
    assert_eq!(id, vector["fileId"].as_str().unwrap());
    let blob = crypto::encrypt_bytes(&keys, &id, "# Algebra\n\nx² + y²".as_bytes());
    assert_eq!(crypto::to_base64(&blob), vector["blob"].as_str().unwrap());
    let meta = crypto::encrypt_meta(
        &keys,
        &id,
        &crypto::SyncFileMeta {
            path: path.to_owned(),
            mtime_ms: 1_700_000_001_000.0,
            size: 21.0,
            sha256: "ab".repeat(32),
        },
    );
    assert_eq!(meta, vector["meta"].as_str().unwrap());
    let kdf: crypto::SyncKdf = serde_json::from_value(vector["kdf"].clone()).unwrap();
    let (wrapping, auth) =
        crypto::derive_from_password(vector["password"].as_str().unwrap(), &kdf).unwrap();
    assert_eq!(auth, vector["authKey"].as_str().unwrap());
    let wrap = crypto::wrap_vault_secret(&secret, &wrapping);
    assert_eq!(serde_json::to_value(&wrap).unwrap(), vector["wrap"]);
    crypto::set_fixed_random_for_tests(None);
    assert_eq!(
        crypto::unwrap_vault_secret(&wrap, &wrapping).unwrap(),
        secret
    );
}
