//! First-run folders from `electron/onboarding.cjs`.
//!
//! A vault asks for setup only when `.fanotes/onboarding.json` says `pending`.
//! Older vaults have no marker and open straight into the shell.

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use serde_json::{json, Value};

use crate::notes;

struct StarterFolder {
    name: &'static str,
    color: &'static str,
}

const REQUIRED_DE: StarterFolder = StarterFolder {
    name: "Eingang",
    color: "#6b7280",
};
const REQUIRED_EN: StarterFolder = StarterFolder {
    name: "Inbox",
    color: "#6b7280",
};

const SCHOOL_DE: &[StarterFolder] = &[
    StarterFolder {
        name: "Mathematik",
        color: "#2a6f97",
    },
    StarterFolder {
        name: "AMAT",
        color: "#9065b0",
    },
    StarterFolder {
        name: "Deutsch",
        color: "#c4554d",
    },
    StarterFolder {
        name: "Englisch",
        color: "#0f7b6c",
    },
    StarterFolder {
        name: "Französisch",
        color: "#1d5f86",
    },
    StarterFolder {
        name: "Physik",
        color: "#7c6a9a",
    },
    StarterFolder {
        name: "Chemie",
        color: "#d9730d",
    },
    StarterFolder {
        name: "Biologie",
        color: "#448361",
    },
    StarterFolder {
        name: "Geschichte",
        color: "#ba9b4a",
    },
    StarterFolder {
        name: "Informatik",
        color: "#337ea9",
    },
    StarterFolder {
        name: "Wirtschaft",
        color: "#c47d4e",
    },
];

const SCHOOL_EN: &[StarterFolder] = &[
    StarterFolder {
        name: "Mathematics",
        color: "#2a6f97",
    },
    StarterFolder {
        name: "AMAT",
        color: "#9065b0",
    },
    StarterFolder {
        name: "German",
        color: "#c4554d",
    },
    StarterFolder {
        name: "English",
        color: "#0f7b6c",
    },
    StarterFolder {
        name: "French",
        color: "#1d5f86",
    },
    StarterFolder {
        name: "Physics",
        color: "#7c6a9a",
    },
    StarterFolder {
        name: "Chemistry",
        color: "#d9730d",
    },
    StarterFolder {
        name: "Biology",
        color: "#448361",
    },
    StarterFolder {
        name: "History",
        color: "#ba9b4a",
    },
    StarterFolder {
        name: "Computer Science",
        color: "#337ea9",
    },
    StarterFolder {
        name: "Economics",
        color: "#c47d4e",
    },
];

const UNIVERSITY_DE: &[StarterFolder] = &[
    StarterFolder {
        name: "Vorlesungen",
        color: "#2a6f97",
    },
    StarterFolder {
        name: "Seminare",
        color: "#9065b0",
    },
    StarterFolder {
        name: "Forschung",
        color: "#0f7b6c",
    },
    StarterFolder {
        name: "Prüfungen",
        color: "#c4554d",
    },
    StarterFolder {
        name: "Literatur",
        color: "#ba9b4a",
    },
];

const UNIVERSITY_EN: &[StarterFolder] = &[
    StarterFolder {
        name: "Lectures",
        color: "#2a6f97",
    },
    StarterFolder {
        name: "Seminars",
        color: "#9065b0",
    },
    StarterFolder {
        name: "Research",
        color: "#0f7b6c",
    },
    StarterFolder {
        name: "Exams",
        color: "#c4554d",
    },
    StarterFolder {
        name: "Reading",
        color: "#ba9b4a",
    },
];

const PRIVATE_DE: &[StarterFolder] = &[
    StarterFolder {
        name: "Persönlich",
        color: "#c4554d",
    },
    StarterFolder {
        name: "Ideen",
        color: "#9065b0",
    },
    StarterFolder {
        name: "Projekte",
        color: "#337ea9",
    },
    StarterFolder {
        name: "Tagebuch",
        color: "#448361",
    },
    StarterFolder {
        name: "Dokumente",
        color: "#ba9b4a",
    },
];

