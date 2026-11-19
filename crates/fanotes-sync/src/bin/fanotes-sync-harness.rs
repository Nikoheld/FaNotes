//! `fanotes-sync-harness <origin> <device-id> <device-name>`: one simulated
//! device on stdin/stdout, one JSON command per line, one JSON answer per line.
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: fanotes-sync-harness <origin> <device-id> <device-name>");
        std::process::exit(2);
    }
    let mut device = fanotes_sync::harness::Device::new(&args[2], &args[3], &args[1]);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str(&line) {
            Ok(command) => device.handle(&command),
            Err(error) => serde_json::json!({ "ok": false, "error": error.to_string() }),
        };
        let _ = writeln!(stdout, "{answer}");
        let _ = stdout.flush();
    }
}
