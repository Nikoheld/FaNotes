//! OneNote import through the same hash-checked `one2html` and `7za` binaries
//! Electron ships. Pages become Markdown notes plus sanitized HTML worksheets.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::Host;

const ONE2HTML_SHA: &str = "140c347e192d8bed8225f01a4c736e04c19bed241589d46cdc8b241b906eadb0";
const SEVENZIP_SHA: &str = "afc9448bd0cc2eeda131cce313ef4994f9656417e0a15c8465fcda9ca859b280";
const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_HTML_BYTES: usize = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES: u64 = 96 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_EXPANDED_BYTES: u64 = 6 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const TOOL_TIMEOUT: Duration = Duration::from_secs(12 * 60);
const ARCHIVE_LISTING_TIMEOUT: Duration = Duration::from_secs(90);
/// JavaScript `/u` `\s`: includes U+FEFF and excludes U+0085.
const JS_WS: &str = r"[\t\n\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
const JS_NOT_WS_OR_GT: &str = r"[^\t\n\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}>]";

pub fn import_onenote(host: &Host, args: &[Value]) -> Result<Value, String> {
    if let Some(path) = args
        .first()
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    {
        return import_path(host, Path::new(path));
    }
    if !host.file_dialogs {
        return Err("Die Dateiauswahl ist in dieser Sitzung nicht verfügbar.".to_owned());
    }
    let Some(path) = rfd::FileDialog::new()
        .set_title("Microsoft OneNote in FaNotes importieren")
        .add_filter("Microsoft OneNote", &["one", "onetoc2", "onepkg", "zip"])
        .pick_file()
    else {
        return Ok(Value::Null);
    };
    import_path(host, &path)
}

fn import_path(host: &Host, input: &Path) -> Result<Value, String> {
    let vault = host
        .vault
        .as_deref()
        .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())?;
    let extension = extension_of(input);
    if !matches!(extension.as_str(), ".one" | ".onetoc2" | ".onepkg" | ".zip") {
        return Err("Diese Datei ist kein unterstützter OneNote-Export.".to_owned());
    }
    let source_meta = fs::symlink_metadata(input).map_err(|_| {
        "Die OneNote-Quelldatei ist leer, unsicher oder größer als 4 GB.".to_owned()
    })?;
    if source_meta.file_type().is_symlink()
        || !source_meta.is_file()
        || source_meta.len() == 0
        || source_meta.len() > MAX_SOURCE_BYTES
    {
        return Err("Die OneNote-Quelldatei ist leer, unsicher oder größer als 4 GB.".to_owned());
    }
    let (one2html, seven_zip) = materialize_tools(&host.app_data)?;
    let temporary = std::env::temp_dir().join(format!("fanotes-onenote-{}", uuid()));
    create_private_dir(&temporary)
        .map_err(|_| "Der OneNote-Import konnte nicht vorbereitet werden.".to_owned())?;
    let result = import_in_temp(input, vault, &one2html, &seven_zip, &temporary);
    let _ = fs::remove_dir_all(&temporary);
    result
}

fn import_in_temp(
    input: &Path,
    vault: &Path,
    one2html: &Path,
    seven_zip: &Path,
    temporary: &Path,
) -> Result<Value, String> {
    let inputs = prepare_input(input, temporary, seven_zip)?;
    let output_root = temporary.join("rendered");
    create_private_dir(&output_root)
        .map_err(|_| "Der OneNote-Import konnte nicht vorbereitet werden.".to_owned())?;
    let warnings = render_inputs(&inputs, &output_root, one2html)?;
    let output_files = walk_files(&output_root, MAX_OUTPUT_BYTES)?;
    let html_files: Vec<PathBuf> = output_files
        .iter()
        .filter(|path| extension_of(path) == ".html")
        .cloned()
        .collect();
    let parents = page_parents(&html_files, &output_root);
    let mut pages = Vec::new();
    for path in &html_files {
        let preview = crate::notes::read_lossy_string(path).unwrap_or_default();
        if preview_is_nav(&preview) {
            continue;
        }
        pages.push(path.clone());
    }
    if pages.is_empty() {
        return Err("Im OneNote-Export wurden keine lesbaren Seiten gefunden. Verwende einen aktuellen OneDrive-Export oder eine moderne .one-Datei.".to_owned());
    }
    pages.sort_by(|left, right| {
        crate::numeric_dictionary_order(&left.to_string_lossy(), &right.to_string_lossy())
    });

    let source_digest = sha256_file(input)?;
    let source_base = input
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("OneNote");
    let notebook_source = if source_base == "Open Notebook" {
        input
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or(source_base)
    } else {
        source_base
    };
    let notebook_name = safe_segment(notebook_source, "OneNote-Notizbuch");
    let note_root = unique_directory(vault, &format!("OneNote – {notebook_name}"))?;
    let internal = crate::vault::ensure_internal_directory(vault)
        .map_err(|_| "Der OneNote-Import konnte nicht angelegt werden.".to_owned())?;
    let batch = internal.join("onenote").join(uuid());
    let attachment_dir = batch.join("attachments");
    create_private_dir(&attachment_dir)
        .map_err(|_| "Der OneNote-Import konnte nicht angelegt werden.".to_owned())?;
    create_private_dir(&internal.join("worksheets"))
        .map_err(|_| "Der OneNote-Import konnte nicht angelegt werden.".to_owned())?;

    let import_result = (|| {
        let attachments = copy_attachments(&output_files, &output_root, &attachment_dir)?;
        let originals = preserve_sources(input, &batch)?;
        let now = now_iso();
        let mut imported = Vec::new();
        let mut created = Vec::new();
        for page_path in &pages {
            let page = sanitize_page(page_path, &output_root)?;
            let relative = page_path.strip_prefix(&output_root).unwrap_or(page_path);
            let mut hierarchy: Vec<String> = relative
                .parent()
                .map(|parent| {
                    parent
                        .components()
                        .filter_map(|component| component.as_os_str().to_str())
                        .filter(|segment| !segment.is_empty() && *segment != ".")
                        .map(|segment| segment.to_owned())
                        .collect()
                })
                .unwrap_or_default();
            if hierarchy.first().is_some_and(|segment| {
                crate::base_dictionary_order(segment, &notebook_name) == std::cmp::Ordering::Equal
            }) {
                hierarchy.remove(0);
            }
            let mut directory = note_root.clone();
            for segment in note_directory_segments(
                hierarchy,
                parents.get(page_path).cloned().unwrap_or_default(),
            ) {
                directory.push(segment);
            }
            create_private_dir(&directory)
                .map_err(|_| "Eine OneNote-Seitenhierarchie ist ungültig.".to_owned())?;
            let id = uuid();
            let worksheets = vault.join(".fanotes").join("worksheets");
            let html_path = worksheets.join(format!("{id}.html"));
            let json_path = worksheets.join(format!("{id}.json"));
            crate::notes::atomic_write(&html_path, page.html.as_bytes(), 0o600)
                .map_err(|_| "Eine OneNote-Seite konnte nicht gespeichert werden.".to_owned())?;
            created.push(html_path);
            let worksheet = json!({
                "schemaVersion": 1,
                "id": id,
                "title": page.title,
                "kind": "html",
                "mimeType": "text/html",
                "sourceRelativePath": format!(".fanotes/worksheets/{id}.html"),
                "dataRelativePath": format!(".fanotes/worksheets/{id}.json"),
                "createdAt": now,
                "updatedAt": now,
                "pageWidth": page.width,
                "pageHeight": page.height,
                "textBoxes": [],
            });
            let worksheet_json = format!(
                "{}\n",
                serde_json::to_string_pretty(&worksheet).unwrap_or_default()
            );
            crate::notes::atomic_write(&json_path, worksheet_json.as_bytes(), 0o600)
                .map_err(|_| "Eine OneNote-Seite konnte nicht gespeichert werden.".to_owned())?;
            created.push(json_path);
            let searchable = if page.transcript.is_empty() {
                String::new()
            } else {
                format!(
                    "\n<details>\n<summary>Importierter Text · suchbar und bearbeitbar</summary>\n\n```text\n{}\n```\n\n</details>\n",
                    page.transcript.replace("```", "ˋˋˋ")
                )
            };
            let markdown = format!(
                "# {}\n\n<!-- fanotes-onenote:{} -->\n<!-- fanotes-worksheet:{id} -->\n{searchable}",
                markdown_title(&page.title),
                &source_digest[..24]
            );
            let note = write_unique_markdown(&directory, &page.title, &markdown)?;
            let relative_note = note
                .strip_prefix(vault)
                .unwrap_or(&note)
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            imported.push(relative_note);
        }
        let manifest = json!({
            "schemaVersion": 1,
            "importedAt": now,
            "sourceName": input.file_name().and_then(|name| name.to_str()).unwrap_or("onenote"),
            "sourceSha256": source_digest,
            "pages": imported.len(),
            "attachments": attachments,
            "originalSources": originals,
            "safety": "Attachments are stored byte-identically with an inert .fanotes-attachment suffix and are never executed.",
        });
        let manifest_json = format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).unwrap_or_default()
        );
        crate::notes::atomic_write(
            &batch.join("manifest.json"),
            manifest_json.as_bytes(),
            0o600,
        )
        .map_err(|_| "Der OneNote-Import konnte nicht gespeichert werden.".to_owned())?;
        let mut all_warnings = warnings;
        if !attachments.is_empty() {
            all_warnings.push(
                "Anlagen wurden bytegenau, aber nicht ausführbar im internen Vault-Bereich verwahrt."
                    .to_owned(),
            );
        }
        let root_folder = note_root
            .strip_prefix(vault)
            .unwrap_or(&note_root)
            .to_string_lossy()
            .replace('\\', "/");
        Ok(json!({
            "rootFolder": root_folder,
            "pageCount": imported.len(),
            "attachmentCount": attachments.len(),
            "importedNotes": imported,
            "warnings": all_warnings,
        }))
    })();
    if import_result.is_err() {
        let _ = fs::remove_dir_all(&note_root);
        let _ = fs::remove_dir_all(&batch);
    }
    import_result
}

