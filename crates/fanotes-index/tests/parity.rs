//! The native index against the TypeScript search on the shared fixture vault.
//! Golden file: `fanotes/scripts/fixtures/search-parity/expected.json`, written by
//! `node scripts/search-parity.mjs --write` from the TS code.

use std::path::PathBuf;

use fanotes_index::{Engine, MAX_RESULTS};
use serde_json::Value;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fanotes/scripts/fixtures/search-parity")
}

fn normalized<T: serde::Serialize>(value: &T) -> Value {
    serde_json::from_str(&serde_json::to_string(value).unwrap()).unwrap()
}

fn first_difference(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|key| {
                first_difference(
                    &format!("{path}.{key}"),
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                )
            })
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                let show = |list: &Vec<Value>| {
                    list.iter()
                        .map(|v| {
                            format!(
                                "{}:{}",
                                v.get("unitId").or(v.get("id")).unwrap_or(&Value::Null),
                                v.get("score").unwrap_or(&Value::Null)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                };
                return Some(format!(
                    "{path}: rust {} items vs ts {}\n  rust: {}\n  ts:   {}",
                    a.len(),
                    b.len(),
                    show(a),
                    show(b)
                ));
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(index, (x, y))| first_difference(&format!("{path}[{index}]"), x, y))
        }
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => None,
        _ if left == right => None,
        _ => Some(format!("{path}: rust {left} vs ts {right}")),
    }
}

#[test]
fn same_units_and_same_results_as_the_typescript_search() {
    let root = fixture();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("expected.json")).unwrap())
            .unwrap();
    let engine = Engine::build(&root.join("vault"), 2);

    let mut failures = Vec::new();
    let ts_units = expected["units"].as_array().unwrap();
    let rust_units: Vec<Value> = engine
        .index
        .doc_paths()
        .map(|path| serde_json::json!({ "path": path, "units": normalized(&engine.index.units_of(path)) }))
        .collect();
    if let Some(difference) = first_difference(
        "units",
        &Value::Array(rust_units),
        &Value::Array(ts_units.clone()),
    ) {
        failures.push(difference);
    }
    let queries = expected["queries"].as_array().unwrap();
    for entry in queries {
        let query = entry["query"].as_str().unwrap();
        let results = normalized(&engine.search(query, MAX_RESULTS));
        if let Some(difference) =
            first_difference(&format!("query {query:?}"), &results, &entry["results"])
        {
            failures.push(difference);
        }
    }
    assert!(queries.len() >= 100, "the fixture has too few queries");
    assert!(
        failures.is_empty(),
        "{} of {} checks differ:\n{}",
        failures.len(),
        queries.len() + 1,
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
