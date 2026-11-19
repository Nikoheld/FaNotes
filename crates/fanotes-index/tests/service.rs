//! The running index: watcher updates, cache reuse, corrupt and stale caches.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fanotes_index::{cache_file, IndexService, Options};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fanotes-index-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn hits(service: &IndexService, query: &str) -> Vec<String> {
    service
        .query(query, 40)
        .into_iter()
        .map(|hit| hit.path)
        .collect()
}

fn eventually(service: &IndexService, query: &str, want: &[&str]) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if hits(service, query) == want {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn write(root: &Path, relative: &str, text: &str) {
    let file = root.join(relative);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

#[test]
fn watcher_updates_and_the_cache_is_reused_or_rebuilt() {
    let vault = temp("vault");
    let cache = temp("cache");
    write(
        &vault,
        "Bio/Zelle.md",
        "# Zelle\n\nDer Zellkern steuert die Zelle.",
    );
    write(&vault, "Physik.md", "Energie und Straße");
    let service = IndexService::open(
        &vault,
        Some(&cache),
        Options {
            threads: 2,
            watch: true,
        },
    );
    assert!(service.wait_idle(Duration::from_secs(20)));
    assert_eq!(hits(&service, "strasse"), ["Physik.md"]);
    // A new file, an edit and a delete reach the index through the watcher.
    write(&vault, "Neu.md", "Photosynthese im Herbst");
    assert!(eventually(&service, "photosynthese", &["Neu.md"]));
    write(&vault, "Physik.md", "Nur noch Energie");
    assert!(eventually(&service, "strasse", &[]));
    std::fs::remove_file(vault.join("Neu.md")).unwrap();
    assert!(eventually(&service, "photosynthese", &[]));
    // Dot folders are not indexed.
    write(&vault, ".fanotes/geheim.md", "Photosynthese");
    service.notify_changed();
    std::thread::sleep(Duration::from_millis(600));
    assert!(service.wait_idle(Duration::from_secs(10)));
    assert!(hits(&service, "photosynthese").is_empty());
    drop(service);

    let file = cache_file(&cache, &std::fs::canonicalize(&vault).unwrap()).unwrap();
    assert!(file.exists(), "the cache is written outside the vault");
    assert!(!file.starts_with(&vault));
    // A stale cache: the vault changed while the app was closed.
    write(&vault, "Spaet.md", "Nachgetragen: Mitochondrien");
    let service = IndexService::open(
        &vault,
        Some(&cache),
        Options {
            threads: 2,
            watch: false,
        },
    );
    assert!(service.wait_idle(Duration::from_secs(20)));
    assert_eq!(service.status()["cache"], "loaded");
    assert_eq!(hits(&service, "mitochondrien"), ["Spaet.md"]);
    assert_eq!(hits(&service, "zellkern"), ["Bio/Zelle.md"]);
    drop(service);

    // Corrupt caches are thrown away and rebuilt, never fatal.
    for damage in [
        b"garbage".to_vec(),
        Vec::new(),
        std::fs::read(&file).unwrap()[..100].to_vec(),
    ] {
        std::fs::write(&file, &damage).unwrap();
        let service = IndexService::open(
            &vault,
            Some(&cache),
            Options {
                threads: 2,
                watch: false,
            },
        );
        assert!(service.wait_idle(Duration::from_secs(20)));
        assert_eq!(service.status()["cache"], "rebuilt");
        assert_eq!(hits(&service, "zellkern"), ["Bio/Zelle.md"]);
        drop(service);
    }
    // A flipped byte inside the body fails the checksum.
    let mut bytes = std::fs::read(&file).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0x20;
    std::fs::write(&file, &bytes).unwrap();
    let service = IndexService::open(
        &vault,
        Some(&cache),
        Options {
            threads: 2,
            watch: false,
        },
    );
    assert!(service.wait_idle(Duration::from_secs(20)));
    assert_eq!(service.status()["cache"], "rebuilt");
    service.rebuild();
    std::thread::sleep(Duration::from_millis(600));
    assert!(service.wait_idle(Duration::from_secs(20)));
    assert_eq!(hits(&service, "zellkern"), ["Bio/Zelle.md"]);
    drop(service);
    let _ = std::fs::remove_dir_all(&vault);
    let _ = std::fs::remove_dir_all(&cache);
}

#[test]
fn the_cache_is_never_inside_the_vault() {
    let vault = temp("inside");
    assert!(cache_file(&vault.join("cache"), &vault).is_none());
    let _ = std::fs::remove_dir_all(&vault);
}