struct Page {
    html: String,
    title: String,
    transcript: String,
    width: i64,
    height: i64,
}

fn sanitize_page(page_path: &Path, output_root: &Path) -> Result<Page, String> {
    let meta = fs::symlink_metadata(page_path)
        .map_err(|_| "Eine OneNote-Seite ist leer oder zu groß.".to_owned())?;
    if meta.file_type().is_symlink()
        || !meta.is_file()
        || meta.len() == 0
        || meta.len() as usize > MAX_HTML_BYTES
    {
        return Err("Eine OneNote-Seite ist leer oder zu groß.".to_owned());
    }
    let mut html = crate::notes::read_lossy_string(page_path)
        .ok_or_else(|| "Eine OneNote-Seite ist leer oder zu groß.".to_owned())?;
    let title = page_title(&html, page_path);
    let transcript = extract_search_text(&html);
    let (width, height) = page_dimensions(&html);
    html = inline_images(&html, page_path, output_root);
    html = strip_active_html(&html);
    let policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    let guard = format!(
        "<meta name=\"fanotes-onenote-safe-v1\" content=\"1\"><meta http-equiv=\"Content-Security-Policy\" content=\"{policy}\"><style id=\"fanotes-page-guard\">html,body{{width:{width}px;min-width:{width}px;min-height:{height}px;overflow:hidden;background:#fff;color:#111}}a{{color:inherit;text-decoration:underline;pointer-events:none}}</style>"
    );
    if html.contains("<head>") {
        html = html.replacen("<head>", &format!("<head>{guard}"), 1);
    } else {
        html = format!("<!doctype html><html><head>{guard}</head><body>{html}</body></html>");
    }
    if html.len() > MAX_HTML_BYTES {
        return Err("Eine eingebettete OneNote-Seite überschreitet nach der Bildübernahme die sichere Größe.".to_owned());
    }
    Ok(Page {
        html,
        title,
        transcript,
        width,
        height,
    })
}

fn page_title(html: &str, page_path: &Path) -> String {
    let raw = Regex::new(r"(?is)<title[^>]*>(.*?)</title>")
        .ok()
        .and_then(|pattern| {
            pattern
                .captures(html)
                .and_then(|caps| caps.get(1).map(|item| item.as_str().to_owned()))
        })
        .unwrap_or_else(|| title_fallback(page_path));
    let decoded = decode_entities(&raw);
    let stripped = Regex::new(r"<[^>]+>")
        .map(|pattern| pattern.replace_all(&decoded, "").into_owned())
        .unwrap_or(decoded);
    safe_segment(crate::vault::js_trim(&stripped), "OneNote-Seite")
}

fn title_fallback(page_path: &Path) -> String {
    let name = page_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "OneNote-Seite".to_owned());
    match name.strip_suffix(".html") {
        Some(stripped) if !stripped.is_empty() => stripped.to_owned(),
        _ => name,
    }
}

/// JavaScript `\b` is an ASCII word boundary, including in a `u` pattern.
fn js_regex(pattern: &str) -> Result<Regex, regex::Error> {
    Regex::new(&pattern.replace(r"\b", r"(?-u:\b)"))
}

fn strip_active_html(html: &str) -> String {
    let mut html = html.to_owned();
    let patterns = [
        r"(?is)<script\b[^>]*>.*?</script>".to_owned(),
        r"(?is)<(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)\b[^>]*>.*?</(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)>".to_owned(),
        r"(?is)<(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)\b[^>]*/?>".to_owned(),
        format!(
            r#"(?i){JS_WS}+on[a-z][a-z0-9_-]*{JS_WS}*={JS_WS}*(?:"[^"]*"|'[^']*'|{JS_NOT_WS_OR_GT}+)"#
        ),
        format!(
            r#"(?i){JS_WS}+(?:href|action|formaction|poster){JS_WS}*={JS_WS}*(?:"[^"]*"|'[^']*'|{JS_NOT_WS_OR_GT}+)"#
        ),
        format!(r"(?i)(?:javascript|vbscript){JS_WS}*:"),
        format!(r"(?i)@import{JS_WS}+[^;]+;?"),
        format!(r"(?i)url{JS_WS}*\([^)]*\)"),
        format!(r"(?i)expression{JS_WS}*\([^)]*\)"),
    ];
    for pattern in &patterns {
        if let Ok(regex) = js_regex(pattern) {
            let replacement = if pattern.starts_with("(?i)url") {
                "none"
            } else {
                ""
            };
            html = regex.replace_all(&html, replacement).into_owned();
        }
    }
    html
}

