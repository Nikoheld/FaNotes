use std::{fs, path::PathBuf};

use fanotes_ort::{verify_model_file, Error, ModelDescriptor};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn manifest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fanotes/public/ocr/manifest.json")
}

fn manifest() -> Value {
    serde_json::from_str(&fs::read_to_string(manifest_path()).unwrap()).unwrap()
}

fn scratch(name: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("fanotes-ort-model-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn a_whole_model_size_still_opens() {
    let mut manifest = manifest();
    let size = manifest["models"]["desktop"]["size"].as_u64().unwrap();
    manifest["models"]["desktop"]["size"] = serde_json::from_str(&format!("{size}.0")).unwrap();
    manifest["characters"]["count"] = serde_json::json!(1.0);
    let descriptor = ModelDescriptor::from_manifest(&manifest.to_string()).unwrap();
    assert_eq!(descriptor.size(), size);
    manifest["models"]["desktop"]["size"] = serde_json::json!(1.5);
    assert!(matches!(
        ModelDescriptor::from_manifest(&manifest.to_string()),
        Err(Error::UnknownModel)
    ));
}

#[test]
fn reads_the_desktop_entry_of_the_shipped_manifest() {
    let descriptor =
        ModelDescriptor::from_manifest(&fs::read_to_string(manifest_path()).unwrap()).unwrap();
    let manifest = manifest();
    assert_eq!(descriptor.file(), "pylaia-iam.onnx");
    assert_eq!(
        descriptor.size(),
        manifest["models"]["desktop"]["size"].as_u64().unwrap()
    );
    assert_eq!(
        descriptor.sha256_hex(),
        manifest["models"]["desktop"]["sha256"].as_str().unwrap()
    );
}

type Tamper = (&'static str, fn(&mut Value));

#[test]
fn refuses_manifests_main_cjs_refused() {
    let tamper: [Tamper; 13] = [
        ("format", |m| {
            m["format"] = json!("fanotes-neural-handwriting-v2")
        }),
        ("name", |m| m["models"]["desktop"]["name"] = json!("TrOCR")),
        ("precision", |m| {
            m["models"]["desktop"]["precision"] = json!("q8-dynamic")
        }),
        ("file path", |m| {
            m["models"]["desktop"]["file"] = json!("../pylaia-iam.onnx")
        }),
        ("file case", |m| {
            m["models"]["desktop"]["file"] = json!("PyLaia.onnx")
        }),
        ("size zero", |m| m["models"]["desktop"]["size"] = json!(0)),
        ("size 32 MiB + 1", |m| {
            m["models"]["desktop"]["size"] = json!(32 * 1024 * 1024 + 1)
        }),
        ("size text", |m| {
            m["models"]["desktop"]["size"] = json!("21334652")
        }),
        ("digest case", |m| {
            let upper = m["models"]["desktop"]["sha256"]
                .as_str()
                .unwrap()
                .to_uppercase();
            m["models"]["desktop"]["sha256"] = json!(upper);
        }),
        ("digest length", |m| {
            m["models"]["desktop"]["sha256"] = json!("abc")
        }),
        ("characters file", |m| {
            m["characters"]["file"] = json!("chars/../x.json")
        }),
        ("characters size", |m| {
            m["characters"]["size"] = json!(256 * 1024 + 1)
        }),
        ("characters digest", |m| {
            m["characters"]["sha256"] = json!("z".repeat(64))
        }),
    ];
    for (label, change) in tamper {
        let mut manifest = manifest();
        change(&mut manifest);
        assert!(
            matches!(
                ModelDescriptor::from_manifest(&manifest.to_string()),
                Err(Error::UnknownModel)
            ),
            "{label} must be refused"
        );
    }
    assert!(matches!(
        ModelDescriptor::from_manifest("not json"),
        Err(Error::UnknownModel)
    ));
}

#[test]
fn the_gate_returns_exactly_the_verified_bytes() {
    let directory = scratch("gate");
    let bytes = b"stand-in weights".repeat(64);
    let path = directory.join("pylaia-iam.onnx");
    fs::write(&path, &bytes).unwrap();
    let descriptor =
        ModelDescriptor::new("pylaia-iam.onnx", bytes.len() as u64, &hex(&bytes)).unwrap();
    assert_eq!(verify_model_file(&path, &descriptor).unwrap(), bytes);

    let mut flipped = bytes.clone();
    flipped[100] ^= 1;
    fs::write(&path, &flipped).unwrap();
    assert!(matches!(
        verify_model_file(&path, &descriptor),
        Err(Error::CorruptModel)
    ));

    fs::write(&path, &bytes[1..]).unwrap();
    assert!(matches!(
        verify_model_file(&path, &descriptor),
        Err(Error::IncompleteModel)
    ));

    fs::remove_file(&path).unwrap();
    assert!(matches!(
        verify_model_file(&path, &descriptor),
        Err(Error::IncompleteModel)
    ));

    let other = directory.join("other.onnx");
    fs::write(&other, &bytes).unwrap();
    assert!(
        matches!(
            verify_model_file(&other, &descriptor),
            Err(Error::IncompleteModel)
        ),
        "a file other than the manifest entry is refused"
    );

    fs::create_dir(&path).unwrap();
    assert!(matches!(
        verify_model_file(&path, &descriptor),
        Err(Error::IncompleteModel)
    ));
    fs::remove_dir_all(&directory).unwrap();
}

#[cfg(unix)]
#[test]
fn a_symlinked_model_is_refused_like_lstat_did() {
    let directory = scratch("symlink");
    let bytes = b"weights".repeat(32);
    let target = directory.join("real.onnx");
    fs::write(&target, &bytes).unwrap();
    let link = directory.join("pylaia-iam.onnx");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let descriptor =
        ModelDescriptor::new("pylaia-iam.onnx", bytes.len() as u64, &hex(&bytes)).unwrap();
    assert!(matches!(
        verify_model_file(&link, &descriptor),
        Err(Error::IncompleteModel)
    ));
    fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn descriptor_fields_are_bounded() {
    let digest = "a".repeat(64);
    assert!(ModelDescriptor::new("pylaia-iam.onnx", 1, &digest).is_ok());
    assert!(ModelDescriptor::new("pylaia-iam.onnx", 0, &digest).is_err());
    assert!(ModelDescriptor::new("pylaia-iam.onnx", 32 * 1024 * 1024 + 1, &digest).is_err());
    assert!(ModelDescriptor::new("", 1, &digest).is_err());
    assert!(ModelDescriptor::new(".hidden", 1, &digest).is_err());
    assert!(ModelDescriptor::new("a/b.onnx", 1, &digest).is_err());
    assert!(ModelDescriptor::new("pylaia-iam.onnx", 1, &"g".repeat(64)).is_err());
}
