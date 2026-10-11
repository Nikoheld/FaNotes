use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use fanotes_host::Host;
use serde_json::json;

fn host() -> Host {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fanotes-ocr-host-{}-{id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("vault")).unwrap();
    let mut host = Host::open(dir.join("app"));
    host.set_vault(dir.join("vault")).unwrap();
    host
}

#[test]
fn an_empty_native_line_is_rejected_before_the_model_loads() {
    let mut host = host();
    assert_eq!(
        host.dispatch("fanotes:recognize-native-handwriting-line", &[])
            .unwrap_err(),
        "Die native OCR-Eingabe ist ungültig."
    );
}

#[test]
fn a_blank_line_returns_pylaia_probabilities() {
    let mut host = host();
    let width = 32usize;
    let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0u8; width * 128 * 4]);
    let result = host
        .dispatch(
            "fanotes:recognize-native-handwriting-line",
            &[json!({
                "width": width,
                "height": 128,
                "threads": 1,
                "inputBase64": encoded,
            })],
        )
        .expect("blank line");
    assert_eq!(result["engine"], "fanotes-ort-cpu");
    assert_eq!(result["characters"].as_array().unwrap().len(), 80);
    let dims: Vec<i64> = result["dims"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_i64().unwrap())
        .collect();
    assert_eq!(dims.len(), 3);
    assert!(dims.iter().all(|dim| *dim > 0));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(result["probabilitiesBase64"].as_str().unwrap())
        .unwrap();
    let count: i64 = dims.iter().product();
    assert_eq!(bytes.len() as i64, count * 4);
}
