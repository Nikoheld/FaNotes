//! Helpers for tests (hidden from the docs): temp dirs that remove themselves.

use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};

/// A scratch directory path under the system temp dir. The directory is not
/// created (callers do that); the path is cleared on creation and the whole tree
/// is removed when the value drops, also when the test panics.
#[derive(Debug)]
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(name: impl AsRef<Path>) -> Self {
        let path = std::env::temp_dir().join(name);
        remove_tree(&path);
        Self(path)
    }
}

impl Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        remove_tree(&self.0);
    }
}

/// Removes a tree, first making read-only folders writable again: several tests
/// chmod a folder to prove an error path.
fn remove_tree(path: &Path) {
    #[cfg(unix)]
    make_writable(path);
    let _ = fs::remove_dir_all(path);
}

#[cfg(unix)]
fn make_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            make_writable(&entry.path());
        }
    }
}
