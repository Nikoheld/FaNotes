//! Index benchmark for WP6.
//!
//!   fanotes-index-bench generate --out DIR [--notes 10000]
//!   fanotes-index-bench run --vault DIR [--threads 4] [--queries FILE] [--out FILE]
//!
//! `generate` writes a deterministic vault (notes, handwriting companions,
//! stories) and `DIR.queries.json`. `run` prints one JSON line: cold build,
//! cache save/load, one incremental update, query p50/p95. The TS numbers for
//! the same vault: `node scripts/search-parity.mjs bench --vault DIR --queries DIR.queries.json`.

use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Instant;

use fanotes_index::{Engine, MAX_RESULTS};

const WORDS: &[&str] = &[
    "Zelle",
    "Zellkern",
    "Mitose",
    "Photosynthese",
    "Chlorophyll",
    "Licht",
    "Energie",
    "Lageenergie",
    "Geschwindigkeit",
    "Höhe",
    "Größe",
    "Straße",
    "Übung",
    "Prüfung",
    "Mädchen",
    "Bäume",
    "Gewässer",
    "Fluss",
    "Grüße",
    "Aufsatz",
    "Gedicht",
    "Erörterung",
    "Integral",
    "Ableitung",
    "Funktion",
    "Gleichung",
    "Vektor",
    "Matrix",
    "Revolution",
    "Grammatik",
    "Vokabeln",
    "Säure",
    "Molekül",
    "Atom",
    "Elektron",
    "Spannung",
    "Widerstand",
    "Strom",
    "Kraft",
    "Masse",
    "Beschleunigung",
    "Zeit",
    "Geschichte",
    "Europa",
    "cell",
    "nucleus",
    "membrane",
    "energy",
    "velocity",
    "equation",
    "essay",
    "poem",
    "chapter",
    "river",
    "mountain",
    "history",
    "acid",
    "molecule",
    "café",
    "Zürich",
    "München",
    "über",
    "unter",
    "und",
    "oder",
    "the",
    "and",
    "with",
    "for",
    "von",
    "mit",
    "der",
    "die",
    "das",
    "ist",
    "nicht",
    "ein",
    "eine",
    "auch",
    "wird",
    "sind",
    "Beispiel",
    "Aufgabe",
    "Lösung",
    "Formel",
    "Tabelle",
];

struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn word(&mut self) -> &'static str {
        // Skewed like real text: common words are common.
        let a = self.next() as usize % WORDS.len();
        let b = self.next() as usize % WORDS.len();
        WORDS[a.min(b).max(a / 3)]
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|at| args.get(at + 1))
        .cloned()
}

fn write(root: &Path, relative: &str, text: &str) {
    let file = root.join(relative);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn famd(markdown: &str, transcript: &str) -> String {
    let json = serde_json::json!({ "schema": "fanotes-famd-v1", "updatedAt": "2026-11-01T10:00:00.000Z", "ink": { "schemaVersion": 1, "title": "Handschrift", "strokes": [], "searchTranscript": transcript }, "worksheets": [] }).to_string();
    format!(
        "{markdown}\n\n<!-- fanotes-famd:v1 chars={} -->\n{json}\n",
        json.encode_utf16().count()
    )
}

fn generate(out: &Path, notes: usize) {
    let _ = std::fs::remove_dir_all(out);
    let mut random = Random(0x2026_1115);
    for index in 0..notes {
        let folder = format!("Fach {}/Thema {}", index % 12, index % 97);
        let title = format!("{} {} {index}", random.word(), random.word());
        let length = 80 + (random.next() % 520) as usize;
        let mut text = format!("# {title}\n\n");
        for word in 0..length {
            text.push_str(random.word());
            text.push(if word % 14 == 13 { '\n' } else { ' ' });
        }
        write(out, &format!("{folder}/{title}.md"), &text);
        if index % 20 == 0 {
            let transcript: Vec<String> = (0..8)
                .map(|line| {
                    format!(
                        "{:.4}\t{} {} {}",
                        line as f64 / 8.0,
                        random.word(),
                        random.word(),
                        random.word()
                    )
                })
                .collect();
            write(
                out,
                &format!("{folder}/{title}.famd"),
                &famd(&format!("# {title}"), &transcript.join("\n")),
            );
        }
    }
    for story in 0..20 {
        let path = format!("Geschichten/Roman {story}.story");
        let ids: Vec<String> = (0..10)
            .map(|scene| format!("s{story:03}x{scene:03}"))
            .collect();
        let binder: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({ "id": id, "kind": "scene", "title": id }))
            .collect();
        write(out, &format!("{path}/story.json"), &serde_json::json!({ "format": "fanotes-story-v1", "id": format!("story{story}"), "title": "Roman", "binder": binder }).to_string());
        for id in &ids {
            let paragraphs: Vec<_> = (0..30)
                .map(|p| {
                    let text: Vec<&str> = (0..40).map(|_| random.word()).collect();
                    serde_json::json!({ "id": format!("p{p}"), "key": format!("a{p:03}"), "v": {}, "style": "body", "runs": [{ "text": text.join(" ") }] })
                })
                .collect();
            write(out, &format!("{path}/scenes/{id}.json"), &serde_json::json!({ "format": "fanotes-story-scene-v1", "id": id, "paragraphs": paragraphs }).to_string());
        }
    }
    let mut queries: Vec<String> = Vec::new();
    for index in 0..200 {
        queries.push(match index % 4 {
            0 => random.word().to_owned(),
            1 => format!("{} {}", random.word(), random.word()),
            2 => random.word().chars().take(4).collect(),
            _ => format!(
                "{} {}",
                random.word().to_uppercase(),
                random.word().chars().take(3).collect::<String>()
            ),
        });
    }
    let file = PathBuf::from(format!("{}.queries.json", out.display()));
    std::fs::write(file, serde_json::to_string(&queries).unwrap()).unwrap();
}

