//! Runs every scenario in `fanotes/scripts/sync-parity/scenarios` with the Rust
//! engine against the real sync server module (started by the Node harness on a
//! random local port, temporary data directory, throwaway accounts) and compares
//! the records with the ones the TypeScript engine produced (`expected/`).
//!
//! Needs Node and `npm ci` in `fanotes/`. `FANOTES_SYNC_PARITY_SKIP=1` skips it.

use std::process::Command;

#[test]
fn rust_engine_matches_typescript_records() {
    if std::env::var("FANOTES_SYNC_PARITY_SKIP").as_deref() == Ok("1") {
        eprintln!("sync parity skipped (FANOTES_SYNC_PARITY_SKIP=1)");
        return;
    }
    let app = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fanotes");
    let engines =
        std::env::var("FANOTES_SYNC_PARITY_ENGINES").unwrap_or_else(|_| "rust".to_owned());
    let output = Command::new("node")
        .current_dir(app)
        .args([
            "scripts/sync-parity/run.mjs",
            "--engines",
            &engines,
            "--quiet",
            "--bin",
            env!("CARGO_BIN_EXE_fanotes-sync-harness"),
        ])
        .output()
        .expect("node must be installed to run the sync parity harness");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "sync parity failed\n{stdout}\n{stderr}"
    );
    assert!(stdout.contains("sync-parity: ok"), "{stdout}");
}