fn inline_images(html: &str, page_path: &Path, output_root: &Path) -> String {
    let mut html = html.to_owned();
    let mut embedded_bytes = 0u64;
    for (pattern, quote) in [
        (r#"(?i)(<img\b[^>]*\bsrc=")([^"]+)""#, "\""),
        (r#"(?i)(<img\b[^>]*\bsrc=')([^']+)'"#, "'"),
    ] {
        let Ok(regex) = js_regex(pattern) else {
            continue;
        };
        let mut replacements = HashMap::new();
        for caps in regex.captures_iter(&html) {
            let Some(source) = caps.get(2).map(|item| item.as_str()) else {
                continue;
            };
            if replacements.contains_key(source) {
                continue;
            }
            replacements.insert(
                source.to_owned(),
                image_data_url(source, page_path, output_root, &mut embedded_bytes),
            );
        }
        html = regex
            .replace_all(&html, |caps: &regex::Captures| {
                let prefix = caps.get(1).map(|item| item.as_str()).unwrap_or("");
                let source = caps.get(2).map(|item| item.as_str()).unwrap_or("");
                match replacements.get(source).map(String::as_str) {
                    Some("") => {
                        let kept = prefix.trim_end_matches(&format!("src={quote}"));
                        format!("{kept}data-fanotes-missing-image={quote}blocked{quote}")
                    }
                    Some(replacement) => format!("{prefix}{replacement}{quote}"),
                    None => caps
                        .get(0)
                        .map(|item| item.as_str())
                        .unwrap_or("")
                        .to_owned(),
                }
            })
            .into_owned();
    }
    html
}

fn image_data_url(
    source: &str,
    page_path: &Path,
    output_root: &Path,
    embedded_bytes: &mut u64,
) -> String {
    let lower = source.to_ascii_lowercase();
    if lower.starts_with("data:")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("file:")
        || lower.starts_with("javascript:")
    {
        return if source.starts_with("data:") {
            source.to_owned()
        } else {
            String::new()
        };
    }
    let decoded = urlencoding_decode(source);
    let image_path = page_path.parent().unwrap_or(output_root).join(decoded);
    if !image_stays_inside(output_root, &image_path) {
        return String::new();
    }
    let extension = extension_of(&image_path);
    let Some(mime) = image_mime(&extension) else {
        return String::new();
    };
    let Ok(meta) = fs::symlink_metadata(&image_path) else {
        return String::new();
    };
    if meta.file_type().is_symlink()
        || !meta.is_file()
        || meta.len() == 0
        || meta.len() > MAX_IMAGE_BYTES
        || embedded_bytes.saturating_add(meta.len()) > MAX_EMBEDDED_IMAGE_BYTES
    {
        return String::new();
    }
    let Ok(data) = fs::read(&image_path) else {
        return String::new();
    };
    if !image_signature(&extension, &data) {
        return String::new();
    }
    *embedded_bytes = embedded_bytes.saturating_add(data.len() as u64);
    format!("data:{mime};base64,{}", base64_encode(&data))
}

fn image_stays_inside(output_root: &Path, image_path: &Path) -> bool {
    let root = normalize_lexical(output_root);
    let candidate = normalize_lexical(image_path);
    candidate == root || crate::vault::is_inside_root(&root, &candidate)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn extract_search_text(html: &str) -> String {
    let mut text = html.to_owned();
    for pattern in [
        r"(?is)<style\b[^>]*>.*?</style>",
        r"(?is)<svg\b[^>]*>.*?</svg>",
        r"(?is)<head\b[^>]*>.*?</head>",
    ] {
        if let Ok(regex) = js_regex(pattern) {
            text = regex.replace_all(&text, " ").into_owned();
        }
    }
    if let Ok(regex) = Regex::new(&format!(r"(?i)<br{JS_WS}*/?{JS_WS}*>")) {
        text = regex.replace_all(&text, "\n").into_owned();
    }
    if let Ok(regex) = Regex::new(r"(?i)</(?:p|h[1-6]|li|tr|td|div|table)>") {
        text = regex.replace_all(&text, "\n").into_owned();
    }
    if let Ok(regex) = Regex::new(r"(?s)<[^>]+>") {
        text = regex.replace_all(&text, " ").into_owned();
    }
    let text = decode_entities(&text);
    let text = replace_all(&text, r"[ \t]+", " ");
    let text = replace_all(&text, &format!(r"{JS_WS}*\n{JS_WS}*"), "\n");
    let text = replace_all(&text, r"\n{3,}", "\n\n");
    crate::vault::truncate_utf16(crate::vault::js_trim(&text), 2_000_000)
}

fn replace_all(text: &str, pattern: &str, replacement: &str) -> String {
    Regex::new(pattern)
        .map(|regex| regex.replace_all(text, replacement).into_owned())
        .unwrap_or_else(|_| text.to_owned())
}

fn page_dimensions(html: &str) -> (i64, i64) {
    let measured = |name: &str| -> Vec<f64> {
        let pattern =
            format!(r"(?i)(?:^|[;{JS_WS}\x22])(?:max-)?{name}{JS_WS}*:{JS_WS}*(-?[0-9.]+)px");
        Regex::new(&pattern)
            .map(|regex| {
                regex
                    .captures_iter(html)
                    .filter_map(|caps| {
                        caps.get(1)
                            .and_then(|item| item.as_str().parse::<f64>().ok())
                    })
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .collect()
            })
            .unwrap_or_default()
    };
    let max_or =
        |values: Vec<f64>, fallback: f64| values.into_iter().reduce(f64::max).unwrap_or(fallback);
    let blocks = js_regex(r"(?i)<(?:p|li|tr|h[1-6])\b")
        .map(|regex| regex.find_iter(html).count())
        .unwrap_or(0);
    let width = (max_or(measured("left"), 0.0) + max_or(measured("width"), 720.0) + 96.0)
        .clamp(720.0, 3000.0);
    let css_height = max_or(measured("top"), 0.0) + max_or(measured("height"), 160.0) + 140.0;
    let block_height = blocks as f64 * 24.0 + 280.0;
    let height = css_height.min(block_height).clamp(900.0, 30_000.0);
    (width.round() as i64, height.round() as i64)
}

fn preview_is_nav(html: &str) -> bool {
    js_regex(r"(?i)<nav\b").is_ok_and(|regex| regex.is_match(html))
        || js_regex(r"(?i)<iframe\b").is_ok_and(|regex| regex.is_match(html))
}

fn page_parents(html_files: &[PathBuf], output_root: &Path) -> HashMap<PathBuf, Vec<String>> {
    let mut parents = HashMap::new();
    let Ok(anchor) = js_regex(r"(?is)<a\b([^>]*)>(.*?)</a>") else {
        return parents;
    };
    for entry in html_files {
        let Some(html) = crate::notes::read_lossy_string(entry) else {
            continue;
        };
        if !preview_is_nav(&html) && !html.to_ascii_lowercase().contains("<nav") {
            continue;
        }
        if !js_regex(r"(?i)<nav\b").is_ok_and(|regex| regex.is_match(&html)) {
            continue;
        }
        let mut stack = Vec::new();
        for caps in anchor.captures_iter(&html) {
            let attributes = caps.get(1).map(|item| item.as_str()).unwrap_or("");
            let Some(href) = attr(attributes, "href") else {
                continue;
            };
            let level = outline_level(attributes);
            let decoded = urlencoding_decode(&href);
            let target = entry.parent().unwrap_or(output_root).join(&decoded);
            if !image_stays_inside(output_root, &target) {
                continue;
            }
            let title = safe_segment(
                &decode_entities(&attr(attributes, "title").unwrap_or_else(|| {
                    Regex::new(r"<[^>]+>")
                        .map(|regex| {
                            regex
                                .replace_all(
                                    caps.get(2).map(|item| item.as_str()).unwrap_or(""),
                                    " ",
                                )
                                .into_owned()
                        })
                        .unwrap_or_default()
                })),
                "OneNote-Seite",
            );
            if level == 0 {
                continue;
            }
            if stack.len() < level {
                stack.resize(level, String::new());
            }
            stack[level - 1] = title;
            stack.truncate(level);
            let prefix = stack[..level.saturating_sub(1)].to_vec();
            parents.insert(target, prefix);
        }
    }
    parents
}

/// Desktop pattern: the last `\bl[1-9]\b` inside the first matching `class`.
///
/// Word boundaries are ASCII, so a hyphen or a byte-order mark still counts.
/// The `regex` crate has no backreference, so the quote pair is matched here.
fn outline_level(attributes: &str) -> usize {
    let bytes = attributes.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if class_attribute_at(bytes, index) {
            let quote_at = index + 6;
            if quote_at < bytes.len() && matches!(bytes[quote_at], b'"' | b'\'') {
                let quote = bytes[quote_at];
                let start = quote_at + 1;
                if let Some(end) = bytes[start..].iter().position(|byte| *byte == quote) {
                    let interior = &attributes[start..start + end];
                    let other = if quote == b'"' { '\'' } else { '"' };
                    if !interior.contains(other) {
                        if let Some(level) = last_outline_digit(interior) {
                            return level;
                        }
                    }
                }
            }
        }
        index += 1;
    }
    1
}

fn class_attribute_at(bytes: &[u8], index: usize) -> bool {
    let boundary = index == 0 || !is_ascii_word(bytes[index - 1]);
    boundary && index + 6 <= bytes.len() && bytes[index..index + 6].eq_ignore_ascii_case(b"class=")
}

fn last_outline_digit(interior: &str) -> Option<usize> {
    let bytes = interior.as_bytes();
    let mut found = None;
    for index in 0..bytes.len() {
        let boundary = index == 0 || !is_ascii_word(bytes[index - 1]);
        if !boundary || index + 2 > bytes.len() || !bytes[index].eq_ignore_ascii_case(&b'l') {
            continue;
        }
        let digit = bytes[index + 1];
        let after = index + 2;
        if (b'1'..=b'9').contains(&digit) && (after == bytes.len() || !is_ascii_word(bytes[after]))
        {
            found = Some((digit - b'0') as usize);
        }
    }
    found
}

fn is_ascii_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn attr(attributes: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=").to_ascii_lowercase();
    let lower = attributes.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut search_from = 0;
    let index = loop {
        let found = lower[search_from..].find(&needle)? + search_from;
        let boundary = found == 0 || !is_ascii_word(bytes[found - 1]);
        if boundary {
            break found;
        }
        search_from = found + 1;
    };
    let rest = &attributes[index + needle.len()..];
    let mut chars = rest.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value = rest[quote.len_utf8()..].split(quote).next()?;
    if value.is_empty() {
        return None;
    }
    Some(value.to_owned())
}

fn prepare_input(input: &Path, temporary: &Path, seven_zip: &Path) -> Result<Vec<PathBuf>, String> {
    let extension = extension_of(input);
    if extension == ".one" || extension == ".onetoc2" {
        return Ok(vec![input.to_path_buf()]);
    }
    if extension != ".zip" && extension != ".onepkg" {
        return Err("Unterstützt werden .one, .onetoc2, OneDrive-ZIP und .onepkg.".to_owned());
    }
    let extracted = temporary.join("extracted");
    create_private_dir(&extracted)
        .map_err(|_| "Das OneNote-Archiv konnte nicht entpackt werden.".to_owned())?;
    let listing = run_tool(
        seven_zip,
        &["l", "-slt", "--", &input.to_string_lossy()],
        tool_limit("Archivprüfung"),
        "Archivprüfung",
    )?;
    validate_listing(&listing)?;
    run_tool(
        seven_zip,
        &[
            "x",
            "-y",
            "-bd",
            "-bb0",
            &format!("-o{}", extracted.display()),
            "--",
            &input.to_string_lossy(),
        ],
        tool_limit("Archivextraktion"),
        "Archivextraktion",
    )?;
    let files = walk_files(&extracted, MAX_EXPANDED_BYTES)?;
    let mut toc: Vec<PathBuf> = files
        .iter()
        .filter(|path| extension_of(path) == ".onetoc2")
        .cloned()
        .collect();
    toc.sort_by_key(|path| path.components().count());
    if let Some(first) = toc.into_iter().next() {
        return Ok(vec![first]);
    }
    let sections: Vec<PathBuf> = files
        .into_iter()
        .filter(|path| extension_of(path) == ".one")
        .collect();
    if sections.is_empty() {
        Err("Im Archiv wurde kein OneNote-Notizbuch gefunden.".to_owned())
    } else {
        Ok(sections)
    }
}

fn validate_listing(stdout: &str) -> Result<(), String> {
    let mut count = 0usize;
    let mut bytes = 0.0f64;
    let stdout = stdout.replace("\r\n", "\n");
    for record in stdout.split("\n\n") {
        let mut fields = HashMap::new();
        for line in record.lines() {
            if let Some((key, value)) = line.split_once(" = ") {
                fields.insert(key.to_owned(), value.to_owned());
            }
        }
        // An empty path is ignored. `Type` skips a record only when it has text,
        // so `Type =` still counts the file.
        let Some(entry_path) = fields.get("Path").filter(|path| !path.is_empty()) else {
            continue;
        };
        if fields.get("Type").is_some_and(|kind| !kind.is_empty()) {
            continue;
        }
        let normalized = entry_path.replace('\\', "/");
        if unsafe_archive_path(&normalized) {
            return Err("Das OneNote-Archiv enthält einen unsicheren Pfad.".to_owned());
        }
        if fields.get("Folder").map(String::as_str) != Some("+") {
            let size = fields.get("Size").map(String::as_str).unwrap_or("0");
            bytes += crate::vault::js_tonumber(size).unwrap_or(f64::NAN);
        }
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES
            || !safe_archive_bytes(bytes)
            || bytes > MAX_EXPANDED_BYTES as f64
        {
            return Err("Das OneNote-Archiv überschreitet die sicheren Importgrenzen.".to_owned());
        }
    }
    if count == 0 {
        Err("Das OneNote-Archiv enthält keine importierbaren Dateien.".to_owned())
    } else {
        Ok(())
    }
}

/// `Number(size)` then `Number.isSafeInteger` on the running total.
fn safe_archive_bytes(bytes: f64) -> bool {
    bytes.is_finite() && bytes.fract() == 0.0 && bytes.abs() <= 9_007_199_254_740_991.0
}

fn render_inputs(
    inputs: &[PathBuf],
    output_root: &Path,
    one2html: &Path,
) -> Result<Vec<String>, String> {
    if inputs.len() == 1 && extension_of(&inputs[0]) == ".onetoc2" {
        if let Err(error) = run_tool(
            one2html,
            &[
                "--input",
                &inputs[0].to_string_lossy(),
                "--output",
                &output_root.to_string_lossy(),
            ],
            tool_limit("OneNote-Konvertierung"),
            "OneNote-Konvertierung",
        ) {
            let notebook = inputs[0].parent().unwrap_or(Path::new("."));
            let sections: Vec<PathBuf> = walk_files(notebook, MAX_EXPANDED_BYTES)?
                .into_iter()
                .filter(|path| extension_of(path) == ".one")
                .collect();
            if sections.is_empty() {
                return Err(error);
            }
            let _ = fs::remove_dir_all(output_root);
            create_private_dir(output_root)
                .map_err(|_| "Der OneNote-Import konnte nicht vorbereitet werden.".to_owned())?;
            render_sections(&sections, notebook, output_root, one2html)?;
            return Ok(vec!["Verschachtelte OneNote-Abschnittsgruppen wurden abschnittsweise mit ihrer Ordnerhierarchie übernommen.".to_owned()]);
        }
        return Ok(Vec::new());
    }
    let sections: Vec<PathBuf> = inputs
        .iter()
        .filter(|path| extension_of(path) == ".one")
        .cloned()
        .collect();
    if sections.is_empty() {
        return Err(
            "Es wurden keine OneNote-Abschnitte für die Konvertierung gefunden.".to_owned(),
        );
    }
    let ancestor = common_ancestor(&sections);
    render_sections(&sections, &ancestor, output_root, one2html)?;
    Ok(Vec::new())
}

fn render_sections(
    sections: &[PathBuf],
    source_root: &Path,
    output_root: &Path,
    one2html: &Path,
) -> Result<(), String> {
    for section in sections {
        let relative = section
            .parent()
            .and_then(|parent| parent.strip_prefix(source_root).ok())
            .unwrap_or(Path::new(""));
        let mut destination = output_root.to_path_buf();
        for segment in relative.components() {
            let Some(name) = segment.as_os_str().to_str() else {
                continue;
            };
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            destination.push(import_folder_segment(name));
        }
        create_private_dir(&destination)
            .map_err(|_| "Der OneNote-Import konnte nicht vorbereitet werden.".to_owned())?;
        let section_name = section
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Abschnitt");
        let label = format!("OneNote-Abschnitt {section_name}");
        run_tool(
            one2html,
            &[
                "--input",
                &section.to_string_lossy(),
                "--output",
                &destination.to_string_lossy(),
            ],
            tool_limit(&label),
            &label,
        )?;
    }
    Ok(())
}

fn stored_relative_path(path: &Path, root: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let segments = relative
        .components()
        .map(|component| safe_segment(&component.as_os_str().to_string_lossy(), "Unbenannt"))
        .collect::<Vec<_>>();
    if segments.is_empty() {
        "Unbenannt".to_owned()
    } else {
        segments.join("/")
    }
}

fn copy_attachments(
    files: &[PathBuf],
    output_root: &Path,
    attachment_dir: &Path,
) -> Result<Vec<Value>, String> {
    let mut attachments = Vec::new();
    for path in files {
        if extension_of(path) == ".html" {
            continue;
        }
        let digest = sha256_file(path)?;
        let relative = stored_relative_path(path, output_root);
        let stored = format!(
            "{}-{}.fanotes-attachment",
            &digest[..16],
            safe_segment(
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Anlage"),
                "Anlage"
            )
        );
        let target = attachment_dir.join(&stored);
        let already_stored = fs::symlink_metadata(&target)
            .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink());
        if !already_stored {
            crate::notes::atomic_copy(path, &target, 0o600)
                .map_err(|_| "Eine OneNote-Anlage konnte nicht verwahrt werden.".to_owned())?;
        }
        let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        attachments.push(json!({
            "originalPath": relative,
            "storedName": stored,
            "size": size,
            "sha256": digest,
        }));
    }
    Ok(attachments)
}

fn preserve_sources(input: &Path, batch: &Path) -> Result<Vec<Value>, String> {
    let extension = extension_of(input);
    let mut sources = vec![input.to_path_buf()];
    let source_root = input.parent().unwrap_or(Path::new("."));
    if extension == ".onetoc2" {
        sources = walk_files(source_root, MAX_EXPANDED_BYTES)?
            .into_iter()
            .filter(|path| matches!(extension_of(path).as_str(), ".one" | ".onetoc2"))
            .collect();
    }
    let directory = batch.join("original");
    create_private_dir(&directory)
        .map_err(|_| "Die OneNote-Quelle konnte nicht verwahrt werden.".to_owned())?;
    let mut preserved = Vec::new();
    for source in sources {
        let digest = sha256_file(&source)?;
        let relative = stored_relative_path(&source, source_root);
        let stored = format!(
            "{}-{}.fanotes-onenote-source",
            &digest[..16],
            safe_segment(
                source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("OneNote"),
                "OneNote"
            )
        );
        crate::notes::atomic_copy(&source, &directory.join(&stored), 0o600)
            .map_err(|_| "Die OneNote-Quelle konnte nicht verwahrt werden.".to_owned())?;
        let size = fs::metadata(&source).map(|meta| meta.len()).unwrap_or(0);
        preserved.push(json!({
            "originalPath": relative,
            "storedName": stored,
            "size": size,
            "sha256": digest,
        }));
    }
    Ok(preserved)
}

fn materialize_tools(app_data: &Path) -> Result<(PathBuf, PathBuf), String> {
    let embedded = embedded_root()?;
    let cache = app_data
        .join("tool-cache")
        .join("onenote")
        .join("v1-linux-x64");
    create_private_dir(&cache)
        .map_err(|_| "Der lokale OneNote-Werkzeugcache ist unsicher.".to_owned())?;
    let one2html = install_tool(
        &embedded.join("linux").join("one2html"),
        &cache.join("one2html"),
        ONE2HTML_SHA,
    )?;
    let seven_zip = install_tool(
        &embedded.join("linux").join("7za"),
        &cache.join("7za"),
        SEVENZIP_SHA,
    )?;
    Ok((one2html, seven_zip))
}

fn install_tool(source: &Path, target: &Path, expected: &str) -> Result<PathBuf, String> {
    let data = fs::read(source).map_err(|_| {
        format!(
            "Die eingebettete OneNote-Komponente {} ist beschädigt.",
            source.display()
        )
    })?;
    if sha256_bytes(&data) != expected {
        return Err(format!(
            "Die eingebettete OneNote-Komponente {} ist beschädigt.",
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("tool")
        ));
    }
    let reuse = fs::read(target)
        .ok()
        .is_some_and(|existing| sha256_bytes(&existing) == expected);
    if !reuse {
        let _ = fs::remove_file(target);
        fs::write(target, &data)
            .map_err(|_| "Der lokale OneNote-Werkzeugcache ist unsicher.".to_owned())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(target, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Der lokale OneNote-Werkzeugcache ist unsicher.".to_owned())?;
    }
    Ok(target.to_path_buf())
}

fn embedded_root() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("FANOTES_ONENOTE_DIR") {
        return Ok(PathBuf::from(path));
    }
    let compiled =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fanotes/resources/onenote");
    if compiled.join("linux/one2html").is_file() {
        return Ok(compiled);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let beside = parent.join("resources/onenote");
            if beside.join("linux/one2html").is_file() {
                return Ok(beside);
            }
        }
    }
    Err("Der OneNote-Import wird auf dieser Plattform noch nicht unterstützt.".to_owned())
}

