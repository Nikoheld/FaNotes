use base64::Engine;
use fanotes_host::Host;
use serde_json::json;

fn host() -> Host {
    Host::open(std::env::temp_dir().join(format!("fanotes-resources-{}", std::process::id())))
}

fn decode(value: &serde_json::Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(value.as_str().unwrap())
        .unwrap()
}

#[test]
fn spelling_and_handwriting_bundles_match_their_manifests() {
    let mut host = host();
    assert_eq!(
        host.dispatch("fanotes:load-spelling-word-candidates", &[json!("fr")])
            .unwrap_err(),
        "Unbekannte Wörterbuchsprache."
    );

    let spelling = host
        .dispatch("fanotes:load-spelling-resources", &[])
        .unwrap();
    assert_eq!(spelling["manifest"]["format"], "fanotes-spelling-bloom-v2");
    assert_eq!(spelling["manifest"]["hashes"], 8);
    let de_bits = spelling["manifest"]["languages"]["de"]["bitCount"]
        .as_u64()
        .unwrap();
    let en_bits = spelling["manifest"]["languages"]["en"]["bitCount"]
        .as_u64()
        .unwrap();
    assert_eq!(decode(&spelling["de"]).len() as u64 * 8, de_bits);
    assert_eq!(decode(&spelling["en"]).len() as u64 * 8, en_bits);

    let words = host
        .dispatch("fanotes:load-spelling-word-candidates", &[json!("de")])
        .unwrap();
    assert_eq!(words["language"], "de");
    assert_eq!(
        decode(&words["bytes"]).len() as u64,
        words["descriptor"]["size"].as_u64().unwrap()
    );

    let handwriting = host
        .dispatch("fanotes:load-handwriting-recognition-resources", &[])
        .unwrap();
    assert_eq!(
        handwriting["manifest"]["format"],
        "fanotes-neural-handwriting-v3"
    );
    assert_eq!(
        handwriting["characters"].as_array().unwrap().len(),
        handwriting["manifest"]["characters"]["count"]
            .as_u64()
            .unwrap() as usize
    );
    assert_eq!(
        decode(&handwriting["model"]).len() as u64,
        handwriting["manifest"]["models"]["desktop"]["size"]
            .as_u64()
            .unwrap()
    );
    assert_eq!(
        decode(&handwriting["wasm"]).len() as u64,
        handwriting["manifest"]["runtime"]["size"].as_u64().unwrap()
    );
}
