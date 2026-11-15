//! Desktop-only vault search (`fanotes-native:search-*`), backed by
//! `fanotes-index`. Not preload channels: Electron and the web app keep the
//! TypeScript document search. The renderer reaches these through the
//! optional `window.fanotes.nativeSearch` capability.
//!
//! One index per open vault; switching vaults closes the old one. The cache
//! lives in the app's cache directory, never in the vault, and is rebuilt
//! when it is missing, stale or damaged.

use std::sync::Mutex;

use fanotes_index::{IndexService, Options, MAX_RESULTS};
use serde_json::{json, Value};
use tauri::{Manager, State};

static SERVICE: Mutex<Option<IndexService>> = Mutex::new(None);

fn with_service<T>(
    app: &tauri::AppHandle,
    host: &State<'_, crate::HostState>,
    run: impl FnOnce(&IndexService) -> T,
) -> Result<T, String> {
    let vault = host
        .0
        .lock()
        .map_err(|_| "Der Host ist belegt.".to_owned())?
        .vault
        .clone();
    let vault = vault.ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())?;
    let vault = std::fs::canonicalize(&vault).unwrap_or(vault);
    let mut service = SERVICE
        .lock()
        .map_err(|_| "Der Suchindex ist belegt.".to_owned())?;
    if service.as_ref().is_none_or(|open| open.vault() != vault) {
        // Close the previous vault's index before opening this one.
        *service = None;
        let cache = app.path().app_cache_dir().ok();
        *service = Some(IndexService::open(
            &vault,
            cache.as_deref(),
            Options::default(),
        ));
    }
    Ok(run(service.as_ref().expect("index service")))
}

/// `[query, limit?]` → `{ results, generation, state }`. Results have the TS `SearchResult` shape.
#[tauri::command(rename = "fanotes-native:search-query")]
pub async fn search_query(
    app: tauri::AppHandle,
    host: State<'_, crate::HostState>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let query = args
        .first()
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(200)
        .collect::<String>();
    let limit = args
        .get(1)
        .and_then(Value::as_u64)
        .map(|limit| limit.clamp(1, 200) as usize)
        .unwrap_or(MAX_RESULTS);
    with_service(&app, &host, |service| {
        let results = service.query(&query, limit);
        json!({ "results": results, "generation": service.generation(), "state": service.status()["state"] })
    })
}

/// Progress in the TS `IndexerProgress` shape, plus `generation`, `cache` and `problems`.
#[tauri::command(rename = "fanotes-native:search-status")]
pub async fn search_status(
    app: tauri::AppHandle,
    host: State<'_, crate::HostState>,
) -> Result<Value, String> {
    with_service(&app, &host, IndexService::status)
}

/// A save, import, rename, move, delete or sync happened. Debounced in the index.
#[tauri::command(rename = "fanotes-native:search-notify")]
pub async fn search_notify(
    app: tauri::AppHandle,
    host: State<'_, crate::HostState>,
) -> Result<Value, String> {
    with_service(&app, &host, |service| {
        service.notify_changed();
        Value::Bool(true)
    })
}

/// Throws the index and its cache away and reads the vault again.
#[tauri::command(rename = "fanotes-native:search-rebuild")]
pub async fn search_rebuild(
    app: tauri::AppHandle,
    host: State<'_, crate::HostState>,
) -> Result<Value, String> {
    with_service(&app, &host, |service| {
        service.rebuild();
        Value::Bool(true)
    })
}