fn tool_limit(label: &str) -> Duration {
    if label == "Archivprüfung" {
        ARCHIVE_LISTING_TIMEOUT
    } else {
        TOOL_TIMEOUT
    }
}

fn run_tool(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    label: &str,
) -> Result<String, String> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{label} ist fehlgeschlagen: {error}"))?;
    let mut stdout_pipe = child.stdout.take().unwrap();
    let mut stderr_pipe = child.stderr.take().unwrap();
    let stdout_handle = thread::spawn(move || read_output_tail(&mut stdout_pipe));
    let stderr_handle = thread::spawn(move || read_output_tail(&mut stderr_pipe));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("{label} ist fehlgeschlagen: {error}"))?
        {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Der OneNote-Import hat das sichere Zeitlimit überschritten.".to_owned());
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        Err(tool_failure_message(
            label,
            &stdout,
            &stderr,
            status.code(),
            exit_signal(&status).as_deref(),
        ))
    }
}

fn read_output_tail(reader: &mut impl Read) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let cap = 256 * 1024 * 4;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                if buffer.len() > cap {
                    buffer.drain(..buffer.len() - cap);
                }
            }
        }
    }
    keep_tail(&String::from_utf8_lossy(&buffer), 256 * 1024)
}

fn keep_tail(value: &str, max_units: usize) -> String {
    let total = crate::vault::utf16_len(value);
    if total <= max_units {
        return value.to_owned();
    }
    let skip = total - max_units;
    let mut units = 0usize;
    for (index, character) in value.char_indices() {
        if units >= skip {
            return value[index..].to_owned();
        }
        units += character.len_utf16();
    }
    String::new()
}

