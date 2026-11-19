//! Rust counterpart of `fanotes/scripts/check-release-delta.cjs`: rebuild a
//! real release delta from the installed source file and compare the result
//! byte for byte with the published target.
//!
//!   cargo run -p fanotes-updater --example check_release_delta -- SOURCE PATCH EXPECTED_TARGET

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use fanotes_updater::delta::{apply_delta_patch, inspect_delta_patch, ApplyOptions};
use fanotes_updater::util::sha256_file;

fn main() -> ExitCode {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [source, patch, expected] = args.as_slice() else {
        eprintln!("Quelle, Delta und erwartete Zieldatei werden benötigt.");
        return ExitCode::FAILURE;
    };
    match run(source, patch, expected) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run(source: &Path, patch: &Path, expected: &Path) -> Result<String, String> {
    let temporary = tempdir().map_err(|e| e.to_string())?;
    let result = (|| {
        let inspected = inspect_delta_patch(patch).map_err(|e| e.to_string())?;
        let file_name = inspected
            .header
            .target
            .file_name
            .clone()
            .unwrap_or_default();
        let output = temporary.join(file_name);
        let header = apply_delta_patch(patch, source, &output, ApplyOptions::default())
            .map_err(|e| e.to_string())?;
        let actual = sha256_file(&output).map_err(|e| e.to_string())?;
        let wanted = sha256_file(expected).map_err(|e| e.to_string())?;
        if actual != wanted {
            return Err(
                "Das reale Release-Delta rekonstruiert nicht die veröffentlichte Zieldatei."
                    .to_owned(),
            );
        }
        Ok(format!(
            "{}: {} → {} bytegenau rekonstruiert ({} Bytes).",
            header.platform, header.base_version, header.target_version, header.target.size_bytes
        ))
    })();
    let _ = std::fs::remove_dir_all(&temporary);
    result
}

fn tempdir() -> std::io::Result<PathBuf> {
    let path = std::env::temp_dir().join(format!("fanotes-release-delta-{}", std::process::id()));
    std::fs::create_dir_all(&path)?;
    Ok(path)
}
