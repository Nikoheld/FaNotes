//! Launch smoke test: `FANOTES_SMOKE_TEST=1` starts the app, waits until the
//! React bundle reports `fanotes:renderer-ready`, and exits with status 0.
//!
//! The bundle sends that signal two frames after its bootstrap rendered
//! (`App.tsx`), so a 0 means the window loaded the bundle, the bridge ran and
//! the host answered. Without the signal within `FANOTES_SMOKE_TIMEOUT_SECS`
//! (default 120) the process exits with status 3. Without the variable
//! nothing changes. CI runs the installed packages this way.
//!
//! The messages go to stderr and, when `FANOTES_SMOKE_LOG` names a file, are
//! appended there too (a Windows release build has no console). The log also
//! lists the commands the page invoked, so a timeout shows how far it got.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager;

pub const ENV: &str = "FANOTES_SMOKE_TEST";
pub const TIMEOUT_ENV: &str = "FANOTES_SMOKE_TIMEOUT_SECS";
pub const LOG_ENV: &str = "FANOTES_SMOKE_LOG";
pub const TIMEOUT_EXIT_CODE: i32 = 3;
const READY_COMMAND: &str = "fanotes:renderer-ready";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

static REPORTED: AtomicBool = AtomicBool::new(false);

fn say(message: &str) {
    eprintln!("FaNotes smoke test: {message}");
    if let Some(path) = std::env::var_os(LOG_ENV) {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(
                file,
                "[{:>6} ms] {message}",
                started().elapsed().as_millis()
            );
        }
    }
}

fn started() -> Instant {
    static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *STARTED.get_or_init(Instant::now)
}

pub fn enabled() -> bool {
    enabled_by(std::env::var_os(ENV).as_deref())
}

fn enabled_by(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|value| value == "1")
}

fn timeout_from(value: Option<&str>) -> Duration {
    value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TIMEOUT)
}

/// Start the timeout. Called once from `setup`.
pub fn arm(app: &tauri::AppHandle) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    let begun = started();
    let limit = timeout_from(std::env::var(TIMEOUT_ENV).ok().as_deref());
    say(&format!(
        "waiting up to {} s for the renderer.",
        limit.as_secs()
    ));
    std::thread::spawn(move || {
        std::thread::sleep(limit.saturating_sub(begun.elapsed()));
        if !REPORTED.load(Ordering::Acquire) {
            let window = app.get_webview_window("main");
            let visible = window.as_ref().and_then(|window| window.is_visible().ok());
            let url = window.as_ref().and_then(|window| window.url().ok());
            say(&format!(
                "the renderer did not report ready within {} s (main window visible: {visible:?}, url: {}).",
                limit.as_secs(),
                url.map(|url| url.to_string()).unwrap_or_default()
            ));
            std::process::exit(TIMEOUT_EXIT_CODE);
        }
    });
}

/// Wrap the command handler so the ready signal ends a smoke run.
pub fn observe<H>(handler: H) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync
where
    H: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
{
    let enabled = enabled();
    if enabled {
        started();
    }
    move |invoke| {
        if enabled {
            say(&format!("invoke {}", invoke.message.command()));
        }
        let app = (enabled && invoke.message.command() == READY_COMMAND)
            .then(|| invoke.message.webview().app_handle().clone());
        let handled = handler(invoke);
        if let Some(app) = app {
            if !REPORTED.swap(true, Ordering::AcqRel) {
                say(&format!(
                    "the renderer was ready after {} ms.",
                    started().elapsed().as_millis()
                ));
                finish(app);
            }
        }
        handled
    }
}

fn finish(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Let the command answer the page first, then leave like a normal quit.
        std::thread::sleep(Duration::from_millis(500));
        app.exit(0);
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(0);
    });
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::time::Duration;

    #[test]
    fn only_one_turns_the_smoke_test_on() {
        assert!(super::enabled_by(Some(OsStr::new("1"))));
        assert!(!super::enabled_by(None));
        assert!(!super::enabled_by(Some(OsStr::new(""))));
        assert!(!super::enabled_by(Some(OsStr::new("0"))));
        assert!(!super::enabled_by(Some(OsStr::new("true"))));
    }

    #[test]
    fn the_timeout_falls_back_to_two_minutes() {
        assert_eq!(super::timeout_from(None), Duration::from_secs(120));
        assert_eq!(super::timeout_from(Some("45")), Duration::from_secs(45));
        assert_eq!(super::timeout_from(Some("0")), Duration::from_secs(120));
        assert_eq!(super::timeout_from(Some("soon")), Duration::from_secs(120));
    }
}