fn tool_failure_message(
    label: &str,
    stdout: &str,
    stderr: &str,
    code: Option<i32>,
    signal: Option<&str>,
) -> String {
    let fallback = match code {
        Some(code) => format!("Code {code}"),
        None => "Code null".to_owned(),
    };
    let chosen = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback.as_str()
    };
    let signal = signal
        .map(|signal| format!(" ({signal})"))
        .unwrap_or_default();
    format!(
        "{label} ist fehlgeschlagen{signal}: {}",
        keep_tail(crate::vault::js_trim(chosen), 1800)
    )
}

fn exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        return status.signal().map(signal_name);
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        other => return format!("SIG{other}"),
    }
    .to_owned()
}

fn unsafe_archive_path(normalized: &str) -> bool {
    let mut chars = normalized.chars();
    // `/^[a-z]:\//iu` also matches the long s and the Kelvin sign.
    let drive = chars.next().is_some_and(js_ascii_letter)
        && chars.next() == Some(':')
        && chars.next() == Some('/');
    normalized.starts_with('/')
        || drive
        || normalized
            .split('/')
            .any(|segment| segment.is_empty() || segment == "..")
}

/// A character `[a-z]` matches under the JavaScript `iu` flags.
fn js_ascii_letter(character: char) -> bool {
    character.is_ascii_alphabetic() || matches!(character, '\u{017F}' | '\u{212A}')
}

fn walk_files(root: &Path, max_bytes: u64) -> Result<Vec<PathBuf>, String> {
    walk_limited(root, max_bytes, MAX_ARCHIVE_ENTRIES)
}

fn walk_limited(root: &Path, max_bytes: u64, max_entries: usize) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut total_bytes = 0u64;
    while let Some(directory) = pending.pop() {
        let mut listed = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|_| {
            "Der OneNote-Export enthält einen nicht unterstützten Dateityp.".to_owned()
        })? {
            listed.push(entry.map_err(|_| {
                "Der OneNote-Export enthält einen nicht unterstützten Dateityp.".to_owned()
            })?);
        }
        if files.len() + listed.len() > max_entries {
            return Err("Der OneNote-Export enthält zu viele Dateien.".to_owned());
        }
        for entry in listed {
            let target = entry.path();
            if !image_stays_inside(root, &target) {
                return Err("Ein OneNote-Pfad verlässt das Importverzeichnis.".to_owned());
            }
            let meta = fs::symlink_metadata(&target).map_err(|_| {
                "Der OneNote-Export enthält einen nicht unterstützten Dateityp.".to_owned()
            })?;
            if meta.file_type().is_symlink() {
                return Err(
                    "Symbolische Verknüpfungen sind in einem OneNote-Import nicht erlaubt."
                        .to_owned(),
                );
            }
            if meta.is_dir() {
                pending.push(target);
            } else if meta.is_file() {
                total_bytes = total_bytes.saturating_add(meta.len());
                if total_bytes > max_bytes {
                    return Err("Der entpackte OneNote-Export ist zu groß.".to_owned());
                }
                files.push(target);
            } else {
                return Err(
                    "Der OneNote-Export enthält einen nicht unterstützten Dateityp.".to_owned(),
                );
            }
        }
    }
    Ok(files)
}

fn write_unique_markdown(directory: &Path, title: &str, markdown: &str) -> Result<PathBuf, String> {
    let stem = safe_segment(title, "OneNote-Seite");
    for index in 0..10_000 {
        let name = if index == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem} {}.md", index + 1)
        };
        let target = directory.join(name);
        match crate::notes::publish_new_file(&target, markdown.as_bytes(), 0o600) {
            Ok(()) => return Ok(target),
            Err(crate::notes::NewFileError::Exists) => continue,
            Err(crate::notes::NewFileError::Io) => {
                return Err("Die OneNote-Seite konnte nicht geschrieben werden.".to_owned());
            }
        }
    }
    Err("Für die OneNote-Seite konnte kein freier Dateiname erzeugt werden.".to_owned())
}

