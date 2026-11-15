//! `fanotes-native:migration-*`: the Electron profile migration for the renderer step
//! (`src/lib/desktopMigration.ts`) and a later settings page. The host runs the migration
//! itself in `Host::open`; these commands report it, feed the browser-data import and
//! offer the rollback helpers. Arguments arrive as `{ args: [...] }` like every channel.

use fanotes_host::migrate;
use serde_json::Value;
use tauri::State;

use crate::HostState;

fn with_host<T>(
    state: &State<'_, HostState>,
    action: impl FnOnce(&fanotes_host::Host) -> T,
) -> Result<T, String> {
    let host = state
        .0
        .lock()
        .map_err(|_| "Der Host ist belegt.".to_owned())?;
    Ok(action(&host))
}

fn text_arg(args: &[Value], index: usize) -> Result<String, String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Ungültige Migrationsanfrage.".to_owned())
}

/// The report: status, backup, what was migrated, which secrets need re-entry.
#[tauri::command(rename = "fanotes-native:migration-status")]
pub fn migration_status(state: State<'_, HostState>, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    with_host(&state, |host| migrate::status(&host.app_data))
}

/// The pending IndexedDB/localStorage export, or `null`.
#[tauri::command(rename = "fanotes-native:migration-plan")]
pub fn migration_plan(state: State<'_, HostState>, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    with_host(&state, |host| migrate::web_storage_plan(&host.app_data))
}

/// `[file, start]` → `{ items, next }`.
#[tauri::command(rename = "fanotes-native:migration-page")]
pub fn migration_page(state: State<'_, HostState>, args: Vec<Value>) -> Result<Value, String> {
    let file = text_arg(&args, 0)?;
    let start = args.get(1).and_then(Value::as_u64).unwrap_or(0) as usize;
    with_host(&state, |host| {
        migrate::web_storage_page(&host.app_data, &file, start)
    })?
}

/// `[counts]` from the renderer after it read every record back.
#[tauri::command(rename = "fanotes-native:migration-done")]
pub fn migration_done(state: State<'_, HostState>, args: Vec<Value>) -> Result<Value, String> {
    let result = args.into_iter().next().unwrap_or(Value::Null);
    with_host(&state, |host| {
        migrate::web_storage_done(&host.app_data, &result, host.secret_store)
    })?
}

/// `[rerun]`: resume a stopped migration, or with `true` import again from a new verified backup.
#[tauri::command(rename = "fanotes-native:migration-run")]
pub fn migration_run(state: State<'_, HostState>, args: Vec<Value>) -> Result<Value, String> {
    let rerun = args.first().and_then(Value::as_bool).unwrap_or(false);
    with_host(&state, |host| {
        let mut options = migrate::Options::native(host.secret_store);
        options.rerun = rerun;
        migrate::run(&host.app_data, &options)
    })
}

#[tauri::command(rename = "fanotes-native:migration-backups")]
pub fn migration_backups(state: State<'_, HostState>, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    with_host(&state, |host| migrate::list_backups(&host.app_data))
}

/// `[backupId, destination]`: rollback helper, writes a verified backup into an empty folder.
#[tauri::command(rename = "fanotes-native:migration-restore-electron")]
pub fn migration_restore_electron(
    state: State<'_, HostState>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let id = text_arg(&args, 0)?;
    let destination = std::path::PathBuf::from(text_arg(&args, 1)?);
    if !destination.is_absolute() {
        return Err("Ungültiger Zielordner.".to_owned());
    }
    with_host(&state, |host| {
        migrate::restore_electron_profile(&host.app_data, &id, &destination)
    })?
}