const PRIVATE_EN: &[StarterFolder] = &[
    StarterFolder {
        name: "Personal",
        color: "#c4554d",
    },
    StarterFolder {
        name: "Ideas",
        color: "#9065b0",
    },
    StarterFolder {
        name: "Projects",
        color: "#337ea9",
    },
    StarterFolder {
        name: "Journal",
        color: "#448361",
    },
    StarterFolder {
        name: "Documents",
        color: "#ba9b4a",
    },
];

const WORK_DE: &[StarterFolder] = &[
    StarterFolder {
        name: "Projekte",
        color: "#337ea9",
    },
    StarterFolder {
        name: "Meetings",
        color: "#9065b0",
    },
    StarterFolder {
        name: "Aufgaben",
        color: "#c4554d",
    },
    StarterFolder {
        name: "Wissen",
        color: "#0f7b6c",
    },
    StarterFolder {
        name: "Archiv",
        color: "#ba9b4a",
    },
];

const WORK_EN: &[StarterFolder] = &[
    StarterFolder {
        name: "Projects",
        color: "#337ea9",
    },
    StarterFolder {
        name: "Meetings",
        color: "#9065b0",
    },
    StarterFolder {
        name: "Tasks",
        color: "#c4554d",
    },
    StarterFolder {
        name: "Knowledge",
        color: "#0f7b6c",
    },
    StarterFolder {
        name: "Archive",
        color: "#ba9b4a",
    },
];

const CATALOGS: &[&[StarterFolder]] = &[
    SCHOOL_DE,
    UNIVERSITY_DE,
    PRIVATE_DE,
    WORK_DE,
    SCHOOL_EN,
    UNIVERSITY_EN,
    PRIVATE_EN,
    WORK_EN,
];

pub(crate) fn welcome_note(language: &str) -> &'static str {
    if language == "en" {
        include_str!("welcome_en.md")
    } else {
        include_str!("welcome_de.md")
    }
}

pub(crate) fn welcome_file_name(language: &str) -> &'static str {
    if language == "en" {
        "Welcome.md"
    } else {
        "Willkommen.md"
    }
}

const LEGACY_WELCOME_DE: &str = r#"# Willkommen bei FaNotes

Deine Notizen liegen als normale Markdown-Dateien in diesem Ordner. Du kannst sie jederzeit auch mit anderen Editoren öffnen.

## Schnellstart

- Wähle links einen Bereich oder erstelle einen eigenen Ordner.
- Schreibe mit Tastatur oder Grafiktablett direkt auf derselben Notizseite.
- Importiere Bilder oder PDFs als Arbeitsblätter und fülle sie mit Textfeldern oder dem Stift aus.
- Konvertierte Mathematik wird als LaTeX gespeichert und sauber gesetzt dargestellt.
- Mit `[[Notizname]]` kannst du später Wissensseiten miteinander verbinden.

Viel Freude beim Lernen!
"#;

const WELCOME_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Refresh an untouched starter note. A note the user has rewritten stays as it is.
pub(crate) fn upgrade_welcome_notes(root: &Path) {
    repair_welcome_file(root, "Willkommen.md", |content| {
        if content == LEGACY_WELCOME_DE {
            return Some(welcome_note("de").to_owned());
        }
        replace_first(
            content,
            "Mit `Strg+Z` holst du eine versehentliche Löschung sofort zurück.",
            "Mit **Strg+Z** holst du eine versehentliche Löschung sofort zurück.",
        )
    });
    repair_welcome_file(root, "Welcome.md", |content| {
        replace_first(
            content,
            "Press `Ctrl+Z` to restore something you erased by accident.",
            "Press **Ctrl+Z** to restore something you erased by accident.",
        )
    });
}

fn replace_first(content: &str, from: &str, to: &str) -> Option<String> {
    if !content.contains(from) {
        return None;
    }
    Some(content.replacen(from, to, 1))
}

fn repair_welcome_file(root: &Path, name: &str, repair: impl Fn(&str) -> Option<String>) {
    let path = root.join(name);
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > WELCOME_MAX_BYTES {
        return;
    }
    let Ok(existing) = fs::read_to_string(&path) else {
        return;
    };
    let Some(repaired) = repair(&existing) else {
        return;
    };
    if repaired == existing {
        return;
    }
    let _ = notes::atomic_write(&path, repaired.as_bytes(), 0o600);
}