fn peak_rss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmHWM:"))
                .and_then(|line| line.split_whitespace().nth(1)?.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

fn run(vault: &Path, threads: usize, queries: Vec<String>) -> serde_json::Value {
    let started = Instant::now();
    let engine = Engine::build(vault, threads);
    let build_ms = started.elapsed().as_secs_f64() * 1000.0;
    let cache =
        std::env::temp_dir().join(format!("fanotes-index-bench-{}.json", std::process::id()));
    let at = Instant::now();
    engine.save(&cache, vault).unwrap();
    let save_ms = at.elapsed().as_secs_f64() * 1000.0;
    let cache_mb = std::fs::metadata(&cache)
        .map(|m| m.len() as f64 / 1048576.0)
        .unwrap_or(0.0);
    let at = Instant::now();
    let loaded = Engine::load(&cache, vault).unwrap();
    let load_ms = at.elapsed().as_secs_f64() * 1000.0;
    let _ = std::fs::remove_file(&cache);
    drop(loaded);
    let mut times: Vec<f64> = Vec::new();
    for _ in 0..3 {
        for query in &queries {
            let at = Instant::now();
            std::hint::black_box(engine.search(query, MAX_RESULTS));
            times.push(at.elapsed().as_secs_f64() * 1000.0);
        }
    }
    times.sort_by(|a, b| a.total_cmp(b));
    let quantile = |q: f64| times[((q * times.len() as f64) as usize).min(times.len() - 1)];
    // One edited note: list + stat the vault, re-read that note.
    let documents = engine.index.document_count();
    let units = engine.index.unit_count();
    let lock = RwLock::new(engine);
    let first = lock
        .read()
        .unwrap()
        .sources()
        .into_iter()
        .find(|source| source.path.ends_with(".md"))
        .unwrap();
    let file = vault.join(&first.path);
    let original = std::fs::read_to_string(&file).unwrap();
    std::fs::write(&file, format!("{original}\nNachtrag Quantenmechanik")).unwrap();
    let at = Instant::now();
    let changed = Engine::refresh(&lock, vault, threads, &|_, _| {});
    let update_ms = at.elapsed().as_secs_f64() * 1000.0;
    std::fs::write(&file, original).unwrap();
    assert_eq!(changed, 1);
    serde_json::json!({
        "engine": "rust",
        "threads": threads,
        "documents": documents,
        "units": units,
        "buildMs": build_ms.round(),
        "cacheSaveMs": save_ms.round(),
        "cacheLoadMs": load_ms.round(),
        "cacheMb": (cache_mb * 10.0).round() / 10.0,
        "updateOneNoteMs": update_ms.round(),
        "queryP50Ms": (quantile(0.5) * 1000.0).round() / 1000.0,
        "queryP95Ms": (quantile(0.95) * 1000.0).round() / 1000.0,
        "queries": times.len(),
        "peakRssMb": peak_rss_mb(),
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("generate") => {
            let out = PathBuf::from(arg(&args, "--out").expect("--out DIR"));
            let notes = arg(&args, "--notes")
                .and_then(|n| n.parse().ok())
                .unwrap_or(10_000);
            generate(&out, notes);
            println!(
                "{{\"generated\":{notes},\"vault\":{:?}}}",
                out.display().to_string()
            );
        }
        Some("run") => {
            let vault = PathBuf::from(arg(&args, "--vault").expect("--vault DIR"));
            let threads = arg(&args, "--threads")
                .and_then(|n| n.parse().ok())
                .unwrap_or(4);
            let queries_file = arg(&args, "--queries")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(format!("{}.queries.json", vault.display())));
            let queries: Vec<String> =
                serde_json::from_str(&std::fs::read_to_string(queries_file).expect("queries file"))
                    .expect("queries JSON");
            let report = run(&vault, threads, queries);
            if let Some(out) = arg(&args, "--out") {
                std::fs::write(out, format!("{report:#}\n")).unwrap();
            }
            println!("{report}");
        }
        _ => {
            eprintln!("usage: fanotes-index-bench generate --out DIR [--notes N] | run --vault DIR [--threads N] [--queries FILE] [--out FILE]");
            std::process::exit(2);
        }
    }
}