fn create_private_dir(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            create_private_dir(parent)?;
        }
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "unsafe directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(path)?,
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn unique_directory(parent: &Path, preferred: &str) -> Result<PathBuf, String> {
    for index in 0..10_000 {
        let name = if index == 0 {
            preferred.to_owned()
        } else {
            format!("{preferred} {}", index + 1)
        };
        let target = parent.join(name);
        if fs::create_dir(&target).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).is_err() {
                    let _ = fs::remove_dir(&target);
                    return Err(
                        "Für den OneNote-Import konnte kein freier Zielordner angelegt werden."
                            .to_owned(),
                    );
                }
            }
            return Ok(target);
        }
    }
    Err("Für den OneNote-Import konnte kein freier Zielordner angelegt werden.".to_owned())
}

fn common_ancestor(paths: &[PathBuf]) -> PathBuf {
    let Some(first) = paths.first() else {
        return PathBuf::from("/");
    };
    let mut ancestor = first.parent().unwrap_or(first.as_path()).to_path_buf();
    while !paths.iter().all(|candidate| {
        candidate == &ancestor || crate::vault::is_inside_root(&ancestor, candidate)
    }) {
        let Some(parent) = ancestor.parent().map(Path::to_path_buf) else {
            break;
        };
        if parent == ancestor {
            break;
        }
        ancestor = parent;
    }
    ancestor
}

/// Export folders and outline parents use the desktop default, `Unbenannt`.
/// Page titles and markdown file names keep the `OneNote-Seite` fallback.
fn import_folder_segment(segment: &str) -> String {
    safe_segment(segment, "Unbenannt")
}

fn note_directory_segments(hierarchy: Vec<String>, parents: Vec<String>) -> Vec<String> {
    hierarchy
        .into_iter()
        .chain(parents)
        .map(|segment| import_folder_segment(&segment))
        .collect()
}

fn safe_segment(value: &str, fallback: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let value: String = value.nfc().collect();
    let cleaned: String = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || crate::vault::is_c0_or_del(character)
            {
                ' '
            } else {
                character
            }
        })
        .collect();
    let collapsed = collapse_js_spaces(&cleaned);
    let trimmed = crate::vault::js_trim(collapsed.trim_end_matches(['.', ' ']));
    let trimmed = crate::vault::truncate_utf16(trimmed, 120);
    let device = crate::vault::js_trim(trimmed.split('.').next().unwrap_or(""));
    let reserved = matches!(
        device.to_ascii_lowercase().as_str(),
        "con" | "prn" | "aux" | "nul"
    ) || (device.len() == 4
        && (device.to_ascii_lowercase().starts_with("com")
            || device.to_ascii_lowercase().starts_with("lpt"))
        && device.as_bytes()[3].is_ascii_digit());
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || reserved {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn collapse_js_spaces(value: &str) -> String {
    let mut collapsed = String::new();
    let mut pending = false;
    for character in value.chars() {
        if fanotes_famd::is_js_whitespace(character) {
            pending = true;
            continue;
        }
        if pending {
            collapsed.push(' ');
            pending = false;
        }
        collapsed.push(character);
    }
    if pending {
        collapsed.push(' ');
    }
    collapsed
}

fn markdown_title(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if "\\`*_{}[]()#+.!|-".contains(character) {
                vec!['\\', character]
            } else {
                vec![character]
            }
        })
        .collect()
}

fn decode_entities(value: &str) -> String {
    // The desktop replaces hex, then decimal, then the six named entities.
    // A later pass sees text produced by an earlier one, so `&#38;amp;` becomes `&`.
    let value = replace_entities(value, EntityPass::Hex);
    let value = replace_entities(&value, EntityPass::Decimal);
    replace_entities(&value, EntityPass::Named)
}

enum EntityPass {
    Hex,
    Decimal,
    Named,
}

fn replace_entities(value: &str, pass: EntityPass) -> String {
    let mut output = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find(';') else {
            output.push_str(&rest[start..]);
            return output;
        };
        if let Some(decoded) = decode_one_entity(&after[..end], &pass) {
            output.push_str(&decoded);
            rest = &after[end + 1..];
        } else {
            output.push('&');
            rest = after;
        }
    }
    output.push_str(rest);
    output
}

fn decode_one_entity(entity: &str, pass: &EntityPass) -> Option<String> {
    match pass {
        EntityPass::Hex => {
            let hex = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))?;
            if hex.is_empty() || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            Some(code_point(u32::from_str_radix(hex, 16).ok()))
        }
        EntityPass::Decimal => {
            let decimal = entity.strip_prefix('#')?;
            if decimal.is_empty() || !decimal.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            Some(code_point(decimal.parse().ok()))
        }
        EntityPass::Named => match entity.to_ascii_lowercase().as_str() {
            "nbsp" => Some(" ".to_owned()),
            "amp" => Some("&".to_owned()),
            "lt" => Some("<".to_owned()),
            "gt" => Some(">".to_owned()),
            "quot" => Some("\"".to_owned()),
            "apos" => Some("'".to_owned()),
            _ => None,
        },
    }
}

fn code_point(point: Option<u32>) -> String {
    match point {
        Some(point) if point <= 0x10ffff && !(0xD800..=0xDFFF).contains(&point) => {
            char::from_u32(point)
                .map(|character| character.to_string())
                .unwrap_or_else(|| "\u{FFFD}".to_owned())
        }
        _ => "\u{FFFD}".to_owned(),
    }
}

/// `decodeURIComponent`. One bad escape keeps the original string.
fn urlencoding_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return value.to_owned();
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            let Ok(byte) = u8::from_str_radix(hex, 16) else {
                return value.to_owned();
            };
            output.push(byte);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| value.to_owned())
}

fn image_mime(extension: &str) -> Option<&'static str> {
    match extension {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        _ => None,
    }
}

fn image_signature(extension: &str, data: &[u8]) -> bool {
    match extension {
        ".png" => data.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ".jpg" | ".jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        ".gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        ".webp" => data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP",
        _ => false,
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|_| "Die OneNote-Datei konnte nicht gelesen werden.".to_owned())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Die OneNote-Datei konnte nicht gelesen werden.".to_owned())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
}

fn uuid() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn now_iso() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = elapsed.as_secs();
    let millis = elapsed.subsec_millis();
    let days = secs / 86_400;
    let time = secs % 86_400;
    let (year, month, day) = civil_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

fn civil_date(mut days: u64) -> (i32, u32, u32) {
    let mut year = 1970i32;
    loop {
        let year_days = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
            366
        } else {
            365
        };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for length in months {
        if days < length {
            return (year, month, days as u32 + 1);
        }
        days -= length;
        month += 1;
    }
    (year, 12, 31)
}

#[cfg(test)]
mod tests {
    use super::{
        common_ancestor, extract_search_text, import_folder_segment, inline_images,
        note_directory_segments, outline_level, page_dimensions, page_parents, page_title,
        preview_is_nav, render_inputs, safe_segment, sanitize_page, stored_relative_path,
        strip_active_html, tool_failure_message, tool_limit, urlencoding_decode, validate_listing,
        walk_limited,
    };
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn onenote_tools_keep_the_desktop_time_limit() {
        assert_eq!(tool_limit("Archivprüfung").as_secs(), 90);
        assert_eq!(tool_limit("Archivextraktion").as_secs(), 12 * 60);
        assert_eq!(tool_limit("OneNote-Konvertierung").as_secs(), 12 * 60);
        assert_eq!(
            tool_limit("OneNote-Abschnitt Gruppe.one").as_secs(),
            12 * 60
        );
    }

    #[test]
    fn an_encoded_page_title_drops_tags_after_decoding() {
        assert_eq!(
            page_title(
                "<title>&lt;b&gt;Hello&lt;/b&gt;</title>",
                Path::new("Seite.html")
            ),
            "Hello"
        );
        assert_eq!(
            page_title(
                "<title>&lt;img src=x&gt;Foto</title>",
                Path::new("Seite.html")
            ),
            "Foto"
        );
        assert_eq!(
            page_title(
                "<title>  <span>Foto</span>  </title>",
                Path::new("Seite.html")
            ),
            "Foto"
        );
        assert_eq!(
            page_title("<title>A &amp; B</title>", Path::new("Seite.html")),
            "A & B"
        );
        assert_eq!(
            page_title("<p>ohne titel</p>", Path::new("/ordner/Page.HTML")),
            "Page.HTML"
        );
        assert_eq!(
            page_title("<p>ohne titel</p>", Path::new("/ordner/Seite.html")),
            "Seite"
        );
        assert_eq!(
            page_title("<p>ohne titel</p>", Path::new("/ordner/.html")),
            ".html"
        );
    }

