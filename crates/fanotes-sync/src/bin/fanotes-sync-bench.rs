//! Sync-time benchmark for the Rust engine against a local sync server.
//!
//!   cargo run --release -p fanotes-sync --bin fanotes-sync-bench -- [--origin URL] [--files 2000] [--edits 20] [--runs 1]
//!
//! Without `--origin` it starts `fanotes/scripts/sync-parity/server.mjs` (the real
//! sync server module, temporary data, throwaway account). Never use a
//! production origin. Prints one JSON line per run.
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

use fanotes_sync::api::SyncApi;
use fanotes_sync::engine::{EngineOptions, SyncEngine};
use fanotes_sync::host::FsHost;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|item| item == name)
        .and_then(|index| args.get(index + 1).cloned())
}

fn note(index: usize, edited: bool) -> String {
    if edited {
        format!("# Notiz {index}\n\nGeändert.\n")
    } else {
        format!("# Notiz {index}\n\n{}\n", "Text ".repeat(index % 40 + 5))
    }
}

fn timed(engine: &SyncEngine) -> f64 {
    let started = Instant::now();
    engine.sync_now("manual").expect("cycle");
    let state = engine.public_state();
    assert_eq!(state.status, "idle", "{:?}", state.error);
    started.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let files: usize = arg("--files")
        .and_then(|value| value.parse().ok())
        .unwrap_or(2000);
    let edits: usize = arg("--edits")
        .and_then(|value| value.parse().ok())
        .unwrap_or(20);
    let runs: usize = arg("--runs")
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let mut server = None;
    let origin = match arg("--origin") {
        Some(origin) => origin,
        None => {
            let script = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../fanotes/scripts/sync-parity/server.mjs"
            );
            let mut child = Command::new("node")
                .arg(script)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("node");
            let mut line = String::new();
            BufReader::new(child.stdout.take().expect("stdout"))
                .read_line(&mut line)
                .expect("server origin");
            let origin = serde_json::from_str::<serde_json::Value>(&line).expect("json")["origin"]
                .as_str()
                .expect("origin")
                .to_owned();
            server = Some(child);
            origin
        }
    };
    assert!(
        origin.starts_with("http://127.0.0.1") || origin.starts_with("http://localhost"),
        "the benchmark only runs against a local server"
    );
    for run in 0..runs {
        let root =
            std::env::temp_dir().join(format!("fanotes-sync-bench-{}-{run}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (vault_a, vault_b) = (root.join("a/vault"), root.join("b/vault"));
        for dir in [
            &vault_a,
            &vault_b,
            &root.join("a/data"),
            &root.join("b/data"),
        ] {
            std::fs::create_dir_all(dir).expect("dir");
        }
        for index in 0..files {
            std::fs::write(
                vault_a.join(format!("Notiz {index:05}.md")),
                note(index, false),
            )
            .expect("write");
        }
        let make = |vault: &std::path::Path, data: std::path::PathBuf, name: &str| {
            SyncEngine::new(
                Arc::new(FsHost::new(vault, data)),
                SyncApi::new(origin.clone()),
                EngineOptions::new("linux", name),
            )
        };
        let a = make(&vault_a, root.join("a/data"), "Bench A");
        let b = make(&vault_b, root.join("b/data"), "Bench B");
        let email = format!("bench-{}-{run}@example.com", std::process::id());
        a.register(&email, "bench passwort fuer den sync 7")
            .expect("register");
        let full = timed(&a);
        b.login(&email, "bench passwort fuer den sync 7")
            .expect("login");
        let full_pull = timed(&b);
        std::thread::sleep(std::time::Duration::from_millis(20));
        for index in 0..edits {
            std::fs::write(
                vault_a.join(format!("Notiz {index:05}.md")),
                note(index, true),
            )
            .expect("edit");
        }
        let incremental = timed(&a);
        let incremental_pull = timed(&b);
        let idle = timed(&a);
        let line = serde_json::json!({ "engine": "rust", "files": files, "edits": edits, "run": run, "fullUploadMs": full, "fullPullMs": full_pull, "incrementalUploadMs": incremental, "incrementalPullMs": incremental_pull, "idleMs": idle });
        println!("{line}");
        let _ = std::io::stdout().flush();
        let _ = std::fs::remove_dir_all(&root);
    }
    if let Some(mut child) = server {
        let _ = Command::new("kill").arg(child.id().to_string()).status();
        let _ = child.wait();
    }
}
