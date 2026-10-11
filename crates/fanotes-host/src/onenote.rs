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
    let output_files = walk_files(&output_root)?;
    let html_files: Vec<PathBuf> = output_files
        .iter()
        .filter(|path| extension_of(path) == ".html")
        .cloned()
        .collect();
    let parents = page_parents(&html_files, &output_root);
    let mut pages = Vec::new();
    for path in &html_files {
        let preview = fs::read_to_string(path).unwrap_or_default();
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
                crate::compare_names(segment, &notebook_name) == std::cmp::Ordering::Equal
            }) {
                hierarchy.remove(0);
            }
            let mut directory = note_root.clone();
            for segment in hierarchy
                .into_iter()
                .chain(parents.get(page_path).cloned().unwrap_or_default())
            {
                directory.push(safe_segment(&segment, "OneNote-Seite"));
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
    let mut html = fs::read_to_string(page_path)
        .map_err(|_| "Eine OneNote-Seite ist leer oder zu groß.".to_owned())?;
    let raw_title = Regex::new(r"(?is)<title[^>]*>(.*?)</title>")
        .ok()
        .and_then(|pattern| {
            pattern
                .captures(&html)
                .and_then(|caps| caps.get(1).map(|item| item.as_str().to_owned()))
        })
        .unwrap_or_else(|| {
            page_path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("OneNote-Seite")
                .to_owned()
        });
    let title = safe_segment(
        &decode_entities(&Regex::new(r"<[^>]+>").unwrap().replace_all(&raw_title, "")),
        "OneNote-Seite",
    );
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

fn strip_active_html(html: &str) -> String {
    let mut html = html.to_owned();
    let patterns = [
        r"(?is)<script\b[^>]*>.*?</script>",
        r"(?is)<(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)\b[^>]*>.*?</(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)>",
        r"(?is)<(?:iframe|frame|frameset|object|embed|audio|video|source|track|link|base|form|input|button|textarea|select)\b[^>]*/?>",
        r#"(?i)\s+on[a-z][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#,
        r#"(?i)\s+(?:href|action|formaction|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#,
        r"(?i)(?:javascript|vbscript)\s*:",
        r"(?i)@import\s+[^;]+;?",
        r"(?i)url\s*\([^)]*\)",
        r"(?i)expression\s*\([^)]*\)",
    ];
    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            let replacement = if pattern.contains("url\\s*") {
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
    let Ok(regex) = Regex::new(r#"(?i)(<img\b[^>]*\bsrc=)(['"])([^'"]+)\2"#) else {
        return html.to_owned();
    };
    let mut embedded_bytes = 0u64;
    let mut replacements = HashMap::new();
    for caps in regex.captures_iter(html) {
        let Some(source) = caps.get(3).map(|item| item.as_str()) else {
            continue;
        };
        let replacement = image_data_url(source, page_path, output_root, &mut embedded_bytes);
        replacements.insert(source.to_owned(), replacement);
    }
    regex
        .replace_all(html, |caps: &regex::Captures| {
            let prefix = caps.get(1).map(|item| item.as_str()).unwrap_or("");
            let quote = caps.get(2).map(|item| item.as_str()).unwrap_or("\"");
            let source = caps.get(3).map(|item| item.as_str()).unwrap_or("");
            match replacements.get(source).map(String::as_str) {
                None => caps
                    .get(0)
                    .map(|item| item.as_str())
                    .unwrap_or("")
                    .to_owned(),
                Some("") => {
                    let kept = prefix.trim_end_matches("src=");
                    format!("{kept}data-fanotes-missing-image={quote}blocked{quote}")
                }
                Some(replacement) => format!("{prefix}{quote}{replacement}{quote}"),
            }
        })
        .into_owned()
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
        if let Ok(regex) = Regex::new(pattern) {
            text = regex.replace_all(&text, " ").into_owned();
        }
    }
    if let Ok(regex) = Regex::new(r"(?i)<br\s*/?\s*>") {
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
    let text = replace_all(&text, r"\s*\n\s*", "\n");
    let text = replace_all(&text, r"\n{3,}", "\n\n");
    crate::vault::truncate_utf16(text.trim(), 2_000_000)
}

fn replace_all(text: &str, pattern: &str, replacement: &str) -> String {
    Regex::new(pattern)
        .map(|regex| regex.replace_all(text, replacement).into_owned())
        .unwrap_or_else(|_| text.to_owned())
}

fn page_dimensions(html: &str) -> (i64, i64) {
    let measured = |name: &str| -> Vec<f64> {
        let pattern = format!(r"(?i)(?:^|[;\s\x22])(?:max-)?{name}\s*:\s*(-?[0-9.]+)px");
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
    let blocks = Regex::new(r"(?i)<(?:p|li|tr|h[1-6])\b")
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
    Regex::new(r"(?i)<nav\b").is_ok_and(|regex| regex.is_match(html))
        || Regex::new(r"(?i)<iframe\b").is_ok_and(|regex| regex.is_match(html))
}

fn page_parents(html_files: &[PathBuf], output_root: &Path) -> HashMap<PathBuf, Vec<String>> {
    let mut parents = HashMap::new();
    let Ok(anchor) = Regex::new(r"(?is)<a\b([^>]*)>(.*?)</a>") else {
        return parents;
    };
    for entry in html_files {
        let Ok(html) = fs::read_to_string(entry) else {
            continue;
        };
        if !preview_is_nav(&html) && !html.to_ascii_lowercase().contains("<nav") {
            continue;
        }
        if !Regex::new(r"(?i)<nav\b").is_ok_and(|regex| regex.is_match(&html)) {
            continue;
        }
        let mut stack = Vec::new();
        for caps in anchor.captures_iter(&html) {
            let attributes = caps.get(1).map(|item| item.as_str()).unwrap_or("");
            let Some(href) = attr(attributes, "href") else {
                continue;
            };
            let level = attr(attributes, "class")
                .and_then(|class| {
                    class.split_whitespace().find_map(|token| {
                        token
                            .strip_prefix('l')
                            .and_then(|number| number.parse::<usize>().ok())
                    })
                })
                .unwrap_or(1);
            let decoded = urlencoding_decode(&href);
            let target = entry.parent().unwrap_or(output_root).join(decoded);
            if !target.starts_with(output_root) {
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

fn attr(attributes: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let lower = attributes.to_ascii_lowercase();
    let index = lower.find(&needle.to_ascii_lowercase())?;
    let rest = &attributes[index + needle.len()..];
    let mut chars = rest.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    Some(rest[quote.len_utf8()..].split(quote).next()?.to_owned())
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
        Duration::from_secs(90),
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
        Duration::from_secs(120),
        "Archivextraktion",
    )?;
    let files = walk_files(&extracted)?;
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
    let mut bytes = 0u64;
    for record in stdout.split("\n\n") {
        let mut fields = HashMap::new();
        for line in record.lines() {
            if let Some((key, value)) = line.split_once(" = ") {
                fields.insert(key.to_owned(), value.to_owned());
            }
        }
        let Some(entry_path) = fields.get("Path") else {
            continue;
        };
        if fields.get("Type").is_some() {
            continue;
        }
        let normalized = entry_path.replace('\\', "/");
        if normalized.starts_with('/')
            || normalized
                .split('/')
                .any(|segment| segment.is_empty() || segment == "..")
            || (normalized.len() > 2 && normalized.as_bytes()[1] == b':')
        {
            return Err("Das OneNote-Archiv enthält einen unsicheren Pfad.".to_owned());
        }
        if fields.get("Folder").map(String::as_str) != Some("+") {
            bytes += fields
                .get("Size")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
        }
        count += 1;
        if count > 20_000 || bytes > 6 * 1024 * 1024 * 1024 {
            return Err("Das OneNote-Archiv überschreitet die sicheren Importgrenzen.".to_owned());
        }
    }
    if count == 0 {
        Err("Das OneNote-Archiv enthält keine importierbaren Dateien.".to_owned())
    } else {
        Ok(())
    }
}

fn render_inputs(
    inputs: &[PathBuf],
    output_root: &Path,
    one2html: &Path,
) -> Result<Vec<String>, String> {
    if inputs.len() == 1 && extension_of(&inputs[0]) == ".onetoc2" {
        if run_tool(
            one2html,
            &[
                "--input",
                &inputs[0].to_string_lossy(),
                "--output",
                &output_root.to_string_lossy(),
            ],
            Duration::from_secs(120),
            "OneNote-Konvertierung",
        )
        .is_ok()
        {
            return Ok(Vec::new());
        }
        let notebook = inputs[0].parent().unwrap_or(Path::new("."));
        let sections: Vec<PathBuf> = walk_files(notebook)?
            .into_iter()
            .filter(|path| extension_of(path) == ".one")
            .collect();
        if sections.is_empty() {
            return Err(
                "Es wurden keine OneNote-Abschnitte für die Konvertierung gefunden.".to_owned(),
            );
        }
        let _ = fs::remove_dir_all(output_root);
        create_private_dir(output_root)
            .map_err(|_| "Der OneNote-Import konnte nicht vorbereitet werden.".to_owned())?;
        render_sections(&sections, notebook, output_root, one2html)?;
        return Ok(vec!["Verschachtelte OneNote-Abschnittsgruppen wurden abschnittsweise mit ihrer Ordnerhierarchie übernommen.".to_owned()]);
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
    render_sections(&sections, common_ancestor(&sections), output_root, one2html)?;
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
            destination.push(safe_segment(name, "Abschnitt"));
        }
        create_private_dir(&destination)
            .map_err(|_| "Der OneNote-Import konnte nicht vorbereitet werden.".to_owned())?;
        run_tool(
            one2html,
            &[
                "--input",
                &section.to_string_lossy(),
                "--output",
                &destination.to_string_lossy(),
            ],
            Duration::from_secs(120),
            "OneNote-Abschnitt",
        )?;
    }
    Ok(())
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
        let relative = path
            .strip_prefix(output_root)
            .unwrap_or(path)
            .components()
            .map(|component| safe_segment(&component.as_os_str().to_string_lossy(), "Anlage"))
            .collect::<Vec<_>>()
            .join("/");
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
        sources = walk_files(source_root)?
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
        let relative = source
            .strip_prefix(source_root)
            .unwrap_or(&source)
            .components()
            .map(|component| safe_segment(&component.as_os_str().to_string_lossy(), "OneNote"))
            .collect::<Vec<_>>()
            .join("/");
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
    let stdout_handle = thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stdout_pipe.read_to_string(&mut buffer);
        buffer
    });
    let stderr_handle = thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stderr_pipe.read_to_string(&mut buffer);
        buffer
    });
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
        let detail = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        Err(format!(
            "{label} ist fehlgeschlagen: {}",
            detail
                .trim()
                .chars()
                .rev()
                .take(1800)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ))
    }
}