    #[test]
    fn a_page_with_an_invalid_byte_still_keeps_its_title() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "fanotes-onenote-lossy-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let page = directory.join("Seite.html");
        let mut bytes = b"<title>Gr\xc3\xbc\xc3\x9fe</title><p>Text</p>".to_vec();
        bytes.insert(bytes.len() - 4, 0xff);
        std::fs::write(&page, &bytes).unwrap();
        let parsed = sanitize_page(&page, &directory).unwrap();
        assert_eq!(parsed.title, "Grüße");
        assert!(parsed.transcript.contains('\u{FFFD}'));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_import_folder_uses_the_unnamed_fallback() {
        assert_eq!(import_folder_segment(""), "Unbenannt");
        assert_eq!(import_folder_segment("CON"), "Unbenannt");
        assert_eq!(import_folder_segment(".."), "Unbenannt");
        assert_eq!(import_folder_segment("Kapitel"), "Kapitel");
        assert_eq!(import_folder_segment("OneNote-Seite"), "OneNote-Seite");
        assert_eq!(
            note_directory_segments(
                vec!["CON".to_owned(), "Kapitel".to_owned()],
                vec![String::new(), "Echt".to_owned()],
            ),
            vec![
                "Unbenannt".to_owned(),
                "Kapitel".to_owned(),
                "Unbenannt".to_owned(),
                "Echt".to_owned(),
            ]
        );
    }

    #[test]
    fn a_reserved_import_folder_uses_the_desktop_path_fallback() {
        assert_eq!(
            stored_relative_path(Path::new("/notes/CON/photo.png"), Path::new("/notes")),
            "Unbenannt/photo.png"
        );
        assert_eq!(
            stored_relative_path(Path::new("/notes/Section.one"), Path::new("/notes")),
            "Section.one"
        );
        assert_eq!(
            stored_relative_path(
                Path::new("/notes/Section.one"),
                Path::new("/notes/Section.one")
            ),
            "Unbenannt"
        );
    }

    #[test]
    fn a_page_title_stops_at_120_utf16_units() {
        let umlauts = "Ä".repeat(121);
        assert_eq!(
            safe_segment(&umlauts, "fallback").encode_utf16().count(),
            120
        );
        let emoji = "😀".repeat(80);
        let trimmed = safe_segment(&emoji, "fallback");
        assert_eq!(trimmed.encode_utf16().count(), 120);
        assert_eq!(trimmed.chars().count(), 60);
        let kept = format!("Seite{}", '\u{0080}');
        assert_eq!(safe_segment(&kept, "fallback"), kept);
        assert_eq!(
            safe_segment(&format!("Seite{}", '\u{007f}'), "fallback"),
            "Seite"
        );
        assert_eq!(safe_segment("A\u{FEFF}B", "fallback"), "A B");
        assert_eq!(safe_segment("\u{FEFF}Seite", "fallback"), "Seite");
        assert_eq!(safe_segment("A\u{0085}B", "fallback"), "A\u{0085}B");
    }

    #[test]
    fn onenote_search_text_collapses_blank_lines() {
        assert_eq!(extract_search_text("a\n\n\nb"), "a\nb");
        assert_eq!(extract_search_text("a\n\n\n\nb"), "a\nb");
        assert_eq!(extract_search_text("a\n \n \nb"), "a\nb");
        assert_eq!(extract_search_text("a\u{FEFF}\nb"), "a\nb");
        assert_eq!(extract_search_text("a\u{0085}\nb"), "a\u{0085}\nb");
        assert_eq!(extract_search_text("<br\u{FEFF}/>Hi"), "Hi");
        assert_eq!(extract_search_text("&#65;"), "A");
        assert_eq!(extract_search_text("&#x26;amp;"), "&");
        assert_eq!(extract_search_text("&#38;amp;"), "&");
        assert_eq!(extract_search_text("A&nbsp;B"), "A B");
        assert_eq!(extract_search_text("&#x;"), "&#x;");
        assert_eq!(extract_search_text("&#xZZ;"), "&#xZZ;");
        assert_eq!(urlencoding_decode("a%20b"), "a b");
        assert_eq!(urlencoding_decode("caf%C3%A9"), "café");
        assert_eq!(urlencoding_decode("%E2%9C%93"), "✓");
        assert_eq!(urlencoding_decode("a%20b%"), "a%20b%");
        assert_eq!(urlencoding_decode("a%2Gb"), "a%2Gb");
        assert_eq!(urlencoding_decode("%E2%9C"), "%E2%9C");
        assert_eq!(urlencoding_decode("%"), "%");
        assert_eq!(extract_search_text("&unknown;"), "&unknown;");
        assert_eq!(
            extract_search_text("<p>Eins</p>\n<p>Zwei</p>"),
            "Eins\nZwei"
        );
        let long = "😀".repeat(1_000_001);
        assert_eq!(extract_search_text(&long).encode_utf16().count(), 2_000_000);
    }

    #[test]
    fn an_onenote_tag_boundary_is_ascii() {
        assert!(preview_is_nav("<navä>"));
        assert!(preview_is_nav("<IFRAMEÄ>"));
        assert!(preview_is_nav("<nav>"));
        assert!(!preview_is_nav("<navigation>"));
        assert!(!preview_is_nav("<iframeextra>"));
        assert!(!strip_active_html("<scriptä>alert(1)</script>").contains("alert"));
        assert!(strip_active_html("<scripted>alert(1)</scripted>").contains("alert"));
        assert_eq!(
            extract_search_text("<styleä>SECRET</style> visible"),
            "visible"
        );
        assert_eq!(
            extract_search_text("<styled>SECRET</styled> visible"),
            "SECRET visible"
        );
    }

    #[test]
    fn an_event_handler_after_a_byte_order_mark_is_removed() {
        let stripped = strip_active_html("<div\u{FEFF}onclick=\"alert(1)\">x</div>");
        assert!(!stripped.to_ascii_lowercase().contains("onclick"));
        assert!(stripped.contains(">x</div>"));
        let kept = strip_active_html("<div\u{0085}onclick=\"alert(1)\">x</div>");
        assert!(kept.contains("onclick"));
        let styled = strip_active_html("a{background:url(javascript:alert(1))}");
        assert!(!styled.contains("javascript:"));
        assert!(!styled.contains("url("));
        assert!(styled.contains("none"));
    }

    #[test]
    fn onenote_page_size_uses_the_smaller_estimate() {
        assert_eq!(page_dimensions(""), (816, 900));
        assert_eq!(page_dimensions("left:400px;width:100px;<p>"), (720, 900));
        assert_eq!(
            page_dimensions(&format!(
                "left:0px;width:2000px;top:100px;height:4000px;{}",
                "<p>".repeat(10)
            )),
            (2096, 900)
        );
        assert_eq!(page_dimensions(&"<p>".repeat(100)), (816, 900));
        assert_eq!(page_dimensions("height:40px;top:10px;<p><p>"), (816, 900));
    }

