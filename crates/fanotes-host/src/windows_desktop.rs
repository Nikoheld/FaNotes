//! Windows versions of the desktop calls Electron makes through `shell` and `app`.
//!
//! The Linux host uses `xdg-open`, the FileManager1 D-Bus call, `gio trash`,
//! `user-dirs.dirs` and `LANG`; none of them exists on Windows.

use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_Documents, SHFileOperationW, SHGetKnownFolderPath, ShellExecuteW, FOF_ALLOWUNDO,
    FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const OPEN_FAILED: &str = "Der Link konnte nicht geöffnet werden.";
const TRASH_FAILED: &str = "Der Eintrag konnte nicht in den Papierkorb verschoben werden.";

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

/// Electron `shell.openExternal`: the default handler for the link.
pub fn open_external(target: &str) -> Result<(), String> {
    let operation = wide("open".as_ref());
    let file = wide(target.as_ref());
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute reports success with a value above 32.
    if result as usize > 32 {
        Ok(())
    } else {
        Err(OPEN_FAILED.to_owned())
    }
}

/// Electron `shell.showItemInFolder`: Explorer with the entry selected.
pub fn reveal(path: &Path) -> Result<(), String> {
    let absolute = std::path::absolute(path).map_err(|_| OPEN_FAILED.to_owned())?;
    // Explorer reads `/select,"path"` itself; Rust's argument quoting would
    // wrap the whole switch and Explorer would open the default folder.
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", absolute.display()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| OPEN_FAILED.to_owned())
}

/// Electron `shell.trashItem`: the Recycle Bin, without a confirmation dialog.
pub fn trash(path: &Path) -> Result<(), String> {
    let absolute = std::path::absolute(path).map_err(|_| TRASH_FAILED.to_owned())?;
    // `pFrom` is a list that ends with an empty string.
    let mut from: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    from.extend([0, 0]);
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let status = unsafe { SHFileOperationW(&mut operation) };
    if status == 0 && operation.fAnyOperationsAborted == 0 && !absolute.exists() {
        Ok(())
    } else {
        Err(TRASH_FAILED.to_owned())
    }
}

/// Electron `app.getPath('documents')`, including a folder moved to OneDrive.
pub fn documents_dir() -> Option<PathBuf> {
    unsafe {
        let mut path = std::ptr::null_mut();
        let status = SHGetKnownFolderPath(&FOLDERID_Documents, 0, std::ptr::null_mut(), &mut path);
        let found = if status >= 0 && !path.is_null() {
            let mut length = 0;
            while *path.add(length) != 0 {
                length += 1;
            }
            let slice = std::slice::from_raw_parts(path, length);
            Some(PathBuf::from(std::ffi::OsString::from_wide(slice)))
        } else {
            None
        };
        CoTaskMemFree(path.cast());
        found.filter(|path| !path.as_os_str().is_empty())
    }
}

/// The first Windows display language, such as `de-CH`, which Chromium and
/// so Electron's `app.getLocale()` follow. Empty when Windows reports none.
pub fn ui_language() -> String {
    unsafe {
        let mut count = 0u32;
        let mut length = 0u32;
        if GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut length,
        ) == 0
            || length == 0
        {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize];
        if GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            buffer.as_mut_ptr(),
            &mut length,
        ) == 0
        {
            return String::new();
        }
        let first = buffer.split(|unit| *unit == 0).next().unwrap_or(&[]);
        String::from_utf16_lossy(first)
    }
}
