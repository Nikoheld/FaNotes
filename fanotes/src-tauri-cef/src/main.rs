//! Spike S1 (do not merge): the FaNotes React bundle on Tauri 3 alpha with the
//! CEF runtime (Chromium), for the runtime benchmark in
//! `docs/rust-rewrite/S1-runtime-spike.md`.
//!
//! It loads the same `dist/` and the same `window.fanotes` bridge
//! (`../src-tauri/src/fanotes-api.js`) as the Tauri 2 shell. Every `fanotes:*`
//! command goes to `fanotes_host::Host::dispatch` through one catch-all invoke
//! handler, which is enough to open a vault, the tree, notes and PDFs. The shell
//! commands of the Tauri 2 host (PDF export, popouts, capture, close dialog) are
//! left out, except a plain close.
//!
//! Spike-only switches, read from the environment:
//! - `FANOTES_CEF_REMOTE_DEBUGGING_PORT=<port>`: the DevTools protocol on
//!   127.0.0.1, for the benchmark harness (page control only).
//! - `FANOTES_CEF_NO_SANDBOX=1`: run Chromium unsandboxed (containers without
//!   user namespaces). Without it the runtime keeps the sandbox where it can.
//! - `FANOTES_CEF_ARGS="--switch[=value] ..."`: extra Chromium switches, for the
//!   GPU experiments (`--use-angle=...`, `--disable-gpu`, ...).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use fanotes_host::Host;
use serde_json::Value;
use tauri::ipc::{Invoke, InvokeBody, InvokeError};
use tauri::Manager;
use tauri_runtime_cef::{Cef, RemoteDebugging, SandboxPolicy};

struct HostState(Mutex<Host>);

/// `[args]` of a bridge call: the bridge sends `{ args: [...] }`.
fn invoke_args(body: &InvokeBody) -> Vec<Value> {
    match body {
        InvokeBody::Json(value) => value
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        InvokeBody::Raw(_) => Vec::new(),
    }
}

/// Whether a command is a host channel this shell forwards to `fanotes-host`.
fn is_host_channel(command: &str) -> bool {
    command.starts_with("fanotes:")
        && !matches!(command, "fanotes:request-close" | "fanotes:confirm-close")
}

fn handle_invoke(invoke: Invoke) -> bool {
    let command = invoke.message.command().to_owned();
    let webview = invoke.message.webview();
    if matches!(
        command.as_str(),
        "fanotes:request-close" | "fanotes:confirm-close"
    ) {
        invoke.resolver.resolve(Value::Bool(true));
        webview.app_handle().exit(0);
        return true;
    }
    if !is_host_channel(&command) {
        return false;
    }
    let args = invoke_args(invoke.message.payload());
    let state = webview.state::<HostState>();
    let result = match state.0.lock() {
        Ok(mut host) => host.dispatch(&command, &args),
        Err(_) => Err("Der Host ist belegt.".to_owned()),
    };
    invoke.resolver.respond(result.map_err(InvokeError::from));
    true
}

/// `navigator.language` from the desktop locale, then the bridge, as one init
/// script that runs after Tauri's core script (the Tauri 2 bridge fix).
fn bridge_plugin() -> tauri::plugin::TauriPlugin<tauri::DynRuntime> {
    tauri::plugin::Builder::new("fanotes-bridge")
        .initialization_script(format!(
            "{}{}",
            system_language_script(fanotes_host::desktop_navigator_language()),
            include_str!("../../src-tauri/src/fanotes-api.js")
        ))
        .build()
}

/// Same as the Tauri 2 shell's `system_language_script`.
fn system_language_script(language: &str) -> String {
    let language = if language == "de" { "de" } else { "en-US" };
    format!(
        "(function(){{const language={language:?};const languages=Object.freeze([language]);const define=(name,value)=>{{try{{Object.defineProperty(Navigator.prototype,name,{{configurable:true,get:()=>value}})}}catch(e){{}}}};define('language',language);define('languages',languages);}})();\n"
    )
}

fn cef_runtime() -> Cef {
    let mut cef = Cef::default();
    if let Some(port) = std::env::var("FANOTES_CEF_REMOTE_DEBUGGING_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
    {
        cef = cef.remote_debugging(RemoteDebugging::Port {
            port,
            allowed_origins: Vec::new(),
        });
    }
    if std::env::var("FANOTES_CEF_NO_SANDBOX").as_deref() == Ok("1") {
        cef = cef.sandbox(SandboxPolicy::Disabled);
    }
    if let Ok(extra) = std::env::var("FANOTES_CEF_ARGS") {
        for switch in extra.split_whitespace() {
            let switch = switch.trim_start_matches("--");
            let (name, value) = match switch.split_once('=') {
                Some((name, value)) => (name, Some(value)),
                None => (switch, None),
            };
            cef = cef.command_line_arg(format!("--{name}"), value);
        }
    }
    // The app's own spellchecker runs in the page; Chromium's is not wanted.
    cef.spell_checking(false)
}

#[tauri_runtime_cef::cef_entry_point]
fn main() {
    tauri::Builder::default()
        .runtime(cef_runtime())
        .plugin(bridge_plugin())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("fanotes"));
            app.manage(HostState(Mutex::new(Host::open(app_data))));
            Ok(())
        })
        .invoke_handler(handle_invoke)
        .run(tauri::generate_context!())
        .expect("FaNotes Tauri 3 + CEF spike failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_arguments_come_from_the_args_list() {
        let body = InvokeBody::Json(serde_json::json!({ "args": ["Start/Letzte Notiz.md", 3] }));
        assert_eq!(
            invoke_args(&body),
            vec![Value::from("Start/Letzte Notiz.md"), Value::from(3)]
        );
        assert!(invoke_args(&InvokeBody::Json(serde_json::json!({}))).is_empty());
        assert!(invoke_args(&InvokeBody::Raw(vec![1, 2])).is_empty());
    }

    #[test]
    fn only_fanotes_channels_reach_the_host() {
        assert!(is_host_channel("fanotes:get-tree"));
        assert!(is_host_channel("fanotes:read-file"));
        assert!(!is_host_channel("fanotes:request-close"));
        assert!(!is_host_channel("plugin:event|listen"));
    }
}