    #[test]
    fn onenote_images_keep_their_attributes_and_stay_inside_the_import() {
        let root = std::env::temp_dir().join(format!(
            "fanotes-onenote-img-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let output = root.join("out");
        let pages = output.join("pages");
        std::fs::create_dir_all(output.join("images")).unwrap();
        std::fs::create_dir_all(&pages).unwrap();
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
        std::fs::write(output.join("images/ok.png"), png).unwrap();
        std::fs::write(root.join("secret.png"), png).unwrap();
        let page = pages.join("note.html");
        let html = r#"<img class="pic" src="../images/ok.png" alt="Bild"><img class="pic" src="missing.png" alt="Leer"><img src="../../secret.png" alt="Geheim"><img src="HTTP://example.com/a.png" alt="Netz">"#;
        let result = inline_images(html, &page, &output);
        assert!(result.contains(r#"class="pic" src="data:image/png;base64,"#));
        assert!(result.contains(r#"alt="Bild""#));
        assert!(result.contains(r#"class="pic" data-fanotes-missing-image="blocked" alt="Leer""#));
        assert!(result.contains(r#"data-fanotes-missing-image="blocked" alt="Geheim""#));
        assert!(result.contains(r#"data-fanotes-missing-image="blocked" alt="Netz""#));
        assert!(!result.contains("secret"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn onenote_outline_levels_stay_between_one_and_nine() {
        let root = std::env::temp_dir().join(format!(
            "fanotes-onenote-nav-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let section = root.join("section");
        std::fs::create_dir_all(&section).unwrap();
        let nav = section.join("nav.html");
        std::fs::write(
            &nav,
            r#"<nav>
<a class="l1" href="a.html" title="Kapitel">Kapitel</a>
<a class="l9 l2" href="c.html" title="Zweig">Zweig</a>
<a class="foo-l2" href="d.html" title="Bindestrich">Bindestrich</a>
<a class="l10" href="b.html" title="Zehn">Zehn</a>
<a class="l1" href="../../secret.html" title="Draussen">Draussen</a>
<a class="l1" myhref="nope.html" href="real.html" title="Echt">Echt</a>
<a class="l2" href="" title="Leer">Leer</a>
<a class="l2" href="inner.html" title="">Inner text</a>
<a class="l3" href="leaf.html">Leaf</a>
</nav>"#,
        )
        .unwrap();
        let parents = page_parents(&[nav], &root);
        let parent_of = |name: &str| {
            parents
                .iter()
                .find(|(path, _)| path.ends_with(name))
                .map(|(_, prefix)| prefix.clone())
        };
        assert_eq!(parent_of("a.html"), Some(Vec::<String>::new()));
        assert_eq!(parent_of("c.html"), Some(vec!["Kapitel".to_owned()]));
        assert_eq!(parent_of("d.html"), Some(vec!["Kapitel".to_owned()]));
        assert_eq!(parent_of("b.html"), Some(Vec::<String>::new()));
        assert!(parent_of("secret.html").is_none());
        assert!(parent_of("nope.html").is_none());
        assert_eq!(parent_of("real.html"), Some(Vec::<String>::new()));
        assert_eq!(
            parent_of("leaf.html"),
            Some(vec!["Echt".to_owned(), "Inner text".to_owned()])
        );
        assert_eq!(outline_level(r#" class="l2 l9""#), 9);
        assert_eq!(outline_level(" class=\"l2\u{FEFF}\""), 2);
        assert_eq!(outline_level(" class=\"l2\u{0085}\""), 2);
        assert_eq!(outline_level(" class=\"outline\u{FEFF}l3\""), 3);
        assert_eq!(outline_level(r#" class="äl2""#), 2);
        assert_eq!(outline_level(r#" class="l2ä""#), 2);
        assert_eq!(outline_level(r#" class="xl2""#), 1);
        assert_eq!(outline_level(r#" class="l2extra""#), 1);
        assert_eq!(outline_level(r#" class="l10""#), 1);
        assert_eq!(outline_level(r#" class = "l4""#), 1);
        assert_eq!(outline_level(r#" CLASS="l5""#), 5);
        assert_eq!(outline_level(r#" class='l3'"#), 3);
        assert_eq!(outline_level(r#" data-class="l6" class="page""#), 6);
        assert_eq!(outline_level(r#" myclass="l6""#), 1);
        assert_eq!(outline_level(r#" class="_l2""#), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_onenote_tool_reports_the_exit_status() {
        assert_eq!(
            tool_failure_message("Archivprüfung", "", "", Some(7), None),
            "Archivprüfung ist fehlgeschlagen: Code 7"
        );
        assert_eq!(
            tool_failure_message("OneNote-Konvertierung", "out", "err", Some(1), None),
            "OneNote-Konvertierung ist fehlgeschlagen: err"
        );
        assert_eq!(
            tool_failure_message("OneNote-Konvertierung", "", "kaputt", None, Some("SIGKILL")),
            "OneNote-Konvertierung ist fehlgeschlagen (SIGKILL): kaputt"
        );
        let long = "ä".repeat(1801);
        let message = tool_failure_message("Werkzeug", &long, "", Some(1), None);
        assert!(message.ends_with(&"ä".repeat(1800)));
        assert_eq!(message.matches('ä').count(), 1800);
    }

    #[test]
    fn an_onenote_export_stops_at_the_desktop_limits() {
        assert!(
            validate_listing("Path = a.txt\r\nSize = 1\r\n\r\nPath = b.txt\r\nSize = 2\r\n")
                .is_ok()
        );
        assert!(validate_listing("Path = C:/secret.txt\nSize = 1\n").is_err());
        assert!(validate_listing("Path = \u{212A}:/secret.txt\nSize = 1\n").is_err());
        assert!(validate_listing("Path = \u{017F}:/secret.txt\nSize = 1\n").is_err());
        assert!(validate_listing("Path = note/\u{017F}:/secret.txt\nSize = 1\n").is_ok());
        assert!(validate_listing("Path = note.one\nSize = 1\n").is_ok());

        let root = std::env::temp_dir().join(format!(
            "fanotes-onenote-walk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.bin"), vec![1u8; 10]).unwrap();
        std::fs::write(root.join("b.bin"), vec![2u8; 10]).unwrap();
        let too_big = walk_limited(&root, 15, 20).unwrap_err();
        assert!(too_big.contains("zu groß"));
        std::fs::write(root.join("c.bin"), vec![3u8; 1]).unwrap();
        let too_many = walk_limited(&root, 1_000, 2).unwrap_err();
        assert!(too_many.contains("zu viele Dateien"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("a.bin"), root.join("link.bin")).unwrap();
            let linked = walk_limited(&root, 1_000, 20).unwrap_err();
            assert!(linked.contains("Symbolische"));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_archive_size_uses_javascript_number() {
        let limited = "Das OneNote-Archiv überschreitet die sicheren Importgrenzen.";
        assert_eq!(
            validate_listing("Path = a.txt\nSize = 1.5\n").unwrap_err(),
            limited
        );
        assert_eq!(
            validate_listing("Path = a.txt\nSize = abc\n").unwrap_err(),
            limited
        );
        assert!(validate_listing("Path = a.txt\nSize = 1e2\n").is_ok());
        assert!(validate_listing("Path = a.txt\nSize =  12 \n").is_ok());
        assert!(validate_listing("Path = a.txt\nSize = 1.0\n").is_ok());
        assert!(validate_listing("Path = dir\nFolder = +\nSize = 1.5\n").is_ok());
        assert!(validate_listing("Path = \nSize = 1\n\nPath = note.one\nSize = 2\n").is_ok());
        assert!(validate_listing("Path = note.one\nType = \nSize = 1\n").is_ok());
        assert_eq!(
            validate_listing("Path = archive.zip\nType = zip\n").unwrap_err(),
            "Das OneNote-Archiv enthält keine importierbaren Dateien."
        );
    }

    #[test]
    fn onenote_sections_share_the_nearest_common_folder() {
        assert_eq!(
            common_ancestor(&[
                PathBuf::from("/notes/Mathe/Gruppe A/a.one"),
                PathBuf::from("/notes/Mathe/Gruppe B/b.one"),
            ]),
            PathBuf::from("/notes/Mathe")
        );
        assert_eq!(
            common_ancestor(&[
                PathBuf::from("/notes/Mathe/Gruppe/tief/a.one"),
                PathBuf::from("/notes/Mathe/b.one"),
            ]),
            PathBuf::from("/notes/Mathe")
        );
        assert_eq!(
            common_ancestor(&[PathBuf::from("/notes/Mathe/a.one")]),
            PathBuf::from("/notes/Mathe")
        );
    }

    #[test]
    fn a_failed_notebook_keeps_the_tool_error_when_no_section_remains() {
        let root = std::env::temp_dir().join(format!(
            "fanotes-onenote-render-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let notebook = root.join("notebook");
        let output = root.join("rendered");
        std::fs::create_dir_all(&notebook).unwrap();
        std::fs::create_dir_all(&output).unwrap();
        let toc = notebook.join("Open Notebook.onetoc2");
        std::fs::write(&toc, b"notebook").unwrap();
        let missing = render_inputs(&[toc.clone()], &output, Path::new("/bin/false")).unwrap_err();
        assert!(missing.contains("OneNote-Konvertierung ist fehlgeschlagen: Code 1"));
        assert!(!missing.contains("keine OneNote-Abschnitte"));

        std::fs::write(notebook.join("Algebra.one"), b"section").unwrap();
        let named = render_inputs(&[toc], &output, Path::new("/bin/false")).unwrap_err();
        assert!(named.contains("OneNote-Abschnitt Algebra.one"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