fn walk_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|_| {
            "Der OneNote-Export enthält einen nicht unterstützten Dateityp.".to_owned()
        })?;
        for entry in entries {
            let entry = entry.map_err(|_| {
                "Der OneNote-Export enthält einen nicht unterstützten Dateityp.".to_owned()
            })?;
            let target = entry.path();
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

fn common_ancestor(paths: &[PathBuf]) -> &Path {
    paths
        .first()
        .and_then(|path| path.parent())
        .unwrap_or(Path::new("."))
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
    let collapsed = Regex::new(r"\s+")
        .map(|regex| regex.replace_all(cleaned.trim(), " ").into_owned())
        .unwrap_or_else(|_| cleaned.trim().to_owned());
    let trimmed = collapsed.trim_end_matches(['.', ' ']).trim();
    let trimmed = crate::vault::truncate_utf16(trimmed, 120);
    let device = trimmed.split('.').next().unwrap_or("").trim();
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
    let mut output = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find(';') else {
            output.push_str(rest);
            return output;
        };
        let entity = &rest[1..end];
        let decoded = if let Some(hex) = entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
        {
            code_point(u32::from_str_radix(hex, 16).ok())
        } else if let Some(decimal) = entity.strip_prefix('#') {
            code_point(decimal.parse().ok())
        } else {
            match entity.to_ascii_lowercase().as_str() {
                "nbsp" => " ".to_owned(),
                "amp" => "&".to_owned(),
                "lt" => "<".to_owned(),
                "gt" => ">".to_owned(),
                "quot" => "\"".to_owned(),
                "apos" => "'".to_owned(),
                _ => format!("&{entity};"),
            }
        };
        output.push_str(&decoded);
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    output
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

fn urlencoding_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                output.push(byte);
                index += 3;
                continue;
            }
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
    use super::{extract_search_text, inline_images, page_dimensions, safe_segment};

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
    }

    #[test]
    fn onenote_search_text_collapses_blank_lines() {
        assert_eq!(extract_search_text("a\n\n\nb"), "a\nb");
        assert_eq!(extract_search_text("a\n\n\n\nb"), "a\nb");
        assert_eq!(extract_search_text("a\n \n \nb"), "a\nb");
        assert_eq!(
            extract_search_text("<p>Eins</p>\n<p>Zwei</p>"),
            "Eins\nZwei"
        );
        let long = "😀".repeat(1_000_001);
        assert_eq!(extract_search_text(&long).encode_utf16().count(), 2_000_000);
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
}