pub(crate) fn starter_subjects(language: &str) -> Value {
    let source = if language == "en" {
        SCHOOL_EN
    } else {
        SCHOOL_DE
    };
    Value::Array(
        source
            .iter()
            .map(|folder| json!({ "name": folder.name, "color": folder.color }))
            .collect(),
    )
}

pub(crate) fn validate_selection(value: &Value) -> Result<Vec<String>, String> {
    let Some(list) = value.as_array() else {
        return Err("Die Ordnerauswahl ist ungültig.".to_owned());
    };
    if list.len() > 16 {
        return Err("Die Ordnerauswahl ist ungültig.".to_owned());
    }
    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in list {
        let Some(name) = item.as_str() else {
            return Err(
                "Die Ordnerauswahl enthält einen ungültigen oder doppelten Eintrag.".to_owned(),
            );
        };
        if starter_color(name).is_none() || !seen.insert(name.to_owned()) {
            return Err(
                "Die Ordnerauswahl enthält einen ungültigen oder doppelten Eintrag.".to_owned(),
            );
        }
        selected.push(name.to_owned());
    }
    Ok(selected)
}

pub(crate) fn folders_to_create(
    language: &str,
    selected: &[String],
) -> Vec<(&'static str, &'static str)> {
    let mut folders = vec![if language == "en" {
        (REQUIRED_EN.name, REQUIRED_EN.color)
    } else {
        (REQUIRED_DE.name, REQUIRED_DE.color)
    }];
    for name in selected {
        let Some(folder) = find_starter(name) else {
            continue;
        };
        if folders.iter().any(|(existing, _)| *existing == folder.name) {
            continue;
        }
        folders.push((folder.name, folder.color));
    }
    folders
}

fn find_starter(name: &str) -> Option<&'static StarterFolder> {
    CATALOGS
        .iter()
        .flat_map(|catalog| catalog.iter())
        .find(|folder| folder.name == name)
}

fn starter_color(name: &str) -> Option<&'static str> {
    find_starter(name).map(|folder| folder.color)
}

pub(crate) fn ensure_folder(root: &Path, name: &str) -> Result<(), String> {
    let target = root.join(name);
    match fs::create_dir(&target) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o700));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&target).map_err(|_| starter_folder_error(name))?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(starter_folder_error(name));
            }
        }
        Err(_) => return Err(starter_folder_error(name)),
    }
    let real = fs::canonicalize(&target).map_err(|_| starter_folder_error(name))?;
    let root_real = fs::canonicalize(root).map_err(|_| starter_folder_error(name))?;
    if !crate::vault::is_inside_root(&root_real, &real) {
        return Err(format!("Der Ordner „{name}“ verlässt den Vault."));
    }
    Ok(())
}

fn starter_folder_error(name: &str) -> String {
    format!("Der vorbereitete Ordner „{name}“ kann nicht sicher angelegt werden.")
}

pub(crate) fn read_status(root: &Path) -> Option<&'static str> {
    let path = crate::vault::ensure_internal_directory(root)
        .ok()?
        .join("onboarding.json");
    let meta = fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 16 * 1024 {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let parsed = serde_json::from_str::<Value>(&text).ok()?;
    if parsed.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    match parsed.get("status").and_then(Value::as_str) {
        Some("pending") => Some("pending"),
        Some("complete") => Some("complete"),
        _ => None,
    }
}

pub(crate) fn write_status(root: &Path, status: &str) -> Result<(), String> {
    if status != "pending" && status != "complete" {
        return Err("Ungültiger Einrichtungsstatus.".to_owned());
    }
    let path = crate::vault::ensure_internal_directory(root)?.join("onboarding.json");
    let snapshot = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "status": status,
            "updatedAt": notes::iso_from_system_time(SystemTime::now()),
        }))
        .unwrap_or_default()
    );
    notes::atomic_write(&path, snapshot.as_bytes(), 0o600)
}
